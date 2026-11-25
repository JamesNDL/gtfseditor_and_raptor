// Closures: a line drawn on the map that nothing can run through, whatever kind of service it is.
// Each line it crosses is split there: the part on each side becomes a line of its own (B1 becomes
// B1-N and B1-S), with its own path and timetable, and its vehicles turn back at the last stop
// before the closure. Either part can be dropped. A bus or coach line can be sent round by other
// roads instead.
// (Two older forms are still taken: a stretch of road round a point, and one mode's line between
// two stations.)
//
// A closure is an area on the map. Every stop pattern whose path enters it is changed, using the
// same machinery as "Change route":
// - Road vehicles are sent another way between the last stop before the closure and the first stop
//   after it, and no longer call at the stops inside it.
// - Trains, trams and ferries cannot go round, so each trip is cut in two: one part that ends at the
//   last station before the closure, and one that starts from the first station after it.
import {
  distanceM,
  distanceToPathM,
  formatClock,
  locateStops,
  pathDistances,
  slicePath,
  type Coord,
} from '@gtfs-editor/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  applyReshape,
  describeChange,
  planReshape,
  type ReshapeDeps,
  type ReshapePlan,
} from './reshape.ts';
import { entersAvoid, ROAD_MODES, type Avoid } from '../../routing/roads.ts';
import { scenarioOf, visible, type Scenario } from '../scenarios.ts';
import { trackPath } from '../../routing/tracks.ts';
import { fail } from '../../http.ts';

export interface ClosureDeps extends ReshapeDeps {
  assignVehicles: (
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
    forceNew?: boolean,
    extra?: {
      groupOf?: Map<number, string>;
      crosses?: (ax: number, ay: number, bx: number, by: number) => boolean;
      alsoDays?: number[];
    },
  ) => Promise<{ reused: number; added: number }>;
  removeTrips: (tx: Sql, sc: Scenario, seq: number, tripIds: number[]) => Promise<void>;
  fleetFigures: (
    tx: Sql,
    sc: Scenario,
    routeIds: number[],
  ) => Promise<{ chains: number; peak: number }>;
  dayFigures: (
    tx: Sql,
    baselineId: number,
    sc: Scenario | null,
  ) => Promise<{ vehicles: number; peak: number }>;
}

/**
 * Where each stop of a stop pattern sits along its path, as a fraction of the path's length (in
 * the map's own degrees, which is what PostGIS measures a fraction in).
 *
 * The feed's distances are used: each stop time says how far along the path it is. The nearest
 * point of the whole path will not do. A loop's last stop is nearest to the path's start, which put
 * every stop of a loop line "before" the closure, and the line was left running through it.
 * Without usable distances the stops are placed in order, each at or after the one before.
 */
function stopFractions(
  lon: number[],
  lat: number[],
  stored: number[] | null,
  callDist: (number | null)[] | null,
  stopLon: number[],
  stopLat: number[],
): { fracs: number[]; cum: number[] } {
  const m = lon.length;
  const cum = [0];
  for (let k = 1; k < m; k++)
    cum.push(cum[k - 1] + Math.hypot(lon[k] - lon[k - 1], lat[k] - lat[k - 1]));
  const total = cum[m - 1] || 1;
  const n = stopLon.length;
  const usable =
    stored !== null &&
    stored.length === m &&
    callDist !== null &&
    callDist.length === n &&
    stored[m - 1] > stored[0] &&
    callDist.every((d, i) => d !== null && (i === 0 || d >= callDist[i - 1]!));
  let at: number[];
  if (usable) {
    let k = 1;
    at = (callDist as number[]).map((d) => {
      while (k < m - 1 && stored![k] < d) k++;
      const span = stored![k] - stored![k - 1];
      const f = span > 0 ? Math.max(0, Math.min(1, (d - stored![k - 1]) / span)) : 0;
      return cum[k - 1] + (cum[k] - cum[k - 1]) * f;
    });
  } else {
    const coords = lon.map((x, k) => [x, lat[k]] as Coord);
    at = locateStops(
      coords,
      stopLon.map((x, i) => [x, stopLat[i]] as Coord),
    ).map((k) => cum[k]);
  }
  const fracs: number[] = [];
  for (const v of at)
    fracs.push(Math.max(fracs[fracs.length - 1] ?? 0, Math.max(0, Math.min(1, v / total))));
  return { fracs, cum };
}

export interface CloseBody {
  /** 'cut' for a line drawn on the map; or 'road', or the mode whose line is closed: train, metro, light_rail or ferry. */
  what: string;
  baselineId?: number;
  /** Cut: the points of the drawn line, how far either side of it is closed, and the modes to leave running. */
  line?: [number, number][];
  widthM?: number;
  exceptModes?: string[];
  /** Cut: what happens to buses and coaches: each line is split at the closure (the default), or sent round it. */
  roads?: 'split' | 'detour';
  /** Cut: which parts of a split line are kept: 'both', one side of the closure ('N', 'S', 'E' or 'W'), or 'none'. */
  keep?: string;
  /** Cut: a different choice for single lines, by route id. 'leave' leaves the line running through. */
  lines?: Record<string, { how?: 'split' | 'detour' | 'leave'; keep?: string }>;
  /** Road: the middle of the closed stretch and how far it reaches. */
  lon?: number;
  lat?: number;
  radiusM?: number;
  /** Line: the two stations the closure lies between. */
  fromStopId?: number;
  toStopId?: number;
  /**
   * Part of the day: the closure starts and ends at these times, in seconds since the start of the
   * service day (so an end after midnight is more than 24 hours). Left out, it lasts all day.
   */
  fromSecs?: number;
  toSecs?: number;
}

const TRACK_MODES = new Set(['train', 'metro', 'light_rail', 'ferry']);
// How far either side of the closed line another service's path can be and still count as using it.
// Ferry paths are drawn loosely, so they get more room.
const CORRIDOR_M: Record<string, number> = { train: 40, metro: 40, light_rail: 30, ferry: 150 };
// A closure sends at most this many bus and coach stop patterns another way in one go: each one is a
// set of questions to the routing server. (It was 80 until 18 Nov; the Harbour Bridge carries 162.)
const MAX_PATTERNS = 400;

