// Which timetable the router plans on, the water lines it is given, and having it load them.
// Moved out of sim.ts unchanged (AA-13).
import { createHash } from 'node:crypto';
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Scenario } from '../scenarios/engine.ts';
import { fail } from '../http.ts';
import { router } from './router-client.ts';

/** Where the router can reach this API, to fetch an export. */
export const SELF = (
  process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
).replace(/\/+$/, '');

export interface Box {
  name: string | null;
  south: number;
  west: number;
  north: number;
  east: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Which timetable, and which version of it
// ---------------------------------------------------------------------------
export interface TimetableKey {
  /** The router's id for the timetable: the day, the scenario, and the box it is cut to. */
  id: string;
  /** What decides the plans: the published day as imported, and the scenario as edited. */
  planVersion: string;
  /** The plan version and the vehicle capacities, which decide the capacity results as well. */
  version: string;
  /** Where the router fetches it from. */
  exportUrl: string;
  /** Where the router fetches the day's water lines from (see waterFile). */
  waterUrl: string;
}

/**
 * The rules the router plans by, as far as they decide a plan beyond the timetable itself. Raise
 * this when they change, so that runs planned under the old rules show as out of date and are not
 * compared with runs planned under the new ones.
 *   2: a change on foot takes at least the time to change; no walks over water; platforms take
 *      their pathway time to the street.
 */
export const ROUTER_RULES = 2;

export const boxText = (box: Box) => [box.south, box.west, box.north, box.east].join(',');

/**
 * The key of a timetable as it stands now. A scenario's `head` alone is reused after an undo, so the
 * time of the edit numbered `head` is part of the key (section 6.2 of the plan).
 */
export async function timetableKey(
  sql: Sql,
  baselineId: number,
  sc: Scenario | null,
  box: Box | null,
): Promise<TimetableKey> {
  const [baseline] = await sql`
    select feed_id, extract(epoch from imported_at)::bigint as imported from baselines where id = ${baselineId} and ready`;
  if (!baseline) throw fail(404, 'Day not found');
  let planVersion = `${baseline.feed_id}@${baseline.imported}/r${ROUTER_RULES}`;
  if (sc) {
    const [edit] = await sql`
      select extract(epoch from created_at)::bigint as at from scenario_edits where scenario_id = ${sc.id} and seq = ${sc.head}`;
    planVersion += `/s${sc.id}-h${sc.head}-${edit?.at ?? 0}`;
  }
  const [fleet] = await sql`
    select md5(coalesce((select string_agg(id || ':' || seated || ':' || standing, ',' order by id) from vehicle_types), '')
      || '/' || coalesce((select string_agg(mode_id || ':' || vehicle_type_id, ',' order by mode_id) from mode_default_vehicle), '')) as hash`;
  const area = box ? `-a${createHash('md5').update(boxText(box)).digest('hex').slice(0, 8)}` : '';
  const params = new URLSearchParams({ shapes: '0' });
  if (sc) params.set('s', String(sc.id));
  if (box) params.set('box', boxText(box));
  return {
    id: `b${baselineId}${sc ? `-s${sc.id}` : ''}${area}`,
    planVersion,
    version: `${planVersion}|fleet-${String(fleet.hash).slice(0, 12)}`,
    exportUrl: `${SELF}/api/baselines/${baselineId}/export?${params}`,
    waterUrl: `${SELF}/api/sim/water?baseline=${baselineId}`,
  };
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
/**
 * Foot bridges that a ferry sails under and no bus or light rail line crosses, so that the rule
 * below cannot find them. Each is used only where a ferry path of the day passes within 100 m.
 * The position of this one is the railway bridge beside it, taken from the feed's own train path.
 */
export const FOOT_BRIDGES = [
  { name: 'John Whitton Bridge, Meadowbank to Rhodes', lat: -33.8215, lon: 151.0889 },
];

/** Metres of ferry path left out round each wharf, and round each bridge. */
export const WHARF_GAP = 100;
export const BRIDGE_GAP = 150;

const waterFiles = new Map<number, Promise<string>>();

/**
 * Where a straight walk would cross water on a published day, as the CSV the router reads
 * (kind, lat1, lon1, lat2, lon2). The editor has no map of the water, so this is worked out from
 * the day's own paths:
 *
 *   water   the paths its ferries sail, less 100 m round every wharf (a walk to a wharf must not be
 *           refused for reaching the ferry's path) and 150 m round every bridge;
 *   bridge  each place where the path of a bus or light rail line crosses a ferry path, taken to
 *           be a bridge that can be walked, and the foot bridges listed above.
 *
 * Coaches and school buses are left out of the rule because coaches use the harbour tunnel, and
 * trains because a railway bridge or tunnel cannot be walked. Water that no ferry sails is not
 * known about. A scenario does not change the answer: taking a ferry away does not drain the bay.
 */
export function waterFile(sql: Sql, baselineId: number): Promise<string> {
  let known = waterFiles.get(baselineId);
  if (!known) {
    known = (async () => {
      const [place] = await sql`
        select ST_X(ST_Centroid(ST_Extent(s.geom))) as lon, ST_Y(ST_Centroid(ST_Extent(s.geom))) as lat
        from shapes s join patterns p on p.shape_id = s.id join routes r on r.id = p.route_id
        where r.mode_id = 'ferry' and s.baseline_id = ${baselineId} and s.scenario_id is null and p.scenario_id is null`;
      const lines = ['kind,lat1,lon1,lat2,lon2'];
      if (!place || place.lon === null) return lines.join('\n') + '\n';
      // Metres, in the UTM zone the ferries are in.
      const srid = (place.lat < 0 ? 32700 : 32600) + Math.floor((place.lon + 180) / 6) + 1;
      const rows = await sql`
        with ferry as (
          select distinct on (s.id) s.geom, ST_Transform(s.geom, ${srid}::int) as g
          from shapes s join patterns p on p.shape_id = s.id join routes r on r.id = p.route_id
          where r.mode_id = 'ferry' and s.baseline_id = ${baselineId} and s.scenario_id is null and p.scenario_id is null),
        wharf as (
          select distinct st.id, ST_Transform(st.geom, ${srid}::int) as g
          from patterns p join routes r on r.id = p.route_id, unnest(p.stop_ids) as sid join stops st on st.id = sid
          where r.mode_id = 'ferry' and p.baseline_id = ${baselineId} and p.scenario_id is null),
        road as (
          select distinct on (s.id) ST_Transform(s.geom, ${srid}::int) as g
          from shapes s join patterns p on p.shape_id = s.id join routes r on r.id = p.route_id
          where r.mode_id in ('bus', 'light_rail') and s.baseline_id = ${baselineId} and s.scenario_id is null
            and p.scenario_id is null and s.geom && (select ST_Extent(geom) from ferry)),
        met as (
          select (ST_Dump(ST_Intersection(f.g, b.g))).geom as pt from ferry f join road b on ST_Intersects(f.g, b.g)),
        bridge as (
          select ST_Centroid(ST_Collect(pt)) as g
          from (select pt, ST_ClusterDBSCAN(pt, 60, 1) over () as c from met where GeometryType(pt) = 'POINT') x group by c
          union all
          select e.g from (
            select ST_Transform(ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326), ${srid}::int) as g
            from jsonb_to_recordset(${sql.json(FOOT_BRIDGES)}) as x(lat float8, lon float8)) e
          where exists (select 1 from ferry f where ST_DWithin(f.g, e.g, 100))),
        gaps as (
          select ST_Union(g) as g from (
            select ST_Buffer(g, ${WHARF_GAP}) as g from wharf union all select ST_Buffer(g, ${BRIDGE_GAP}) from bridge) x),
        water as (
          select (ST_Dump(ST_Simplify(ST_Difference((select ST_Union(g) from ferry), (select g from gaps)), 3))).geom as g),
        piece as (
          select (ST_DumpSegments(g)).geom as g from water)
        select 'water' as kind, ST_Y(a) as lat1, ST_X(a) as lon1, ST_Y(b) as lat2, ST_X(b) as lon2
        from (select ST_Transform(ST_StartPoint(g), 4326) as a, ST_Transform(ST_EndPoint(g), 4326) as b from piece) x
        union all
        select 'bridge', ST_Y(p), ST_X(p), null, null from (select ST_Transform(g, 4326) as p from bridge) x`;
      for (const row of rows) {
        lines.push(
          row.kind === 'water'
            ? `water,${row.lat1.toFixed(6)},${row.lon1.toFixed(6)},${row.lat2.toFixed(6)},${row.lon2.toFixed(6)}`
            : `bridge,${row.lat1.toFixed(6)},${row.lon1.toFixed(6)},,`,
        );
      }
      return lines.join('\n') + '\n';
    })();
    waterFiles.set(baselineId, known);
    known.catch(() => waterFiles.delete(baselineId));
  }
  return known;
}

/** Has the router load this version of the timetable unless it already holds it. Can take minutes. */
export async function ensureTimetable(
  key: TimetableKey,
  onWait: (secs: number) => Promise<void>,
): Promise<void> {
  const current = await router('GET', `/v1/timetables/${key.id}`);
  if (
    current.status === 200 &&
    current.body.status === 'ready' &&
    current.body.version === key.version &&
    !current.body.building
  ) {
    return;
  }
  if (!(current.status === 200 && current.body.building?.version === key.version)) {
    const asked = await router('PUT', `/v1/timetables/${key.id}`, {
      source: { url: key.exportUrl },
      water: { url: key.waterUrl },
      version: key.version,
    });
    if (asked.status !== 202 && asked.status !== 409) {
      throw new Error(
        `The router would not load the timetable: ${asked.body?.error ?? asked.status}`,
      );
    }
  }
  const started = Date.now();
  for (;;) {
    await sleep(1000);
    const now = await router('GET', `/v1/timetables/${key.id}`);
    if (now.status === 200 && !now.body.building) {
      if (now.body.status === 'ready' && now.body.version === key.version) return;
      if (now.body.lastFailure)
        throw new Error(`The router could not load the timetable: ${now.body.lastFailure.message}`);
      // Another version was loaded meanwhile (the scenario was edited); ask again for ours.
      return ensureTimetable(key, onWait);
    }
    if (now.status === 404)
      throw new Error('The router dropped the timetable while loading it; try again');
    await onWait(Math.round((Date.now() - started) / 1000));
    if (Date.now() - started > 30 * 60_000)
      throw new Error('The router took more than half an hour to load the timetable');
  }
}
