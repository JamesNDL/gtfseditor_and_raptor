// Scenarios: edits layered over a baseline, with undo and redo.
//
// Every edit is applied by cloning the trips it touches into scenario-owned rows and marking the
// originals as removed. Rows carry the edit number that created or removed them, so undo and redo
// only move the scenario's `head`; nothing is ever recomputed backwards.
import {
  bandOf,
  COORD_SCALE,
  DAY_BANDS,
  DEAD_RUN_KMH,
  DEFAULT_CHAIN_RULES,
  distanceM,
  encodePack,
  formatSecs,
  locateStops,
  MODE_MAX_KMH,
  SAME_PLACE_M,
  simplifyIndices,
  type PackArrays,
  type RuleSet,
} from '@gtfs-editor/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  acrossTheRoad,
  applyReshape,
  describeChange,
  describeNewStretches,
  describeStops,
  planOtherWay,
  planReshape,
  ROAD_MODES,
  typicalChange,
  type ReshapeDeps,
} from './edits/reshape.ts';
import { closureRoutes, editClose } from './edits/closure.ts';
import { deleteStopRoutes, editDeleteStop } from './edits/delete-stop.ts';
import { describeMethod, linePath, type PathMethod } from '../routing/roads.ts';
import { describeTimes, sectionTime, stopDwell, type SectionTime } from '../routing/timings.ts';
import {
  bestFree,
  platformChoices,
  scheduleEdits,
  scheduleRoutes,
  type Described,
} from './edits/schedule.ts';
import { editAddStop, scenarioStopsGeoJson, stopVisible, type AddedStop } from './stops.ts';
import { fail } from '../http.ts';

export interface Scenario {
  id: number;
  baselineId: number;
  head: number;
}

/** The scenario named by ?s=, or null for the plain baseline. */
export async function scenarioOf(req: FastifyRequest, sql: Sql): Promise<Scenario | null> {
  const raw = (req.query as Record<string, string | undefined>).s;
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) throw fail(400, 'Bad scenario id');
  const [row] =
    await sql`select id, baseline_id as "baselineId", head from scenarios where id = ${id}`;
  if (!row) throw fail(404, 'Scenario not found');
  return row as unknown as Scenario;
}

/** SQL condition: the trip aliased `alias` exists in this scenario (or in the baseline when null). */
export function visible(sql: Sql, alias: string, sc: Scenario | null) {
  const t = sql(alias);
  if (!sc) return sql`${t}.scenario_id is null`;
  return sql`(
    (${t}.scenario_id is null and not exists (
       select 1 from scenario_removed x
       where x.scenario_id = ${sc.id} and x.trip_id = ${t}.id and x.edit_seq <= ${sc.head}))
    or (${t}.scenario_id = ${sc.id} and ${t}.created_edit <= ${sc.head}
        and (${t}.removed_edit is null or ${t}.removed_edit > ${sc.head})))`;
}

// Seconds saved by not stopping, on top of the dwell itself, when the timetable has no non-stop
// example to learn from. Assumptions, not sourced values.
const SKIP_PENALTY: Record<string, number> = { rail: 45, ferry: 120, road: 20 };

const TRIP_COLUMNS = `baseline_id, route_id, pattern_id, shape_id, service_gtfs_id, headsign, direction_id, feed_block_id,
  trip_name, run_key, set_type, cars, vehicle_type_id, first_stop_id, last_stop_id, extra`;

type Tx = Sql;

/** The row `describe` reads, before it adds the label. */
type DescribeRow = Omit<Described, 'label'> & {
  from: string;
  to: string;
  scenario_id: number | null;
};

/** One stop time as the playback pack reads it. */
interface PackStopRow {
  trip_id: number;
  arr: number;
  dep: number;
  dist: number;
}

interface EditResult {
  summary: string;
  /** Old trip id to its replacement, so the client can keep the same trip selected. */
  idMap: Record<number, number>;
  focusTripId?: number;
  /** A line the edit created, so the client can open it. */
  routeId?: number;
  /** Stops the edit created, the one to use first. */
  stops?: AddedStop[];
}

const loadScenario = async (sql: Sql, id: number): Promise<Scenario> => {
  const [row] =
    await sql`select id, baseline_id as "baselineId", head from scenarios where id = ${id}`;
  if (!row) throw fail(404, 'Scenario not found');
  return row as unknown as Scenario;
};
const idParam = (req: FastifyRequest) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id)) throw fail(400, 'Bad scenario id');
  return id;
};

/**
 * Replaces trips with shifted copies owned by the scenario. Returns old id to new id.
 * `keepVehicle` false detaches the copies from their vehicle (used for brand-new trips).
 */
async function cloneTrips(
  tx: Tx,
  sc: Scenario,
  seq: number,
  tripIds: number[],
  delta: number,
  options: {
    pinnedIds?: number[];
    replace: boolean;
    keepVehicle: boolean;
    stopTimes?: boolean;
    tag?: string;
  },
): Promise<Record<number, number>> {
  if (!tripIds.length) return {};
  // A trip that is replaced must be in the scenario now. One that is only copied need not be: a
  // trip added to a line whose trips were all deleted is copied from the published timetable.
  if (options.replace) await requireLive(tx, sc, seq, tripIds);
  const pinned = options.pinnedIds ?? [];
  const created = await tx.unsafe(
    `insert into trips (${TRIP_COLUMNS}, gtfs_id, vehicle_day_id, vehicle_day_seq, start_secs, end_secs,
                        scenario_id, origin_trip_id, cloned_from, created_edit, pinned)
     select ${TRIP_COLUMNS},
            split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || $8::text || row_number() over (order by id),
            case when $5::boolean then vehicle_day_id end, case when $5::boolean then vehicle_day_seq end,
            start_secs + $3::int, end_secs + $3::int,
            $1::int, case when $6::boolean then coalesce(origin_trip_id, case when scenario_id is null then id end) end, id, $2::int,
            (pinned or id = any($7::bigint[]))
     from trips where id = any($4::bigint[])
     returning id, cloned_from`,
    [
      sc.id,
      seq,
      delta,
      tripIds,
      options.keepVehicle,
      options.replace,
      pinned,
      options.tag ?? '',
    ] as never[],
  );
  const idMap: Record<number, number> = {};
  for (const row of created) idMap[row.cloned_from] = row.id;
  const newIds = Object.values(idMap);
  // A caller that rebuilds the stop times itself (reshaping a line) asks for them not to be copied.
  if (options.stopTimes !== false) {
    await tx`
      insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
      select n.id, st.seq, st.stop_id, st.arr + ${delta}, st.dep + ${delta}, st.dist, st.pickup_type, st.drop_off_type,
             st.timepoint, st.headsign, st.note
      from trips n join stop_times st on st.trip_id = n.cloned_from
      where n.id = any(${newIds})`;
  }
  if (options.replace) await removeTrips(tx, sc, seq, tripIds);
  return idMap;
}

/**
 * Refuses trips that are not in the scenario as it stands: ones an earlier edit already replaced or
 * removed, and ones of another day or scenario. Without this, an edit sent twice (two quick drags
 * naming the same old trip) made a second copy of the trip. Trips made earlier in this same edit pass.
 */
async function requireLive(tx: Tx, sc: Scenario, seq: number, tripIds: number[]) {
  const ids = [...new Set(tripIds.map(Number))];
  if (ids.some((id) => !Number.isInteger(id))) throw fail(400, 'Bad trip id');
  const [{ n }] = await tx`
    select count(*)::int as n from trips t
    where t.id = any(${ids}) and t.baseline_id = ${sc.baselineId}
      and (${visible(tx, 't', sc)} or (t.scenario_id = ${sc.id} and t.created_edit = ${seq}))`;
  if (n !== ids.length) {
    throw fail(
      409,
      ids.length === 1
        ? 'That trip has since been changed or removed, so nothing was done. The timetable has been reloaded: try again.'
        : 'One of those trips has since been changed or removed, so nothing was done. The timetable has been reloaded: try again.',
    );
  }
}

async function removeTrips(tx: Tx, sc: Scenario, seq: number, tripIds: number[]) {
  if (!tripIds.length) return;
  await requireLive(tx, sc, seq, tripIds);
  // A removal already recorded (by this same edit, since anything older is refused above) is kept as it is.
  await tx`
    insert into scenario_removed (scenario_id, trip_id, edit_seq)
    select ${sc.id}, id, ${seq} from trips where id = any(${tripIds}) and scenario_id is null
    on conflict (scenario_id, trip_id) do nothing`;
  await tx`update trips set removed_edit = ${seq} where id = any(${tripIds}) and scenario_id = ${sc.id} and removed_edit is null`;
}

const describe = async (tx: Tx, tripId: number) => {
  const [t] = await tx<DescribeRow[]>`
    select coalesce(r.short_name, r.long_name, 'trip') as line, t.start_secs, f.name as "from", l.name as "to",
           t.route_id, t.direction_id, t.pattern_id, t.vehicle_day_id, t.baseline_id, t.scenario_id, m.rule_set
    from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
    join stops f on f.id = t.first_stop_id join stops l on l.id = t.last_stop_id
    where t.id = ${tripId}`;
  if (!t) throw fail(404, 'Trip not found');
  const short = (s: string) => s.replace(/ Station.*$/, '').replace(/, Platform.*$/, '');
  return {
    ...t,
    label: `${t.line} ${formatSecs(t.start_secs)} ${short(t.from)} to ${short(t.to)}`,
  };
};

const minutes = (secs: number) => {
  const m = Math.abs(secs) / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};

/**
 * How many vehicles a set of lines uses (vehicle chains, which is what the editor counts), and the
 * most trips they have running at any one moment. The second is the firmer figure: a chain count
 * goes up when one vehicle's day is merely cut in two.
 */
async function fleetFigures(
  tx: Tx,
  sc: Scenario,
  routeIds: number[],
): Promise<{ chains: number; peak: number }> {
  if (!routeIds.length) return { chains: 0, peak: 0 };
  const vis = visible(tx, 't', sc);
  const [row] = await tx`
    with live as (select t.vehicle_day_id, t.start_secs, t.end_secs from trips t where t.route_id = any(${routeIds}) and ${vis}),
    ev as (select start_secs as at, 1 as d from live union all select end_secs, -1 from live)
    select (select count(distinct vehicle_day_id)::int from live) as chains,
           coalesce((select max(q.running) from (select sum(d) over (order by at, d) as running from ev) q), 0)::int as peak`;
  return { chains: row.chains, peak: row.peak };
}

/**
 * The whole day: how many vehicles it uses, and the most trips running at any one moment. For the
 * published timetable (`sc` null) the answer never changes, so it is kept.
 */
const publishedFigures = new Map<number, { vehicles: number; peak: number }>();
async function dayFigures(
  tx: Tx,
  baselineId: number,
  sc: Scenario | null,
): Promise<{ vehicles: number; peak: number }> {
  const kept = sc ? undefined : publishedFigures.get(baselineId);
  if (kept) return kept;
  const [row] = await tx`
    with live as (select t.vehicle_day_id, t.start_secs, t.end_secs from trips t where t.baseline_id = ${baselineId} and ${visible(tx, 't', sc)}),
    ev as (select start_secs as at, 1 as d from live union all select end_secs, -1 from live)
    select (select count(distinct vehicle_day_id)::int from live) as vehicles,
           coalesce((select max(q.running) from (select sum(d) over (order by at, d) as running from ev) q), 0)::int as peak`;
  const figures = { vehicles: row.vehicles as number, peak: row.peak as number };
  if (!sc) publishedFigures.set(baselineId, figures);
  return figures;
}

// An edit that would add this many vehicles or more is not applied until the user has seen the figure.
const CONFIRM_VEHICLES = 10;
class NeedsConfirm extends Error {
  detail: { added: number; message: string; summary: string };
  constructor(detail: { added: number; message: string; summary: string }) {
    super('confirm');
    this.detail = detail;
  }
}

/**
 * Runs one edit inside a transaction, discarding any undone edits first.
 * An edit that adds many vehicles is rolled back and described instead, unless `confirmed`.
 */
async function applyEdit(
  sql: Sql,
  scenarioId: number,
  kind: string,
  fn: (tx: Tx, sc: Scenario, seq: number) => Promise<EditResult>,
  confirmed = true,
) {
  try {
    return await applyEditNow(sql, scenarioId, kind, fn, confirmed);
  } catch (err) {
    if (err instanceof NeedsConfirm) return { needsConfirm: err.detail };
    throw err;
  }
}

