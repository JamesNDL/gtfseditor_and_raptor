// The passenger simulator, as the editor sees it (docs/simulator-plan.md, section 6 and phase S3).
//
// The simulator itself runs in the journey router service. This file keeps what the editor needs
// around it: demand sets, saved areas, the library of runs and its folders. For each run it gets
// the right timetable into the router, starts the job there, follows it, and copies the results
// into PostgreSQL so that the editor can query them like everything else.
//
// The browser talks only to this API; this API talks to the router.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { visible, type Scenario } from '../scenarios/scenarios.ts';
import { buildLinkLoads } from './results-read.ts';
import { fail } from '../http.ts';

/** The journey router service. ROUTER_URL is already the road-routing server and keeps that meaning. */
const ROUTER = (process.env.ROUTER_SERVICE_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
/** Where the router can reach this API, to fetch an export. */
const SELF = (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(
  /\/+$/,
  '',
);
/** Demand files, outside git. */
const DEMAND_DIR =
  process.env.SIM_DEMAND_DIR ?? path.resolve(import.meta.dirname, '../../../../data/sim/demand');
/** Whether the router reads files where this API wrote them. Set to 0 when it runs on another machine. */
const SHARED_FILES = process.env.ROUTER_SHARES_FILES !== '0';

/** A run's state, as migrations/0001_initial.sql lists them for sim_runs.state. */
type RunState = 'queued' | 'preparing' | 'running' | 'importing' | 'done' | 'failed' | 'stopped';

const ACTIVE: readonly RunState[] = ['queued', 'preparing', 'running', 'importing'];
const RESULT_TABLES = ['sim_journeys', 'sim_legs', 'sim_trip_loads', 'sim_stop_activity'] as const;
type ResultTable = (typeof RESULT_TABLES)[number];

/** The settings each kind of run chooses for itself; the router checks their values. */
const BAU_SETTINGS = [
  'walkMetres',
  'changePenaltySecs',
  'shareOneIn',
  'schoolBuses',
  'maxWaitSecs',
  'capacity',
  'fullAt',
  'maxLeftBehind',
];
const SCENARIO_SETTINGS = [
  'switchThresholdSecs',
  'giveUpSecs',
  'capacity',
  'fullAt',
  'maxLeftBehind',
];
const CAPACITY_SETTINGS = ['fullAt', 'maxLeftBehind'];

interface Box {
  name: string | null;
  south: number;
  west: number;
  north: number;
  east: number;
}

const int = (value: unknown, label: string): number => {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isInteger(n) || n < 0) {
    throw fail(400, `${label} must be a whole number`);
  }
  return n;
};
const optionalInt = (value: unknown, label: string) =>
  value === null || value === undefined || value === '' ? null : int(value, label);
const name = (value: unknown, otherwise: string) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : otherwise;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One CSV line as its fields. Quotes are honoured; a quoted field does not run over a line end here. */
function csvFields(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') field += line[i++];
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * How many journey ends of a demand file carry a position of their own (origin_lat and so on)
 * that lies inside a box. Such ends are not in the set's stop counts, whatever stop id they also
 * name, so the file is the only place to count them. Made-up sets are all of this kind. The file
 * is read through once per box and the answer kept.
 */
const endsInBox = new Map<string, Promise<number>>();
function positionedEndsInside(file: string, box: Box): Promise<number> {
  const key = `${file}:${box.south},${box.west},${box.north},${box.east}`;
  let known = endsInBox.get(key);
  if (!known) {
    known = (async () => {
      const raw = createReadStream(path.join(DEMAND_DIR, file));
      const lines = createInterface({
        input: file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw,
        crlfDelay: Infinity,
      });
      let at: number[][] | null = null;
      let inside = 0;
      for await (const line of lines) {
        if (!at) {
          const names = csvFields(line.replace(/^﻿/, '')).map((n) => n.trim().toLowerCase());
          at = [
            ['origin_lat', 'origin_lon'],
            ['destination_lat', 'destination_lon'],
          ]
            .map((pair) => pair.map((n) => names.indexOf(n)))
            .filter((pair) => pair.every((i) => i >= 0));
          if (!at.length) break;
          continue;
        }
        const fields = csvFields(line);
        for (const [latAt, lonAt] of at) {
          const latText = fields[latAt]?.trim();
          const lonText = fields[lonAt]?.trim();
          if (!latText || !lonText) continue;
          const lat = Number(latText);
          const lon = Number(lonText);
          if (lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east) inside++;
        }
      }
      return inside;
    })();
    endsInBox.set(key, known);
    known.catch(() => endsInBox.delete(key));
    if (endsInBox.size > 200) endsInBox.delete(endsInBox.keys().next().value!);
  }
  return known;
}

// ---------------------------------------------------------------------------
// The router service
// ---------------------------------------------------------------------------
const ROUTER_DOWN =
  'The journey router is not running. Start it with `npm run router:dev`, then try again.';

/** Calls the router. A router that cannot be reached is a 503 with words for the panel. */
async function router(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(ROUTER + pathname, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw fail(503, ROUTER_DOWN);
  }
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

/** A run as the library query reads it, before the figures are worked out. */
interface SimRunRow {
  id: number;
  name: string;
  kind: 'bau' | 'scenario';
  baselineId: number | null;
  scenarioId: number | null;
  scenarioName: string | null;
  demandSetId: number | null;
  demandSetName: string | null;
  bauRunId: number | null;
  bauRunName: string | null;
  madeUp: boolean | null;
  plansRunId: number | null;
  capacity: boolean;
  settings: Record<string, unknown>;
  state: RunState;
  progress: Record<string, unknown>;
  error: string | null;
  folderId: number | null;
  madeBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  resultRows: number;
  archived: boolean;
  timetableId: string;
  timetable_version: string;
  plan_version: string;
  /** The box: the four sides are all set or all null. */
  area_name: string | null;
  area_south: number | null;
  area_west: number | null;
  area_north: number | null;
  area_east: number | null;
  /** The router's summary of the run; only the parts read here are named. */
  summary: {
    work?: { journeysPlannedPerSecond?: number };
    capacities?: unknown;
    people?: unknown;
  } | null;
  scenarioRuns: number;
  capacityRuns: number;
  scenario_head: number | null;
  scenario_now: number | null;
}

// ---------------------------------------------------------------------------
// Which timetable, and which version of it
// ---------------------------------------------------------------------------
interface TimetableKey {
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
const ROUTER_RULES = 2;

const boxText = (box: Box) => [box.south, box.west, box.north, box.east].join(',');

/**
 * The key of a timetable as it stands now. A scenario's `head` alone is reused after an undo, so the
 * time of the edit numbered `head` is part of the key (section 6.2 of the plan).
 */
async function timetableKey(
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
const FOOT_BRIDGES = [
  { name: 'John Whitton Bridge, Meadowbank to Rhodes', lat: -33.8215, lon: 151.0889 },
];

/** Metres of ferry path left out round each wharf, and round each bridge. */
const WHARF_GAP = 100;
const BRIDGE_GAP = 150;

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
function waterFile(sql: Sql, baselineId: number): Promise<string> {
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
async function ensureTimetable(
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

// ---------------------------------------------------------------------------
// Copying results into the database
// ---------------------------------------------------------------------------
/** Each result file: the columns as the simulator writes them, and how they become the table's rows. */
const IMPORTS: Record<
  ResultTable,
  { file: string; staging: string; select: (b: number) => string; indexes: string[] }
> = {
  sim_journeys: {
    file: 'journeys.csv.gz',
    staging: `journey_id text, part int, user_id text, people int, status text, start_secs int, depart int, arrive int,
      journey_secs int, rides int, boardings int, walk_secs int, wait_secs int, left_behind int, rerouted int, stops text,
      reference_arrive int, later_secs int, margin_secs int, origin_changed int, origin_stop text, origin_walk_metres int,
      destination_changed int, destination_stop text, destination_walk_metres int, change_reason text, own_arrive int,
      own_cost int, near_arrive int, near_cost int, no_journey_reason text, stranded_stop text, stranded_time int`,
    select: (b) => `
      select x.journey_id, x.part, x.user_id, x.people, x.status, x.start_secs, x.depart, x.arrive, x.journey_secs, x.rides,
             x.boardings, x.walk_secs, x.wait_secs, x.left_behind, x.rerouted = 1, x.stops, x.reference_arrive, x.later_secs,
             x.margin_secs, x.origin_changed = 1, o.id, x.origin_walk_metres, x.destination_changed = 1, d.id,
             x.destination_walk_metres, x.change_reason, x.no_journey_reason, s.id, x.stranded_time
      from staged x
      left join stops o on o.baseline_id = ${b} and o.gtfs_id = x.origin_stop
      left join stops d on d.baseline_id = ${b} and d.gtfs_id = x.destination_stop
      left join stops s on s.baseline_id = ${b} and s.gtfs_id = x.stranded_stop`,
    indexes: ['user_id', 'journey_id'],
  },
  sim_legs: {
    file: 'legs.csv.gz',
    staging: `journey_id text, part int, leg int, kind text, trip text, route text, from_stop text, to_stop text,
      depart int, arrive int, metres int, stay_aboard int, people int`,
    select: (b) => `
      select x.journey_id, x.part, x.leg, x.kind, t.id, r.id, f.id, o.id, x.depart, x.arrive, x.metres, x.stay_aboard = 1, x.people
      from staged x
      left join trips t on t.baseline_id = ${b} and t.gtfs_id = x.trip
      left join routes r on r.baseline_id = ${b} and r.gtfs_id = x.route
      left join stops f on f.baseline_id = ${b} and f.gtfs_id = x.from_stop
      left join stops o on o.baseline_id = ${b} and o.gtfs_id = x.to_stop`,
    indexes: ['journey_id', 'trip_id'],
  },
  sim_trip_loads: {
    file: 'trip_loads.csv.gz',
    staging: `trip text, position int, stop text, arrive int, depart int, boardings int, alightings int, load int,
      left_behind int, capacity int`,
    select: (b) => `
      select t.id, x.trip, x.position, s.id, x.arrive, x.depart, x.boardings, x.alightings, x.load, x.left_behind, x.capacity
      from staged x
      left join trips t on t.baseline_id = ${b} and t.gtfs_id = x.trip
      left join stops s on s.baseline_id = ${b} and s.gtfs_id = x.stop`,
    indexes: ['trip_id', 'stop_id'],
  },
  sim_stop_activity: {
    file: 'stop_activity.csv.gz',
    staging: `stop text, quarter_start int, boardings int, alightings int, changes int, left_behind int, max_waiting int`,
    select: (b) => `
      select s.id, x.stop, x.quarter_start, x.boardings, x.alightings, x.changes, x.left_behind, x.max_waiting
      from staged x left join stops s on s.baseline_id = ${b} and s.gtfs_id = x.stop`,
    indexes: ['stop_id'],
  },
};

const partition = (table: ResultTable, runId: number) => `${table}_r${Number(runId)}`;

/**
 * Copies result files from the router into this run's own partitions, turning GTFS ids into the
 * editor's. The database reads each file straight into a scratch table; nothing passes through
 * JavaScript objects.
 */
async function importResults(
  sql: Sql,
  run: { id: number; baseline_id: number; router_run_id: string },
  tables: readonly ResultTable[],
) {
  let rows = 0;
  for (const table of tables) {
    const spec = IMPORTS[table];
    const part = partition(table, run.id);
    const staged = `staging.sim_${run.id}_${table}`;
    let res: Response;
    try {
      res = await fetch(`${ROUTER}/v1/simulations/${run.router_run_id}/files/${spec.file}`);
    } catch {
      throw new Error(ROUTER_DOWN);
    }
    if (res.status !== 200 || !res.body)
      throw new Error(`The router has no ${spec.file} for this run (${res.status})`);
    await sql.unsafe(
      `drop table if exists ${staged}; create unlogged table ${staged} (${spec.staging})`,
    );
    try {
      const writable = await sql
        .unsafe(`copy ${staged} from stdin with (format csv, header true)`)
        .writable();
      await pipeline(Readable.fromWeb(res.body as never), createGunzip(), writable);
      await sql.unsafe(`
        drop table if exists ${part};
        create table ${part} partition of ${table} for values in (${Number(run.id)});
        insert into ${part} select ${Number(run.id)}, q.* from (${spec.select(Number(run.baseline_id)).replace('from staged x', `from ${staged} x`)}) q;
        ${spec.indexes.map((column) => `create index on ${part} (${column});`).join('\n')}
        analyze ${part}`);
      const [{ n }] = await sql.unsafe(`select count(*)::bigint as n from ${part}`);
      rows += Number(n);
    } finally {
      await sql.unsafe(`drop table if exists ${staged}`);
    }
  }
  return rows;
}

async function dropResults(sql: Sql, runId: number, tables: readonly ResultTable[]) {
  for (const table of tables) await sql.unsafe(`drop table if exists ${partition(table, runId)}`);
}

async function countResults(sql: Sql, runId: number) {
  let rows = 0;
  for (const table of RESULT_TABLES) {
    const [found] = await sql`select to_regclass(${partition(table, runId)}) as name`;
    if (found.name)
      rows += Number(
        (await sql.unsafe(`select count(*)::bigint as n from ${partition(table, runId)}`))[0].n,
      );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Driving a run
// ---------------------------------------------------------------------------
const stopping = new Set<number>();

async function setState(sql: Sql, id: number, state: RunState, more: Record<string, unknown> = {}) {
  await sql`update sim_runs set ${sql({ state, ...more } as never)} where id = ${id}`;
}

/**
 * Takes a run from wherever it has got to through to the end. Safe to call again after this API
 * restarts: a run already on the router is followed from there.
 */
async function drive(
  sql: Sql,
  id: number,
  log: (err: unknown, message: string) => void,
): Promise<void> {
  try {
    let [run] = await sql`select * from sim_runs where id = ${id}`;
    if (!run || !ACTIVE.includes(run.state)) return;
    const stopped = async () => {
      if (!stopping.has(id)) return false;
      await setState(sql, id, 'stopped', { finished_at: new Date(), progress: sql.json({}) });
      return true;
    };

    if (!run.router_run_id) {
      // 1. The timetable. Its version is the one recorded when the run was asked for; if the
      // scenario has been edited since, the run is of the scenario as it is now and says so.
      await setState(sql, id, 'preparing', {
        started_at: new Date(),
        progress: sql.json({ stage: 'timetable' }),
      });
      const sc = run.scenario_id
        ? ({ id: run.scenario_id, baselineId: run.baseline_id, head: 0 } as Scenario)
        : null;
      if (sc) {
        const [now] = await sql`select head from scenarios where id = ${sc.id}`;
        if (!now) throw new Error('The scenario was removed before the run could start');
        sc.head = now.head;
      }
      const box: Box | null =
        run.area_south === null
          ? null
          : {
              name: run.area_name,
              south: run.area_south,
              west: run.area_west,
              north: run.area_north,
              east: run.area_east,
            };
      const key = await timetableKey(sql, run.baseline_id, sc, box);
      if (run.plans_run_id && key.planVersion !== run.plan_version) {
        throw new Error(
          'The timetable has changed since the run whose plans these are; make a new run',
        );
      }
      await sql`update sim_runs set timetable_id = ${key.id}, timetable_version = ${key.version}, plan_version = ${key.planVersion} where id = ${id}`;
      await ensureTimetable(key, async (secs) => {
        await sql`update sim_runs set progress = ${sql.json({ stage: 'timetable', secs })} where id = ${id}`;
      });
      if (await stopped()) return;

      // 2. The job on the router.
      const settings = run.settings as Record<string, unknown>;
      const request: Record<string, unknown> = {
        timetable: key.id,
        id: `sim-${id}`,
        name: run.name,
        settings: { ...settings },
      };
      if (run.plans_run_id) {
        request.fromPlans = `sim-${run.plans_run_id}`;
      } else if (run.kind === 'scenario') {
        request.bau = `sim-${run.bau_run_id}`;
      } else {
        const [demand] =
          await sql`select id, file from demand_sets where id = ${run.demand_set_id}`;
        if (!demand) throw new Error('The demand set was removed before the run could start');
        request.demand = SHARED_FILES
          ? { path: path.join(DEMAND_DIR, demand.file) }
          : { url: `${SELF}/api/demand/${demand.id}/download/${demand.file}` };
        if (box)
          (request.settings as Record<string, unknown>).area = {
            south: box.south,
            west: box.west,
            north: box.north,
            east: box.east,
          };
      }
      // A run of this number left on the router by an earlier try is in the way.
      await router('DELETE', `/v1/simulations/sim-${id}?force=true`);
      await router('DELETE', `/v1/simulations/sim-${id}?force=true`);
      const asked = await router('POST', '/v1/simulations', request);
      if (asked.status !== 202)
        throw new Error(asked.body?.error ?? `The router refused the run (${asked.status})`);
      await setState(sql, id, 'running', {
        router_run_id: `sim-${id}`,
        progress: sql.json({ stage: 'queued' }),
      });
      [run] = await sql`select * from sim_runs where id = ${id}`;
    }

    // 3. Follow it.
    let summary: unknown = null;
    if (run.state !== 'importing') {
      for (;;) {
        if (stopping.has(id)) await router('DELETE', `/v1/simulations/${run.router_run_id}`);
        const now = await router('GET', `/v1/simulations/${run.router_run_id}`);
        if (now.status === 404)
          throw new Error(
            'The router no longer has this run; it was restarted while the run was going',
          );
        const job = now.body;
        if (job.state === 'done') {
          summary = job.summary;
          break;
        }
        if (job.state === 'failed') throw new Error(job.error ?? 'The run failed on the router');
        if (job.state === 'stopped') {
          await router('DELETE', `/v1/simulations/${run.router_run_id}`);
          stopping.add(id);
          await stopped();
          return;
        }
        const progress =
          job.state === 'queued'
            ? { stage: 'queued', runsAhead: job.runsAhead ?? 0 }
            : (job.progress ?? {});
        await sql`update sim_runs set progress = ${sql.json(progress)} where id = ${id}`;
        await sleep(1000);
      }
      await setState(sql, id, 'importing', {
        summary: sql.json(summary as never),
        progress: sql.json({ stage: 'copying results' }),
      });
    }

    // 4. Copy the results in.
    const rows = await importResults(sql, run as never, RESULT_TABLES);
    // The flows the results draw on the map. Without them the run is still good: they are worked
    // out the first time they are asked for.
    await buildLinkLoads(sql, id).catch((err) =>
      log(err, `could not work out the stretch loads of run ${id}`),
    );
    await setState(sql, id, 'done', {
      finished_at: new Date(),
      result_rows: rows,
      progress: sql.json({}),
      error: null,
    });
  } catch (err) {
    log(err, `simulation run ${id} failed`);
    const message = err instanceof Error ? err.message : String(err);
    await dropResults(sql, id, RESULT_TABLES).catch(() => {});
    await sql`update sim_runs set state = 'failed', error = ${message}, finished_at = now(), progress = '{}' where id = ${id}`.catch(
      () => {},
    );
  } finally {
    stopping.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerSimRoutes(app: FastifyInstance, sql: Sql) {
  const log = (err: unknown, message: string) => app.log.error(err as Error, message);
  const start = (id: number) => void drive(sql, id, log);

  // An upload arrives as the file itself; hand the stream on untouched.
  app.addContentTypeParser(
    ['text/csv', 'application/gzip', 'application/octet-stream'],
    (_req, payload, done) => done(null, payload),
  );

  /** Whether the router is there, and what it holds. The panel asks before offering to run anything. */
  app.get('/api/sim/status', async () => {
    try {
      const health = await router('GET', '/v1/health');
      return { router: true, url: ROUTER, timetables: health.body?.timetables ?? [] };
    } catch {
      return { router: false, url: ROUTER, message: ROUTER_DOWN, timetables: [] };
    }
  });

  /**
   * Where a straight walk would cross water on a published day: ?baseline=. The router fetches it
   * with the timetable. Worked out once and kept until this API restarts.
   */
  app.get('/api/sim/water', async (req, reply) => {
    const baseline = int((req.query as Record<string, string | undefined>).baseline, 'baseline');
    if (!(await sql`select 1 from baselines where id = ${baseline}`).length)
      throw fail(404, 'Day not found');
    reply.header('content-type', 'text/csv; charset=utf-8');
    return waterFile(sql, baseline);
  });

  // ---- demand sets --------------------------------------------------------
  // A set counts as made up if the editor made it, or if the router's check found that every user
  // id has the form the generator writes (u0000001 ...): a made-up file that was uploaded.
  const madeUp = sql`(d.made_up or coalesce((d.report->>'madeUpIds')::boolean, false))`;
  const demandColumns = sql`
    d.id, d.name, d.state, d.error, ${madeUp} as "madeUp", d.row_count as "rows", d.people, d.users, d.earliest, d.latest,
    d.report, d.made_by as "madeBy", d.created_at as "createdAt",
    (select count(*)::int from sim_runs r where r.demand_set_id = d.id) as runs`;

  /** Has the router read the file, and records what it made of it. */
  async function checkDemand(id: number, file: string) {
    const full = path.join(DEMAND_DIR, file);
    let res: Response;
    try {
      res = await fetch(`${ROUTER}/v1/demand/check`, {
        method: 'POST',
        headers: { 'content-type': file.endsWith('.gz') ? 'application/gzip' : 'text/csv' },
        body: Readable.toWeb(createReadStream(full)) as never,
        duplex: 'half',
      } as never);
    } catch {
      throw fail(503, ROUTER_DOWN);
    }
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.status !== 200)
      throw fail(400, body.error ?? `The router could not read the file (${res.status})`);
    const { stops, ...report } = body;
    await sql`
      update demand_sets set state = 'ready', error = null, row_count = ${body.rows}, people = ${body.people}, users = ${body.users},
        earliest = ${body.rows ? body.earliest : null}, latest = ${body.rows ? body.latest : null},
        report = ${sql.json(report)}, stop_counts = ${sql.json(stops ?? {})}
      where id = ${id}`;
  }

  /**
   * Upload a demand CSV (gzipped or not) as the body, with ?name= and ?madeBy=. The rows are checked
   * and the report comes back with the set. Whether each stop still has a service is checked when a
   * run starts, against the timetable chosen.
   */
  app.post('/api/demand', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const type = String(req.headers['content-type'] ?? '');
    if (!req.body || typeof (req.body as Readable).pipe !== 'function') {
      throw fail(
        415,
        'Send the CSV itself as the body, with Content-Type text/csv (or application/gzip if it is gzipped)',
      );
    }
    const gz = type.startsWith('application/gzip') || query.gzip === '1';
    await mkdir(DEMAND_DIR, { recursive: true });
    const incoming = path.join(
      DEMAND_DIR,
      `incoming-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    );
    await pipeline(req.body as Readable, createWriteStream(incoming));
    const [row] = await sql`
      insert into demand_sets (name, file, state, made_by)
      values (${name(query.name, 'Uploaded journeys')}, '', 'checking', ${query.madeBy?.trim().slice(0, 80) || null}) returning id`;
    const file = `demand-${row.id}.csv${gz ? '.gz' : ''}`;
    try {
      await rename(incoming, path.join(DEMAND_DIR, file));
      await sql`update demand_sets set file = ${file} where id = ${row.id}`;
      await checkDemand(row.id, file);
    } catch (err) {
      // A file that cannot be read, or no router to read it: keep nothing.
      await sql`delete from demand_sets where id = ${row.id}`;
      await rm(incoming, { force: true });
      await rm(path.join(DEMAND_DIR, file), { force: true });
      throw err;
    }
    const [made] = await sql`select ${demandColumns} from demand_sets d where d.id = ${row.id}`;
    return made;
  });

  /**
   * Make a demand set up (section 3.3): { name, baselineId, journeys, seed, areaId | area, withinKm,
   * focus, people, madeBy }. Answers at once; the set is 'generating' until the router has made it,
   * which first needs the published timetable loaded there.
   */
  app.post('/api/demand/generate', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const baselineId = int(body.baselineId, 'baselineId');
    const journeys = int(body.journeys ?? 100_000, 'journeys');
    if (journeys < 1 || journeys > 5_000_000) throw fail(400, 'journeys is 1 to 5,000,000');
    const box = await boxOf(body, {
      name: 'Opal area',
      south: -34.75,
      west: 150.1,
      north: -32.7,
      east: 151.85,
    });
    const key = await timetableKey(sql, baselineId, null, null);
    await router('GET', '/v1/health'); // say at once if the router is not there
    const [row] = await sql`
      insert into demand_sets (name, file, state, made_up, made_by)
      values (${name(body.name, `Made up, ${journeys.toLocaleString('en-AU')} journeys${box ? `, ${box.name ?? 'a box'}` : ''}`)}, '',
              'generating', true, ${typeof body.madeBy === 'string' ? body.madeBy.trim().slice(0, 80) || null : null}) returning id`;
    const file = `demand-${row.id}.csv.gz`;
    void (async () => {
      try {
        await ensureTimetable(key, async () => {});
        const res = await fetch(`${ROUTER}/v1/demand/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            timetable: key.id,
            journeys,
            seed: body.seed ?? 1,
            withinKm: body.withinKm ?? 25,
            focus: body.focus ?? 1,
            people: body.people ?? 1,
            area: box
              ? { south: box.south, west: box.west, north: box.north, east: box.east }
              : 'all',
          }),
        });
        if (res.status !== 200 || !res.body)
          throw new Error(
            ((await res.json().catch(() => ({}))) as any).error ??
              `The router answered ${res.status}`,
          );
        await mkdir(DEMAND_DIR, { recursive: true });
        await pipeline(
          Readable.fromWeb(res.body as never),
          createWriteStream(path.join(DEMAND_DIR, file)),
        );
        await sql`update demand_sets set file = ${file} where id = ${row.id}`;
        await checkDemand(row.id, file);
      } catch (err) {
        log(err, `making up demand set ${row.id} failed`);
        await rm(path.join(DEMAND_DIR, file), { force: true }).catch(() => {});
        await sql`update demand_sets set state = 'failed', error = ${err instanceof Error ? err.message : String(err)} where id = ${row.id}`;
      }
    })();
    const [made] = await sql`select ${demandColumns} from demand_sets d where d.id = ${row.id}`;
    return made;
  });

  /**
   * Sets checked before the check looked at user ids or at small-hours times are checked again,
   * once, when the list is first asked for. It needs the router; without it they wait for next time.
   */
  let recheck: Promise<void> | null = null;
  const recheckOldSets = () => {
    recheck ??= (async () => {
      const old =
        await sql`select id, file from demand_sets where state = 'ready' and file <> '' and not (report ? 'madeUpIds') order by id`;
      for (const set of old) await checkDemand(set.id, set.file);
    })().catch((err) => {
      recheck = null;
      if ((err as { statusCode?: number }).statusCode !== 503)
        log(err, 'could not check the older demand sets again');
    });
    return recheck;
  };

  app.get('/api/demand', async () => {
    await recheckOldSets();
    return sql`select ${demandColumns} from demand_sets d order by d.created_at desc, d.id desc`;
  });

  /**
   * One demand set. With ?baseline=, also the stop ids that day's published timetable does not
   * have, and how many journey ends name them: a warning for the wizard's last step.
   */
  app.get('/api/demand/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const [row] =
      await sql`select ${demandColumns}, d.stop_counts from demand_sets d where d.id = ${id}`;
    if (!row) throw fail(404, 'Demand set not found');
    const { stop_counts: counts, ...set } = row as Record<string, any>;
    const baseline = (req.query as Record<string, string | undefined>).baseline;
    if (!baseline) return set;
    const ids = Object.keys(counts ?? {}).filter((stop) => stop !== '');
    const known = new Set(
      (
        await sql`select gtfs_id from stops where baseline_id = ${int(baseline, 'baseline')} and scenario_id is null and gtfs_id = any(${ids})`
      ).map((s) => s.gtfs_id),
    );
    const unknown = ids.filter((stop) => !known.has(stop));
    return {
      ...set,
      unknownStops: {
        stops: unknown.length,
        journeyEnds: unknown.reduce((sum, stop) => sum + counts[stop], 0),
        examples: unknown.slice(0, 10),
      },
    };
  });

  /**
   * What the wizard's last step warns about, for one demand set on one day (and scenario, with ?s=):
   * with ?south=&west=&north=&east=, how many journey ends lie inside that box; and how many name a
   * stop that nothing calls at, and of those how many have a served stop within ?walk= metres.
   * Journey ends are counted, not journeys: which journeys have both ends inside is known only
   * once the run has read the file. An end with a position of its own (every end of a made-up
   * set) is placed by that position, read from the file; the others by their stop.
   */
  app.get('/api/demand/:id/coverage', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const query = req.query as Record<string, string | undefined>;
    const baseline = int(query.baseline, 'baseline');
    const [row] = await sql`select stop_counts, report, file from demand_sets where id = ${id}`;
    if (!row) throw fail(404, 'Demand set not found');
    const counts = (row.stop_counts ?? {}) as Record<string, number>;
    const ids = Object.keys(counts).filter((stop) => stop !== '');
    const positioned = Number((row.report as any)?.endsWithOwnPosition ?? 0);
    const total = ids.reduce((sum, stop) => sum + counts[stop], 0) + positioned;
    const scenarioId = query.s ? int(query.s, 's') : null;
    const [found] =
      scenarioId === null
        ? [null]
        : await sql`select id, baseline_id as "baselineId", head from scenarios where id = ${scenarioId}`;
    const sc = (found ?? null) as Scenario | null;
    const walk = Math.min(2000, Math.max(0, Number(query.walk ?? 500)));
    const box = query.south === undefined ? null : readBox(query as never);
    // Each stop the journeys name, with its position, whether anything calls there, and for a
    // stop nothing calls at whether a served stop is within the walk. A station counts through
    // its platforms.
    const stops = await sql`
      with named as (
        select s.id, s.gtfs_id, s.geom from stops s
        where s.baseline_id = ${baseline} and s.scenario_id is null and s.gtfs_id = any(${ids})),
      served as (
        select n.id, n.gtfs_id, n.geom, exists (
          select 1 from stops p join stop_times st on st.stop_id = p.id join trips t on t.id = st.trip_id
          where (p.id = n.id or p.parent_id = n.id) and ${visible(sql, 't', sc)}) as has_service
        from named n)
      select v.gtfs_id, v.has_service,
             ${box ? sql`v.geom && ST_MakeEnvelope(${box.west}, ${box.south}, ${box.east}, ${box.north}, 4326)` : sql`true`} as inside,
             case when v.has_service then true else exists (
               select 1 from stops o join stop_times st on st.stop_id = o.id join trips t on t.id = st.trip_id
               where o.baseline_id = ${baseline} and ST_DWithin(o.geom::geography, v.geom::geography, ${walk}) and ${visible(sql, 't', sc)}) end as near
      from served v`;
    // Ends with a position of their own are not in the stop counts; they are counted from the file.
    let inside =
      box && positioned > 0 && row.file
        ? Math.min(positioned, await positionedEndsInside(row.file, box))
        : 0;
    const none = { stops: 0, journeyEnds: 0, withAnotherNear: 0 };
    for (const stop of stops) {
      if (stop.inside) inside += counts[stop.gtfs_id];
      if (!stop.has_service) {
        none.stops++;
        none.journeyEnds += counts[stop.gtfs_id];
        if (stop.near) none.withAnotherNear += counts[stop.gtfs_id];
      }
    }
    return { journeyEnds: total, endsInside: box ? inside : total, noService: none };
  });

  /** The file itself, for a router that cannot read this machine's disk. */
  app.get('/api/demand/:id/download/:file', async (req, reply) => {
    const id = int((req.params as { id: string }).id, 'id');
    const [row] = await sql`select file from demand_sets where id = ${id} and state = 'ready'`;
    if (!row) throw fail(404, 'Demand set not found');
    reply.header('content-type', row.file.endsWith('.gz') ? 'application/gzip' : 'text/csv');
    reply.header('content-length', (await stat(path.join(DEMAND_DIR, row.file))).size);
    return reply.send(createReadStream(path.join(DEMAND_DIR, row.file)));
  });

  app.delete('/api/demand/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const [row] = await sql`select file from demand_sets where id = ${id}`;
    if (!row) throw fail(404, 'Demand set not found');
    const runs = await sql`select name from sim_runs where demand_set_id = ${id} order by id`;
    if (runs.length && (req.query as Record<string, string | undefined>).force !== 'true') {
      throw fail(
        409,
        `${runs.length} run${runs.length === 1 ? ' uses' : 's use'} these journeys (${runs
          .slice(0, 3)
          .map((r) => r.name)
          .join(
            ', ',
          )}${runs.length > 3 ? ', ...' : ''}). The runs keep their results, but no new BAU run can be made from them. Add ?force=true to remove the set anyway.`,
      );
    }
    await sql`delete from demand_sets where id = ${id}`;
    if (row.file) await rm(path.join(DEMAND_DIR, row.file), { force: true });
    return { ok: true };
  });

  // ---- areas --------------------------------------------------------------
  const areaColumns = sql`id, name, south, west, north, east, provided`;

  /** The box a request names: a saved area by `areaId`, a box given as `area`, or neither. */
  async function boxOf(
    body: Record<string, unknown>,
    otherwise: Box | null = null,
  ): Promise<Box | null> {
    if (body.areaId !== undefined && body.areaId !== null && body.areaId !== '') {
      const [area] =
        await sql`select ${areaColumns} from sim_areas where id = ${int(body.areaId, 'areaId')}`;
      if (!area) throw fail(404, 'Area not found');
      return {
        name: area.name,
        south: area.south,
        west: area.west,
        north: area.north,
        east: area.east,
      };
    }
    if (body.area === 'all' || body.area === null) return null;
    if (body.area === undefined) return otherwise;
    return readBox(body.area as Record<string, unknown>);
  }

  function readBox(given: Record<string, unknown>): Box {
    const [south, west, north, east] = ['south', 'west', 'north', 'east'].map((side) =>
      Number(given?.[side]),
    );
    if (
      ![south, west, north, east].every(Number.isFinite) ||
      !(south < north) ||
      !(west < east) ||
      south < -90 ||
      north > 90 ||
      west < -180 ||
      east > 180
    ) {
      throw fail(
        400,
        'An area needs south, west, north and east, with south below north and west below east',
      );
    }
    return {
      name:
        typeof given.name === 'string' && given.name.trim() ? given.name.trim().slice(0, 80) : null,
      south,
      west,
      north,
      east,
    };
  }

  app.get(
    '/api/sim-areas',
    async () => sql`select ${areaColumns} from sim_areas order by provided desc, name`,
  );

  app.post('/api/sim-areas', async (req) => {
    const box = readBox((req.body ?? {}) as Record<string, unknown>);
    if (!box.name) throw fail(400, 'Give the area a name');
    const [taken] = await sql`select 1 from sim_areas where name = ${box.name}`;
    if (taken) throw fail(409, `There is already an area called ${box.name}`);
    const [row] = await sql`
      insert into sim_areas (name, south, west, north, east) values (${box.name}, ${box.south}, ${box.west}, ${box.north}, ${box.east})
      returning ${areaColumns}`;
    return row;
  });

  app.delete('/api/sim-areas/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const [area] = await sql`select provided from sim_areas where id = ${id}`;
    if (!area) throw fail(404, 'Area not found');
    if (area.provided) throw fail(400, 'The areas the editor comes with cannot be removed');
    await sql`delete from sim_areas where id = ${id}`; // runs keep their own copy of the box
    return { ok: true };
  });

  // ---- folders ------------------------------------------------------------
  const folderColumns = sql`
    f.id, f.name, f.parent_id as "parentId", (select count(*)::int from sim_runs r where r.folder_id = f.id) as runs`;

  async function folderParent(value: unknown, self: number | null) {
    const parent = optionalInt(value, 'parentId');
    if (parent === null) return null;
    // A folder cannot go inside itself or anything under it.
    const chain = await sql`
      with recursive up as (
        select id, parent_id from sim_folders where id = ${parent}
        union all select f.id, f.parent_id from sim_folders f join up on f.id = up.parent_id)
      select id from up`;
    if (!chain.length) throw fail(404, 'Folder not found');
    if (self !== null && chain.some((f) => f.id === self))
      throw fail(400, 'A folder cannot be moved inside itself');
    return parent;
  }

  app.get(
    '/api/sim-folders',
    async () => sql`select ${folderColumns} from sim_folders f order by f.name, f.id`,
  );

  app.post('/api/sim-folders', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const folder = name(body.name, '');
    if (!folder) throw fail(400, 'Give the folder a name');
    const [row] = await sql`
      insert into sim_folders (name, parent_id) values (${folder}, ${await folderParent(body.parentId, null)}) returning id`;
    return (await sql`select ${folderColumns} from sim_folders f where f.id = ${row.id}`)[0];
  });

  app.patch('/api/sim-folders/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const [current] = await sql`select name, parent_id from sim_folders where id = ${id}`;
    if (!current) throw fail(404, 'Folder not found');
    const parent = 'parentId' in body ? await folderParent(body.parentId, id) : current.parent_id;
    await sql`update sim_folders set name = ${name(body.name, current.name)}, parent_id = ${parent} where id = ${id}`;
    return (await sql`select ${folderColumns} from sim_folders f where f.id = ${id}`)[0];
  });

  app.delete('/api/sim-folders/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const [folder] = await sql`
      select (select count(*)::int from sim_runs where folder_id = f.id) as runs,
             (select count(*)::int from sim_folders c where c.parent_id = f.id) as folders
      from sim_folders f where f.id = ${id}`;
    if (!folder) throw fail(404, 'Folder not found');
    if (folder.runs || folder.folders)
      throw fail(409, 'Only an empty folder can be removed; move what is in it first');
    await sql`delete from sim_folders where id = ${id}`;
    return { ok: true };
  });

  // ---- runs ---------------------------------------------------------------
  /**
   * Runs as the library shows them. A run is out of date when the timetable it was planned on is
   * no longer the scenario's (or the published day's); its capacity results alone are out of
   * date when only vehicle capacities have changed since.
   */
  async function runs(where: ReturnType<typeof sql>, full = false) {
    const rows = await sql<SimRunRow[]>`
      select r.id, r.name, r.kind, r.baseline_id as "baselineId", r.scenario_id as "scenarioId", s.name as "scenarioName",
             r.demand_set_id as "demandSetId", d.name as "demandSetName", r.bau_run_id as "bauRunId", b.name as "bauRunName",
             ${madeUp} as "madeUp",
             r.plans_run_id as "plansRunId", r.capacity, r.settings, r.state, r.progress, r.error,
             r.folder_id as "folderId", r.made_by as "madeBy", r.created_at as "createdAt", r.started_at as "startedAt",
             r.finished_at as "finishedAt", r.result_rows as "resultRows", r.archived,
             r.timetable_id as "timetableId", r.timetable_version, r.plan_version, r.area_name, r.area_south, r.area_west,
             r.area_north, r.area_east, r.summary,
             (select count(*)::int from sim_runs x where x.bau_run_id = r.id and x.plans_run_id is null) as "scenarioRuns",
             (select count(*)::int from sim_runs x where x.plans_run_id = r.id) as "capacityRuns",
             s.head as scenario_head, s.id as scenario_now
      from sim_runs r
      left join scenarios s on s.id = r.scenario_id
      left join demand_sets d on d.id = r.demand_set_id
      left join sim_runs b on b.id = r.bau_run_id
      where ${where} order by r.created_at desc, r.id desc`;
    // What each run's results take up in the database.
    const sizes = new Map<number, number>(
      (
        await sql`
        select (regexp_match(c.relname, '_r([0-9]+)$'))[1]::int as run, sum(pg_total_relation_size(c.oid))::bigint as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname ~ '^sim_(journeys|legs|trip_loads|stop_activity)_r[0-9]+$'
        group by 1`
      ).map((r) => [r.run, Number(r.bytes)]),
    );
    const keys = new Map<string, TimetableKey | null>();
    const out = [];
    for (const row of rows) {
      const {
        timetable_version: version,
        plan_version: planVersion,
        area_name,
        area_south,
        area_west,
        area_north,
        area_east,
        scenario_head,
        scenario_now,
        summary,
        ...run
      } = row;
      const gone = run.baselineId === null || (run.kind === 'scenario' && scenario_now === null);
      let outOfDate = gone;
      let capacityOutOfDate = false;
      if (!gone && !ACTIVE.includes(run.state)) {
        const at = `${run.baselineId}/${run.scenarioId ?? ''}`;
        if (!keys.has(at)) {
          keys.set(
            at,
            await timetableKey(
              sql,
              run.baselineId!, // not null: a run without one is gone
              // scenario_head is not null here: deleting a scenario clears the run's scenario id
              // (on delete set null), and scenarios.head is never null.
              run.scenarioId
                ? { id: run.scenarioId, baselineId: run.baselineId!, head: scenario_head! }
                : null,
              null,
            ).catch(() => null),
          );
        }
        const key = keys.get(at);
        outOfDate = !key || key.planVersion !== planVersion;
        capacityOutOfDate =
          !outOfDate && run.capacity && !String(version).endsWith(key!.version.split('|')[1]);
      }
      out.push({
        ...run,
        area:
          area_south === null
            ? null
            : {
                name: area_name,
                south: area_south,
                west: area_west!,
                north: area_north!,
                east: area_east!,
              },
        timetableVersion: version,
        sizeBytes: sizes.get(run.id) ?? 0,
        // Journeys planned a second, for guessing how long the next run will take.
        planRate: summary?.work?.journeysPlannedPerSecond ?? null,
        // How many trips the run had, and how many of their capacities are placeholders or assumed:
        // for the warning wherever crowding is shown.
        capacities: summary?.capacities ?? null,
        outOfDate,
        capacityOutOfDate,
        // The list carries the headline figures; the whole summary is at the run's own address.
        ...(full ? { summary } : { people: summary?.people ?? null }),
      });
    }
    return out;
  }

  const oneRun = async (id: number) => {
    const [run] = await runs(sql`r.id = ${id}`, true);
    if (!run) throw fail(404, 'Run not found');
    return run;
  };

  /** Keeps the settings this kind of run may choose, and refuses the rest with the reason. */
  function settingsFor(given: unknown, allowed: string[], what: string) {
    const settings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries((given ?? {}) as Record<string, unknown>)) {
      if (!allowed.includes(key)) {
        const known = [...BAU_SETTINGS, ...SCENARIO_SETTINGS].includes(key);
        throw fail(
          400,
          known ? `${key} cannot be set for ${what}` : `There is no setting called ${key}`,
        );
      }
      settings[key] = value;
    }
    return settings;
  }

  /**
   * Start a run. Three kinds, told apart by what the request names:
   *   { demandSetId, baselineId, areaId | area, settings }   a BAU run, on the published timetable
   *   { bauRunId, settings } with ?s= or scenarioId           a scenario run against that BAU run
   *   { fromRunId, settings }                                 that run's plans again, capacity on
   * and for any: name, folderId, madeBy. Answers at once with the run; follow it at its address.
   */
  app.post('/api/sim-runs', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = req.query as Record<string, string | undefined>;
    const folderId = optionalInt(body.folderId, 'folderId');
    if (folderId !== null && !(await sql`select 1 from sim_folders where id = ${folderId}`).length)
      throw fail(404, 'Folder not found');
    const madeBy = typeof body.madeBy === 'string' ? body.madeBy.trim().slice(0, 80) || null : null;
    await router('GET', '/v1/health'); // say at once if the router is not there

    let row: Record<string, unknown>;
    if (body.fromRunId !== undefined && body.fromRunId !== null) {
      // Capacity, from the kept plans of a finished run.
      const from = await oneRun(int(body.fromRunId, 'fromRunId'));
      if (from.state !== 'done')
        throw fail(409, 'Capacity can be added once that run has finished');
      if (from.plansRunId)
        throw fail(
          400,
          'That run is itself a capacity run; add capacity to the run it was made from',
        );
      if (from.outOfDate) {
        throw fail(
          409,
          "That run is out of date: its timetable, or the router's rules for walks and changes, have changed since. Make a new run",
        );
      }
      const [source] = await sql`select * from sim_runs where id = ${from.id}`;
      row = {
        name: name(body.name, `${from.name}, with capacity`),
        kind: from.kind,
        baseline_id: source.baseline_id,
        scenario_id: source.scenario_id,
        timetable_id: source.timetable_id,
        timetable_version: source.timetable_version,
        plan_version: source.plan_version,
        demand_set_id: source.demand_set_id,
        bau_run_id: source.bau_run_id,
        plans_run_id: from.id,
        area_name: source.area_name,
        area_south: source.area_south,
        area_west: source.area_west,
        area_north: source.area_north,
        area_east: source.area_east,
        capacity: true,
        settings: sql.json(
          settingsFor(
            body.settings,
            CAPACITY_SETTINGS,
            'a capacity run: the rest are the settings of the run it is made from',
          ) as never,
        ),
        folder_id: folderId ?? source.folder_id,
      };
    } else if (query.s || body.scenarioId) {
      // A scenario run, measured against a BAU run that the owner picks.
      const scenarioId = int(query.s ?? body.scenarioId, 'scenario');
      const [sc] =
        await sql`select id, baseline_id as "baselineId", head, name from scenarios where id = ${scenarioId}`;
      if (!sc) throw fail(404, 'Scenario not found');
      if (body.bauRunId === undefined || body.bauRunId === null) {
        throw fail(
          400,
          'A scenario run is measured against a BAU run: name one with bauRunId, or make a BAU run first',
        );
      }
      const bau = await oneRun(int(body.bauRunId, 'bauRunId'));
      if (bau.kind !== 'bau' || bau.plansRunId) throw fail(400, 'bauRunId must be a BAU run');
      if (bau.state !== 'done') throw fail(409, 'That BAU run has not finished');
      if (bau.baselineId !== sc.baselineId)
        throw fail(400, 'That BAU run is of a different published day from the scenario');
      if (bau.outOfDate) {
        throw fail(
          409,
          "That BAU run is out of date: the published day has been imported again, or the router's rules for walks and changes have changed since. Make a new one",
        );
      }
      const [source] = await sql`select * from sim_runs where id = ${bau.id}`;
      const key = await timetableKey(sql, sc.baselineId, sc as Scenario, bau.area);
      row = {
        name: name(body.name, `${sc.name} against ${bau.name}`),
        kind: 'scenario',
        baseline_id: sc.baselineId,
        scenario_id: sc.id,
        timetable_id: key.id,
        timetable_version: key.version,
        plan_version: key.planVersion,
        // The same people, the same area: taken from the BAU run, not asked for again.
        demand_set_id: source.demand_set_id,
        bau_run_id: bau.id,
        area_name: source.area_name,
        area_south: source.area_south,
        area_west: source.area_west,
        area_north: source.area_north,
        area_east: source.area_east,
        capacity:
          body.settings !== undefined &&
          (body.settings as Record<string, unknown>)?.capacity === true,
        settings: sql.json(
          settingsFor(
            body.settings,
            SCENARIO_SETTINGS,
            'a scenario run: it is taken from the BAU run',
          ) as never,
        ),
        folder_id: folderId ?? source.folder_id,
      };
    } else {
      // A BAU run.
      const baselineId = int(body.baselineId, 'baselineId');
      const [demand] =
        await sql`select id, name, state from demand_sets where id = ${int(body.demandSetId, 'demandSetId')}`;
      if (!demand) throw fail(404, 'Demand set not found');
      if (demand.state !== 'ready')
        throw fail(409, `Those journeys are not ready (${demand.state})`);
      const box = await boxOf(body);
      const key = await timetableKey(sql, baselineId, null, box);
      row = {
        name: name(body.name, box ? `BAU bounded ${box.name ?? 'to a box'}` : 'BAU, whole network'),
        kind: 'bau',
        baseline_id: baselineId,
        timetable_id: key.id,
        timetable_version: key.version,
        plan_version: key.planVersion,
        demand_set_id: demand.id,
        area_name: box?.name ?? null,
        area_south: box?.south ?? null,
        area_west: box?.west ?? null,
        area_north: box?.north ?? null,
        area_east: box?.east ?? null,
        capacity: (body.settings as Record<string, unknown> | undefined)?.capacity === true,
        settings: sql.json(settingsFor(body.settings, BAU_SETTINGS, 'a BAU run') as never),
        folder_id: folderId,
      };
    }
    const [made] =
      await sql`insert into sim_runs ${sql({ ...row, made_by: madeBy } as never)} returning id`;
    start(made.id);
    return oneRun(made.id);
  });

  /** The library: ?baseline=, ?scenario=, ?folder= (0 for unfiled), ?kind=, ?q= (in the name), ?madeBy=. */
  app.get('/api/sim-runs', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const folder = optionalInt(query.folder, 'folder');
    return runs(sql`true
      ${query.baseline ? sql`and r.baseline_id = ${int(query.baseline, 'baseline')}` : sql``}
      ${query.scenario ? sql`and r.scenario_id = ${int(query.scenario, 'scenario')}` : sql``}
      ${folder === null ? sql`` : folder === 0 ? sql`and r.folder_id is null` : sql`and r.folder_id = ${folder}`}
      ${query.kind ? sql`and r.kind = ${query.kind}` : sql``}
      ${query.q ? sql`and r.name ilike ${'%' + query.q.replace(/[%_\\]/g, (c) => '\\' + c) + '%'}` : sql``}
      ${query.madeBy ? sql`and r.made_by = ${query.madeBy}` : sql``}`);
  });

  app.get('/api/sim-runs/:id', async (req) => oneRun(int((req.params as { id: string }).id, 'id')));

  /** Rename a run or move it to another folder (null for unfiled). */
  app.patch('/api/sim-runs/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = await oneRun(id);
    let folderId = current.folderId;
    if ('folderId' in body) {
      folderId = optionalInt(body.folderId, 'folderId');
      if (
        folderId !== null &&
        !(await sql`select 1 from sim_folders where id = ${folderId}`).length
      )
        throw fail(404, 'Folder not found');
    }
    await sql`update sim_runs set name = ${name(body.name, current.name)}, folder_id = ${folderId} where id = ${id}`;
    return oneRun(id);
  });

  /**
   * Stop a run that is going, or remove one that has ended: its rows here and its files on the
   * router. A BAU run that scenario runs were made against is not removed unless ?force=true; they
   * stay viewable but lose their against-BAU link.
   */
  app.delete('/api/sim-runs/:id', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const run = await oneRun(id);
    if (ACTIVE.includes(run.state)) {
      stopping.add(id);
      const [row] = await sql`select router_run_id from sim_runs where id = ${id}`;
      if (row.router_run_id)
        await router('DELETE', `/v1/simulations/${row.router_run_id}`).catch(() => {});
      return { ok: true, stopping: true };
    }
    const dependents = run.scenarioRuns + run.capacityRuns;
    if (dependents && (req.query as Record<string, string | undefined>).force !== 'true') {
      throw fail(
        409,
        `${dependents} other run${dependents === 1 ? ' was' : 's were'} made from this one. ${
          run.scenarioRuns
            ? 'Its scenario runs would stay viewable but lose what they are compared with. '
            : ''
        }Add ?force=true to remove it anyway.`,
      );
    }
    await dropResults(sql, id, RESULT_TABLES);
    const [row] = await sql`delete from sim_runs where id = ${id} returning router_run_id`;
    // Its files on the router go too. A router that is not running keeps them until it is told again.
    if (row?.router_run_id) {
      await router('DELETE', `/v1/simulations/${row.router_run_id}?force=true`).catch(() => {});
    }
    return { ok: true };
  });

  /**
   * Archive: the journeys and legs leave the database and stay as files on the router. The loads
   * on trips and the figures at stops stay, so the run still opens and compares in total.
   */
  app.post('/api/sim-runs/:id/archive', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const run = await oneRun(id);
    if (run.state !== 'done') throw fail(409, 'Only a finished run can be archived');
    await dropResults(sql, id, ['sim_journeys', 'sim_legs']);
    await sql`update sim_runs set archived = true, result_rows = ${await countResults(sql, id)} where id = ${id}`;
    return oneRun(id);
  });

  /** Restore an archived run's journeys and legs from its files. */
  app.post('/api/sim-runs/:id/restore', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const run = await oneRun(id);
    if (!run.archived) return run;
    const [row] = await sql`select id, baseline_id, router_run_id from sim_runs where id = ${id}`;
    if (row.baseline_id === null)
      throw fail(409, 'The published day this run was made on has been removed');
    try {
      await importResults(sql, row as never, ['sim_journeys', 'sim_legs']);
    } catch (err) {
      await dropResults(sql, id, ['sim_journeys', 'sim_legs']);
      throw fail(502, err instanceof Error ? err.message : String(err));
    }
    await sql`update sim_runs set archived = false, result_rows = ${await countResults(sql, id)} where id = ${id}`;
    return oneRun(id);
  });

  /** One result file, as the router wrote it: the download. */
  app.get('/api/sim-runs/:id/files/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const [row] =
      await sql`select router_run_id from sim_runs where id = ${int(id, 'id')} and state = 'done'`;
    if (!row) throw fail(404, 'Run not found, or not finished');
    let res: Response;
    try {
      res = await fetch(
        `${ROUTER}/v1/simulations/${row.router_run_id}/files/${encodeURIComponent(file)}`,
      );
    } catch {
      throw fail(503, ROUTER_DOWN);
    }
    if (res.status !== 200 || !res.body) throw fail(404, 'The run has no such file');
    reply.header('content-type', res.headers.get('content-type') ?? 'application/octet-stream');
    reply.header(
      'content-disposition',
      `attachment; filename="run-${Number(id)}-${file.replace(/[^A-Za-z0-9._-]/g, '')}"`,
    );
    return reply.send(Readable.fromWeb(res.body as never));
  });

  // ---- results, for the views of phase S4 ----------------------------------
  const finished = async (id: number, needsJourneys = false) => {
    const [run] = await sql`select state, archived from sim_runs where id = ${id}`;
    if (!run) throw fail(404, 'Run not found');
    if (run.state !== 'done') throw fail(409, 'The run has not finished');
    if (needsJourneys && run.archived)
      throw fail(409, 'This run is archived; restore it to look up journeys');
  };

  /** One person's journeys in a run, each with its legs: ?user=. */
  app.get('/api/sim-runs/:id/journeys', async (req) => {
    const id = int((req.params as { id: string }).id, 'id');
    const user = (req.query as Record<string, string | undefined>).user;
    if (!user) throw fail(400, 'Say whose journeys with ?user=');
    await finished(id, true);
    const journeys = await sql`
      select j.journey_id as "journeyId", j.part, j.people, j.status, j.start_secs as "start", j.depart, j.arrive,
             j.journey_secs as "journeySecs", j.rides, j.boardings, j.walk_secs as "walkSecs", j.wait_secs as "waitSecs",
             j.left_behind as "leftBehind", j.rerouted, j.stops, j.reference_arrive as "referenceArrive",
             j.later_secs as "laterSecs", j.margin_secs as "marginSecs", j.origin_changed as "originChanged",
             j.origin_stop_id as "originStopId", j.origin_walk_metres as "originWalkMetres",
             j.destination_changed as "destinationChanged", j.destination_stop_id as "destinationStopId",
             j.destination_walk_metres as "destinationWalkMetres", j.change_reason as "changeReason",
             j.no_journey_reason as "noJourneyReason", j.stranded_stop_id as "strandedStopId", j.stranded_time as "strandedTime"
      from sim_journeys j where j.run_id = ${id} and j.user_id = ${user} order by j.start_secs, j.journey_id, j.part`;
    const legs = await sql`
      select l.journey_id as "journeyId", l.part, l.leg, l.kind, l.trip_id as "tripId", l.route_id as "routeId",
             r.short_name as "routeName", l.from_stop_id as "fromStopId", f.name as "fromStop", l.to_stop_id as "toStopId",
             o.name as "toStop", l.depart, l.arrive, l.metres, l.stay_aboard as "stayAboard",
             ST_X(f.geom) as "fromLon", ST_Y(f.geom) as "fromLat", ST_X(o.geom) as "toLon", ST_Y(o.geom) as "toLat"
      from sim_legs l
      left join routes r on r.id = l.route_id left join stops f on f.id = l.from_stop_id left join stops o on o.id = l.to_stop_id
      where l.run_id = ${id} and l.journey_id = any(${journeys.map((j) => j.journeyId)})
      order by l.journey_id, l.part, l.leg`;
    return journeys.map((j) => ({
      ...j,
      legs: legs.filter((l) => l.journeyId === j.journeyId && l.part === j.part),
    }));
  });

  /** Passengers aboard one trip along its stops, against its capacity. */
  app.get('/api/sim-runs/:id/trips/:trip', async (req) => {
    const { id, trip } = req.params as { id: string; trip: string };
    await finished(int(id, 'id'));
    return sql`
      select l.position, l.stop_id as "stopId", s.name as "stop", l.arrive, l.depart, l.boardings, l.alightings, l.load,
             l.left_behind as "leftBehind", l.capacity
      from sim_trip_loads l left join stops s on s.id = l.stop_id
      where l.run_id = ${int(id, 'id')} and l.trip_id = ${int(trip, 'trip')} order by l.position`;
  });

  /**
   * A line's day in a run: passengers, how full its trips get, and passengers by direction and the
   * hour their trip starts, to set against the places the line's hourly chart already shows.
   */
  app.get('/api/sim-runs/:id/routes/:route', async (req) => {
    const { id, route } = req.params as { id: string; route: string };
    const run = int(id, 'id');
    await finished(run);
    const perTrip = sql`
      select t.id, t.direction_id, t.start_secs, max(l.capacity) as capacity, max(l.load) as peak,
             sum(l.boardings)::int as boardings, sum(l.left_behind)::int as left_behind
      from sim_trip_loads l join trips t on t.id = l.trip_id
      where l.run_id = ${run} and t.route_id = ${int(route, 'route')} group by t.id`;
    const [totals] = await sql`
      select coalesce(sum(boardings), 0)::int as passengers, count(*)::int as trips,
             count(*) filter (where capacity > 0 and peak >= capacity)::int as "tripsFull",
             count(*) filter (where capacity > 0 and peak >= 0.8 * capacity)::int as "tripsOver80",
             coalesce(sum(left_behind), 0)::int as "leftBehind"
      from (${perTrip}) x`;
    const hourly = await sql`
      select coalesce(direction_id, 0) as direction, (start_secs / 3600)::int as hour, sum(boardings)::int as passengers,
             max(case when capacity > 0 then peak::float / capacity else 0 end) as "peakShare"
      from (${perTrip}) x group by 1, 2 order by 1, 2`;
    const [fullest] = await sql`
      select s.name as stop, l.depart, l.load, l.capacity
      from sim_trip_loads l join trips t on t.id = l.trip_id left join stops s on s.id = l.stop_id
      where l.run_id = ${run} and t.route_id = ${int(route, 'route')} and l.capacity > 0
      order by l.load::float / l.capacity desc, l.load desc limit 1`;
    return { ...totals, hourly, fullest: fullest && fullest.load > 0 ? fullest : null };
  });

  /**
   * One stop, or with a station id every stop under it, by quarter hour. The most waiting at once
   * is known for each platform apart: `maxWaiting` is the largest of them, and `maxWaitingAtMost`
   * their sum, which the station as a whole cannot exceed and reaches only if every platform is
   * at its fullest in the same moment. `platforms` says how many stops the row adds up.
   */
  app.get('/api/sim-runs/:id/stops/:stop', async (req) => {
    const { id, stop } = req.params as { id: string; stop: string };
    await finished(int(id, 'id'));
    return sql`
      select a.quarter_start as "quarterStart", sum(a.boardings)::int as boardings, sum(a.alightings)::int as alightings,
             sum(a.changes)::int as changes, sum(a.left_behind)::int as "leftBehind", max(a.max_waiting)::int as "maxWaiting",
             sum(a.max_waiting)::int as "maxWaitingAtMost", count(*) filter (where a.max_waiting > 0)::int as platforms
      from sim_stop_activity a
      where a.run_id = ${int(id, 'id')}
        and a.stop_id in (select s.id from stops s where s.id = ${int(stop, 'stop')} or s.parent_id = ${int(stop, 'stop')})
      group by 1 order by 1`;
  });

  // Runs that were going when this API last stopped carry on from where they were.
  void (async () => {
    try {
      for (const run of await sql`select id from sim_runs where state = any(${ACTIVE}) order by id`)
        start(run.id);
      await sql`update demand_sets set state = 'failed', error = 'The editor was restarted while this was being made'
                where state in ('checking', 'generating')`;
    } catch (err) {
      log(err, 'could not pick up unfinished simulation runs');
    }
  })();
}
