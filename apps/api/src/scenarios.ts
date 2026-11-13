// Scenarios: edits layered over a baseline, with undo and redo.
//
// Every edit is applied by cloning the trips it touches into scenario-owned rows and marking the
// originals as removed. Rows carry the edit number that created or removed them, so undo and redo
// only move the scenario's `head`; nothing is ever recomputed backwards.
import {
  COORD_SCALE,
  DEFAULT_CHAIN_RULES,
  distanceM,
  encodePack,
  formatSecs,
  simplifyIndices,
  type PackArrays,
  type RuleSet,
} from '@gtfs-editor/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { describeMethod, roadPath, type PathMethod } from './roads.ts';

export interface Scenario {
  id: number;
  baselineId: number;
  head: number;
}

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The scenario named by ?s=, or null for the plain baseline. */
export async function scenarioOf(req: FastifyRequest, sql: Sql): Promise<Scenario | null> {
  const raw = (req.query as Record<string, string | undefined>).s;
  if (!raw) return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) throw fail(400, 'Bad scenario id');
  const [row] = await sql`select id, baseline_id as "baselineId", head from scenarios where id = ${id}`;
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

interface EditResult {
  summary: string;
  /** Old trip id to its replacement, so the client can keep the same trip selected. */
  idMap: Record<number, number>;
  focusTripId?: number;
  /** A line the edit created, so the client can open it. */
  routeId?: number;
}