async function applyEditNow(
  sql: Sql,
  scenarioId: number,
  kind: string,
  fn: (tx: Tx, sc: Scenario, seq: number) => Promise<EditResult>,
  confirmed: boolean,
) {
  return sql.begin(async (tx0) => {
    const tx = tx0 as unknown as Tx;
    const [row] =
      await tx`select id, baseline_id as "baselineId", head from scenarios where id = ${scenarioId} for update`;
    if (!row) throw fail(404, 'Scenario not found');
    const sc = row as unknown as Scenario;
    // A new edit after an undo throws away the undone edits.
    await tx`delete from trips where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from vehicle_days where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from patterns where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from routes where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from shapes where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from stops where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from scenario_closures where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
    await tx`delete from scenario_removed_stops where scenario_id = ${sc.id} and edit_seq > ${sc.head}`;
    await tx`update trips set removed_edit = null where scenario_id = ${sc.id} and removed_edit > ${sc.head}`;
    await tx`delete from scenario_removed where scenario_id = ${sc.id} and edit_seq > ${sc.head}`;
    await tx`delete from scenario_edits where scenario_id = ${sc.id} and seq > ${sc.head}`;
    const seq = sc.head + 1;
    const result = await fn(tx, sc, seq);
    if (!confirmed) {
      const [{ added }] =
        await tx`select count(*)::int as added from vehicle_days where scenario_id = ${sc.id} and created_edit = ${seq}`;
      if (added >= CONFIRM_VEHICLES) {
        const routes = (
          await tx`
            select distinct t.route_id from trips t where t.scenario_id = ${sc.id} and t.created_edit = ${seq}
            union select distinct t.route_id from trips t where t.scenario_id = ${sc.id} and t.removed_edit = ${seq}
            union select distinct t.route_id from scenario_removed x join trips t on t.id = x.trip_id where x.scenario_id = ${sc.id} and x.edit_seq = ${seq}`
        ).map((r) => r.route_id as number);
        const before = await fleetFigures(tx, sc, routes);
        const after = await fleetFigures(tx, { ...sc, head: seq }, routes);
        const dayBefore = await dayFigures(tx, sc.baselineId, sc);
        const dayAfter = await dayFigures(tx, sc.baselineId, { ...sc, head: seq });
        const [limits] =
          await tx`select count(*) filter (where fleet_size is not null)::int as n from vehicle_types`;
        // Thrown so that the transaction is rolled back: nothing has been changed.
        throw new NeedsConfirm({
          added,
          summary: result.summary,
          message:
            `This would add ${added} vehicles. The whole network uses ${dayBefore.vehicles.toLocaleString('en-AU')} now and would use ${dayAfter.vehicles.toLocaleString('en-AU')}. ` +
            `The most trips running at once on the lines it changes would go from ${before.peak} to ${after.peak}. ` +
            `A "vehicle" here is a chain of trips one vehicle could run, worked out from the timetable, so the number is an estimate: ` +
            `it rises when a vehicle's day is cut in two, even if no more are on the road at once.` +
            (limits.n === 0
              ? ' No fleet sizes are set, so nothing else will warn you that there are not enough vehicles.'
              : ''),
        });
      }
    }
    await tx`insert into scenario_edits (scenario_id, seq, kind, summary) values (${sc.id}, ${seq}, ${kind}, ${result.summary})`;
    await tx`update scenarios set head = ${seq} where id = ${sc.id}`;
    return { seq, ...result };
  });
}

// -------------------------------------------------------------------------
// The edits
// -------------------------------------------------------------------------
interface FleetTrip {
  id: number;
  vd: number | null;
  s: number;
  e: number;
  partition: string;
  /** A group the trip must stay within, on top of its partition: the side of a closure. */
  group?: string;
  modeId: string;
  vt: number | null;
  ruleSet: RuleSet;
  fx: number;
  fy: number;
  lx: number;
  ly: number;
}

/**
 * Gives each new trip a vehicle. A vehicle already working the line takes the trip if it is free,
 * in the right place before it and (when it has a later trip) in the right place afterwards.
 * Otherwise a new vehicle is added. Vehicles added here can pick up further new trips, so a
 * there-and-back pair shares one. `forceNew` true puts every trip on its own new vehicle; 'fresh'
 * ignores the vehicles already working the line and chains the trips onto new ones.
 */
async function assignVehicles(
  tx: Tx,
  sc: Scenario,
  seq: number,
  tripIds: number[],
  forceNew: boolean | 'fresh' = false,
  /**
   * For a closure. `groupOf` gives the side each trip is on: a vehicle takes trips of one side only.
   * `crosses` says whether going straight from one place to another runs through the closure: such
   * a link is never made. `alsoDays` are more vehicles that may take the trips (the ones that ran
   * them before they were split).
   */
  extra: {
    groupOf?: Map<number, string>;
    crosses?: (ax: number, ay: number, bx: number, by: number) => boolean;
    alsoDays?: number[];
  } = {},
) {
  if (!tripIds.length) return { reused: 0, added: 0 };
  const now = { ...sc, head: seq };
  const load = async (where: ReturnType<Tx>): Promise<FleetTrip[]> => {
    const rows = await tx`
      select t.id, t.vehicle_day_id as vd, t.start_secs as s, t.end_secs as e, r.mode_id, r.agency_gtfs_id, m.rule_set,
             t.vehicle_type_id as vt,
             ST_X(coalesce(fp.geom, f.geom)) as fx, ST_Y(coalesce(fp.geom, f.geom)) as fy,
             ST_X(coalesce(lp.geom, l.geom)) as lx, ST_Y(coalesce(lp.geom, l.geom)) as ly
      from trips t
      join routes r on r.id = t.route_id
      join modes m on m.id = r.mode_id
      join stops f on f.id = t.first_stop_id
      join stops l on l.id = t.last_stop_id
      left join stops fp on fp.id = f.parent_id and m.rule_set <> 'road'
      left join stops lp on lp.id = l.parent_id and m.rule_set <> 'road'
      where ${where}`;
    return rows.map((r) => ({
      id: r.id,
      vd: r.vd,
      s: r.s,
      e: r.e,
      modeId: r.mode_id,
      vt: r.vt,
      ruleSet: r.rule_set as RuleSet,
      partition: `${r.mode_id}|${r.agency_gtfs_id ?? ''}|${r.vt ?? ''}`,
      fx: r.fx,
      fy: r.fy,
      lx: r.lx,
      ly: r.ly,
    }));
  };
  const fresh = (await load(tx`t.id = any(${tripIds})`)).sort((a, b) => a.s - b.s || a.id - b.id);
  if (extra.groupOf) for (const t of fresh) t.group = extra.groupOf.get(t.id);
  const crosses = extra.crosses ?? (() => false);
  // Candidates: every vehicle that already runs a trip on one of these lines.
  const working = forceNew
    ? []
    : await load(tx`
        (t.vehicle_day_id in (
          select t2.vehicle_day_id from trips t2
          where t2.route_id in (select route_id from trips where id = any(${tripIds}))
            and t2.vehicle_day_id is not null and ${visible(tx, 't2', now)})
         or t.vehicle_day_id = any(${extra.alsoDays ?? []}::bigint[]))
        and ${visible(tx, 't', now)} and not (t.id = any(${tripIds}))`);

  interface Vehicle {
    id: number | null;
    partition: string;
    /** The side of a closure it works, once it has taken a trip that has one. */
    group?: string;
    trips: FleetTrip[];
    modeId: string;
    vt: number | null;
  }
  const vehicles = new Map<number, Vehicle>();
  for (const t of working) {
    let v = vehicles.get(t.vd!);
    if (!v)
      vehicles.set(
        t.vd!,
        (v = { id: t.vd, partition: t.partition, trips: [], modeId: t.modeId, vt: t.vt }),
      );
    v.trips.push(t);
  }
  const pool = [...vehicles.values()];
  for (const v of pool) v.trips.sort((a, b) => a.s - b.s);
  const added: Vehicle[] = [];
  const chosen = new Map<number, Vehicle>();
  let reused = 0;

  for (const trip of fresh) {
    const rules = DEFAULT_CHAIN_RULES[trip.ruleSet];
    let best: { v: Vehicle; wait: number } | null = null;
    for (const v of forceNew === true ? [] : [...pool, ...added]) {
      if (v.partition !== trip.partition) continue;
      if (v.group !== undefined && trip.group !== undefined && v.group !== trip.group) continue;
      let prev: FleetTrip | null = null;
      let next: FleetTrip | null = null;
      for (const t of v.trips) {
        if (t.s <= trip.s) prev = t;
        else {
          next = t;
          break;
        }
      }
      if (
        prev &&
        (prev.e + rules.minLayoverSecs > trip.s ||
          distanceM(prev.lx, prev.ly, trip.fx, trip.fy) > rules.radiusM ||
          crosses(prev.lx, prev.ly, trip.fx, trip.fy))
      )
        continue;
      if (
        next &&
        (trip.e + rules.minLayoverSecs > next.s ||
          distanceM(trip.lx, trip.ly, next.fx, next.fy) > rules.radiusM ||
          crosses(trip.lx, trip.ly, next.fx, next.fy))
      )
        continue;
      const wait = prev ? trip.s - prev.e : next!.s - trip.e;
      // A vehicle idle for hours has most likely gone back to its depot.
      if (wait > 4 * 3600) continue;
      if (!best || wait < best.wait) best = { v, wait };
    }
    let v: Vehicle;
    if (best) {
      v = best.v;
      if (v.id !== null) reused++;
    } else {
      v = { id: null, partition: trip.partition, trips: [], modeId: trip.modeId, vt: trip.vt };
      added.push(v);
    }
    if (v.group === undefined) v.group = trip.group;
    v.trips.push(trip);
    v.trips.sort((a, b) => a.s - b.s);
    chosen.set(trip.id, v);
  }

  if (added.length) {
    const [{ n }] =
      await tx`select count(*)::int as n from vehicle_days where scenario_id = ${sc.id}`;
    const rows = added.map((v, i) => ({
      baseline_id: sc.baselineId,
      mode_id: v.modeId,
      label: `New vehicle ${n + i + 1}`,
      source: 'inferred',
      vehicle_type_id: v.vt,
      trip_count: v.trips.length,
      start_secs: v.trips[0].s,
      end_secs: Math.max(...v.trips.map((t) => t.e)),
      scenario_id: sc.id,
      created_edit: seq,
    }));
    const inserted = await tx`insert into vehicle_days ${tx(rows)} returning id`;
    added.forEach((v, i) => (v.id = inserted[i].id));
  }
  const ids = fresh.map((t) => t.id);
  const days = fresh.map((t) => chosen.get(t.id)!.id!);
  await tx`
    update trips t set vehicle_day_id = u.day_id
    from unnest(${ids}::bigint[], ${days}::bigint[]) as u(trip_id, day_id) where t.id = u.trip_id`;
  return { reused, added: added.length };
}

const fleetNote = (fleet: { reused: number; added: number }) => {
  const parts: string[] = [];
  if (fleet.added) parts.push(`${fleet.added} new vehicle${fleet.added === 1 ? '' : 's'}`);
  if (fleet.reused)
    parts.push(`${fleet.reused} trip${fleet.reused === 1 ? '' : 's'} on vehicles with spare time`);
  return parts.length ? `; ${parts.join(', ')}` : '';
};

async function editSetVehicle(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { tripId: number; mode: 'new' | 'auto' },
) {
  const tripId = Number(body.tripId);
  const t = await describe(tx, tripId);
  const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: false });
  const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap), body.mode === 'new');
  return {
    summary: fleet.added
      ? `${t.label} now runs on a new vehicle`
      : `${t.label} moved to a vehicle with spare time`,
    idMap,
    focusTripId: idMap[tripId],
  };
}

// Typical end-to-end speeds including time lost stopping, and time spent at each stop.
// Assumptions for brand-new lines, where there is no timetable to learn from.
const NEW_LINE: Record<string, { speed: number; dwell: number; routeType: number }> = {
  train: { speed: 15, dwell: 45, routeType: 2 },
  metro: { speed: 16, dwell: 30, routeType: 401 },
  light_rail: { speed: 7, dwell: 30, routeType: 900 },
  ferry: { speed: 6, dwell: 120, routeType: 4 },
  bus: { speed: 6.5, dwell: 20, routeType: 700 },
  coach: { speed: 14, dwell: 60, routeType: 204 },
  school_bus: { speed: 6.5, dwell: 20, routeType: 712 },
};

