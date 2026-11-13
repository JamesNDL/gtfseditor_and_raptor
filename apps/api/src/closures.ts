// Closures: a stretch of road, or a line between two stations, that nothing can run through.
//
// A closure is an area on the map. Every stop pattern whose path enters it is changed, using the
// same machinery as "Change route":
// - Road vehicles are sent another way between the last stop before the closure and the first stop
//   after it, and no longer call at the stops inside it.
// - Trains, trams and ferries cannot go round, so each trip is cut in two: one part that ends at the
//   last station before the closure, and one that starts from the first station after it.
import { distanceM, distanceToPathM, pathDistances, slicePath, type Coord } from '@gtfs-editor/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { applyReshape, describeChange, planReshape, type ReshapeDeps, type ReshapePlan } from './reshape.ts';
import { ROAD_MODES, type Avoid } from './roads.ts';
import { scenarioOf, visible, type Scenario } from './scenarios.ts';
import { trackPath } from './tracks.ts';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export interface ClosureDeps extends ReshapeDeps {
  assignVehicles: (tx: Sql, sc: Scenario, seq: number, tripIds: number[], forceNew?: boolean) => Promise<{ reused: number; added: number }>;
  removeTrips: (tx: Sql, sc: Scenario, seq: number, tripIds: number[]) => Promise<void>;
}

export interface CloseBody {
  /** 'road', or the mode whose line is closed: train, metro, light_rail or ferry. */
  what: string;
  baselineId?: number;
  /** Road: the middle of the closed stretch and how far it reaches. */
  lon?: number;
  lat?: number;
  radiusM?: number;
  /** Line: the two stations the closure lies between. */
  fromStopId?: number;
  toStopId?: number;
}

const TRACK_MODES = new Set(['train', 'metro', 'light_rail', 'ferry']);
// How far either side of the closed line another service's path can be and still count as using it.
// Ferry paths are drawn loosely, so they get more room.
const CORRIDOR_M: Record<string, number> = { train: 40, metro: 40, light_rail: 30, ferry: 150 };
// Road closures change at most this many stop patterns in one go; a bigger closure is better made in parts.
const MAX_PATTERNS = 80;

type Action = 'detour' | 'shortened' | 'split' | 'removed' | 'blocked' | 'failed';

interface Item {
  patternId: number;
  routeId: number;
  name: string;
  color: string;
  trips: number;
  closedStops: string[];
  action: Action;
  /** Why a pattern could not be changed. */
  reason?: string;
  /** One plan for a detour or a line cut short; two when trips are split either side of the closure. */
  plans: ReshapePlan[];
}

interface ClosurePlan {
  what: string;
  label: string;
  zoneWkt: string;
  zone: unknown;
  items: Item[];
  /** Stop patterns over the limit, left as they are. */
  skipped: number;
}