export function registerScenarioRoutes(app: FastifyInstance, sql: Sql) {
  const loadScenario = async (id: number): Promise<Scenario> => {
    const [row] = await sql`select id, baseline_id as "baselineId", head from scenarios where id = ${id}`;
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
    options: { pinnedIds?: number[]; replace: boolean; keepVehicle: boolean },
  ): Promise<Record<number, number>> {
    if (!tripIds.length) return {};
    const pinned = options.pinnedIds ?? [];
    const created = await tx.unsafe(
      `insert into trips (${TRIP_COLUMNS}, gtfs_id, vehicle_day_id, vehicle_day_seq, start_secs, end_secs,
                          scenario_id, origin_trip_id, cloned_from, created_edit, pinned)
       select ${TRIP_COLUMNS},
              split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || row_number() over (order by id),
              case when $5::boolean then vehicle_day_id end, case when $5::boolean then vehicle_day_seq end,
              start_secs + $3::int, end_secs + $3::int,
              $1::int, case when $6::boolean then coalesce(origin_trip_id, case when scenario_id is null then id end) end, id, $2::int,
              (pinned or id = any($7::bigint[]))
       from trips where id = any($4::bigint[])
       returning id, cloned_from`,
      [sc.id, seq, delta, tripIds, options.keepVehicle, options.replace, pinned] as never[],
    );
    const idMap: Record<number, number> = {};
    for (const row of created) idMap[row.cloned_from] = row.id;
    const newIds = Object.values(idMap);
    await tx`
      insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
      select n.id, st.seq, st.stop_id, st.arr + ${delta}, st.dep + ${delta}, st.dist, st.pickup_type, st.drop_off_type,
             st.timepoint, st.headsign, st.note
      from trips n join stop_times st on st.trip_id = n.cloned_from
      where n.id = any(${newIds})`;
    if (options.replace) await removeTrips(tx, sc, seq, tripIds);
    return idMap;
  }

  async function removeTrips(tx: Tx, sc: Scenario, seq: number, tripIds: number[]) {
    if (!tripIds.length) return;
    await tx`
      insert into scenario_removed (scenario_id, trip_id, edit_seq)
      select ${sc.id}, id, ${seq} from trips where id = any(${tripIds}) and scenario_id is null
      on conflict (scenario_id, trip_id) do update set edit_seq = excluded.edit_seq`;
    await tx`update trips set removed_edit = ${seq} where id = any(${tripIds}) and scenario_id = ${sc.id}`;
  }

  const describe = async (tx: Tx, tripId: number) => {
    const [t] = await tx`
      select coalesce(r.short_name, r.long_name, 'trip') as line, t.start_secs, f.name as "from", l.name as "to",
             t.route_id, t.direction_id, t.pattern_id, t.vehicle_day_id, t.baseline_id, t.scenario_id, m.rule_set
      from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
      join stops f on f.id = t.first_stop_id join stops l on l.id = t.last_stop_id
      where t.id = ${tripId}`;
    if (!t) throw fail(404, 'Trip not found');
    const short = (s: string) => s.replace(/ Station.*$/, '').replace(/, Platform.*$/, '');
    return { ...t, label: `${t.line} ${formatSecs(t.start_secs)} ${short(t.from)} to ${short(t.to)}` };
  };

  const minutes = (secs: number) => {
    const m = Math.abs(secs) / 60;
    return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
  };

  /** Runs one edit inside a transaction, discarding any undone edits first. */
  async function applyEdit(scenarioId: number, kind: string, fn: (tx: Tx, sc: Scenario, seq: number) => Promise<EditResult>) {
    return sql.begin(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const [row] = await tx`select id, baseline_id as "baselineId", head from scenarios where id = ${scenarioId} for update`;
      if (!row) throw fail(404, 'Scenario not found');
      const sc = row as unknown as Scenario;
      // A new edit after an undo throws away the undone edits.
      await tx`delete from trips where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
      await tx`delete from vehicle_days where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
      await tx`delete from patterns where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
      await tx`delete from routes where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
      await tx`delete from shapes where scenario_id = ${sc.id} and created_edit > ${sc.head}`;
      await tx`update trips set removed_edit = null where scenario_id = ${sc.id} and removed_edit > ${sc.head}`;
      await tx`delete from scenario_removed where scenario_id = ${sc.id} and edit_seq > ${sc.head}`;
      await tx`delete from scenario_edits where scenario_id = ${sc.id} and seq > ${sc.head}`;
      const seq = sc.head + 1;
      const result = await fn(tx, sc, seq);
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
   * there-and-back pair shares one.
   */
  async function assignVehicles(tx: Tx, sc: Scenario, seq: number, tripIds: number[], forceNew = false) {
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
        id: r.id, vd: r.vd, s: r.s, e: r.e, modeId: r.mode_id, vt: r.vt, ruleSet: r.rule_set as RuleSet,
        partition: `${r.mode_id}|${r.agency_gtfs_id ?? ''}|${r.vt ?? ''}`,
        fx: r.fx, fy: r.fy, lx: r.lx, ly: r.ly,
      }));
    };
    const fresh = (await load(tx`t.id = any(${tripIds})`)).sort((a, b) => a.s - b.s || a.id - b.id);
    // Candidates: every vehicle that already runs a trip on one of these lines.
    const working = forceNew
      ? []
      : await load(tx`
          t.vehicle_day_id in (
            select t2.vehicle_day_id from trips t2
            where t2.route_id in (select route_id from trips where id = any(${tripIds}))
              and t2.vehicle_day_id is not null and ${visible(tx, 't2', now)})
          and ${visible(tx, 't', now)} and not (t.id = any(${tripIds}))`);

    interface Vehicle {
      id: number | null;
      partition: string;
      trips: FleetTrip[];
      modeId: string;
      vt: number | null;
    }
    const vehicles = new Map<number, Vehicle>();
    for (const t of working) {
      let v = vehicles.get(t.vd!);
      if (!v) vehicles.set(t.vd!, (v = { id: t.vd, partition: t.partition, trips: [], modeId: t.modeId, vt: t.vt }));
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
      for (const v of forceNew ? [] : [...pool, ...added]) {
        if (v.partition !== trip.partition) continue;
        let prev: FleetTrip | null = null;
        let next: FleetTrip | null = null;
        for (const t of v.trips) {
          if (t.s <= trip.s) prev = t;
          else {
            next = t;
            break;
          }
        }
        if (prev && (prev.e + rules.minLayoverSecs > trip.s || distanceM(prev.lx, prev.ly, trip.fx, trip.fy) > rules.radiusM)) continue;
        if (next && (trip.e + rules.minLayoverSecs > next.s || distanceM(trip.lx, trip.ly, next.fx, next.fy) > rules.radiusM)) continue;
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
      v.trips.push(trip);
      v.trips.sort((a, b) => a.s - b.s);
      chosen.set(trip.id, v);
    }

    if (added.length) {
      const [{ n }] = await tx`select count(*)::int as n from vehicle_days where scenario_id = ${sc.id}`;
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
    if (fleet.reused) parts.push(`${fleet.reused} trip${fleet.reused === 1 ? '' : 's'} on vehicles with spare time`);
    return parts.length ? `; ${parts.join(', ')}` : '';
  };

  async function editSetVehicle(tx: Tx, sc: Scenario, seq: number, body: { tripId: number; mode: 'new' | 'auto' }) {
    const tripId = Number(body.tripId);
    const t = await describe(tx, tripId);
    const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: false });
    const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap), body.mode === 'new');
    return {
      summary: fleet.added ? `${t.label} now runs on a new vehicle` : `${t.label} moved to a vehicle with spare time`,
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

  const ROAD_MODES = new Set(['bus', 'coach', 'school_bus']);

  // Typical end-to-end speed of a mode in the published timetable (metres per second, stops included):
  // the median over that day's trips of path length divided by scheduled time.
  const speedCache = new Map<string, number>();
  async function typicalSpeed(tx: Tx, baselineId: number, modeId: string, fallback: number): Promise<number> {
    const key = `${baselineId}|${modeId}`;
    const cached = speedCache.get(key);
    if (cached) return cached;
    const [row] = await tx`
      select percentile_cont(0.5) within group (order by sh.length_m / (t.end_secs - t.start_secs)) as speed
      from trips t join routes r on r.id = t.route_id join shapes sh on sh.id = t.shape_id
      where t.baseline_id = ${baselineId} and t.scenario_id is null and r.mode_id = ${modeId}
        and t.end_secs > t.start_secs + 120 and sh.length_m > 500`;
    const speed = row?.speed && row.speed > 1 && row.speed < 40 ? Number(row.speed) : fallback;
    speedCache.set(key, speed);
    return speed;
  }

  /**
   * Creates a new line through existing stops, with a timetable in both directions.
   * The path is drawn straight from stop to stop and run times come from a typical speed for the
   * mode, so both are rough until refined.
   */
  async function editCreateLine(
    tx: Tx,
    sc: Scenario,
    seq: number,
    body: { name: string; modeId: string; color?: string; stopIds: number[]; headwaySecs?: number; fromSecs?: number; toSecs?: number; followRoads?: boolean },
  ) {
    const followRoads = ROAD_MODES.has(body.modeId) && body.followRoads !== false;
    let pathMethod: PathMethod = 'straight';
    const name = (body.name ?? '').trim().slice(0, 40);
    if (!name) throw fail(400, 'Give the line a name');
    const model = NEW_LINE[body.modeId];
    if (!model) throw fail(400, 'Choose a mode');
    const color = /^[0-9A-Fa-f]{6}$/.test(body.color ?? '') ? body.color!.toUpperCase() : null;
    const headway = Math.round(Number(body.headwaySecs ?? 900));
    const from = Math.round(Number(body.fromSecs ?? 6 * 3600));
    const to = Math.round(Number(body.toSecs ?? 22 * 3600));
    if (!(headway >= 60) || !(to > from)) throw fail(400, 'Bad frequency or hours');
    const chosen = (body.stopIds ?? []).map(Number);
    if (chosen.length < 2 || chosen.length > 150) throw fail(400, 'Pick at least two stops');
    for (let i = 1; i < chosen.length; i++) if (chosen[i] === chosen[i - 1]) throw fail(400, 'The same stop is listed twice in a row');

    const rows = await tx`
      select s.id, s.name, s.location_type, ST_X(s.geom) as lon, ST_Y(s.geom) as lat,
             array(select c.id from stops c where c.parent_id = s.id and c.location_type = 0
                   order by (cardinality(c.mode_ids) = 0), length(c.platform_code), c.platform_code, c.id) as platforms
      from stops s where s.id = any(${chosen}) and s.baseline_id = ${sc.baselineId}`;
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

    const [route] = await tx`
      insert into routes (baseline_id, gtfs_id, agency_gtfs_id, agency_name, short_name, long_name, route_type, mode_id, color,
                          scenario_id, created_edit)
      values (${sc.baselineId}, ${`NEW-${sc.id}-${seq}`}, 'NEW', 'New services', ${name},
              ${`${stops[0].name.replace(/,.*$/, '')} to ${stops[stops.length - 1].name.replace(/,.*$/, '')}`},
              ${model.routeType}, ${body.modeId}, ${color}, ${sc.id}, ${seq})
      returning id`;

    const tripIds: number[] = [];
    let outboundLine: [number, number][] | null = null;
    const timing = { learned: 0, estimated: 0, speed: 0 };
    for (const direction of [0, 1]) {
      const order = direction === 0 ? stops : [...stops].reverse();
      // The path: along roads for road vehicles where it can be found, otherwise straight between stops.
      let line: [number, number][] = order.map((s) => [s.lon, s.lat]);
      if (followRoads) {
        const found = await roadPath(tx, sc.baselineId, order.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat })));
        line = found.coords;
        if (direction === 0) {
          pathMethod = found.method;
          outboundLine = found.coords;
        } else if (found.method !== 'roads' && outboundLine) {
          // Without a routing server there is rarely a published path for the way back, so the
          // return trip runs back along the outbound path rather than cutting straight across.
          line = [...outboundLine].reverse();
        }
      }
      const lineDist: number[] = [0];
      for (let i = 1; i < line.length; i++) lineDist.push(lineDist[i - 1] + distanceM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
      // Where each stop sits along the path: the nearest point at or after the previous stop's.
      const dist: number[] = [];
      let at = 0;
      order.forEach((s, i) => {
        if (i === order.length - 1) at = line.length - 1;
        else if (i > 0) {
          let best = at;
          let bestD = Infinity;
          for (let k = at; k < line.length; k++) {
            const d = distanceM(s.lon, s.lat, line[k][0], line[k][1]);
            if (d < bestD) {
              bestD = d;
              best = k;
            }
          }
          at = best;
        }
        dist.push(lineDist[at]);
      });
      // Arrival and departure at each stop, as seconds after the trip starts.
      // Run time for each section. Best evidence first:
      //   1. published trips that already run between these two stops: their median time;
      //   2. otherwise the section's length at the typical speed of this mode on this day's timetable.
      const speed = await typicalSpeed(tx, sc.baselineId, body.modeId, model.speed);
      timing.speed = speed;
      const arr: number[] = [0];
      const dep: number[] = [0];
      for (let i = 1; i < order.length; i++) {
        const from = platform(order[i - 1], direction);
        const to = platform(order[i], direction);
        const [seen] = await tx`
          select count(*)::int as n, percentile_cont(0.5) within group (order by b.arr - a.dep) as median
          from stop_times a
          join stop_times b on b.trip_id = a.trip_id and b.seq > a.seq and b.stop_id = ${to}
          join trips t on t.id = a.trip_id
          where a.stop_id = ${from} and t.scenario_id is null`;
        let secs: number;
        if (seen.n >= 3 && seen.median > 0) {
          secs = Math.round(seen.median / 10) * 10;
          timing.learned++;
        } else {
          // The typical speed already includes time spent at stops, so take the stop time back out.
          secs = Math.max(30, Math.round(((dist[i] - dist[i - 1]) / speed - model.dwell) / 10) * 10);
          timing.estimated++;
        }
        arr.push(dep[i - 1] + Math.max(20, secs));
        dep.push(i === order.length - 1 ? arr[i] : arr[i] + model.dwell);
      }
      const stopIds = order.map((s) => platform(s, direction));
      const wkt = `LINESTRING(${line.map((p) => `${p[0]} ${p[1]}`).join(',')})`;
      const [shape] = await tx`
        insert into shapes (baseline_id, gtfs_id, geom, length_m, dists, scenario_id, created_edit)
        values (${sc.baselineId}, ${`NEW-${sc.id}-${seq}-${direction}`}, ST_GeomFromText(${wkt}, 4326), ${lineDist[lineDist.length - 1]},
                ${lineDist}::float8[], ${sc.id}, ${seq})
        returning id`;
      const headsign = order[order.length - 1].name.replace(/,.*$/, '').replace(/ Station$/, '');
      const [pattern] = await tx`
        insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
        values (${sc.baselineId}, ${route.id}, ${direction}, ${shape.id}, ${headsign}, ${stopIds}::bigint[], 0,
                ${`new-${sc.id}-${seq}-${direction}`}, ${sc.id}, ${seq})
        returning id`;
      const starts: number[] = [];
      for (let s = from; s < to; s += headway) starts.push(s);
      const created = await tx`
        insert into trips (baseline_id, gtfs_id, route_id, pattern_id, shape_id, service_gtfs_id, headsign, direction_id,
                           start_secs, end_secs, first_stop_id, last_stop_id, scenario_id, created_edit)
        select ${sc.baselineId}, ${`NEW${sc.id}.${seq}.${direction}-`} || row_number() over (order by s.start), ${route.id}, ${pattern.id},
               ${shape.id}, 'NEW', ${headsign}, ${direction}, s.start, s.start + ${arr[arr.length - 1]},
               ${stopIds[0]}, ${stopIds[stopIds.length - 1]}, ${sc.id}, ${seq}
        from unnest(${starts}::int[]) as s(start)
        returning id, start_secs`;
      await tx`
        insert into stop_times (trip_id, seq, stop_id, arr, dep, dist)
        select n.id, o.seq, o.stop_id, n.start_secs + o.arr, n.start_secs + o.dep, o.dist
        from trips n
        cross join unnest(${stopIds}::bigint[], ${arr}::int[], ${dep}::int[], ${dist}::float4[]) with ordinality as o(stop_id, arr, dep, dist, seq)
        where n.id = any(${created.map((r) => r.id)})`;
      for (const r of created) tripIds.push(r.id);
    }
    const fleet = await assignVehicles(tx, sc, seq, tripIds);
    return {
      summary: `New line ${name}: ${stops.length} stops, every ${minutes(headway)} from ${formatSecs(from)} to ${formatSecs(to)} (${tripIds.length} trips), ${describeMethod(pathMethod)}; run times: ${timing.learned} section${timing.learned === 1 ? '' : 's'} from published trips, ${timing.estimated} at the typical ${Math.round(timing.speed * 3.6)} km/h for this mode${fleetNote(fleet)}`,
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
    body: { routeId: number; bands: { fromSecs: number; toSecs: number; headwaySecs: number }[] },
  ) {
    const routeId = Number(body.routeId);
    const bands = (body.bands ?? []).map((b) => ({ from: Math.round(Number(b.fromSecs)), to: Math.round(Number(b.toSecs)), headway: Math.round(Number(b.headwaySecs)) }));
    if (!bands.length || bands.length > 12) throw fail(400, 'Give between one and twelve time bands');
    for (const b of bands) {
      if (!(b.to > b.from) || b.from < 0) throw fail(400, 'Each time band must end after it starts');
      if (!(b.headway >= 60) || b.headway > 4 * 3600) throw fail(400, 'Each frequency must be between 1 minute and 4 hours');
    }
    const vis = visible(tx, 't', sc);
    const [route] = await tx`select coalesce(short_name, long_name) as name from routes where id = ${routeId}`;
    if (!route) throw fail(404, 'Line not found');
    const mains = await tx`
      select distinct on (direction) pattern_id, direction from (
        select t.pattern_id, coalesce(t.direction_id, 0) as direction, count(*) as n
        from trips t where t.route_id = ${routeId} and t.pattern_id is not null and ${vis} group by 1, 2) x
      order by direction, n desc`;
    if (!mains.length) throw fail(400, 'This line has no trips to copy');

    const createdIds: number[] = [];
    let replacedCount = 0;
    let keptPinned = 0;
    let batch = 0;
    for (const main of mains) {
      const existing = await tx`
        select t.id, t.start_secs, t.pinned from trips t where t.pattern_id = ${main.pattern_id} and ${vis} order by t.start_secs`;
      for (const band of bands) {
        const middle = (band.from + band.to) / 2;
        const template = existing.reduce((best, t) => (Math.abs(t.start_secs - middle) < Math.abs(best.start_secs - middle) ? t : best));
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
        batch++;
        const created = await tx.unsafe(
          `insert into trips (${TRIP_COLUMNS}, gtfs_id, start_secs, end_secs, scenario_id, cloned_from, created_edit)
           select ${TRIP_COLUMNS},
                  split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || $5::int || '-' || row_number() over (order by s.start),
                  s.start, end_secs + (s.start - start_secs), $1::int, id, $2::int
           from trips, unnest($4::int[]) as s(start) where id = $3::bigint
           returning id, start_secs`,
          [sc.id, seq, template.id, starts, batch] as never[],
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
    const fleet = await assignVehicles(tx, sc, seq, createdIds);
    return {
      summary: `${route.name}: new frequency in ${bands.length} time band${bands.length === 1 ? '' : 's'}, both directions (${createdIds.length} trips, replacing ${replacedCount}${keptPinned ? `, keeping ${keptPinned} placed by hand` : ''})${fleetNote(fleet)}`,
      idMap: {},
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
    const [type] = await tx`select id, name from vehicle_types where id = ${Number(body.vehicleTypeId)}`;
    if (!type) throw fail(400, 'Unknown vehicle type');
    const vis = visible(tx, 't', sc);
    let ids: number[];
    let what: string;
    if (body.scope === 'trip') {
      ids = [id];
      what = (await describe(tx, id)).label;
    } else if (body.scope === 'vehicleDay') {
      ids = (await tx`select t.id from trips t where t.vehicle_day_id = ${id} and ${vis}`).map((r) => r.id);
      const [vd] = await tx`select label from vehicle_days where id = ${id}`;
      what = vd?.label ?? 'Vehicle';
    } else if (body.scope === 'route') {
      ids = (await tx`select t.id from trips t where t.route_id = ${id} and t.baseline_id = ${sc.baselineId} and ${vis}`).map((r) => r.id);
      const [r] = await tx`select coalesce(short_name, long_name) as name from routes where id = ${id}`;
      what = `Line ${r?.name ?? ''}`;
    } else {
      throw fail(400, 'Unknown scope');
    }
    if (!ids.length) throw fail(400, 'No trips to change');
    const idMap = await cloneTrips(tx, sc, seq, ids, 0, { replace: true, keepVehicle: true });
    await tx`update trips set vehicle_type_id = ${type.id} where id = any(${Object.values(idMap)})`;
    return {
      summary: `${what} now runs with ${type.name}${ids.length > 1 ? ` (${ids.length} trips)` : ''}`,
      idMap,
      focusTripId: body.scope === 'trip' ? idMap[id] : undefined,
    };
  }

  type Ripple = 'none' | 'vehicle' | 'line';

  async function editShift(tx: Tx, sc: Scenario, seq: number, body: { tripIds: number[]; delta: number; ripple?: Ripple }) {
    const delta = Math.round(Number(body.delta));
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 6 * 3600) throw fail(400, 'Shift must be between 1 second and 6 hours');
    const chosen = body.tripIds.map(Number);
    if (!chosen.length) throw fail(400, 'No trips given');
    const ids = new Set<number>(chosen);
    const vis = visible(tx, 't', sc);
    for (const id of chosen) {
      const t = await describe(tx, id);
      if (body.ripple === 'vehicle' && t.vehicle_day_id) {
        const rows = await tx`select t.id from trips t where t.vehicle_day_id = ${t.vehicle_day_id} and t.start_secs > ${t.start_secs} and ${vis}`;
        for (const r of rows) ids.add(r.id);
      } else if (body.ripple === 'line') {
        const rows = await tx`
          select t.id from trips t where t.baseline_id = ${sc.baselineId} and t.route_id = ${t.route_id}
            and t.direction_id is not distinct from ${t.direction_id} and t.start_secs > ${t.start_secs} and ${vis}`;
        for (const r of rows) ids.add(r.id);
      }
    }
    const all = [...ids];
    const [{ earliest }] = await tx`select min(start_secs) as earliest from trips where id = any(${all})`;
    if (earliest + delta < 0) throw fail(400, 'That would start before the service day begins');
    const first = await describe(tx, chosen[0]);
    const idMap = await cloneTrips(tx, sc, seq, all, delta, { pinnedIds: chosen, replace: true, keepVehicle: true });
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
    return { summary: ids.length === 1 ? `Deleted ${first.label}` : `Deleted ${ids.length} trips starting with ${first.label}`, idMap: {} };
  }

  async function editDuplicate(tx: Tx, sc: Scenario, seq: number, body: { tripId: number; startSecs: number }) {
    const t = await describe(tx, Number(body.tripId));
    const start = Math.round(Number(body.startSecs));
    if (!Number.isFinite(start) || start < 0 || start > 36 * 3600) throw fail(400, 'Bad departure time');
    const idMap = await cloneTrips(tx, sc, seq, [Number(body.tripId)], start - t.start_secs, {
      pinnedIds: [Number(body.tripId)],
      replace: false,
      keepVehicle: false,
    });
    const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap));
    return {
      summary: `Added a copy of ${t.label} departing ${formatSecs(start)}${fleetNote(fleet)}`,
      idMap: {},
      focusTripId: idMap[Number(body.tripId)],
    };
  }

  /** How many seconds a trip saves by running through a stop, learned from the timetable where possible. */
  async function skipSaving(tx: Tx, baselineId: number, tripId: number, stopSeq: number, ruleSet: string) {
    const stops = await tx`
      select st.seq, st.arr, st.dep, coalesce(s.parent_id, s.id) as station,
             (st.pickup_type = 1 and st.drop_off_type = 1) as passing
      from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${tripId} order by st.seq`;
    const i = stops.findIndex((s) => s.seq === stopSeq);
    if (i <= 0 || i >= stops.length - 1) throw fail(400, 'The first and last stops cannot be skipped');
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
    let target = observed.n >= 3 && observed.median < current ? Math.round(observed.median) : fallback;
    target = Math.max(Math.round(current * 0.5), Math.min(current, target));
    return { saving: current - target, learned: observed.n >= 3 && observed.median < current, a: stops[a].seq, c: stops[c].seq };
  }

  async function editSkipStop(tx: Tx, sc: Scenario, seq: number, body: { tripId: number; stopSeq: number; scope?: 'trip' | 'pattern' }) {
    const tripId = Number(body.tripId);
    const stopSeq = Number(body.stopSeq);
    const t = await describe(tx, tripId);
    const { saving, learned, a, c } = await skipSaving(tx, sc.baselineId, tripId, stopSeq, t.rule_set);
    const [stop] = await tx`select s.name from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${tripId} and st.seq = ${stopSeq}`;
    let ids = [tripId];
    if (body.scope === 'pattern' && t.pattern_id) {
      const rows = await tx`
        select t.id from trips t where t.pattern_id = ${t.pattern_id} and ${visible(tx, 't', sc)}
          and exists (select 1 from stop_times st where st.trip_id = t.id and st.seq = ${stopSeq}
                      and not (st.pickup_type = 1 and st.drop_off_type = 1))`;
      ids = rows.map((r) => r.id);
    }
    const idMap = await cloneTrips(tx, sc, seq, ids, 0, { pinnedIds: body.scope === 'pattern' ? [] : [tripId], replace: true, keepVehicle: true });
    const newIds = Object.values(idMap);
    // The stop stays in the trip as a pass-through, so the vehicle still follows the same path.
    // Times between the stops either side are re-spaced in proportion; everything after is earlier.
    await tx`
      update stop_times st set
        arr = case when st.seq >= ${c} then st.arr - ${saving}
                   else b.a_dep + round((st.arr - b.a_dep) * b.ratio)::int end,
        dep = case when st.seq >= ${c} then st.dep - ${saving}
                   when st.seq = ${stopSeq} then b.a_dep + round((st.arr - b.a_dep) * b.ratio)::int
                   else b.a_dep + round((st.dep - b.a_dep) * b.ratio)::int end,
        pickup_type = case when st.seq = ${stopSeq} then 1 else st.pickup_type end,
        drop_off_type = case when st.seq = ${stopSeq} then 1 else st.drop_off_type end
      from (
        select x.trip_id, x.dep as a_dep,
               (y.arr - x.dep - ${saving})::float8 / greatest(1, y.arr - x.dep) as ratio
        from stop_times x join stop_times y on y.trip_id = x.trip_id and y.seq = ${c}
        where x.seq = ${a} and x.trip_id = any(${newIds})) b
      where st.trip_id = b.trip_id and st.seq > ${a}`;
    await tx`update trips set end_secs = end_secs - ${saving} where id = any(${newIds})`;
    const name = String(stop.name).replace(/, Platform.*$/, '');
    return {
      summary: `${ids.length === 1 ? t.label : `${ids.length} ${t.line} trips`} now skip${ids.length === 1 ? 's' : ''} ${name}, saving ${minutes(saving)}${learned ? '' : ' (estimated)'}`,
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
    if (!(to > from) || from < 0) throw fail(400, 'The time band must end after it starts');
    if (!(headway >= 60) || headway > 4 * 3600) throw fail(400, 'Headway must be between 1 minute and 4 hours');
    const vis = visible(tx, 't', sc);
    const existing = await tx`
      select t.id, t.start_secs, t.pinned from trips t
      where t.pattern_id = ${Number(body.patternId)} and ${vis} order by t.start_secs`;
    if (!existing.length) throw fail(400, 'No trips use that stopping pattern, so there is nothing to copy');
    const middle = (from + to) / 2;
    // Copy the trip nearest the middle of the band: its run times are the most representative.
    const template = existing.reduce((best, t) => (Math.abs(t.start_secs - middle) < Math.abs(best.start_secs - middle) ? t : best));
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
      fleet = await assignVehicles(tx, sc, seq, created.map((r) => r.id));
    }
    return {
      summary: `${t.line}: every ${minutes(headway)} from ${formatSecs(from)} to ${formatSecs(to)} (${starts.length} trips, replacing ${replaced.length}${pinned.length ? `, keeping ${pinned.length} pinned` : ''})${fleetNote(fleet)}`,
      idMap: {},
    };
  }

  // -------------------------------------------------------------------------
  // Conflicts caused by the scenario's own trips
  // -------------------------------------------------------------------------
  async function findConflicts(sc: Scenario) {
    const visT = visible(sql, 't', sc);
    const visO = visible(sql, 'o', sc);
    const mine = sql`t.scenario_id = ${sc.id} and ${visT}`;

    const platform = await sql`
      select t.id as "tripId", o.id as "otherTripId", st.stop_id as "stopId", s.name as "stopName",
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

    const [{ n: unassigned }] = await sql`select count(*)::int as n from trips t where ${mine} and t.vehicle_day_id is null`;

    const round30 = (secs: number) => Math.ceil(secs / 30) * 30;
    const conflicts = [
      ...platform.map((c) => {
        const delta = round30(c.otherDep - c.arr + 60);
        return {
          kind: 'platform' as const,
          tripId: c.tripId,
          otherTripId: c.otherTripId,
          stopId: c.stopId,
          atSecs: c.fromSecs,
          title: `${String(c.stopName).replace(/ Station/, '')}: two trips at once`,
          detail: `${c.line ?? 'Trip'} ${formatSecs(c.startSecs)} and ${c.otherLine ?? 'trip'} ${formatSecs(c.otherStart)} overlap at ${formatSecs(c.fromSecs)}`,
          fixes: [{ label: `Move the ${formatSecs(c.startSecs)} trip ${minutes(delta)} later`, edit: { kind: 'shift', tripIds: [c.tripId], delta, ripple: 'none' } }],
        };
      }),
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
            { label: `Push the vehicle's later trips back ${minutes(delta)}`, edit: { kind: 'shift', tripIds: [c.otherTripId], delta, ripple: 'vehicle' } },
          ],
        };
      }),
    ];
    return { conflicts, unassigned };
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  app.get('/api/scenarios', async (req) => {
    const baseline = Number((req.query as Record<string, string>).baseline);
    return sql`
      select id, name, head, baseline_id as "baselineId",
             (select count(*)::int from scenario_edits e where e.scenario_id = s.id) as "editCount"
      from scenarios s where ${Number.isInteger(baseline) ? sql`baseline_id = ${baseline}` : sql`true`}
      order by created_at`;
  });

  app.post('/api/scenarios', async (req) => {
    const body = req.body as { baselineId: number; name?: string };
    const [b] = await sql`select id from baselines where id = ${Number(body.baselineId)} and ready`;
    if (!b) throw fail(400, 'Unknown day');
    const [{ n }] = await sql`select count(*)::int as n from scenarios where baseline_id = ${b.id}`;
    const name = (body.name ?? '').trim().slice(0, 80) || `Scenario ${n + 1}`;
    const [row] = await sql`insert into scenarios (baseline_id, name) values (${b.id}, ${name}) returning id, name, head, baseline_id as "baselineId"`;
    return { ...row, editCount: 0 };
  });

  app.delete('/api/scenarios/:id', async (req) => {
    await sql`delete from scenarios where id = ${idParam(req)}`;
    return { ok: true };
  });

  app.get('/api/scenarios/:id', async (req) => {
    const sc = await loadScenario(idParam(req));
    const [info] = await sql`select id, name, head, baseline_id as "baselineId" from scenarios where id = ${sc.id}`;
    const edits = await sql`select seq, kind, summary, (seq <= ${sc.head}) as applied from scenario_edits where scenario_id = ${sc.id} order by seq`;
    const vis = visible(sql, 't', sc);
    const [stats] = await sql`
      select
        (select count(*)::int from trips t where t.baseline_id = ${sc.baselineId} and t.scenario_id is null) as "baselineTrips",
        (select count(*)::int from trips t where t.baseline_id = ${sc.baselineId} and ${vis}) as trips,
        (select count(*)::int from trips t where t.scenario_id = ${sc.id} and ${vis}) as "editedTrips",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.baseline_id = ${sc.baselineId} and ${vis}) as vehicles,
        (select count(distinct t.vehicle_day_id)::int from trips t where t.baseline_id = ${sc.baselineId} and t.scenario_id is null) as "baselineVehicles"`;
    const { conflicts, unassigned } = await findConflicts(sc);
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
    return { ...info, edits, stats: { ...stats, unassigned }, conflicts, impact, fleet };
  });

  app.post('/api/scenarios/:id/undo', async (req) => {
    const [row] = await sql`update scenarios set head = head - 1 where id = ${idParam(req)} and head > 0 returning head`;
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
      duplicate: editDuplicate,
      skipStop: editSkipStop,
      headway: editHeadway,
      setVehicle: editSetVehicle,
      setVehicleType: editSetVehicleType,
      lineFrequency: editLineFrequency,
      createLine: editCreateLine,
    }[body.kind] as
      | ((tx: Tx, sc: Scenario, seq: number, body: never) => Promise<EditResult>)
      | undefined;
    if (!run) throw fail(400, `Unknown edit "${body.kind}"`);
    return applyEdit(idParam(req), body.kind, (tx, sc, seq) => run(tx, sc, seq, body as never));
  });

  /** The path a new line would take through these stops, for the preview while drawing. */
  app.post('/api/road-path', async (req) => {
    const body = req.body as { baselineId: number; stopIds: number[] };
    const ids = (body.stopIds ?? []).map(Number).slice(0, 150);
    if (ids.length < 2) throw fail(400, 'Pick at least two stops');
    const rows = await sql`select id, ST_X(geom) as lon, ST_Y(geom) as lat from stops where id = any(${ids}) and baseline_id = ${Number(body.baselineId)}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (ids.some((id) => !byId.has(id))) throw fail(400, 'Unknown stop');
    const found = await roadPath(sql, Number(body.baselineId), ids.map((id) => ({ id, lon: byId.get(id)!.lon, lat: byId.get(id)!.lat })));
    return { coords: found.coords, method: found.method, description: describeMethod(found.method) };
  });

  /** Lines this scenario created, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/lines', async (req) => {
    const sc = await loadScenario(idParam(req));
    const rows = await sql`
      select r.id, coalesce(r.short_name, '') as name, r.mode_id, coalesce(r.color, m.color) as color, ST_AsGeoJSON(s.geom) as geometry
      from routes r join modes m on m.id = r.mode_id
      join patterns p on p.route_id = r.id
      join shapes s on s.id = p.shape_id
      where r.scenario_id = ${sc.id} and r.created_edit <= ${sc.head}`;
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
    const sc = await loadScenario(idParam(req));
    const rows = await sql`select trip_id from scenario_removed where scenario_id = ${sc.id} and edit_seq <= ${sc.head}`;
    return rows.map((r) => r.trip_id);
  });

  /** The scenario's own trips as an animation pack, in the same format as the per-mode packs. */
  app.get('/api/scenarios/:id/pack', async (req, reply) => {
    const sc = await loadScenario(idParam(req));
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
      const scale = dist[lon.length - 1] > 0 && row.length_m ? row.length_m / dist[lon.length - 1] : 1;
      const stored = row.dists as number[] | null;
      const keep = simplifyIndices(lon, lat, 8);
      return {
        lon: Int32Array.from(keep, (k) => Math.round(lon[k] * COORD_SCALE)),
        lat: Int32Array.from(keep, (k) => Math.round(lat[k] * COORD_SCALE)),
        dist: Float32Array.from(keep, (k) => (stored && stored.length === lon.length ? stored[k] : dist[k] * scale)),
      };
    });

    const n = trips.length;
    const stops = n
      ? await sql`
          select st.trip_id, st.arr, st.dep, coalesce(st.dist, 0)::float4 as dist from stop_times st
          where st.trip_id = any(${trips.map((t) => t.id)}) order by st.trip_id, st.seq`
      : [];
    const byTrip = new Map<number, typeof stops>();
    for (const s of stops) {
      let list = byTrip.get(s.trip_id);
      if (!list) byTrip.set(s.trip_id, (list = [] as unknown as typeof stops));
      list.push(s);
    }
    const tripStOffset = new Uint32Array(n + 1);
    trips.forEach((t, i) => (tripStOffset[i + 1] = tripStOffset[i] + (byTrip.get(t.id)?.length ?? 0)));
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
      { version: 1, modeId: 'scenario', tripCount: n, stopTimeCount: total, shapeCount: shapes.length, pointCount: points },
      arrays,
    );
    reply.header('content-type', 'application/octet-stream');
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}