/**
 * Creates a new line through existing stops, with a timetable in both directions, or in one
 * direction only for a loop that runs round and back to where it started.
 * The path follows roads, or the track and ferry routes that published services already use.
 */
async function editCreateLine(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: {
    name: string;
    modeId: string;
    color?: string;
    stopIds: number[];
    headwaySecs?: number;
    fromSecs?: number;
    toSecs?: number;
    followRoads?: boolean;
    /** Runs one way round and back to the first stop, with no return direction. */
    loop?: boolean;
  },
) {
  const follow = body.followRoads !== false;
  const loop = body.loop === true;
  let pathMethod: PathMethod = 'straight';
  const name = (body.name ?? '').trim().slice(0, 40);
  if (!name) throw fail(400, 'Give the line a name');
  const model = NEW_LINE[body.modeId];
  if (!model) throw fail(400, 'Choose a mode');
  const color = /^[0-9A-Fa-f]{6}$/.test(body.color ?? '') ? body.color!.toUpperCase() : null;
  const headway = Math.round(Number(body.headwaySecs ?? 900));
  const from = Math.round(Number(body.fromSecs ?? 6 * 3600));
  const to = Math.round(Number(body.toSecs ?? 22 * 3600));
  if (!(headway >= 60) || headway > 4 * 3600 || !(to > from) || from < 0 || to > 30 * 3600) {
    throw fail(
      400,
      'Give a frequency between 1 minute and 4 hours, and hours between the start of the day and 06:00 the next morning',
    );
  }
  const chosen = (body.stopIds ?? []).map(Number);
  if (chosen.length < 2 || chosen.length > 150) throw fail(400, 'Pick at least two stops');
  // A loop comes back to where it started.
  if (loop && chosen[chosen.length - 1] !== chosen[0]) chosen.push(chosen[0]);
  if (loop && chosen.length < 4)
    throw fail(
      400,
      'A loop needs at least three stops, so that it goes round rather than out and back',
    );
  for (let i = 1; i < chosen.length; i++)
    if (chosen[i] === chosen[i - 1]) throw fail(400, 'The same stop is listed twice in a row');

  const rows = await tx`
    select s.id, s.name, s.location_type, s.parent_id, ST_X(s.geom) as lon, ST_Y(s.geom) as lat,
           array(select c.id from stops c where c.parent_id = s.id and c.location_type = 0 and ${stopVisible(tx, 'c', sc)}
                 order by (cardinality(c.mode_ids) = 0), length(c.platform_code), c.platform_code, c.id) as platforms
    from stops s where s.id = any(${chosen}) and s.baseline_id = ${sc.baselineId} and ${stopVisible(tx, 's', sc)}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (chosen.some((id) => !byId.has(id))) throw fail(400, 'One of those stops is not on this day');
  const stops = chosen.map((id) => byId.get(id)!);
  // A station was clicked: use one of its platforms, a different one each way where there are two.
  const platform = (s: (typeof stops)[number], direction: number): number => {
    if (s.location_type !== 1) return s.id;
    const list = s.platforms as number[];
    if (!list.length) throw fail(400, `${s.name} has no platforms to stop at`);
    return list[Math.min(direction, list.length - 1)];
  };

  const tidy = (stopName: string) => stopName.replace(/,.*$/, '').replace(/ Station$/, '');
  // A loop is named after the stop furthest from where it starts.
  const furthest = stops.reduce((best, s) =>
    distanceM(stops[0].lon, stops[0].lat, s.lon, s.lat) >
    distanceM(stops[0].lon, stops[0].lat, best.lon, best.lat)
      ? s
      : best,
  );
  const longName = loop
    ? `${tidy(stops[0].name)} loop via ${tidy(furthest.name)}`
    : `${stops[0].name.replace(/,.*$/, '')} to ${stops[stops.length - 1].name.replace(/,.*$/, '')}`;
  const [route] = await tx`
    insert into routes (baseline_id, gtfs_id, agency_gtfs_id, agency_name, short_name, long_name, route_type, mode_id, color,
                        scenario_id, created_edit)
    values (${sc.baselineId}, ${`NEW-${sc.id}-${seq}`}, 'NEW', 'New services', ${name},
            ${longName},
            ${model.routeType}, ${body.modeId}, ${color}, ${sc.id}, ${seq})
    returning id`;

  // Road vehicles stop on the left, so the way back uses the stop across the road. A stop's partner
  // is found from the published timetable: among the lines that call at it, the stop within 150 m
  // that their opposite direction calls at most often. Stops with no partner (termini, one-way
  // streets, loops) are used both ways.
  const returnStops = [...stops];
  let swapped = 0;
  if (ROAD_MODES.has(body.modeId) && !loop) {
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (s.location_type !== 0) continue;
      const partner = await acrossTheRoad(tx, s.id);
      if (partner) {
        returnStops[i] = partner as unknown as (typeof stops)[number];
        swapped++;
      }
    }
  }

  const tripIds: number[] = [];
  let outboundLine: [number, number][] | null = null;
  const timed: SectionTime[] = [];
  for (const direction of loop ? [0] : [0, 1]) {
    const order = direction === 0 ? stops : [...returnStops].reverse();
    // The path: along roads, track or ferry routes where it can be found, otherwise straight between stops.
    const found = await linePath(
      tx,
      sc.baselineId,
      body.modeId,
      order.map((s) => ({
        id: s.id,
        lon: s.lon,
        lat: s.lat,
        stationId: s.location_type === 1 ? s.id : s.parent_id,
      })),
      { follow },
    );
    let line: [number, number][] = found.coords;
    let known = found.at;
    if (direction === 0) {
      pathMethod = found.method;
      outboundLine = found.coords;
    } else if (follow && found.method === 'straight' && pathMethod !== 'straight' && outboundLine) {
      // Without a routing server there is rarely a published path for the way back, so the
      // return trip runs back along the outbound path rather than cutting straight across.
      line = [...outboundLine].reverse();
      known = undefined;
    }
    const lineDist: number[] = [0];
    for (let i = 1; i < line.length; i++)
      lineDist.push(
        lineDist[i - 1] + distanceM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]),
      );
    // Where each stop sits along the path: where the path's maker says, otherwise worked out in order.
    const placedAt =
      known ??
      locateStops(
        line,
        order.map((s) => [s.lon, s.lat] as [number, number]),
      );
    const dist = placedAt.map((k) => lineDist[Math.min(k, lineDist.length - 1)]);
    // Arrival and departure at each stop, as seconds after the trip starts, for each part of the day:
    // a trip that starts in the morning peak uses the morning peak's run times throughout.
    const stopIds = order.map((s) => platform(s, direction));
    const runs: SectionTime[] = [];
    const dwells: number[] = [0];
    for (let i = 1; i < order.length; i++) {
      const dwell =
        i === order.length - 1
          ? 0
          : await stopDwell(tx, sc.baselineId, body.modeId, stopIds[i], model.dwell);
      dwells.push(dwell);
      const run = await sectionTime(
        tx,
        sc.baselineId,
        body.modeId,
        { id: stopIds[i - 1], lon: order[i - 1].lon, lat: order[i - 1].lat },
        { id: stopIds[i], lon: order[i].lon, lat: order[i].lat },
        dist[i] - dist[i - 1],
        { speed: model.speed, dwellAtTo: dwell },
      );
      runs.push(run);
      timed.push(run);
    }
    const arrBy: number[][] = [];
    const depBy: number[][] = [];
    DAY_BANDS.forEach((_, k) => {
      const arr = [0];
      const dep = [0];
      for (let i = 1; i < order.length; i++) {
        arr.push(dep[i - 1] + runs[i - 1].byBand[k]);
        dep.push(arr[i] + dwells[i]);
      }
      arrBy.push(arr);
      depBy.push(dep);
    });
    const wkt = `LINESTRING(${line.map((p) => `${p[0]} ${p[1]}`).join(',')})`;
    const [shape] = await tx`
      insert into shapes (baseline_id, gtfs_id, geom, length_m, dists, scenario_id, created_edit)
      values (${sc.baselineId}, ${`NEW-${sc.id}-${seq}-${direction}`}, ST_GeomFromText(${wkt}, 4326), ${lineDist[lineDist.length - 1]},
              ${lineDist}::float8[], ${sc.id}, ${seq})
      returning id`;
    const headsign = loop ? `${tidy(furthest.name)} loop` : tidy(order[order.length - 1].name);
    const [pattern] = await tx`
      insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
      values (${sc.baselineId}, ${route.id}, ${direction}, ${shape.id}, ${headsign}, ${stopIds}::bigint[], 0,
              ${`new-${sc.id}-${seq}-${direction}`}, ${sc.id}, ${seq})
      returning id`;
    const starts: number[] = [];
    for (let s = from; s < to; s += headway) starts.push(s);
    const lasts = starts.map((s) => arrBy[bandOf(s)][order.length - 1]);
    const created = await tx`
      insert into trips (baseline_id, gtfs_id, route_id, pattern_id, shape_id, service_gtfs_id, headsign, direction_id,
                         start_secs, end_secs, first_stop_id, last_stop_id, scenario_id, created_edit)
      select ${sc.baselineId}, ${`NEW${sc.id}.${seq}.${direction}-`} || row_number() over (order by s.start), ${route.id}, ${pattern.id},
             ${shape.id}, 'NEW', ${headsign}, ${direction}, s.start, s.start + s.last,
             ${stopIds[0]}, ${stopIds[stopIds.length - 1]}, ${sc.id}, ${seq}
      from unnest(${starts}::int[], ${lasts}::int[]) as s(start, last)
      returning id, start_secs`;
    for (let k = 0; k < DAY_BANDS.length; k++) {
      const ids = created.filter((r) => bandOf(r.start_secs) === k).map((r) => r.id);
      if (!ids.length) continue;
      await tx`
        insert into stop_times (trip_id, seq, stop_id, arr, dep, dist)
        select n.id, o.seq, o.stop_id, n.start_secs + o.arr, n.start_secs + o.dep, o.dist
        from trips n
        cross join unnest(${stopIds}::bigint[], ${arrBy[k]}::int[], ${depBy[k]}::int[], ${dist}::float4[]) with ordinality as o(stop_id, arr, dep, dist, seq)
        where n.id = any(${ids})`;
    }
    for (const r of created) tripIds.push(r.id);
  }
  const fleet = await assignVehicles(tx, sc, seq, tripIds);
  const settled = await settlePlatforms(tx, sc, seq, tripIds);
  return {
    summary: `New ${loop ? 'one-way loop' : 'line'} ${name}: ${loop ? stops.length - 1 : stops.length} stops, every ${minutes(headway)} from ${formatSecs(from)} to ${formatSecs(to)} (${tripIds.length} trips), ${describeMethod(pathMethod)}; run times: ${describeTimes(timed, 'end to end', chosen.length - 1)}${swapped ? `; the way back uses the stop across the road at ${swapped} of ${stops.length} stops` : ''}${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
    routeId: route.id,
  };
}

/**
 * Sets how often a whole line runs, in both directions, across several time bands at once.
 * In each direction the most-used stopping pattern is the one regenerated; other patterns (branches,
 * expresses) are left alone. Vehicles are worked out across all the new trips together, so a trip
 * out and a trip back share one.
 */
