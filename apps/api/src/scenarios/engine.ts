// The scenario engine: what a scenario can see, and the one way an edit is applied.
//
// Every edit is applied by cloning the trips it touches into scenario-owned rows and marking the
// originals as removed. Rows carry the edit number that created or removed them, so undo and redo
// only move the scenario's `head`; nothing is ever recomputed backwards.
//
// Edit kinds import this file; it imports no edit kind.
import type { FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
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

export const TRIP_COLUMNS = `baseline_id, route_id, pattern_id, shape_id, service_gtfs_id, headsign, direction_id, feed_block_id,
  trip_name, run_key, set_type, cars, vehicle_type_id, first_stop_id, last_stop_id, extra`;

export type Tx = Sql;

export interface AddedStop {
  id: number;
  name: string;
  lon: number;
  lat: number;
  parentId: number | null;
  isStation: boolean;
}

export interface EditResult {
  summary: string;
  /** Old trip id to its replacement, so the client can keep the same trip selected. */
  idMap: Record<number, number>;
  focusTripId?: number;
  /** A line the edit created, so the client can open it. */
  routeId?: number;
  /** Stops the edit created, the one to use first. */
  stops?: AddedStop[];
}

/**
 * Replaces trips with shifted copies owned by the scenario. Returns old id to new id.
 * `keepVehicle` false detaches the copies from their vehicle (used for brand-new trips).
 */
export async function cloneTrips(
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
export async function requireLive(tx: Tx, sc: Scenario, seq: number, tripIds: number[]) {
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

export async function removeTrips(tx: Tx, sc: Scenario, seq: number, tripIds: number[]) {
  if (!tripIds.length) return;
  await requireLive(tx, sc, seq, tripIds);
  // A removal already recorded (by this same edit, since anything older is refused above) is kept as it is.
  await tx`
    insert into scenario_removed (scenario_id, trip_id, edit_seq)
    select ${sc.id}, id, ${seq} from trips where id = any(${tripIds}) and scenario_id is null
    on conflict (scenario_id, trip_id) do nothing`;
  await tx`update trips set removed_edit = ${seq} where id = any(${tripIds}) and scenario_id = ${sc.id} and removed_edit is null`;
}

/**
 * How many vehicles a set of lines uses (vehicle chains, which is what the editor counts), and the
 * most trips they have running at any one moment. The second is the firmer figure: a chain count
 * goes up when one vehicle's day is merely cut in two.
 */
export async function fleetFigures(
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
export async function dayFigures(
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
export async function applyEdit(
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