// joined: a line that crossed the closure and came back now turns round before it, as one trip.
// left: the line was chosen to be left running through.
type Action =
  'detour' | 'shortened' | 'split' | 'joined' | 'removed' | 'blocked' | 'failed' | 'left';

/** One part of a line that a closure splits. */
interface Piece {
  /** The side of the closure it is on: 'N', 'S', 'E' or 'W'; empty for a closure that has no sides. */
  side: string;
  stopIds: number[];
  /** The stop where its vehicles now turn back. */
  turnsAt: { name: string; lon: number; lat: number };
  kept: boolean;
  /** The stretches of the published path it keeps, as fractions of its length: for the map. */
  ranges: [number, number][];
}

const SIDE_NAME: Record<string, string> = { N: 'north', S: 'south', E: 'east', W: 'west' };

interface Item {
  patternId: number;
  routeId: number;
  name: string;
  color: string;
  modeId: string;
  /** A bus or coach line, which can be sent round by other roads. */
  road: boolean;
  /** What was chosen for the line, and which parts of it are kept. */
  how: 'split' | 'detour' | 'leave';
  keep: string;
  pieces: Piece[];
  trips: number;
  /** For a closure that lasts part of the day: the trips that would be in it then. The rest are left alone. */
  tripIds?: number[];
  closedStops: string[];
  action: Action;
  /** Why a pattern could not be changed. */
  reason?: string;
  /** One plan for a detour or a line cut short; two when trips are split either side of the closure. */
  plans: ReshapePlan[];
  /** The side of the closure each plan is for, where the closure has sides. */
  planSides: string[];
}

interface ClosurePlan {
  what: string;
  label: string;
  zoneWkt: string;
  zone: unknown;
  /** The times it starts and ends, or null when it lasts all day. */
  window: { fromSecs: number; toSecs: number } | null;
  items: Item[];
  /** Stop patterns over the limit, left as they are. */
  skipped: number;
  /** Every mode with services through the closed area, whether or not it was left running. */
  modes: { id: string; name: string; lines: number }[];
  /** The two sides of a drawn closure, or null for one that has none. */
  sides: [string, string] | null;
  /** The closed area as the road router is given it, where the closure has one. */
  avoid?: Avoid;
}