async function editLineFrequency(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: {
    routeId: number;
    bands: { fromSecs: number; toSecs: number; headwaySecs: number }[];
    /** Share the new departures between every stop pattern in each direction, in the proportions they run now. */
    allPatterns?: boolean;
  },
) {
  const routeId = Number(body.routeId);
  const bands = (body.bands ?? []).map((b) => ({
    from: Math.round(Number(b.fromSecs)),
    to: Math.round(Number(b.toSecs)),
    headway: Math.round(Number(b.headwaySecs)),
  }));
  if (!bands.length || bands.length > 12) throw fail(400, 'Give between one and twelve time bands');
  for (const b of bands) {
    if (!(b.to > b.from) || b.from < 0 || b.to > 30 * 3600)
      throw fail(
        400,
        'Each time band must end after it starts, and no later than 06:00 the next morning',
      );
    if (!(b.headway >= 60) || b.headway > 4 * 3600)
      throw fail(400, 'Each frequency must be between 1 minute and 4 hours');
  }
  const vis = visible(tx, 't', sc);
  const [route] =
    await tx`select coalesce(short_name, long_name) as name from routes where id = ${routeId}`;
  if (!route) throw fail(404, 'Line not found');
  const counted = await tx`
    select t.pattern_id, coalesce(t.direction_id, 0) as direction, count(*)::int as n
    from trips t where t.route_id = ${routeId} and t.pattern_id is not null and ${vis} group by 1, 2
    order by direction, n desc, t.pattern_id`;
  if (!counted.length) throw fail(400, 'This line has no trips to copy');
  const allPatterns = body.allPatterns === true;
  const directions = [...new Set(counted.map((c) => c.direction))];

  const createdIds: number[] = [];
  let replacedCount = 0;
  let keptPinned = 0;
  let batch = 0;
  let patternsUsed = 0;
  for (const direction of directions) {
    const inDirection = counted.filter((c) => c.direction === direction);
    // The most-used stop pattern, or every pattern when the new departures are to be shared between them.
    const patterns = (allPatterns ? inDirection : inDirection.slice(0, 1)).map(
      (c) => c.pattern_id as number,
    );
    patternsUsed = Math.max(patternsUsed, patterns.length);
    const existing = await tx`
      select t.id, t.start_secs, t.pinned, t.pattern_id from trips t where t.pattern_id = any(${patterns}) and ${vis} order by t.start_secs`;
    for (const band of bands) {
      const middle = (band.from + band.to) / 2;
      const inBand = existing.filter((t) => t.start_secs >= band.from && t.start_secs < band.to);
      const pinned = inBand.filter((t) => t.pinned);
      const replaced = inBand.filter((t) => !t.pinned).map((t) => t.id);
      const starts: number[] = [];
      for (let s = band.from; s < band.to; s += band.headway) {
        if (!pinned.some((p) => Math.abs(p.start_secs - s) < band.headway / 2)) starts.push(s);
      }
      await removeTrips(tx, sc, seq, replaced);
      replacedCount += replaced.length;
      keptPinned += pinned.length;
      if (!starts.length) continue;
      // Each pattern keeps the share of departures it has in this part of the day; a part of the day
      // with no trips at all goes to the most-used pattern. Departures are dealt out in turn, so
      // the patterns stay evenly mixed.
      const share = patterns.map((p) => inBand.filter((t) => t.pattern_id === p).length);
      const total = share.reduce((sum, n) => sum + n, 0);
      const weight =
        total > 0 ? share.map((n) => n / total) : patterns.map((_, i) => (i === 0 ? 1 : 0));
      const credit = patterns.map(() => 0);
      const dealt: number[][] = patterns.map(() => []);
      for (const start of starts) {
        let pick = 0;
        for (let i = 0; i < patterns.length; i++) {
          credit[i] += weight[i];
          if (credit[i] > credit[pick] + 1e-9) pick = i;
        }
        credit[pick] -= 1;
        dealt[pick].push(start);
      }
      for (let i = 0; i < patterns.length; i++) {
        if (!dealt[i].length) continue;
        const own = existing.filter((t) => t.pattern_id === patterns[i]);
        const template = own.reduce((best, t) =>
          Math.abs(t.start_secs - middle) < Math.abs(best.start_secs - middle) ? t : best,
        );
        batch++;
        const created = await tx.unsafe(
          `insert into trips (${TRIP_COLUMNS}, gtfs_id, start_secs, end_secs, scenario_id, cloned_from, created_edit)
           select ${TRIP_COLUMNS},
                  split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || $5::int || '-' || row_number() over (order by s.start),
                  s.start, end_secs + (s.start - start_secs), $1::int, id, $2::int
           from trips, unnest($4::int[]) as s(start) where id = $3::bigint
           returning id, start_secs`,
          [sc.id, seq, template.id, dealt[i], batch] as never[],
        );
        await tx`
          insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
          select n.id, st.seq, st.stop_id, st.arr + (n.start_secs - ${template.start_secs}), st.dep + (n.start_secs - ${template.start_secs}),
                 st.dist, st.pickup_type, st.drop_off_type, st.timepoint, st.headsign, st.note
          from trips n join stop_times st on st.trip_id = ${template.id}
          where n.id = any(${created.map((r) => r.id)})`;
        for (const r of created) createdIds.push(r.id);
      }
    }
  }
  const fleet = await assignVehicles(tx, sc, seq, createdIds);
  const settled = await settlePlatforms(tx, sc, seq, createdIds);
  return {
    summary: `${route.name}: new frequency in ${bands.length} time band${bands.length === 1 ? '' : 's'}, ${directions.length > 1 ? 'both directions' : 'one direction'}${allPatterns && patternsUsed > 1 ? `, shared between ${patternsUsed} stop patterns` : ''} (${createdIds.length} trips, replacing ${replacedCount}${keptPinned ? `, keeping ${keptPinned} placed by hand` : ''})${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
  };
}

const reshapeDeps: ReshapeDeps = { cloneTrips, newLine: NEW_LINE, skipPenalty: SKIP_PENALTY };
const closureDeps = { ...reshapeDeps, assignVehicles, removeTrips, fleetFigures, dayFigures };
const deleteStopDeps = {
  cloneTrips,
  removeTrips,
  skipPenalty: SKIP_PENALTY,
  clashes: async (tx: Tx, sc: Scenario) => (await conflictsIn(tx, sc, false)).conflicts.length,
};
const schedule = scheduleEdits({
  cloneTrips,
  assignVehicles,
  describe: describe as never,
  fleetNote,
  skipPenalty: SKIP_PENALTY,
  newLine: NEW_LINE,
});
const { settlePlatforms, platformNote } = schedule;

interface ReshapeBody {
  patternId: number;
  stopIds: number[];
  followRoads?: boolean;
  direct?: boolean;
  bothWays?: boolean;
}
const reshapeOptions = (body: ReshapeBody) => ({
  followRoads: body.followRoads !== false,
  direct: body.direct === true,
  platformIndex: 0,
});

/**
 * Gives one of a line's stop patterns a new list of stops and rebuilds every trip that uses it:
 * extending, cutting short, re-routing, adding or removing a stop. Unless told otherwise the
 * line's other direction is changed to match.
 */
async function editReshape(tx: Tx, sc: Scenario, seq: number, body: ReshapeBody) {
  const options = reshapeOptions(body);
  const plan = await planReshape(
    tx,
    sc,
    Number(body.patternId),
    body.stopIds ?? [],
    options,
    reshapeDeps,
  );
  const other =
    body.bothWays === false ? null : await planOtherWay(tx, sc, plan, options, reshapeDeps);
  const done = await applyReshape(tx, sc, seq, plan, 0, reshapeDeps);
  const idMap = { ...done.idMap };
  let otherNote = '';
  if (other && 'plan' in other) {
    const back = await applyReshape(tx, sc, seq, other.plan, 1, reshapeDeps);
    Object.assign(idMap, back.idMap);
    otherNote = `. The other direction changed to match: ${describeStops(other.plan)}, ${back.trips} trip${back.trips === 1 ? '' : 's'}, ${describeChange(back.changeSecs)}`;
  } else if (other && 'reason' in other) {
    otherNote = `. The other direction is unchanged: ${other.reason}`;
  }
  const stretches = describeNewStretches(plan);
  const towards = plan.stops[plan.stops.length - 1].name
    .replace(/,.*$/, '')
    .replace(/ Station$/, '');
  return {
    summary: `${plan.routeName} towards ${towards}: ${describeStops(plan)} on ${done.trips} trip${done.trips === 1 ? '' : 's'}, ${describeChange(done.changeSecs)}${stretches ? `; ${stretches}` : ''}${otherNote}`,
    idMap,
    routeId: plan.routeId,
  };
}

/** Runs a line, one vehicle's day, or one trip with a chosen vehicle type. */
async function editSetVehicleType(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { scope: 'route' | 'vehicleDay' | 'trip'; id: number; vehicleTypeId: number },
) {
  const id = Number(body.id);
  const [type] = await tx`
    select v.id, v.name, m.rule_set, m.name as mode_name from vehicle_types v join modes m on m.id = v.mode_id where v.id = ${Number(body.vehicleTypeId)}`;
  if (!type) throw fail(400, 'Unknown vehicle type');
  const vis = visible(tx, 't', sc);
  let ids: number[];
  let what: string;
  if (body.scope === 'trip') {
    ids = [id];
    what = (await describe(tx, id)).label;
  } else if (body.scope === 'vehicleDay') {
    ids = (await tx`select t.id from trips t where t.vehicle_day_id = ${id} and ${vis}`).map(
      (r) => r.id,
    );
    const [vd] = await tx`select label from vehicle_days where id = ${id}`;
    what = vd?.label ?? 'Vehicle';
  } else if (body.scope === 'route') {
    ids = (
      await tx`select t.id from trips t where t.route_id = ${id} and t.baseline_id = ${sc.baselineId} and ${vis}`
    ).map((r) => r.id);
    const [r] =
      await tx`select coalesce(short_name, long_name) as name from routes where id = ${id}`;
    what = `Line ${r?.name ?? ''}`;
  } else {
    throw fail(400, 'Unknown scope');
  }
  if (!ids.length) throw fail(400, 'No trips to change');
  const [wrong] = await tx`
    select m.name from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
    where t.id = any(${ids}) and m.rule_set <> ${type.rule_set} limit 1`;
  if (wrong)
    throw fail(
      400,
      `${type.name} is a ${String(type.mode_name).toLowerCase()} vehicle, so it cannot run a ${String(wrong.name).toLowerCase()} service`,
    );
  const idMap = await cloneTrips(tx, sc, seq, ids, 0, { replace: true, keepVehicle: true });
  await tx`update trips set vehicle_type_id = ${type.id} where id = any(${Object.values(idMap)})`;
  return {
    summary: `${what} now runs with ${type.name}${ids.length > 1 ? ` (${ids.length} trips)` : ''}`,
    idMap,
    focusTripId: body.scope === 'trip' ? idMap[id] : undefined,
  };
}

type Ripple = 'none' | 'vehicle' | 'line';

async function editShift(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { tripIds: number[]; delta: number; ripple?: Ripple },
) {
  const delta = Math.round(Number(body.delta));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 6 * 3600)
    throw fail(400, 'Shift must be between 1 second and 6 hours');
  const chosen = body.tripIds.map(Number);
  if (!chosen.length) throw fail(400, 'No trips given');
  const ids = new Set<number>(chosen);
  const vis = visible(tx, 't', sc);
  for (const id of chosen) {
    const t = await describe(tx, id);
    if (body.ripple === 'vehicle' && t.vehicle_day_id) {
      const rows =
        await tx`select t.id from trips t where t.vehicle_day_id = ${t.vehicle_day_id} and t.start_secs > ${t.start_secs} and ${vis}`;
      for (const r of rows) ids.add(r.id);
    } else if (body.ripple === 'line') {
      const rows = await tx`
        select t.id from trips t where t.baseline_id = ${sc.baselineId} and t.route_id = ${t.route_id}
          and t.direction_id is not distinct from ${t.direction_id} and t.start_secs > ${t.start_secs} and ${vis}`;
      for (const r of rows) ids.add(r.id);
    }
  }
  const all = [...ids];
  const [{ earliest, latest }] =
    await tx`select min(start_secs) as earliest, max(end_secs) as latest from trips where id = any(${all})`;
  if (earliest + delta < 0) throw fail(400, 'That would start before the service day begins');
  if (delta > 0 && latest + delta > 36 * 3600)
    throw fail(
      400,
      'That would run past midday the next day, which is later than a service day can go',
    );
  const first = await describe(tx, chosen[0]);
  const idMap = await cloneTrips(tx, sc, seq, all, delta, {
    pinnedIds: chosen,
    replace: true,
    keepVehicle: true,
  });
  const extra = all.length - chosen.length;
  return {
    summary: `Moved ${first.label} ${minutes(delta)} ${delta > 0 ? 'later' : 'earlier'}${extra > 0 ? ` with ${extra} following trip${extra === 1 ? '' : 's'}` : ''}`,
    idMap,
    focusTripId: idMap[chosen[0]],
  };
}

async function editDelete(tx: Tx, sc: Scenario, seq: number, body: { tripIds: number[] }) {
  const ids = body.tripIds.map(Number);
  if (!ids.length) throw fail(400, 'No trips given');
  const first = await describe(tx, ids[0]);
  await removeTrips(tx, sc, seq, ids);
  return {
    summary:
      ids.length === 1
        ? `Deleted ${first.label}`
        : `Deleted ${ids.length} trips starting with ${first.label}`,
    idMap: {},
  };
}

/** Takes a whole line out of the scenario: every trip it still runs, in both directions. */
async function editDeleteLine(tx: Tx, sc: Scenario, seq: number, body: { routeId: number }) {
  const routeId = Number(body.routeId);
  const [route] = await tx`
    select coalesce(short_name, long_name, 'the line') as name from routes where id = ${routeId} and baseline_id = ${sc.baselineId}`;
  if (!route) throw fail(404, 'Line not found');
  const trips =
    await tx`select t.id from trips t where t.route_id = ${routeId} and ${visible(tx as unknown as Sql, 't', sc)}`;
  if (!trips.length) throw fail(400, 'That line has no trips left to delete');
  await removeTrips(
    tx,
    sc,
    seq,
    trips.map((t) => t.id),
  );
  return {
    summary: `Deleted line ${route.name}: ${trips.length} trip${trips.length === 1 ? '' : 's'}`,
    idMap: {},
  };
}

async function editDuplicate(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { tripId: number; startSecs: number },
) {
  const t = await describe(tx, Number(body.tripId));
  const start = Math.round(Number(body.startSecs));
  if (!Number.isFinite(start) || start < 0 || start > 36 * 3600)
    throw fail(400, 'Bad departure time');
  const idMap = await cloneTrips(tx, sc, seq, [Number(body.tripId)], start - t.start_secs, {
    pinnedIds: [Number(body.tripId)],
    replace: false,
    keepVehicle: false,
  });
  const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap));
  const settled = await settlePlatforms(tx, sc, seq, Object.values(idMap));
  return {
    summary: `Added a copy of ${t.label} departing ${formatSecs(start)}${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
    focusTripId: idMap[Number(body.tripId)],
  };
}

/** How many seconds a trip saves by running through a stop, learned from the timetable where possible. */
async function skipSaving(
  tx: Tx,
  baselineId: number,
  tripId: number,
  stopSeq: number,
  ruleSet: string,
) {
  const stops = await tx`
    select st.seq, st.arr, st.dep, coalesce(s.parent_id, s.id) as station,
           (st.pickup_type = 1 and st.drop_off_type = 1) as passing
    from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${tripId} order by st.seq`;
  const i = stops.findIndex((s) => s.seq === stopSeq);
  if (i <= 0 || i >= stops.length - 1)
    throw fail(400, 'The first and last stops cannot be skipped');
  if (stops[i].passing) throw fail(400, 'This trip already runs through that stop');
  // Nearest real stops either side.
  let a = i - 1;
  while (a > 0 && stops[a].passing) a--;
  let c = i + 1;
  while (c < stops.length - 1 && stops[c].passing) c++;
  const current = stops[c].arr - stops[a].dep;
  // Trips in the baseline that already run between those two stations without stopping.
  const [observed] = await tx`
    with runs as (
      select st.trip_id, st.dep, coalesce(s.parent_id, s.id) as station,
             lead(coalesce(s.parent_id, s.id)) over w as next_station, lead(st.arr) over w as next_arr
      from stop_times st join stops s on s.id = st.stop_id
      where st.trip_id in (
          select st2.trip_id from stop_times st2 join stops s2 on s2.id = st2.stop_id
          join trips t2 on t2.id = st2.trip_id
          where coalesce(s2.parent_id, s2.id) = ${stops[a].station} and t2.scenario_id is null and t2.baseline_id = ${baselineId})
        and not (st.pickup_type = 1 and st.drop_off_type = 1)
      window w as (partition by st.trip_id order by st.seq))
    select count(*)::int as n, percentile_cont(0.5) within group (order by next_arr - dep) as median
    from runs where station = ${stops[a].station} and next_station = ${stops[c].station}`;
  const fallback = current - (stops[i].dep - stops[i].arr) - (SKIP_PENALTY[ruleSet] ?? 20);
  let target =
    observed.n >= 3 && observed.median < current ? Math.round(observed.median) : fallback;
  target = Math.max(Math.round(current * 0.5), Math.min(current, target));
  return {
    saving: current - target,
    learned: observed.n >= 3 && observed.median < current,
    a: stops[a].seq,
    c: stops[c].seq,
  };
}

async function editSkipStop(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { tripId: number; stopSeq: number; scope?: 'trip' | 'pattern' },
) {
  const tripId = Number(body.tripId);
  const stopSeq = Number(body.stopSeq);
  const t = await describe(tx, tripId);
  const { saving, learned, a, c } = await skipSaving(
    tx,
    sc.baselineId,
    tripId,
    stopSeq,
    t.rule_set,
  );
  const [stop] =
    await tx`select s.name from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${tripId} and st.seq = ${stopSeq}`;
  let ids = [tripId];
  if (body.scope === 'pattern' && t.pattern_id) {
    const rows = await tx`
      select t.id from trips t where t.pattern_id = ${t.pattern_id} and ${visible(tx, 't', sc)}
        and exists (select 1 from stop_times st where st.trip_id = t.id and st.seq = ${stopSeq}
                    and not (st.pickup_type = 1 and st.drop_off_type = 1))`;
    ids = rows.map((r) => r.id);
  }
  const idMap = await cloneTrips(tx, sc, seq, ids, 0, {
    pinnedIds: body.scope === 'pattern' ? [] : [tripId],
    replace: true,
    keepVehicle: true,
  });
  const newIds = Object.values(idMap);
  // The stop stays in the trip as a pass-through, so the vehicle still follows the same path.
  // Times between the stops either side are re-spaced in proportion; everything after is earlier.
  // Each trip saves the same share of its own time between those two stops, never the clicked
  // trip's seconds: a trip that is quicker there than the clicked one would otherwise be given
  // more saving than it has time, and arrive before it left.
  const [clicked] = await tx`
    select y.arr - x.dep as gap from stop_times x join stop_times y on y.trip_id = x.trip_id and y.seq = ${c}
    where x.trip_id = ${tripId} and x.seq = ${a}`;
  const keep = clicked.gap > 0 ? Math.max(0.5, (clicked.gap - saving) / clicked.gap) : 1;
  await tx`
    update stop_times st set
      arr = case when st.seq >= ${c} then st.arr - b.saving
                 else b.a_dep + round((st.arr - b.a_dep) * b.ratio)::int end,
      dep = case when st.seq >= ${c} then st.dep - b.saving
                 when st.seq = ${stopSeq} then b.a_dep + round((st.arr - b.a_dep) * b.ratio)::int
                 else b.a_dep + round((st.dep - b.a_dep) * b.ratio)::int end,
      pickup_type = case when st.seq = ${stopSeq} then 1 else st.pickup_type end,
      drop_off_type = case when st.seq = ${stopSeq} then 1 else st.drop_off_type end
    from (
      select g.trip_id, g.a_dep, g.gap - g.target as saving, g.target::float8 / greatest(1, g.gap) as ratio
      from (
        select x.trip_id, x.dep as a_dep, greatest(0, y.arr - x.dep) as gap,
               greatest(0, round((y.arr - x.dep) * ${keep}::float8))::int as target
        from stop_times x join stop_times y on y.trip_id = x.trip_id and y.seq = ${c}
        where x.seq = ${a} and x.trip_id = any(${newIds})) g) b
    where st.trip_id = b.trip_id and st.seq > ${a}`;
  await tx`
    update trips t set end_secs = e.arr
    from (select st.trip_id, max(st.arr) as arr from stop_times st where st.trip_id = any(${newIds}) group by 1) e
    where t.id = e.trip_id`;
  const [{ backwards }] = await tx`
    select count(*)::int as backwards from (
      select st.arr, st.dep, lag(st.dep) over (partition by st.trip_id order by st.seq) as prev
      from stop_times st where st.trip_id = any(${newIds})) q
    where q.dep < q.arr or q.arr < q.prev`;
  if (backwards)
    throw fail(409, 'That would make a trip arrive before it left, so nothing was done');
  const name = String(stop.name).replace(/, Platform.*$/, '');
  return {
    summary: `${ids.length === 1 ? t.label : `${ids.length} ${t.line} trips`} now skip${ids.length === 1 ? 's' : ''} ${name}, saving ${ids.length === 1 ? '' : 'about '}${minutes(saving)}${ids.length === 1 ? '' : ' each'}${learned ? '' : ' (estimated)'}`,
    idMap,
    focusTripId: idMap[tripId],
  };
}

async function editHeadway(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { patternId: number; fromSecs: number; toSecs: number; headwaySecs: number },
) {
  const from = Math.round(Number(body.fromSecs));
  const to = Math.round(Number(body.toSecs));
  const headway = Math.round(Number(body.headwaySecs));
  if (!(to > from) || from < 0 || to > 30 * 3600)
    throw fail(
      400,
      'The time band must end after it starts, and no later than 06:00 the next morning',
    );
  if (!(headway >= 60) || headway > 4 * 3600)
    throw fail(400, 'Headway must be between 1 minute and 4 hours');
  const vis = visible(tx, 't', sc);
  const existing = await tx`
    select t.id, t.start_secs, t.pinned from trips t
    where t.pattern_id = ${Number(body.patternId)} and ${vis} order by t.start_secs`;
  if (!existing.length)
    throw fail(400, 'No trips use that stopping pattern, so there is nothing to copy');
  const middle = (from + to) / 2;
  // Copy the trip nearest the middle of the band: its run times are the most representative.
  const template = existing.reduce((best, t) =>
    Math.abs(t.start_secs - middle) < Math.abs(best.start_secs - middle) ? t : best,
  );
  const inBand = existing.filter((t) => t.start_secs >= from && t.start_secs < to);
  const pinned = inBand.filter((t) => t.pinned);
  const replaced = inBand.filter((t) => !t.pinned).map((t) => t.id);
  const starts: number[] = [];
  for (let s = from; s < to; s += headway) {
    // Leave room around hand-placed trips rather than doubling up on them.
    if (!pinned.some((p) => Math.abs(p.start_secs - s) < headway / 2)) starts.push(s);
  }
  const t = await describe(tx, template.id);
  await removeTrips(tx, sc, seq, replaced);
  let fleet = { reused: 0, added: 0 };
  let settled = 0;
  if (starts.length) {
    const created = await tx.unsafe(
      `insert into trips (${TRIP_COLUMNS}, gtfs_id, start_secs, end_secs, scenario_id, cloned_from, created_edit)
       select ${TRIP_COLUMNS},
              split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || row_number() over (order by s.start),
              s.start, end_secs + (s.start - start_secs), $1::int, id, $2::int
       from trips, unnest($4::int[]) as s(start) where id = $3::bigint
       returning id, start_secs`,
      [sc.id, seq, template.id, starts] as never[],
    );
    await tx`
      insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
      select n.id, st.seq, st.stop_id, st.arr + (n.start_secs - ${template.start_secs}), st.dep + (n.start_secs - ${template.start_secs}),
             st.dist, st.pickup_type, st.drop_off_type, st.timepoint, st.headsign, st.note
      from trips n join stop_times st on st.trip_id = ${template.id}
      where n.id = any(${created.map((r) => r.id)})`;
    fleet = await assignVehicles(
      tx,
      sc,
      seq,
      created.map((r) => r.id),
    );
    settled = await settlePlatforms(
      tx,
      sc,
      seq,
      created.map((r) => r.id),
    );
  }
  return {
    summary: `${t.line}: every ${minutes(headway)} from ${formatSecs(from)} to ${formatSecs(to)} (${starts.length} trips, replacing ${replaced.length}${pinned.length ? `, keeping ${pinned.length} pinned` : ''})${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
  };
}

// -------------------------------------------------------------------------
// Conflicts caused by the scenario's own trips
// -------------------------------------------------------------------------
const findConflicts = (sql: Sql, sc: Scenario) => conflictsIn(sql, sc);
/**
 * The same, read through any connection: an edit asks from inside its own transaction, to say how
 * many clashes it caused. With `withFixes` false the suggested platform for each clash is not looked up.
 */
async function conflictsIn(sql: Sql, sc: Scenario, withFixes = true) {
  const visT = visible(sql, 't', sc);
  const visO = visible(sql, 'o', sc);
  const mine = sql`t.scenario_id = ${sc.id} and ${visT}`;

  const platform = await sql`
    select t.id as "tripId", o.id as "otherTripId", st.stop_id as "stopId", st.seq, s.name as "stopName",
           r.short_name as line, ro.short_name as "otherLine",
           greatest(st.arr, so.arr) as "fromSecs", least(st.dep, so.dep) as "toSecs",
           st.arr, so.dep as "otherDep", t.start_secs as "startSecs", o.start_secs as "otherStart"
    from trips t
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    join stop_times st on st.trip_id = t.id and not (st.pickup_type = 1 and st.drop_off_type = 1)
    join stops s on s.id = st.stop_id
    join stop_times so on so.stop_id = st.stop_id and so.trip_id <> st.trip_id
      and so.arr < st.dep and st.arr < so.dep and not (so.pickup_type = 1 and so.drop_off_type = 1)
    join trips o on o.id = so.trip_id
    join routes ro on ro.id = o.route_id
    where ${mine} and m.rule_set in ('rail', 'ferry') and ${visO}
      -- Report each pair once, and not the two halves of a through-running vehicle.
      and (o.scenario_id is null or o.id > t.id)
      and (t.vehicle_day_id is null or o.vehicle_day_id is distinct from t.vehicle_day_id)
    order by "fromSecs" limit 200`;

  const vehicle = await sql`
    select t.id as "tripId", o.id as "otherTripId", r.short_name as line, vd.label as vehicle,
           t.end_secs as "endSecs", o.start_secs as "otherStart", t.start_secs as "startSecs"
    from trips t
    join routes r on r.id = t.route_id
    join vehicle_days vd on vd.id = t.vehicle_day_id
    join trips o on o.vehicle_day_id = t.vehicle_day_id and o.id <> t.id
      and o.start_secs >= t.start_secs and o.start_secs < t.end_secs
    where (t.scenario_id = ${sc.id} or o.scenario_id = ${sc.id}) and ${visT} and ${visO}
      and (o.start_secs > t.start_secs or o.id > t.id)
    order by t.end_secs limit 200`;

  // A vehicle that ends a trip at a platform and starts its next from the same one holds it in between.
  // Reported when a trip the scenario made or retimed is the one waiting, or the one calling there.
  const changed = (alias: string) => {
    const t = sql(alias);
    return sql`(${t}.scenario_id = ${sc.id} and (${t}.origin_trip_id is null or exists (
      select 1 from trips og where og.id = ${t}.origin_trip_id
        and (og.start_secs <> ${t}.start_secs or og.end_secs <> ${t}.end_secs or og.first_stop_id <> ${t}.first_stop_id
             or og.last_stop_id <> ${t}.last_stop_id or og.vehicle_day_id is distinct from ${t}.vehicle_day_id))))`;
  };
  const waitingFor = (start: ReturnType<typeof sql>, where: ReturnType<typeof sql>) => sql`
    select a.id as "waitTripId", b.id as "nextTripId", o.id as "tripId", so.seq, a.last_stop_id as "stopId", s.name as "stopName",
           r.short_name as line, ro.short_name as "otherLine", a.end_secs as "from", b.start_secs as "to",
           so.arr, so.dep, o.start_secs as "startSecs", vd.label as vehicle
    from ${start}
    join routes r on r.id = a.route_id
    join modes m on m.id = r.mode_id
    join stops s on s.id = a.last_stop_id
    join vehicle_days vd on vd.id = a.vehicle_day_id
    join routes ro on ro.id = o.route_id
    where ${where} and m.rule_set in ('rail', 'ferry') and s.parent_id is not null
      and ${visible(sql, 'a', sc)} and ${visible(sql, 'b', sc)} and ${visO}
      and o.vehicle_day_id is distinct from a.vehicle_day_id
      and not exists (select 1 from trips c where c.vehicle_day_id = a.vehicle_day_id and c.id not in (a.id, b.id)
                      and c.start_secs >= a.end_secs and c.start_secs < b.start_secs and ${visible(sql, 'c', sc)})
    order by so.arr limit 60`;
  const waitJoin = sql`
    join trips b on b.vehicle_day_id = a.vehicle_day_id and b.first_stop_id = a.last_stop_id and b.id <> a.id
      and b.start_secs > a.end_secs and b.start_secs <= a.end_secs + 3600`;
  const callJoin = sql`
    join stop_times so on so.stop_id = a.last_stop_id and so.trip_id not in (a.id, b.id) and so.arr < b.start_secs and so.dep > a.end_secs
      and not (so.pickup_type = 1 and so.drop_off_type = 1)
    join trips o on o.id = so.trip_id`;
  const waiting = [
    // The waiting vehicle's trips are the scenario's.
    ...(await waitingFor(
      sql`trips a ${waitJoin} ${callJoin}`,
      sql`a.scenario_id = ${sc.id} and (${changed('a')} or ${changed('b')})`,
    )),
    // The trip calling there is the scenario's.
    ...(await waitingFor(
      sql`trips o
        join stop_times so on so.trip_id = o.id and not (so.pickup_type = 1 and so.drop_off_type = 1)
        join trips a on a.last_stop_id = so.stop_id and a.id <> o.id and a.end_secs < so.dep and a.end_secs > so.arr - 3600
        ${waitJoin} and b.id <> o.id and b.start_secs > so.arr`,
      sql`o.scenario_id = ${sc.id} and ${changed('o')} and not (a.scenario_id is not distinct from ${sc.id} and (${changed('a')} or ${changed('b')}))`,
    )),
  ];

  const [{ n: unassigned }] =
    await sql`select count(*)::int as n from trips t where ${mine} and t.vehicle_day_id is null`;

  // ---------------------------------------------------------------------
  // Reality checks: what no vehicle can do. Each compares with the published timetable, because
  // the feed itself has oddities (hundreds of bus hops timed at over 150 km/h), and those are
  // not the scenario's doing.
  // ---------------------------------------------------------------------
  // 1. A stretch between two consecutive stops that the scenario's trip runs backwards in time, or
  //    faster than its mode can go in a straight line, unless a published trip runs that same
  //    stretch as fast.
  const limitModes = Object.keys(MODE_MAX_KMH);
  const speedRows = await sql`
    with calls as (
      select t.id, t.route_id, t.start_secs, st.seq, st.stop_id, st.arr, st.dep,
             lag(st.stop_id) over w as prev_stop, lag(st.dep) over w as prev_dep
      from trips t join stop_times st on st.trip_id = t.id
      where ${mine}
      window w as (partition by t.id order by st.seq)),
    hops as (
      select c.id, c.route_id, c.start_secs, c.seq, c.prev_stop, c.stop_id, c.prev_dep, c.arr - c.prev_dep as secs,
             (c.arr < c.prev_dep or c.dep < c.arr) as backwards,
             ST_DistanceSphere(a.geom, b.geom) as metres, a.name as from_name, b.name as to_name
      from calls c join stops a on a.id = c.prev_stop join stops b on b.id = c.stop_id
      where c.prev_stop is not null)
    select h.id as "tripId", h.seq, h.start_secs as "startSecs", h.prev_dep as "atSecs", h.secs, h.metres, h.backwards,
           h.from_name as "from", h.to_name as "to", h.prev_stop as "fromId", h.stop_id as "toId",
           coalesce(r.short_name, r.long_name, 'Trip') as line, r.id as "routeId", m.name as mode, lim.kmh
    from hops h
    join routes r on r.id = h.route_id
    join modes m on m.id = r.mode_id
    join unnest(${limitModes}::text[], ${limitModes.map((k) => MODE_MAX_KMH[k])}::float8[]) as lim(mode_id, kmh) on lim.mode_id = r.mode_id
    where h.backwards
       or (h.metres > 300 and h.secs * lim.kmh / 3.6 < h.metres
           and not exists (
             select 1 from stop_times x
             join stop_times y on y.trip_id = x.trip_id and y.seq = x.seq + 1
             join trips p on p.id = x.trip_id
             where x.stop_id = h.prev_stop and y.stop_id = h.stop_id and p.scenario_id is null and y.arr - x.dep <= h.secs))
    order by h.backwards desc, h.metres / greatest(h.secs, 1) desc
    limit 2000`;

  // 2. A vehicle whose next trip starts somewhere it cannot have reached. Looked for on every
  //    vehicle the scenario has touched: one that runs a trip the scenario made, or that lost one.
  //    Two published trips with nothing removed between them are the feed's own business.
  const placeRows = await sql`
    with days as (
      select t.vehicle_day_id as vd from trips t where ${mine} and t.vehicle_day_id is not null
      union
      select t.vehicle_day_id from scenario_removed x join trips t on t.id = x.trip_id
      where x.scenario_id = ${sc.id} and x.edit_seq <= ${sc.head} and t.vehicle_day_id is not null),
    run as (
      select t.id, t.vehicle_day_id, t.route_id, t.scenario_id, t.start_secs, t.end_secs, t.last_stop_id,
             lead(t.id) over w as next_id, lead(t.start_secs) over w as next_start, lead(t.first_stop_id) over w as next_first,
             lead(t.scenario_id) over w as next_scenario
      from trips t join days d on d.vd = t.vehicle_day_id
      where ${visT}
      window w as (partition by t.vehicle_day_id order by t.start_secs, t.id))
    select q.* from (
      select s.id as "tripId", s.next_id as "nextTripId", s.end_secs as "endSecs", s.next_start as "nextStart", s.start_secs as "startSecs",
             coalesce(r.short_name, r.long_name, 'Trip') as line, vd.label as vehicle, m.rule_set as "ruleSet",
             coalesce(lp.name, l.name) as "from", coalesce(fp.name, f.name) as "to",
             ST_DistanceSphere(coalesce(lp.geom, l.geom), coalesce(fp.geom, f.geom)) as metres
      from run s
      join routes r on r.id = s.route_id
      join modes m on m.id = r.mode_id
      join vehicle_days vd on vd.id = s.vehicle_day_id
      join stops l on l.id = s.last_stop_id
      join stops f on f.id = s.next_first
      left join stops lp on lp.id = l.parent_id and m.rule_set <> 'road'
      left join stops fp on fp.id = f.parent_id and m.rule_set <> 'road'
      where s.next_id is not null and s.next_start >= s.end_secs
        and (s.scenario_id is not null or s.next_scenario is not null or exists (
          select 1 from scenario_removed x join trips g on g.id = x.trip_id
          where x.scenario_id = ${sc.id} and x.edit_seq <= ${sc.head} and g.vehicle_day_id = s.vehicle_day_id
            and g.start_secs >= s.start_secs and g.start_secs <= s.next_start))) q
    where q.metres > case q."ruleSet" when 'rail' then ${SAME_PLACE_M.rail} when 'ferry' then ${SAME_PLACE_M.ferry} else ${SAME_PLACE_M.road} end::float8
      and (q."nextStart" - q."endSecs")
          * case q."ruleSet" when 'rail' then ${DEAD_RUN_KMH.rail} when 'ferry' then ${DEAD_RUN_KMH.ferry} else ${DEAD_RUN_KMH.road} end::float8 / 3.6 < q.metres
    order by q.metres / greatest(1, q."nextStart" - q."endSecs") desc
    limit 200`;

  // 3. A path the scenario made after a closure that runs through it. (Trips that were already
  //    running through, by choice or because no way round was found, are in the closure's own summary.)
  const closureRows = await sql`
    select c.label, r.id as "routeId", coalesce(r.short_name, r.long_name, 'Line') as line, count(*)::int as trips,
           min(t.id) as "tripId", min(t.start_secs) as "startSecs"
    from scenario_closures c
    join shapes sh on sh.scenario_id = ${sc.id} and sh.created_edit > c.created_edit and sh.created_edit <= ${sc.head} and ST_Intersects(sh.geom, c.geom)
    join trips t on t.shape_id = sh.id
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    where c.scenario_id = ${sc.id} and c.created_edit <= ${sc.head} and ${visT}
      and (c.kind = 'cut' or (c.kind = 'road' and m.rule_set = 'road') or c.kind = r.mode_id)
      and (c.from_secs is null or (t.start_secs < c.to_secs and t.end_secs > c.from_secs))
    group by c.id, c.label, r.id
    order by trips desc
    limit 60`;

  // A free platform at the same station is the gentler fix where there is one. Looked up for the
  // first clashes only, which are the ones shown.
  type Fix = { label: string; edit: Record<string, unknown> };
  const platformFix = async (
    tripId: number,
    seq: number,
  ): Promise<{ fix: Fix; usual: boolean } | null> => {
    const best = bestFree(await platformChoices(sql, sc, tripId, seq));
    if (!best) return null;
    return {
      fix: {
        label: `Use platform ${best.platformCode ?? best.name} instead${best.uses ? '' : ' (not one this line normally uses)'}`,
        edit: { kind: 'setPlatform', tripId, stopSeq: seq, stopId: best.id },
      },
      usual: best.uses > 0,
    };
  };
  const withPlatform = async (
    fixes: Fix[],
    tripId: number,
    seq: number,
    index: number,
  ): Promise<Fix[]> => {
    if (index >= 30 || !withFixes) return fixes;
    const found = await platformFix(tripId, seq);
    if (!found) return fixes;
    return found.usual ? [found.fix, ...fixes] : [...fixes, found.fix];
  };

  const round30 = (secs: number) => Math.ceil(secs / 30) * 30;
  const platformConflicts = await Promise.all(
    platform.map(async (c, i) => {
      const delta = round30(c.otherDep - c.arr + 60);
      return {
        kind: 'platform' as const,
        tripId: c.tripId,
        otherTripId: c.otherTripId,
        stopId: c.stopId,
        atSecs: c.fromSecs,
        title: `${String(c.stopName).replace(/ Station/, '')}: two trips at once`,
        detail: `${c.line ?? 'Trip'} ${formatSecs(c.startSecs)} and ${c.otherLine ?? 'trip'} ${formatSecs(c.otherStart)} overlap at ${formatSecs(c.fromSecs)}`,
        fixes: await withPlatform(
          [
            {
              label: `Move the ${formatSecs(c.startSecs)} trip ${minutes(delta)} later`,
              edit: { kind: 'shift', tripIds: [c.tripId], delta, ripple: 'none' },
            },
          ],
          c.tripId,
          c.seq,
          i,
        ),
      };
    }),
  );
  const seenWaits = new Set<string>();
  const waitingConflicts = await Promise.all(
    waiting
      .filter((c) => {
        const key = `${c.waitTripId}|${c.tripId}`;
        if (
          seenWaits.has(key) ||
          platform.some(
            (p) =>
              (p.tripId === c.tripId && p.otherTripId === c.waitTripId) ||
              (p.tripId === c.waitTripId && p.otherTripId === c.tripId),
          )
        )
          return false;
        seenWaits.add(key);
        return true;
      })
      .map(async (c, i) => {
        const delta = round30(c.to - c.arr + 60);
        return {
          kind: 'platform' as const,
          tripId: c.tripId,
          otherTripId: c.waitTripId,
          stopId: c.stopId,
          atSecs: Math.max(c.arr, c.from),
          title: `${String(c.stopName).replace(/ Station/, '')}: a waiting vehicle is in the way`,
          detail: `${c.otherLine ?? 'Trip'} ${formatSecs(c.startSecs)} calls at ${formatSecs(c.arr)}, while ${c.vehicle} waits there from ${formatSecs(c.from)} to ${formatSecs(c.to)} for its next ${c.line ?? ''} trip`,
          fixes: await withPlatform(
            [
              {
                label: `Move the ${formatSecs(c.startSecs)} trip ${minutes(delta)} later`,
                edit: { kind: 'shift', tripIds: [c.tripId], delta, ripple: 'none' },
              },
            ],
            c.tripId,
            c.seq,
            i,
          ),
        };
      }),
  );
  const km = (metres: number) =>
    metres >= 950 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;
  const tidyStop = (name: string) =>
    String(name)
      .replace(/ Station/, '')
      .replace(/, Platform.*$/, '');
  // One row for each stretch of each line, however many trips run it.
  const speedGroups = new Map<string, { first: (typeof speedRows)[number]; trips: number }>();
  for (const row of speedRows) {
    const key = `${row.routeId}|${row.fromId}|${row.toId}|${row.backwards}`;
    const known = speedGroups.get(key);
    if (known) known.trips++;
    else speedGroups.set(key, { first: row, trips: 1 });
  }
  const speedConflicts = [...speedGroups.values()].slice(0, 60).map(({ first: c, trips }) => {
    const others =
      trips > 1 ? `, and ${trips - 1} more trip${trips === 2 ? '' : 's'} on the same stretch` : '';
    const kmh = c.secs > 0 ? Math.round((c.metres / c.secs) * 3.6) : null;
    return {
      kind: 'speed' as const,
      tripId: c.tripId as number,
      otherTripId: c.tripId as number,
      atSecs: c.atSecs as number,
      title: c.backwards
        ? `${c.line}: arrives before it left`
        : `${c.line}: faster than a ${String(c.mode).toLowerCase()} can go`,
      detail: c.backwards
        ? `${c.line} ${formatSecs(c.startSecs)}: the times at ${tidyStop(c.to)} run backwards${others}`
        : `${c.line} ${formatSecs(c.startSecs)}: ${tidyStop(c.from)} to ${tidyStop(c.to)} is ${km(c.metres)} in a straight line and is timed at ${c.secs} s${kmh === null ? '' : ` (${kmh} km/h; the most allowed for is ${c.kmh})`}${others}`,
      fixes: [] as Fix[],
    };
  });
  const placeConflicts = placeRows.map((c) => ({
    kind: 'place' as const,
    tripId: c.nextTripId as number,
    otherTripId: c.tripId as number,
    atSecs: c.nextStart as number,
    title: `${c.vehicle}: cannot get to its next trip`,
    detail: `${c.line} ${formatSecs(c.startSecs)} ends at ${tidyStop(c.from)} at ${formatSecs(c.endSecs)}; the vehicle's next trip leaves ${tidyStop(c.to)}, ${km(c.metres)} away, at ${formatSecs(c.nextStart)}`,
    fixes: [
      {
        label: 'Put the later trip on another vehicle',
        edit: { kind: 'setVehicle', tripId: c.nextTripId, mode: 'auto' },
      },
    ] as Fix[],
  }));
  const closureConflicts = closureRows.map((c) => ({
    kind: 'closure' as const,
    tripId: c.tripId as number,
    otherTripId: c.tripId as number,
    atSecs: c.startSecs as number,
    title: `${c.line}: runs through a closure`,
    detail: `${c.trips} trip${c.trips === 1 ? '' : 's'} on a path made after "${c.label}" run through it`,
    fixes: [] as Fix[],
  }));
  // The lists above each stop at a limit. Reaching one means there are more clashes than are counted.
  const capped =
    platform.length >= 200 ||
    vehicle.length >= 200 ||
    waiting.length >= 60 ||
    speedRows.length >= 2000 ||
    placeRows.length >= 200;
  const conflicts = [
    ...speedConflicts,
    ...closureConflicts,
    ...placeConflicts,
    ...platformConflicts,
    ...waitingConflicts,
    ...vehicle.map((c) => {
      const delta = round30(c.endSecs - c.otherStart + 60);
      return {
        kind: 'vehicle' as const,
        tripId: c.tripId,
        otherTripId: c.otherTripId,
        atSecs: c.otherStart,
        title: `${c.vehicle}: next trip leaves before it arrives`,
        detail: `${c.line ?? 'Trip'} ${formatSecs(c.startSecs)} arrives ${formatSecs(c.endSecs)}, but the vehicle's next trip leaves ${formatSecs(c.otherStart)}`,
        fixes: [
          {
            label: `Push the vehicle's later trips back ${minutes(delta)}`,
            edit: { kind: 'shift', tripIds: [c.otherTripId], delta, ripple: 'vehicle' },
          },
        ],
      };
    }),
  ];
  return { conflicts, unassigned, capped };
}