const tidy = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Works out everything a closure would do, without changing anything. `full` also plans each new path. */
export async function planClosure(tx: Sql, sc: Scenario | null, baselineId: number, body: CloseBody, deps: ClosureDeps, full: boolean): Promise<ClosurePlan> {
  const what = String(body.what);
  const road = what === 'road';
  if (!road && !TRACK_MODES.has(what)) throw fail(400, 'Choose what is closed');

  let zoneSql;
  let label: string;
  let avoid: Avoid | undefined;
  let modes: string[];
  let minInside = 0;
  if (road) {
    const lon = Number(body.lon);
    const lat = Number(body.lat);
    const radiusM = Math.round(Number(body.radiusM ?? 100));
    if (!(lon > 140 && lon < 160 && lat > -38 && lat < -28)) throw fail(400, 'Click the map where the road is closed');
    if (!(radiusM >= 20 && radiusM <= 500)) throw fail(400, 'The closed stretch must be between 20 and 500 metres across');
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
    if (section.found === 0) throw fail(400, `No ${String(mode.name).toLowerCase()} service runs between ${tidy(from.name)} and ${tidy(to.name)}, so there is nothing to close`);
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
  const [zone] = await tx`select ST_AsText(z.g) as wkt, ST_AsGeoJSON(z.g) as json from (select ${zoneSql} as g) z`;
  const zoneWkt: string = zone.wkt;

  const ownPatterns = sc ? tx`(p.scenario_id = ${sc.id} and p.created_edit <= ${sc.head})` : tx`false`;
  const rows = await tx`
    with zone as (select ST_GeomFromText(${zoneWkt}, 4326) as g),
    cand as materialized (
      select p.id, p.route_id, p.stop_ids, sh.geom, zone.g,
             coalesce(r.short_name, r.long_name, 'Line') as name, coalesce(r.color, m.color) as color
      from patterns p
      join routes r on r.id = p.route_id
      join modes m on m.id = r.mode_id
      join shapes sh on sh.id = p.shape_id
      cross join zone
      where p.baseline_id = ${baselineId} and (p.scenario_id is null or ${ownPatterns})
        and r.mode_id = any(${modes}) and ST_Intersects(sh.geom, zone.g))
    select c.id, c.route_id, c.stop_ids, c.name, c.color, x.trips, span.f0, span.f1, span.inside,
           array(select ST_LineLocatePoint(c.geom, s.geom) from unnest(c.stop_ids) with ordinality as o(id, n) join stops s on s.id = o.id order by o.n) as fracs,
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

  const items: Item[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (Number(r.inside) < minInside) continue; // crosses the closed line rather than running along it
    const ids = r.stop_ids as number[];
    const fracs = (r.fracs as number[]).map(Number);
    const names = r.names as string[];
    const n = ids.length;
    if (fracs.length !== n) continue;
    // The last stop before the closed stretch of this path, and the first one after it.
    let before = -1;
    for (let i = 0; i < n; i++) if (fracs[i] < r.f0) before = i;
    let after = n;
    for (let i = n - 1; i > before; i--) if (fracs[i] > r.f1) after = i;
    // A stop is closed if it lies along the closed stretch of the path or, for a road, inside the closed area itself.
    const closed = ids.map((_, i) => (i > before && i < after) || (avoid !== undefined && distanceM(Number(r.lons[i]), Number(r.lats[i]), avoid.lon, avoid.lat) <= avoid.radiusM));
    const item: Item = {
      patternId: r.id,
      routeId: r.route_id,
      name: r.name,
      color: r.color,
      trips: r.trips,
      closedStops: [...new Set(names.filter((_, i) => closed[i]).map(tidy))],
      action: 'removed',
      plans: [],
    };
    const head = ids.slice(0, before + 1);
    const tail = ids.slice(after);
    if (road) {
      const kept = ids.filter((_, i) => !closed[i]);
      if (kept.length >= 2) {
        item.action = !closed[0] && !closed[n - 1] ? 'detour' : 'shortened';
        if (items.filter((i) => i.action !== 'removed').length >= MAX_PATTERNS) {
          skipped++;
          continue;
        }
        if (full) {
          try {
            const plan = await planReshape(tx, sc, r.id, kept, { followRoads: true, direct: false, platformIndex: 0, avoid }, deps);
            // The path enters the area only before its first stop or after its last: nothing to change.
            if (plan.rerouted === 0 && plan.added === 0 && plan.removed === 0) continue;
            // Checked on the whole new path, so that nothing is applied that still runs through the closure.
            if (plan.blocked || distanceToPathM(plan.coords, avoid!.lon, avoid!.lat) <= avoid!.radiusM) {
              item.action = 'blocked';
              item.reason = 'no way round was found';
            } else item.plans = [plan];
          } catch (err) {
            if ((err as { statusCode?: number }).statusCode !== 400) throw err;
            item.action = 'failed';
            item.reason = (err as Error).message;
          }
        }
      }
    } else {
      if (head.length === n || tail.length === n) continue; // the closed stretch is beyond the end of this line
      const pieces = [head, tail].filter((p) => p.length >= 2);
      if (pieces.length) {
        item.action = pieces.length === 2 ? 'split' : 'shortened';
        if (full) {
          try {
            for (const piece of pieces) {
              item.plans.push(await planReshape(tx, sc, r.id, piece, { followRoads: false, direct: false, platformIndex: 0 }, deps));
            }
          } catch (err) {
            if ((err as { statusCode?: number }).statusCode !== 400) throw err;
            item.action = 'failed';
            item.reason = (err as Error).message;
            item.plans = [];
          }
        }
      }
    }
    items.push(item);
  }
  return { what, label, zoneWkt, zone: JSON.parse(zone.json), items, skipped };
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Closes a road or a line and changes every trip that ran through it. */
export async function editClose(tx: Sql, sc: Scenario, seq: number, body: CloseBody, deps: ClosureDeps) {
  const plan = await planClosure(tx, sc, sc.baselineId, body, deps, true);
  if (!plan.items.some((i) => i.action !== 'blocked' && i.action !== 'failed')) {
    throw fail(400, plan.items.length ? 'None of the lines through here could be changed' : 'Nothing runs through there, so there is nothing to change');
  }
  const idMap: Record<number, number> = {};
  const replan: number[] = [];
  const changes: number[] = [];
  const tally = { detour: 0, shortened: 0, split: 0, removed: 0, blocked: 0, failed: 0 } satisfies Record<Action, number>;
  const tripsBy = { ...tally };
  const lines = new Set<number>();
  const closedStops = new Set<string>();
  let part = 0;
  for (const item of plan.items) {
    tally[item.action]++;
    tripsBy[item.action] += item.trips;
    if (item.action === 'blocked' || item.action === 'failed') continue;
    lines.add(item.routeId);
    for (const name of item.closedStops) closedStops.add(name);
    if (item.action === 'removed') {
      const trips = await tx`select t.id from trips t where t.pattern_id = ${item.patternId} and ${visible(tx, 't', sc)}`;
      await deps.removeTrips(tx, sc, seq, trips.map((t) => t.id));
    } else if (item.plans.length === 1) {
      const done = await applyReshape(tx, sc, seq, item.plans[0], part++, deps);
      Object.assign(idMap, done.idMap);
      if (item.action === 'detour') changes.push(done.changeSecs);
    } else {
      // Each trip becomes two. Neither part can keep the vehicle, which would have to cross the closure.
      const first = await applyReshape(tx, sc, seq, item.plans[0], part++, deps, { keepVehicle: false, tag: 'a' });
      const second = await applyReshape(tx, sc, seq, item.plans[1], part++, deps, { keepVehicle: false, tag: 'b' });
      Object.assign(idMap, first.idMap);
      const parts = [...Object.values(first.idMap), ...Object.values(second.idMap)];
      // A trip that took its vehicle type from its vehicle keeps that type once it is taken off it.
      await tx`
        update trips n set vehicle_type_id = tv.vehicle_type_id
        from trip_vehicle tv
        where tv.trip_id = n.cloned_from and n.id = any(${parts}) and n.vehicle_type_id is null and not tv.assumed`;
      replan.push(...parts);
    }
  }
  const fleet = replan.length ? await deps.assignVehicles(tx, sc, seq, replan) : null;
  await tx`
    insert into scenario_closures (scenario_id, created_edit, kind, label, geom)
    values (${sc.id}, ${seq}, ${plan.what}, ${plan.label}, ST_Multi(ST_GeomFromText(${plan.zoneWkt}, 4326)))`;

  const parts: string[] = [];
  if (tally.detour) parts.push(`${count(tripsBy.detour, 'trip')} sent another way, ${describeChange(median(changes))}`);
  if (tally.split) parts.push(`${count(tripsBy.split, 'trip')} now run in two parts, one either side`);
  if (tally.shortened) parts.push(`${count(tripsBy.shortened, 'trip')} cut short`);
  if (tally.removed) parts.push(`${count(tripsBy.removed, 'trip')} removed, with fewer than two stops left on either side`);
  if (closedStops.size) {
    const list = [...closedStops];
    parts.push(`${count(list.length, 'stop')} closed (${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''})`);
  }
  if (fleet) parts.push(`the split trips were given vehicles again, which took ${count(fleet.added, 'more vehicle')}`);
  if (tally.blocked) parts.push(`${count(tally.blocked, 'stop pattern')} left running through it because no way round was found`);
  if (tally.failed) parts.push(`${count(tally.failed, 'stop pattern')} could not be changed`);
  if (plan.skipped) parts.push(`${count(plan.skipped, 'more stop pattern')} left as they are; close a smaller stretch to change them`);
  return {
    summary: `${plan.label}: ${count(lines.size, 'line')} changed; ${parts.join('; ')}`,
    idMap,
  };
}

/** The preview, and the closures a scenario has made, for the map. */
export function closureRoutes(
  app: FastifyInstance,
  sql: Sql,
  ctx: { loadScenario: (id: number) => Promise<Scenario>; idParam: (req: FastifyRequest) => number; deps: ClosureDeps },
) {
  /** What a closure would do. Changes nothing. */
  app.post('/api/close-preview', async (req) => {
    const body = req.body as CloseBody;
    const sc = await scenarioOf(req, sql);
    const baselineId = sc ? sc.baselineId : Number(body.baselineId);
    if (!Number.isInteger(baselineId)) throw fail(400, 'Unknown day');
    const plan = await planClosure(sql, sc, baselineId, body, ctx.deps, body.what === 'road');
    // One row per line, however many stop patterns it has.
    const byLine = new Map<number, { routeId: number; name: string; color: string; trips: number; patterns: number; actions: Set<Action> }>();
    for (const item of plan.items) {
      let line = byLine.get(item.routeId);
      if (!line) byLine.set(item.routeId, (line = { routeId: item.routeId, name: item.name, color: item.color, trips: 0, patterns: 0, actions: new Set() }));
      line.trips += item.trips;
      line.patterns++;
      line.actions.add(item.action);
    }
    const tripsWith = (...actions: Action[]) => plan.items.filter((i) => actions.includes(i.action)).reduce((sum, i) => sum + i.trips, 0);
    const detours = plan.items.filter((i) => i.action === 'detour' && i.plans.length);
    return {
      label: plan.label,
      zone: plan.zone,
      lines: [...byLine.values()].map((l) => ({ ...l, actions: [...l.actions] })).sort((a, b) => b.trips - a.trips),
      trips: {
        detour: tripsWith('detour'),
        split: tripsWith('split'),
        shortened: tripsWith('shortened'),
        removed: tripsWith('removed'),
        blocked: tripsWith('blocked', 'failed'),
      },
      closedStops: [...new Set(plan.items.filter((i) => i.action !== 'blocked' && i.action !== 'failed').flatMap((i) => i.closedStops))],
      skipped: plan.skipped,
      // The new paths, for the map. A handful is enough to show where the traffic goes.
      paths: detours.slice(0, 25).map((i) => i.plans[0].coords),
    };
  });

  /** Closures this scenario has made, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/closures', async (req) => {
    const sc = await ctx.loadScenario(ctx.idParam(req));
    const rows = await sql`
      select c.id, c.kind, c.label, ST_AsGeoJSON(c.geom) as geometry from scenario_closures c
      where c.scenario_id = ${sc.id} and c.created_edit <= ${sc.head}`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({ type: 'Feature', geometry: JSON.parse(r.geometry), properties: { id: r.id, kind: r.kind, label: r.label } })),
    };
  });
}