const tidy = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');
const clock = (secs: number) => {
  const { time, nextDay } = formatClock(secs);
  return nextDay ? `${time} the next day` : time;
};
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Works out everything a closure would do, without changing anything. */
/** `detail` says which new paths are planned: those of road vehicles only (enough for a preview), or all of them. */
export async function planClosure(
  tx: Sql,
  sc: Scenario | null,
  baselineId: number,
  body: CloseBody,
  deps: ClosureDeps,
  detail: 'roads' | 'all',
): Promise<ClosurePlan> {
  const what = String(body.what);
  const road = what === 'road';
  const cut = what === 'cut';
  if (!road && !cut && !TRACK_MODES.has(what)) throw fail(400, 'Choose what is closed');

  let window: ClosurePlan['window'] = null;
  if (body.fromSecs != null || body.toSecs != null) {
    const fromSecs = Number(body.fromSecs);
    const toSecs = Number(body.toSecs);
    if (
      !Number.isInteger(fromSecs) ||
      !Number.isInteger(toSecs) ||
      fromSecs < 0 ||
      toSecs > 36 * 3600
    )
      throw fail(400, 'Give the times the closure starts and ends');
    if (toSecs <= fromSecs) throw fail(400, 'The closure must end after it starts');
    window = { fromSecs, toSecs };
  }

  let zoneSql;
  let label: string;
  let avoid: Avoid | undefined;
  let modes: string[] | null;
  let minInside = 0;
  type Sides = { codes: [string, string]; of: (lon: number, lat: number) => string };
  let sides: Sides | null = null;
  /** For a line with no left and right: makes the sides from the stops either side of it on one stop pattern. */
  let sidesFrom: ((ax: number, ay: number, bx: number, by: number) => Sides) | null = null;
  const except = new Set(
    cut && Array.isArray(body.exceptModes) ? body.exceptModes.map(String) : [],
  );
  if (cut) {
    const line = (Array.isArray(body.line) ? body.line : []).map(
      (p) => [Number(p?.[0]), Number(p?.[1])] as [number, number],
    );
    if (line.length < 2)
      throw fail(
        400,
        'Draw a line across what is closed: click the map on one side, then on the other',
      );
    if (
      line.length > 60 ||
      !line.every(([lon, lat]) => lon > 140 && lon < 160 && lat > -38 && lat < -28)
    )
      throw fail(400, 'That line cannot be used');
    const widthM = Math.round(Number(body.widthM ?? 20));
    if (!(widthM >= 5 && widthM <= 200))
      throw fail(400, 'The closure can reach between 5 and 200 metres either side of the line');
    const along = pathDistances(line);
    const length = along[along.length - 1];
    if (length < 5) throw fail(400, 'That line is too short: click further apart');
    if (length > 20_000) throw fail(400, 'That line is more than 20 km long: draw a shorter one');
    const middle = slicePath(line, along, length / 2, length)[0];
    const reach = Math.max(...line.map((p) => distanceM(p[0], p[1], middle[0], middle[1])));
    avoid = { lon: middle[0], lat: middle[1], radiusM: reach + widthM, line, widthM };
    // The two sides of the line, named by compass. A line that runs more or less straight has a left
    // and a right; one that doubles back (drawn round something) is judged from its middle.
    const kx = 111_320 * Math.cos((middle[1] * Math.PI) / 180);
    const ky = 110_540;
    const [a, b] = [line[0], line[line.length - 1]];
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    if (Math.hypot(dx, dy) >= length * 0.5) {
      const northSouth = Math.abs(dx) >= Math.abs(dy);
      const left = northSouth ? (dx > 0 ? 'N' : 'S') : dy > 0 ? 'W' : 'E';
      const right = { N: 'S', S: 'N', E: 'W', W: 'E' }[left]!;
      sides = {
        codes: northSouth ? ['N', 'S'] : ['W', 'E'],
        of: (lon, lat) => (dx * (lat - a[1]) * ky - dy * (lon - a[0]) * kx > 0 ? left : right),
      };
    } else {
      // Which way the sides face is taken from the busiest line through it, further down.
      sidesFrom = (ax, ay, bx, by) =>
        Math.abs((bx - ax) * kx) > Math.abs((by - ay) * ky)
          ? { codes: ['W', 'E'], of: (lon) => (lon < middle[0] ? 'W' : 'E') }
          : { codes: ['N', 'S'], of: (_lon, lat) => (lat > middle[1] ? 'N' : 'S') };
    }
    modes = null;
    const wkt = `LINESTRING(${line.map((p) => `${p[0]} ${p[1]}`).join(',')})`;
    zoneSql = tx`ST_Buffer(ST_GeomFromText(${wkt}, 4326)::geography, ${widthM})::geometry`;
    const [near] = await tx`
      select coalesce(p.name, s.name) as name from stops s left join stops p on p.id = s.parent_id
      where s.baseline_id = ${baselineId} and s.scenario_id is null and s.location_type = 0 and cardinality(s.mode_ids) > 0
      order by s.geom <-> ST_SetSRID(ST_MakePoint(${middle[0]}, ${middle[1]}), 4326) limit 1`;
    const size =
      length >= 950
        ? `${(length / 1000).toFixed(1)} km`
        : `${Math.round(length / 10) * 10 || 10} m`;
    label = `Closed near ${near ? tidy(near.name) : 'here'} (a line ${size} long)`;
  } else if (road) {
    const lon = Number(body.lon);
    const lat = Number(body.lat);
    const radiusM = Math.round(Number(body.radiusM ?? 100));
    if (!(lon > 140 && lon < 160 && lat > -38 && lat < -28))
      throw fail(400, 'Click the map where the road is closed');
    if (!(radiusM >= 20 && radiusM <= 500))
      throw fail(400, 'The closed stretch must be between 20 and 500 metres across');
    avoid = { lon, lat, radiusM };
    modes = [...ROAD_MODES];
    zoneSql = tx`ST_Buffer(ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusM})::geometry`;
    const [near] = await tx`
      select s.name from stops s
      where s.baseline_id = ${baselineId} and s.scenario_id is null and s.location_type = 0 and cardinality(s.mode_ids) > 0
      order by s.geom <-> ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326) limit 1`;
    label = `Road closed near ${near ? tidy(near.name) : 'here'} (${radiusM} m either way)`;
  } else {
    const ends = await tx`
      select s.id, coalesce(s.parent_id, s.id) as station, coalesce(p.name, s.name) as name,
             ST_X(coalesce(p.geom, s.geom)) as lon, ST_Y(coalesce(p.geom, s.geom)) as lat
      from stops s left join stops p on p.id = s.parent_id
      where s.id = any(${[Number(body.fromStopId), Number(body.toStopId)]}) and s.baseline_id = ${baselineId}`;
    const from = ends.find((e) => e.id === Number(body.fromStopId));
    const to = ends.find((e) => e.id === Number(body.toStopId));
    if (!from || !to) throw fail(400, 'Click the two stations the closure is between');
    if (from.station === to.station) throw fail(400, 'Those are the same station');
    const section = await trackPath(tx, baselineId, what, [
      { lon: from.lon, lat: from.lat, stationId: from.station },
      { lon: to.lon, lat: to.lat, stationId: to.station },
    ]);
    const [mode] = await tx`select name from modes where id = ${what}`;
    if (section.found === 0)
      throw fail(
        400,
        `No ${String(mode.name).toLowerCase()} service runs between ${tidy(from.name)} and ${tidy(to.name)}, so there is nothing to close`,
      );
    // The stations either side stay open, so the closed area stops a little short of each.
    const dists = pathDistances(section.coords as Coord[]);
    const total = dists[dists.length - 1];
    const trim = Math.min(150, total * 0.2);
    const inner = slicePath(section.coords as Coord[], dists, trim, total - trim);
    minInside = (total - 2 * trim) * 0.5;
    modes = [what];
    const wkt = `LINESTRING(${inner.map((p) => `${p[0]} ${p[1]}`).join(',')})`;
    zoneSql = tx`ST_Buffer(ST_GeomFromText(${wkt}, 4326)::geography, ${CORRIDOR_M[what]})::geometry`;
    label = `${mode.name} closed between ${tidy(from.name)} and ${tidy(to.name)}`;
  }
  if (window) label += `, ${clock(window.fromSecs)} to ${clock(window.toSecs)}`;
  const [zone] =
    await tx`select ST_AsText(z.g) as wkt, ST_AsGeoJSON(z.g) as json from (select ${zoneSql} as g) z`;
  const zoneWkt: string = zone.wkt;

  const ownPatterns = sc
    ? tx`(p.scenario_id = ${sc.id} and p.created_edit <= ${sc.head})`
    : tx`false`;
  const rows = await tx`
    with zone as (select ST_GeomFromText(${zoneWkt}, 4326) as g),
    cand as materialized (
      select p.id, p.route_id, p.stop_ids, sh.geom, sh.dists, zone.g,
             coalesce(r.short_name, r.long_name, 'Line') as name, coalesce(r.color, m.color) as color,
             r.mode_id, m.name as mode_name
      from patterns p
      join routes r on r.id = p.route_id
      join modes m on m.id = r.mode_id
      join shapes sh on sh.id = p.shape_id
      cross join zone
      where p.baseline_id = ${baselineId} and (p.scenario_id is null or ${ownPatterns})
        and ${modes ? tx`r.mode_id = any(${modes})` : tx`true`} and ST_Intersects(sh.geom, zone.g))
    select c.id, c.route_id, c.stop_ids, c.name, c.color, c.mode_id, c.mode_name, x.trips, span.inside, c.dists,
           array(select ST_X((dp).geom) from ST_DumpPoints(c.geom) dp order by (dp).path[1]) as plon,
           array(select ST_Y((dp).geom) from ST_DumpPoints(c.geom) dp order by (dp).path[1]) as plat,
           (select array_agg(st.dist order by st.seq) from stop_times st
            where st.trip_id = (select t.id from trips t where t.pattern_id = c.id and ${visible(tx, 't', sc)} order by t.id limit 1)) as call_dists,
           array(select s.name from unnest(c.stop_ids) with ordinality as o(id, n) join stops s on s.id = o.id order by o.n) as names,
           array(select ST_X(s.geom) from unnest(c.stop_ids) with ordinality as o(id, n) join stops s on s.id = o.id order by o.n) as lons,
           array(select ST_Y(s.geom) from unnest(c.stop_ids) with ordinality as o(id, n) join stops s on s.id = o.id order by o.n) as lats
    from cand c
    cross join lateral (select count(*)::int as trips from trips t where t.pattern_id = c.id and ${visible(tx, 't', sc)}) x
    cross join lateral (
      select min(least(q.fs, q.fe)) as f0, max(greatest(q.fs, q.fe)) as f1, coalesce(sum(q.len), 0) as inside
      from (
        select ST_LineLocatePoint(c.geom, ST_StartPoint(d.geom)) as fs, ST_LineLocatePoint(c.geom, ST_EndPoint(d.geom)) as fe,
               ST_Length(d.geom::geography) as len
        from ST_Dump(ST_Intersection(c.geom, c.g)) d where GeometryType(d.geom) = 'LINESTRING') q) span
    where x.trips > 0 and span.f0 is not null
    order by x.trips desc, c.id`;

  // Which stretches between two consecutive stops of each path run into the closed area. The cut is
  // decided stretch by stretch, so a path that passes the same place twice is judged where it
  // actually runs, not by where its ends happen to be nearest.
  const zoneBox = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  const walk = (v: unknown): void => {
    if (Array.isArray(v) && typeof v[0] === 'number') {
      zoneBox.west = Math.min(zoneBox.west, v[0] as number);
      zoneBox.east = Math.max(zoneBox.east, v[0] as number);
      zoneBox.south = Math.min(zoneBox.south, v[1] as number);
      zoneBox.north = Math.max(zoneBox.north, v[1] as number);
    } else if (Array.isArray(v)) v.forEach(walk);
  };
  walk((JSON.parse(zone.json) as { coordinates: unknown }).coordinates);
  const placed = new Map<number, number[]>();
  const ask = { pid: [] as number[], i: [] as number[], a: [] as number[], b: [] as number[] };
  for (const r of rows) {
    const lon = (r.plon as number[]).map(Number);
    const lat = (r.plat as number[]).map(Number);
    const { fracs, cum } = stopFractions(
      lon,
      lat,
      r.dists as number[] | null,
      r.call_dists as (number | null)[] | null,
      (r.lons as number[]).map(Number),
      (r.lats as number[]).map(Number),
    );
    placed.set(r.id, fracs);
    const total = cum[cum.length - 1] || 1;
    let k = 0;
    for (let i = 0; i + 1 < fracs.length; i++) {
      if (!(fracs[i + 1] > fracs[i])) continue;
      // Only stretches whose own box meets the closed area's are worth asking the database about.
      while (k > 0 && cum[k] > fracs[i] * total) k--;
      while (k + 1 < cum.length && cum[k + 1] <= fracs[i] * total) k++;
      let west = Infinity,
        east = -Infinity,
        south = Infinity,
        north = -Infinity;
      for (let j = k; j < cum.length; j++) {
        west = Math.min(west, lon[j]);
        east = Math.max(east, lon[j]);
        south = Math.min(south, lat[j]);
        north = Math.max(north, lat[j]);
        if (cum[j] >= fracs[i + 1] * total) break;
      }
      if (
        east < zoneBox.west ||
        west > zoneBox.east ||
        north < zoneBox.south ||
        south > zoneBox.north
      )
        continue;
      ask.pid.push(r.id);
      ask.i.push(i);
      ask.a.push(fracs[i]);
      ask.b.push(fracs[i + 1]);
    }
  }
  const shutRows = ask.pid.length
    ? await tx`
        select u.pid, u.i from unnest(${ask.pid}::bigint[], ${ask.i}::int[], ${ask.a}::float8[], ${ask.b}::float8[]) as u(pid, i, a, b)
        join patterns p on p.id = u.pid join shapes sh on sh.id = p.shape_id
        where ST_Intersects(ST_LineSubstring(sh.geom, u.a, u.b), ST_GeomFromText(${zoneWkt}, 4326))`
    : [];
  const shutBy = new Map<number, number[]>();
  for (const s of shutRows) {
    const list = shutBy.get(Number(s.pid));
    if (list) list.push(Number(s.i));
    else shutBy.set(Number(s.pid), [Number(s.i)]);
  }

  const items: Item[] = [];
  let skipped = 0;
  let roadPatterns = 0;
  const found = new Map<string, { id: string; name: string; routes: Set<number> }>();
  for (const r of rows) {
    if (Number(r.inside) < minInside) continue; // crosses the closed line rather than running along it
    if (!found.has(r.mode_id))
      found.set(r.mode_id, { id: r.mode_id, name: r.mode_name, routes: new Set() });
    found.get(r.mode_id)!.routes.add(r.route_id);
    if (except.has(r.mode_id)) continue;
    const byRoad = ROAD_MODES.has(r.mode_id);
    const ids = r.stop_ids as number[];
    const fracs = placed.get(r.id) ?? [];
    const names = r.names as string[];
    const n = ids.length;
    if (fracs.length !== n) continue;
    // The path meets the closed area only before its first stop or after its last, where nothing runs.
    const shut = shutBy.get(r.id);
    if (!shut) continue;
    // A stop is closed if it lies along the closed stretch of the path or, for a road, inside the closed area itself.
    const within = (i: number) =>
      avoid!.line
        ? distanceToPathM(avoid!.line, Number(r.lons[i]), Number(r.lats[i])) <= (avoid!.widthM ?? 0)
        : distanceM(Number(r.lons[i]), Number(r.lats[i]), avoid!.lon, avoid!.lat) <= avoid!.radiusM;
    // The last stop before the first closed stretch of this path, and the first one after the last.
    let before = Math.min(...shut);
    let after = Math.max(...shut) + 1;
    if (avoid) {
      while (before >= 0 && within(before)) before--;
      while (after < n && within(after)) after++;
    }
    // For a drawn line, only stops on the line itself are closed: a line is split or sent round at each
    // place it crosses, and what lies between two crossings is not shut.
    const closed = ids.map(
      (_, i) => (!cut && i > before && i < after) || (avoid !== undefined && within(i)),
    );
    const choice = cut ? body.lines?.[String(r.route_id)] : undefined;
    const how: Item['how'] =
      choice?.how === 'leave'
        ? 'leave'
        : !byRoad
          ? 'split'
          : (choice?.how ?? (cut ? (body.roads ?? 'split') : 'detour')) === 'detour'
            ? 'detour'
            : 'split';
    const keep = cut ? String(choice?.keep ?? body.keep ?? 'both') : 'both';
    const item: Item = {
      patternId: r.id,
      routeId: r.route_id,
      name: r.name,
      color: r.color,
      modeId: r.mode_id,
      road: byRoad,
      how,
      keep,
      pieces: [],
      trips: r.trips,
      closedStops: [...new Set(names.filter((_, i) => closed[i]).map(tidy))],
      action: 'removed',
      plans: [],
      planSides: [],
    };
    if (how === 'leave') {
      item.action = 'left';
      item.closedStops = [];
      items.push(item);
      continue;
    }
    if (window) {
      // A trip is caught if it is between the last stop before the closure and the first one after it
      // at any moment the closure is in force. Where the closure is before the first stop or after the
      // last, the start or end of the trip stands in.
      const caught = await tx`
        select t.id from trips t
        cross join lateral (
          select array_agg(st.dep order by st.seq) as deps, array_agg(st.arr order by st.seq) as arrs
          from stop_times st where st.trip_id = t.id) c
        where t.pattern_id = ${r.id} and ${visible(tx, 't', sc)}
          and coalesce(c.deps[${before + 1}], t.start_secs) < ${window.toSecs}
          and coalesce(c.arrs[${after + 1}], t.end_secs) > ${window.fromSecs}
        order by t.start_secs, t.id`;
      if (!caught.length) continue;
      item.tripIds = caught.map((t) => t.id as number);
      item.trips = item.tripIds.length;
    }
    const head = ids.slice(0, before + 1);
    const tail = ids.slice(after);
    if (byRoad && how === 'detour') {
      const kept = ids.filter((_, i) => !closed[i]);
      if (kept.length >= 2) {
        item.action = !closed[0] && !closed[n - 1] ? 'detour' : 'shortened';
        if (roadPatterns++ >= MAX_PATTERNS) {
          skipped++;
          continue;
        }
        try {
          const plan = await planReshape(
            tx,
            sc,
            r.id,
            kept,
            { followRoads: true, direct: false, platformIndex: 0, avoid },
            deps,
          );
          if (item.tripIds) plan.tripIds = item.tripIds;
          // Nothing was changed and the path stays clear: it only brushes the edge of the area.
          // (Judged from the path itself. Until 20 Nov this was judged from three counters, which
          // could all be nought for a line that had in fact been given a new path.)
          if (
            plan.pathMethod === null &&
            plan.added === 0 &&
            plan.removed === 0 &&
            !entersAvoid(plan.coords, avoid!)
          )
            continue;
          // Checked on the whole new path, so that nothing is applied that still runs through the closure.
          if (plan.blocked || entersAvoid(plan.coords, avoid!)) {
            item.action = 'blocked';
            item.reason = 'no way round was found';
          } else item.plans = [plan];
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode !== 400) throw err;
          item.action = 'failed';
          item.reason = (err as Error).message;
        }
      }
    } else {
      if (!sides && sidesFrom && before >= 0 && after < n)
        sides = sidesFrom(
          Number(r.lons[before]),
          Number(r.lats[before]),
          Number(r.lons[after]),
          Number(r.lats[after]),
        );
      const sideOf = (i: number) => (sides ? sides.of(Number(r.lons[i]), Number(r.lats[i])) : '');
      const turn = (i: number) => ({
        name: tidy(names[i]),
        lon: Number(r.lons[i]),
        lat: Number(r.lats[i]),
      });
      const keeps = (side: string) => keep === 'both' || keep === side;
      const plain = { followRoads: false, direct: false, platformIndex: 0 };
      try {
        if (
          byRoad &&
          cut &&
          head.length >= 1 &&
          tail.length >= 1 &&
          sideOf(before) === sideOf(after)
        ) {
          // The line crosses the closure and comes back to the same side: what lies beyond is dropped,
          // and the two ends are joined into one trip that turns round before the closure.
          const side = sideOf(before);
          const joined = [...head, ...(tail[0] === head[head.length - 1] ? tail.slice(1) : tail)];
          item.pieces = [
            {
              side,
              stopIds: joined,
              turnsAt: turn(before),
              kept: keeps(side) && joined.length >= 2,
              ranges: [
                [fracs[0], fracs[before]],
                [fracs[after], fracs[n - 1]],
              ],
            },
          ];
          if (item.pieces[0].kept) {
            item.action = 'joined';
            if (roadPatterns++ >= MAX_PATTERNS) {
              skipped++;
              continue;
            }
            const plan = await planReshape(
              tx,
              sc,
              r.id,
              joined,
              { followRoads: true, direct: true, platformIndex: 0, avoid, joinAcross: true },
              deps,
            );
            if (item.tripIds) plan.tripIds = item.tripIds;
            if (plan.blocked || entersAvoid(plan.coords, avoid!)) {
              item.action = 'blocked';
              item.reason = 'no way was found to turn round before the closure';
            } else {
              item.plans = [plan];
              item.planSides = [side];
            }
          }
        } else {
          if (head.length >= 2)
            item.pieces.push({
              side: sideOf(before),
              stopIds: head,
              turnsAt: turn(before),
              kept: keeps(sideOf(before)),
              ranges: [[fracs[0], fracs[before]]],
            });
          if (tail.length >= 2)
            item.pieces.push({
              side: sideOf(after),
              stopIds: tail,
              turnsAt: turn(after),
              kept: keeps(sideOf(after)),
              ranges: [[fracs[after], fracs[n - 1]]],
            });
          const kept = item.pieces.filter((p) => p.kept);
          if (kept.length) {
            item.action = kept.length === 2 ? 'split' : 'shortened';
            if (detail === 'all') {
              for (const piece of kept) {
                const plan = await planReshape(tx, sc, r.id, piece.stopIds, plain, deps);
                if (item.tripIds) plan.tripIds = item.tripIds;
                // A part is made of stretches that stay clear of the closure. Checked all the same,
                // so that nothing is ever applied that still runs through it.
                if (avoid && entersAvoid(plan.coords, avoid))
                  throw fail(400, 'one of its parts would still run through the closure');
                item.plans.push(plan);
                item.planSides.push(piece.side);
              }
            }
          }
        }
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 400) throw err;
        item.action = 'failed';
        item.reason = (err as Error).message;
        item.plans = [];
        item.planSides = [];
      }
    }
    items.push(item);
  }
  if (except.size) {
    const left = [...found.values()]
      .filter((m) => except.has(m.id))
      .map((m) => m.name.toLowerCase());
    if (left.length)
      label += `, leaving ${left.length > 1 ? `${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}` : left[0]} running`;
  }
  const modesFound = [...found.values()].map((m) => ({
    id: m.id,
    name: m.name,
    lines: m.routes.size,
  }));
  return {
    what,
    label,
    zoneWkt,
    zone: JSON.parse(zone.json),
    window,
    items,
    skipped,
    modes: modesFound,
    sides: sides?.codes ?? (sidesFrom ? ['N', 'S'] : null),
    avoid,
  };
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Closes a road or a line and changes every trip that ran through it. */
export async function editClose(
  tx: Sql,
  sc: Scenario,
  seq: number,
  body: CloseBody,
  deps: ClosureDeps,
) {
  const plan = await planClosure(tx, sc, sc.baselineId, body, deps, 'all');
  if (
    !plan.items.some((i) => i.action !== 'blocked' && i.action !== 'failed' && i.action !== 'left')
  ) {
    throw fail(
      400,
      plan.items.length
        ? 'None of the lines through here could be changed'
        : 'Nothing runs through there, so there is nothing to change',
    );
  }
  const idMap: Record<number, number> = {};
  const replan: number[] = [];
  const changes: number[] = [];
  const tally = {
    detour: 0,
    shortened: 0,
    split: 0,
    joined: 0,
    removed: 0,
    blocked: 0,
    failed: 0,
    left: 0,
  } satisfies Record<Action, number>;
  const tripsBy = { ...tally };
  const lines = new Set<number>();
  const closedStops = new Set<string>();
  // The part of a line on one side of the closure is a line of its own, named after the original.
  const variants = new Map<string, { id: number; name: string }>();
  // For the vehicles: which side of the closure each part is on, and the trips the parts came from.
  const sideOfPart = new Map<number, string>();
  const splitFrom: number[] = [];
  const leftNames = { blocked: new Set<string>(), failed: new Set<string>() };
  const variantOf = async (routeId: number, side: string) => {
    const key = `${routeId}:${side}`;
    let made = variants.get(key);
    if (!made) {
      const [row] = await tx`
        insert into routes (baseline_id, gtfs_id, agency_gtfs_id, agency_name, short_name, long_name, description, route_type, mode_id,
                            color, text_color, vehicle_type_id, extra, scenario_id, created_edit)
        select baseline_id, gtfs_id || '~' || ${side} || '.' || ${sc.id}::int || '.' || ${seq}::int, agency_gtfs_id, agency_name,
               coalesce(short_name, long_name, 'Line') || '-' || ${side},
               coalesce(long_name, short_name, 'Line') || ${` (${SIDE_NAME[side] ?? side} of the closure)`},
               description, route_type, mode_id, color, text_color, vehicle_type_id,
               extra || jsonb_build_object('variantOf', id, 'side', ${side}::text), ${sc.id}, ${seq}
        from routes where id = ${routeId}
        returning id, short_name as name`;
      variants.set(key, (made = { id: row.id as number, name: row.name as string }));
    }
    return made;
  };
  let part = 0;
  for (const item of plan.items) {
    tally[item.action]++;
    tripsBy[item.action] += item.trips;
    if (item.action === 'blocked' || item.action === 'failed')
      leftNames[item.action].add(item.name);
    if (item.action === 'blocked' || item.action === 'failed' || item.action === 'left') continue;
    lines.add(item.routeId);
    for (const name of item.closedStops) closedStops.add(name);
    if (item.action === 'removed') {
      const ids =
        item.tripIds ??
        (
          await tx`select t.id from trips t where t.pattern_id = ${item.patternId} and ${visible(tx, 't', sc)}`
        ).map((t) => t.id as number);
      await deps.removeTrips(tx, sc, seq, ids);
    } else if (item.action === 'detour') {
      const done = await applyReshape(tx, sc, seq, item.plans[0], part++, deps);
      Object.assign(idMap, done.idMap);
      changes.push(done.changeSecs);
    } else if (item.action === 'joined') {
      // Still one trip from the same start to the same end, so it keeps its vehicle.
      const done = await applyReshape(tx, sc, seq, item.plans[0], part++, deps, {
        routeId: (await variantOf(item.routeId, item.planSides[0])).id,
      });
      Object.assign(idMap, done.idMap);
    } else if (item.plans.length === 1 && !plan.sides) {
      Object.assign(idMap, (await applyReshape(tx, sc, seq, item.plans[0], part++, deps)).idMap);
    } else {
      // Each trip becomes one trip for each part that is kept. No part can keep the vehicle, which
      // would have to cross the closure: they are given vehicles again below, which turn back at the closure.
      const parts: number[] = [];
      for (const [k, piecePlan] of item.plans.entries()) {
        const routeId = plan.sides
          ? (await variantOf(item.routeId, item.planSides[k])).id
          : undefined;
        const done = await applyReshape(tx, sc, seq, piecePlan, part++, deps, {
          keepVehicle: false,
          tag: 'ab'[k],
          routeId,
        });
        if (k === 0) Object.assign(idMap, done.idMap);
        parts.push(...Object.values(done.idMap));
        if (plan.sides)
          for (const id of Object.values(done.idMap)) sideOfPart.set(id, item.planSides[k]);
        if (k === 0) splitFrom.push(...piecePlan.tripIds);
      }
      // A trip that took its vehicle type from its vehicle keeps that type once it is taken off it.
      await tx`
        update trips n set vehicle_type_id = tv.vehicle_type_id
        from trip_vehicle tv
        where tv.trip_id = n.cloned_from and n.id = any(${parts}) and n.vehicle_type_id is null and not tv.assumed`;
      replan.push(...parts);
    }
  }
  // The parts are given vehicles. A vehicle stays on one side of the closure: it never takes a part
  // from the other side, nor one it could only reach by crossing. (Until 20 Nov the two halves of a
  // bus trip, a minute and a few hundred metres apart, were put back on one bus across the closure.)
  // The vehicles that ran the trips before may take the parts that are in the right place for them.
  const routeIds = [...lines, ...[...variants.values()].map((v) => v.id)];
  const figuresBefore = replan.length ? await deps.fleetFigures(tx, sc, routeIds) : null;
  const dayBefore = replan.length ? await deps.dayFigures(tx, sc.baselineId, sc) : null;
  const oldDays = splitFrom.length
    ? (
        await tx`select distinct vehicle_day_id as id from trips where id = any(${splitFrom}) and vehicle_day_id is not null`
      ).map((r) => r.id as number)
    : [];
  const zoneAvoid = plan.avoid;
  const fleet = replan.length
    ? await deps.assignVehicles(tx, sc, seq, replan, false, {
        groupOf: sideOfPart,
        crosses: zoneAvoid
          ? (ax, ay, bx, by) =>
              (ax !== bx || ay !== by) &&
              entersAvoid(
                [
                  [ax, ay],
                  [bx, by],
                ],
                zoneAvoid,
              )
          : undefined,
        alsoDays: oldDays,
      })
    : null;
  const figuresAfter = replan.length
    ? await deps.fleetFigures(tx, { ...sc, head: seq }, routeIds)
    : null;
  const dayAfter = replan.length
    ? await deps.dayFigures(tx, sc.baselineId, { ...sc, head: seq })
    : null;
  await tx`
    insert into scenario_closures (scenario_id, created_edit, kind, label, geom, from_secs, to_secs)
    values (${sc.id}, ${seq}, ${plan.what}, ${plan.label}, ST_Multi(ST_GeomFromText(${plan.zoneWkt}, 4326)),
            ${plan.window?.fromSecs ?? null}, ${plan.window?.toSecs ?? null})`;

  const parts: string[] = [];
  if (tally.detour)
    parts.push(
      `${count(tripsBy.detour, 'trip')} sent another way, ${describeChange(median(changes))}`,
    );
  if (tally.split)
    parts.push(`${count(tripsBy.split, 'trip')} now run in two parts, one either side`);
  if (tally.shortened) parts.push(`${count(tripsBy.shortened, 'trip')} cut short`);
  if (tally.joined) parts.push(`${count(tripsBy.joined, 'trip')} now turn round before it`);
  if (tally.removed) parts.push(`${count(tripsBy.removed, 'trip')} removed`);
  if (variants.size) {
    const made = [...variants.values()].map((v) => v.name);
    parts.push(
      `the parts run as ${made.slice(0, 6).join(', ')}${made.length > 6 ? ` and ${made.length - 6} more` : ''}`,
    );
  }
  if (closedStops.size) {
    const list = [...closedStops];
    parts.push(
      `${count(list.length, 'stop')} closed (${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''})`,
    );
  }
  if (fleet && figuresBefore && figuresAfter && dayBefore && dayAfter) {
    const more = dayAfter.vehicles - dayBefore.vehicles;
    parts.push(
      `their vehicles were worked out again and stay on their own side of the closure: ${count(fleet.added, 'new vehicle')}, ${count(fleet.reused, 'part')} on vehicles already running; ` +
        `the network now uses ${dayAfter.vehicles.toLocaleString('en-AU')} vehicles, ${more === 0 ? 'the same as before' : `${Math.abs(more)} ${more > 0 ? 'more' : 'fewer'} than before`} (an estimate: each is a chain of trips one vehicle could run), ` +
        `and the most trips these lines have running at once went from ${figuresBefore.peak} to ${figuresAfter.peak}`,
    );
  }
  const named = (names: Set<string>) => {
    const list = [...names];
    return `${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`;
  };
  if (tally.blocked)
    parts.push(
      `${count(tally.blocked, 'stop pattern')} (${count(tripsBy.blocked, 'trip')}) left running through it because no way round was found: ${named(leftNames.blocked)}`,
    );
  if (tally.failed)
    parts.push(
      `${count(tally.failed, 'stop pattern')} (${count(tripsBy.failed, 'trip')}) could not be changed and still run through it: ${named(leftNames.failed)}`,
    );
  if (plan.skipped)
    parts.push(
      `${count(plan.skipped, 'more stop pattern')} left as they are; close a smaller stretch to change them`,
    );
  return {
    summary: `${plan.label}: ${count(lines.size, 'line')} changed; ${parts.join('; ')}`,
    idMap,
  };
}