export function registerScenarioRoutes(app: FastifyInstance, sql: Sql) {
  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  app.get('/api/scenarios', async (req) => {
    const baseline = Number((req.query as Record<string, string>).baseline);
    return sql`
      select id, name, head, baseline_id as "baselineId", created_at as "createdAt",
             (select count(*)::int from scenario_edits e where e.scenario_id = s.id) as "editCount",
             (select count(*)::int from sim_runs r where r.scenario_id = s.id) as "simRuns"
      from scenarios s where ${Number.isInteger(baseline) ? sql`baseline_id = ${baseline}` : sql`true`}
      order by created_at`;
  });

  app.post('/api/scenarios', async (req) => {
    const body = req.body as { baselineId: number; name?: string };
    const [b] = await sql`select id from baselines where id = ${Number(body.baselineId)} and ready`;
    if (!b) throw fail(400, 'Unknown day');
    const [{ n }] = await sql`select count(*)::int as n from scenarios where baseline_id = ${b.id}`;
    const name = (body.name ?? '').trim().slice(0, 80) || `Scenario ${n + 1}`;
    const [row] =
      await sql`insert into scenarios (baseline_id, name) values (${b.id}, ${name}) returning id, name, head, baseline_id as "baselineId"`;
    return { ...row, editCount: 0 };
  });

  /** Rename a scenario. */
  app.patch('/api/scenarios/:id', async (req) => {
    const name = String((req.body as { name?: unknown })?.name ?? '')
      .trim()
      .slice(0, 80);
    if (!name) throw fail(400, 'Give the scenario a name');
    const [row] =
      await sql`update scenarios set name = ${name} where id = ${idParam(req)} returning id, name, head, baseline_id as "baselineId"`;
    if (!row) throw fail(404, 'Scenario not found');
    return row;
  });

  app.delete('/api/scenarios/:id', async (req) => {
    await sql`delete from scenarios where id = ${idParam(req)}`;
    return { ok: true };
  });

  app.get('/api/scenarios/:id', async (req) => {
    const sc = await loadScenario(sql, idParam(req));
    const [info] =
      await sql`select id, name, head, baseline_id as "baselineId" from scenarios where id = ${sc.id}`;
    const edits =
      await sql`select seq, kind, summary, (seq <= ${sc.head}) as applied from scenario_edits where scenario_id = ${sc.id} order by seq`;
    const vis = visible(sql, 't', sc);
    const [stats] = await sql`
      select
        (select count(*)::int from trips t where t.baseline_id = ${sc.baselineId} and t.scenario_id is null) as "baselineTrips",
        (select count(*)::int from trips t where t.baseline_id = ${sc.baselineId} and ${vis}) as trips,
        (select count(*)::int from trips t where t.scenario_id = ${sc.id} and ${vis}) as "editedTrips",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.baseline_id = ${sc.baselineId} and ${vis}) as vehicles,
        (select count(distinct t.vehicle_day_id)::int from trips t where t.baseline_id = ${sc.baselineId} and t.scenario_id is null) as "baselineVehicles"`;
    const { conflicts, unassigned, capped } = await findConflicts(sql, sc);
    const day = await dayFigures(sql, sc.baselineId, sc);
    const publishedDay = await dayFigures(sql, sc.baselineId, null);
    // Every line the scenario has touched, before and after.
    const impact = await sql`
      with touched as (
        select t.route_id from trips t where t.scenario_id = ${sc.id} and ${vis}
        union
        select t.route_id from scenario_removed x join trips t on t.id = x.trip_id
        where x.scenario_id = ${sc.id} and x.edit_seq <= ${sc.head})
      select r.id as "routeId", coalesce(r.short_name, r.long_name) as name, coalesce(r.color, m.color) as color,
        (select count(*)::int from trips t where t.route_id = r.id and t.scenario_id is null) as "tripsBefore",
        (select count(*)::int from trips t where t.route_id = r.id and ${vis}) as "tripsAfter",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.route_id = r.id and t.scenario_id is null) as "vehiclesBefore",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.route_id = r.id and ${vis}) as "vehiclesAfter",
        (select count(*)::int from trips t where t.route_id = r.id and t.scenario_id = ${sc.id} and ${vis}) as "changedTrips",
        (select coalesce(sum(v.seated + v.standing), 0)::int from trips t join trip_vehicle tv on tv.trip_id = t.id
           join vehicle_types v on v.id = tv.vehicle_type_id where t.route_id = r.id and t.scenario_id is null) as "placesBefore",
        (select coalesce(sum(v.seated + v.standing), 0)::int from trips t join trip_vehicle tv on tv.trip_id = t.id
           join vehicle_types v on v.id = tv.vehicle_type_id where t.route_id = r.id and ${vis}) as "placesAfter"
      from touched join routes r on r.id = touched.route_id join modes m on m.id = r.mode_id
      order by m.sort, r.short_name`;
    const fleet = await sql`
      select v.id, v.name, v.fleet_size as "fleetSize", count(distinct t.vehicle_day_id)::int as "inUse"
      from trips t join trip_vehicle tv on tv.trip_id = t.id join vehicle_types v on v.id = tv.vehicle_type_id
      where t.baseline_id = ${sc.baselineId} and ${vis} and v.fleet_size is not null
      group by v.id having count(distinct t.vehicle_day_id) > v.fleet_size
      order by v.name`;
    const [{ limits }] =
      await sql`select count(*) filter (where fleet_size is not null)::int as limits from vehicle_types`;
    return {
      ...info,
      edits,
      // peak: the most trips running at any one moment, a firmer measure of vehicles needed than the count of chains.
      stats: { ...stats, unassigned, peak: day.peak, baselinePeak: publishedDay.peak },
      conflicts,
      conflictsCapped: capped,
      impact,
      fleet,
      fleetLimitsSet: limits,
    };
  });

  app.post('/api/scenarios/:id/undo', async (req) => {
    const [row] =
      await sql`update scenarios set head = head - 1 where id = ${idParam(req)} and head > 0 returning head`;
    if (!row) throw fail(400, 'Nothing to undo');
    return row;
  });

  app.post('/api/scenarios/:id/redo', async (req) => {
    const id = idParam(req);
    const [row] = await sql`
      update scenarios set head = head + 1 where id = ${id}
        and head < (select coalesce(max(seq), 0) from scenario_edits where scenario_id = ${id}) returning head`;
    if (!row) throw fail(400, 'Nothing to redo');
    return row;
  });

  app.post('/api/scenarios/:id/edits', async (req) => {
    const body = req.body as { kind: string } & Record<string, unknown>;
    const run = {
      shift: editShift,
      delete: editDelete,
      deleteLine: editDeleteLine,
      duplicate: editDuplicate,
      skipStop: editSkipStop,
      headway: editHeadway,
      setVehicle: editSetVehicle,
      setVehicleType: editSetVehicleType,
      lineFrequency: editLineFrequency,
      createLine: editCreateLine,
      reshape: editReshape,
      addStop: editAddStop,
      setPlatform: schedule.editSetPlatform,
      replan: schedule.editReplan,
      moveToVehicle: schedule.editMoveToVehicle,
      addTrip: schedule.editAddTrip,
      addCall: schedule.editAddCall,
      close: (tx: Tx, sc: Scenario, seq: number, b: never) =>
        editClose(tx, sc, seq, b, closureDeps),
      deleteStop: (tx: Tx, sc: Scenario, seq: number, b: never) =>
        editDeleteStop(tx, sc, seq, b, deleteStopDeps),
    }[body.kind] as
      ((tx: Tx, sc: Scenario, seq: number, body: never) => Promise<EditResult>) | undefined;
    if (!run) throw fail(400, `Unknown edit "${body.kind}"`);
    // The editor sends `confirm: false` first: an edit that would add many vehicles then comes back
    // described, not applied, and is sent again with `confirm: true` once the user has seen the figure.
    return applyEdit(
      sql,
      idParam(req),
      body.kind,
      (tx, sc, seq) => run(tx, sc, seq, body as never),
      body.confirm !== false,
    );
  });

  /** The path a new line would take through these stops, for the preview while drawing. */
  app.post('/api/road-path', async (req) => {
    const body = req.body as {
      baselineId: number;
      stopIds: number[];
      modeId?: string;
      loop?: boolean;
    };
    const ids = (body.stopIds ?? []).map(Number).slice(0, 150);
    if (ids.length < 2) throw fail(400, 'Pick at least two stops');
    if (body.loop && ids[ids.length - 1] !== ids[0]) ids.push(ids[0]);
    const rows = await sql`
      select id, location_type, parent_id, ST_X(geom) as lon, ST_Y(geom) as lat from stops
      where id = any(${ids}) and baseline_id = ${Number(body.baselineId)}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (ids.some((id) => !byId.has(id))) throw fail(400, 'Unknown stop');
    const found = await linePath(
      sql,
      Number(body.baselineId),
      String(body.modeId ?? 'bus'),
      ids.map((id) => {
        const s = byId.get(id)!;
        return { id, lon: s.lon, lat: s.lat, stationId: s.location_type === 1 ? id : s.parent_id };
      }),
      { follow: true },
    );
    return {
      coords: found.coords,
      method: found.method,
      description: describeMethod(found.method),
    };
  });

  closureRoutes(app, sql, { loadScenario, idParam, deps: closureDeps });
  deleteStopRoutes(app, sql, { loadScenario, idParam: idParam as never, deps: deleteStopDeps });
  scheduleRoutes(app, sql);

  /** The stops of one stop pattern, in calling order, for the reshaping tool. */
  app.get('/api/patterns/:id/stops', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw fail(400, 'Bad pattern id');
    const [pattern] = await sql`
      select p.id, p.route_id as "routeId", coalesce(p.direction_id, 0) as direction, p.headsign from patterns p where p.id = ${id}`;
    if (!pattern) throw fail(404, 'Stop pattern not found');
    const stops = await sql`
      select s.id, s.name, s.parent_id as "parentId", ST_X(s.geom) as lon, ST_Y(s.geom) as lat
      from patterns p cross join unnest(p.stop_ids) with ordinality as o(stop_id, n)
      join stops s on s.id = o.stop_id where p.id = ${id} order by o.n`;
    return { ...pattern, stops };
  });

  /** What a reshape would do, for the preview while the stops are being changed. Changes nothing. */
  app.post('/api/reshape-preview', async (req) => {
    const body = req.body as ReshapeBody;
    const sc = await scenarioOf(req, sql);
    const options = reshapeOptions(body);
    const plan = await planReshape(
      sql,
      sc,
      Number(body.patternId),
      body.stopIds ?? [],
      options,
      reshapeDeps,
    );
    const other =
      body.bothWays === false ? null : await planOtherWay(sql, sc, plan, options, reshapeDeps);
    const side = async (p: typeof plan) => ({
      coords: p.coords,
      added: p.added,
      removed: p.removed,
      trips: p.tripIds.length,
      change: describeChange(await typicalChange(sql, p)),
      what: describeStops(p),
    });
    return {
      ...(await side(plan)),
      stretches: describeNewStretches(plan),
      stops: plan.stops.map((s) => ({
        id: s.id,
        name: s.name,
        lon: s.lon,
        lat: s.lat,
        parentId: s.parentId,
      })),
      otherWay: !other
        ? null
        : 'plan' in other
          ? await side(other.plan)
          : 'reason' in other
            ? { reason: other.reason }
            : { same: true },
    };
  });

  /** Stops this scenario added, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/stops', async (req) =>
    scenarioStopsGeoJson(sql, await loadScenario(sql, idParam(req))),
  );

  /** Lines this scenario created or reshaped, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/lines', async (req) => {
    const sc = await loadScenario(sql, idParam(req));
    const rows = await sql`
      select r.id, coalesce(r.short_name, '') as name, r.mode_id, coalesce(r.color, m.color) as color, ST_AsGeoJSON(s.geom) as geometry
      from routes r join modes m on m.id = r.mode_id
      join patterns p on p.route_id = r.id
      join shapes s on s.id = p.shape_id
      where p.scenario_id = ${sc.id} and p.created_edit <= ${sc.head}
        -- A pattern that has since been reshaped again, or cut by a closure, has no trips left and is not drawn.
        and exists (select 1 from trips t where t.pattern_id = p.id and ${visible(sql, 't', sc)})`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geometry),
        properties: { route_id: r.id, name: r.name, mode: r.mode_id, color: `#${r.color}` },
      })),
    };
  });

  /** Baseline trips this scenario has removed or replaced, so the map can stop drawing them. */
  app.get('/api/scenarios/:id/removed', async (req) => {
    const sc = await loadScenario(sql, idParam(req));
    const rows =
      await sql`select trip_id from scenario_removed where scenario_id = ${sc.id} and edit_seq <= ${sc.head}`;
    return rows.map((r) => r.trip_id);
  });

  /** The scenario's own trips as an animation pack, in the same format as the per-mode packs. */
  app.get('/api/scenarios/:id/pack', async (req, reply) => {
    const sc = await loadScenario(sql, idParam(req));
    const trips = await sql`
      select t.id, t.route_id, t.start_secs, t.end_secs, t.shape_id from trips t
      where t.scenario_id = ${sc.id} and ${visible(sql, 't', sc)} and t.shape_id is not null
      order by t.start_secs, t.id`;
    const shapeIds = [...new Set(trips.map((t) => t.shape_id))];
    const shapeRows = shapeIds.length
      ? await sql`
          select s.id, s.length_m, s.dists,
                 array(select ST_X((dp).geom) from ST_DumpPoints(s.geom) dp order by (dp).path[1]) as lon,
                 array(select ST_Y((dp).geom) from ST_DumpPoints(s.geom) dp order by (dp).path[1]) as lat
          from shapes s where s.id = any(${shapeIds})`
      : [];
    const shapeIndex = new Map<number, number>();
    const shapes = shapeRows.map((row, i) => {
      shapeIndex.set(row.id, i);
      const lon = row.lon as number[];
      const lat = row.lat as number[];
      // Distance along the line, scaled to the feed's own total so it lines up with the stop times.
      const dist = new Float64Array(lon.length);
      for (let k = 1; k < lon.length; k++) {
        const dx = (lon[k] - lon[k - 1]) * 111_320 * Math.cos((lat[k] * Math.PI) / 180);
        const dy = (lat[k] - lat[k - 1]) * 110_540;
        dist[k] = dist[k - 1] + Math.hypot(dx, dy);
      }
      const scale =
        dist[lon.length - 1] > 0 && row.length_m ? row.length_m / dist[lon.length - 1] : 1;
      const stored = row.dists as number[] | null;
      const keep = simplifyIndices(lon, lat, 8);
      return {
        lon: Int32Array.from(keep, (k) => Math.round(lon[k] * COORD_SCALE)),
        lat: Int32Array.from(keep, (k) => Math.round(lat[k] * COORD_SCALE)),
        dist: Float32Array.from(keep, (k) =>
          stored && stored.length === lon.length ? stored[k] : dist[k] * scale,
        ),
      };
    });

    const n = trips.length;
    const stops = n
      ? await sql<PackStopRow[]>`
          select st.trip_id, st.arr, st.dep, coalesce(st.dist, 0)::float4 as dist from stop_times st
          where st.trip_id = any(${trips.map((t) => t.id)}) order by st.trip_id, st.seq`
      : [];
    const byTrip = new Map<number, PackStopRow[]>();
    for (const s of stops) {
      let list = byTrip.get(s.trip_id);
      if (!list) byTrip.set(s.trip_id, (list = []));
      list.push(s);
    }
    const tripStOffset = new Uint32Array(n + 1);
    trips.forEach(
      (t, i) => (tripStOffset[i + 1] = tripStOffset[i] + (byTrip.get(t.id)?.length ?? 0)),
    );
    const total = tripStOffset[n];
    const shapePtOffset = new Uint32Array(shapes.length + 1);
    shapes.forEach((s, i) => (shapePtOffset[i + 1] = shapePtOffset[i] + s.lon.length));
    const points = shapePtOffset[shapes.length];
    const arrays: PackArrays = {
      tripId: Int32Array.from(trips, (t) => t.id),
      tripRoute: Int32Array.from(trips, (t) => t.route_id),
      tripStart: Int32Array.from(trips, (t) => t.start_secs),
      tripEnd: Int32Array.from(trips, (t) => t.end_secs),
      tripShape: Int32Array.from(trips, (t) => shapeIndex.get(t.shape_id)!),
      tripStOffset,
      stArr: new Int32Array(total),
      stDep: new Int32Array(total),
      stDist: new Float32Array(total),
      shapePtOffset,
      ptLon: new Int32Array(points),
      ptLat: new Int32Array(points),
      ptDist: new Float32Array(points),
    };
    trips.forEach((t, i) =>
      (byTrip.get(t.id) ?? []).forEach((s, k) => {
        arrays.stArr[tripStOffset[i] + k] = s.arr;
        arrays.stDep[tripStOffset[i] + k] = s.dep;
        arrays.stDist[tripStOffset[i] + k] = s.dist;
      }),
    );
    shapes.forEach((s, i) => {
      arrays.ptLon.set(s.lon, shapePtOffset[i]);
      arrays.ptLat.set(s.lat, shapePtOffset[i]);
      arrays.ptDist.set(s.dist, shapePtOffset[i]);
    });
    const bytes = encodePack(
      {
        version: 1,
        modeId: 'scenario',
        tripCount: n,
        stopTimeCount: total,
        shapeCount: shapes.length,
        pointCount: points,
      },
      arrays,
    );
    reply.header('content-type', 'application/octet-stream');
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}