/** The preview, and the closures a scenario has made, for the map. */
export function closureRoutes(
  app: FastifyInstance,
  sql: Sql,
  ctx: {
    loadScenario: (sql: Sql, id: number) => Promise<Scenario>;
    idParam: (req: FastifyRequest) => number;
    deps: ClosureDeps;
  },
) {
  /** What a closure would do. Changes nothing. */
  app.post('/api/close-preview', async (req) => {
    const body = req.body as CloseBody;
    const sc = await scenarioOf(req, sql);
    const baselineId = sc ? sc.baselineId : Number(body.baselineId);
    if (!Number.isInteger(baselineId)) throw fail(400, 'Unknown day');
    const plan = await planClosure(sql, sc, baselineId, body, ctx.deps, 'roads');
    // One row per line, however many stop patterns it has.
    interface Line {
      routeId: number;
      name: string;
      color: string;
      modeId: string;
      road: boolean;
      how: Item['how'];
      keep: string;
      trips: number;
      patterns: number;
      actions: Set<Action>;
      /** The parts the line is split into: where each turns back, and whether it is kept. */
      parts: Map<
        string,
        { side: string; trips: number; kept: boolean; turns: Map<string, number> }
      >;
    }
    const byLine = new Map<number, Line>();
    for (const item of plan.items) {
      let line = byLine.get(item.routeId);
      if (!line) {
        line = {
          routeId: item.routeId,
          name: item.name,
          color: item.color,
          modeId: item.modeId,
          road: item.road,
          how: item.how,
          keep: item.keep,
          trips: 0,
          patterns: 0,
          actions: new Set(),
          parts: new Map(),
        };
        byLine.set(item.routeId, line);
      }
      line.trips += item.trips;
      line.patterns++;
      line.actions.add(item.action);
      for (const piece of item.pieces) {
        let part = line.parts.get(piece.side);
        if (!part)
          line.parts.set(
            piece.side,
            (part = { side: piece.side, trips: 0, kept: piece.kept, turns: new Map() }),
          );
        part.trips += item.trips;
        part.turns.set(piece.turnsAt.name, (part.turns.get(piece.turnsAt.name) ?? 0) + item.trips);
      }
    }
    const tripsWith = (...actions: Action[]) =>
      plan.items.filter((i) => actions.includes(i.action)).reduce((sum, i) => sum + i.trips, 0);
    const detours = plan.items.filter((i) => i.action === 'detour' && i.plans.length);

    // For the map: the stretch of each published path that every part keeps or loses, and where it turns back.
    const drawn = plan.items.filter((i) => i.pieces.length).slice(0, 400);
    const want = drawn.flatMap((item) =>
      item.pieces.flatMap((piece) =>
        piece.ranges
          .filter(([a, b]) => b > a)
          .map(([a, b]) => ({
            id: item.patternId,
            a,
            b,
            side: piece.side,
            kept: piece.kept,
            routeId: item.routeId,
          })),
      ),
    );
    const stretches = want.length
      ? await sql`
          select u.n::int as n, ST_AsGeoJSON(ST_Simplify(ST_LineSubstring(sh.geom, u.a, u.b), 0.00003), 6) as g
          from unnest(${want.map((w) => w.id)}::bigint[], ${want.map((w) => w.a)}::float8[], ${want.map((w) => w.b)}::float8[]) with ordinality as u(pid, a, b, n)
          join patterns p on p.id = u.pid join shapes sh on sh.id = p.shape_id`
      : [];
    // Many stop patterns, and many lines, share a path: each stretch is sent once, with the lines that use it.
    const seen = new Map<
      string,
      { side: string; kept: boolean; coords: [number, number][]; routeIds: number[] }
    >();
    for (const row of stretches) {
      const w = want[row.n - 1];
      const key = `${w.side}${w.kept}${row.g}`;
      let part = seen.get(key);
      if (!part) {
        const geometry = JSON.parse(row.g) as { type: string; coordinates: [number, number][] };
        if (geometry.type !== 'LineString') continue;
        seen.set(
          key,
          (part = { side: w.side, kept: w.kept, coords: geometry.coordinates, routeIds: [] }),
        );
      }
      if (!part.routeIds.includes(w.routeId)) part.routeIds.push(w.routeId);
    }
    const parts = [...seen.values()];
    const turns = new Map<
      string,
      { name: string; lon: number; lat: number; side: string; kept: boolean }
    >();
    for (const item of drawn) {
      for (const piece of item.pieces) {
        const key = `${piece.turnsAt.name}${piece.side}`;
        const known = turns.get(key);
        if (!known) turns.set(key, { ...piece.turnsAt, side: piece.side, kept: piece.kept });
        else if (piece.kept) known.kept = true;
      }
    }
    return {
      label: plan.label,
      zone: plan.zone,
      window: plan.window,
      modes: plan.modes,
      sides: plan.sides ? plan.sides.map((code) => ({ code, name: SIDE_NAME[code] })) : null,
      lines: [...byLine.values()]
        .map((l) => ({
          ...l,
          actions: [...l.actions],
          parts: [...l.parts.values()].map((p) => ({
            side: p.side,
            trips: p.trips,
            kept: p.kept,
            turnsAt: [...p.turns.entries()].sort((a, b) => b[1] - a[1])[0][0],
            turnPlaces: p.turns.size,
          })),
        }))
        .sort((a, b) => b.trips - a.trips),
      trips: {
        detour: tripsWith('detour'),
        split: tripsWith('split'),
        shortened: tripsWith('shortened'),
        joined: tripsWith('joined'),
        removed: tripsWith('removed'),
        blocked: tripsWith('blocked', 'failed'),
        left: tripsWith('left'),
      },
      closedStops: [
        ...new Set(
          plan.items
            .filter((i) => i.action !== 'blocked' && i.action !== 'failed')
            .flatMap((i) => i.closedStops),
        ),
      ],
      skipped: plan.skipped,
      // The new paths, for the map. A handful is enough to show where the traffic goes.
      paths: detours.slice(0, 25).map((i) => i.plans[0].coords),
      parts,
      turns: [...turns.values()],
    };
  });

  /** Closures this scenario has made, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/closures', async (req) => {
    const sc = await ctx.loadScenario(sql, ctx.idParam(req));
    const rows = await sql`
      select c.id, c.kind, c.label, c.from_secs, c.to_secs, ST_AsGeoJSON(c.geom) as geometry from scenario_closures c
      where c.scenario_id = ${sc.id} and c.created_edit <= ${sc.head}`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geometry),
        properties: {
          id: r.id,
          kind: r.kind,
          label: r.label,
          fromSecs: r.from_secs,
          toSecs: r.to_secs,
        },
      })),
    };
  });
}
