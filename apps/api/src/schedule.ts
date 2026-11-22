// Schedule edits beyond moving and copying a trip: re-planning a line's vehicles, moving a call to
// another platform, adding a stop to one trip, adding a trip to a line, and moving a trip to another vehicle.
import { formatSecs } from '@gtfs-editor/core';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { scenarioOf, visible, type Scenario } from './scenarios.ts';
import { stopDeleted, stopVisible } from './stops.ts';
import { stopDwell } from './timings.ts';

const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

export interface Described {
  label: string;
  line: string;
  start_secs: number;
  route_id: number;
  direction_id: number | null;
  pattern_id: number | null;
  vehicle_day_id: number | null;
  baseline_id: number;
  rule_set: string;
}

export interface ScheduleDeps {
  cloneTrips: (
    tx: Sql,
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
  ) => Promise<Record<number, number>>;
  assignVehicles: (
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
    forceNew?: boolean | 'fresh',
  ) => Promise<{ reused: number; added: number }>;
  describe: (tx: Sql, tripId: number) => Promise<Described>;
  fleetNote: (fleet: { reused: number; added: number }) => string;
  skipPenalty: Record<string, number>;
  newLine: Record<string, { dwell: number }>;
}

const platformName = (name: string, code: string | null) =>
  code ? `platform ${code}` : name.replace(/^.*, /, '');
const stationName = (name: string) => name.replace(/, Platform.*$/, '').replace(/ Station.*$/, '');

export interface PlatformChoice {
  id: number;
  name: string;
  platformCode: string | null;
  /** Nothing else calls or waits there while this trip would. */
  free: boolean;
  /** How many of this line's stop patterns already use it. */
  uses: number;
  current: boolean;
}

/**
 * The platforms a trip could use for one of its calls: the others at the same station, with whether
 * each is free for the time the trip is there (a minute either side) and whether the line already uses it.
 */
export async function platformChoices(
  tx: Sql,
  sc: Scenario | null,
  tripId: number,
  stopSeq: number,
): Promise<PlatformChoice[]> {
  const [call] = await tx`
    select st.stop_id, st.arr, st.dep, s.parent_id, t.route_id, t.vehicle_day_id, r.mode_id
    from stop_times st join stops s on s.id = st.stop_id join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
    where st.trip_id = ${tripId} and st.seq = ${stopSeq}`;
  if (!call) throw fail(404, 'That stop is not on this trip');
  if (call.parent_id === null) return [];
  const from = call.arr - 60;
  const to = call.dep + 60;
  const rows = await tx`
    select c.id, c.name, c.platform_code as "platformCode", (c.id = ${call.stop_id}) as current,
           (select count(*)::int from patterns p where p.route_id = ${call.route_id} and p.stop_ids @> array[c.id]) as uses,
           not exists (
             select 1 from stop_times so join trips t on t.id = so.trip_id
             where so.stop_id = c.id and so.trip_id <> ${tripId} and so.arr < ${to} and so.dep > ${from}
               and so.arr > ${from - 7200} and not (so.pickup_type = 1 and so.drop_off_type = 1) and ${visible(tx, 't', sc)})
           and not exists (
             -- A vehicle that ended a trip here and leaves from here again holds the platform in between.
             select 1 from trips a join trips b on b.vehicle_day_id = a.vehicle_day_id and b.first_stop_id = c.id
               and b.start_secs >= a.end_secs and b.start_secs <= a.end_secs + 3600 and b.id <> a.id
             where a.last_stop_id = c.id and a.end_secs < ${to} and b.start_secs > ${from} and a.end_secs > ${from - 3600}
               and a.id <> ${tripId} and b.id <> ${tripId}
               and ${visible(tx, 'a', sc)} and ${visible(tx, 'b', sc)}) as free
    from stops c
    where c.parent_id = ${call.parent_id} and c.location_type = 0 and (${call.mode_id} = any(c.mode_ids) or c.scenario_id is not null)
      and ${stopVisible(tx, 'c', sc)}
    order by length(c.platform_code), c.platform_code, c.id`;
  return rows as unknown as PlatformChoice[];
}

/** The best free platform for a call, preferring ones the line already uses, or null. */
export const bestFree = (choices: PlatformChoice[]): PlatformChoice | null =>
  choices.filter((c) => c.free && !c.current).sort((a, b) => b.uses - a.uses)[0] ?? null;

export function scheduleEdits(deps: ScheduleDeps) {
  const { cloneTrips, assignVehicles, describe, fleetNote } = deps;

  async function movePlatform(tx: Sql, tripId: number, stopSeq: number, stopId: number) {
    await tx`update stop_times set stop_id = ${stopId} where trip_id = ${tripId} and seq = ${stopSeq}`;
    await tx`
      update trips t set
        first_stop_id = (select stop_id from stop_times where trip_id = t.id order by seq limit 1),
        last_stop_id = (select stop_id from stop_times where trip_id = t.id order by seq desc limit 1)
      where t.id = ${tripId}`;
  }

  /**
   * New trips copy the platforms of the trip they were made from, so they often land on top of
   * another train. Each such call is moved to a free platform at the same station that the line
   * already uses, where there is one. Returns how many calls were moved.
   */
  async function settlePlatforms(
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
  ): Promise<number> {
    if (!tripIds.length) return 0;
    const now = { ...sc, head: seq };
    const clashes = await tx`
      select distinct st.trip_id, st.seq, st.arr
      from stop_times st
      join trips t on t.id = st.trip_id
      join routes r on r.id = t.route_id
      join modes m on m.id = r.mode_id
      join stops s on s.id = st.stop_id
      join stop_times so on so.stop_id = st.stop_id and so.trip_id <> st.trip_id
        and so.arr < st.dep and st.arr < so.dep and not (so.pickup_type = 1 and so.drop_off_type = 1)
      join trips o on o.id = so.trip_id
      where st.trip_id = any(${tripIds}) and m.rule_set in ('rail', 'ferry') and s.parent_id is not null
        and not (st.pickup_type = 1 and st.drop_off_type = 1) and ${visible(tx, 'o', now)}
        and (t.vehicle_day_id is null or o.vehicle_day_id is distinct from t.vehicle_day_id)
      order by st.arr limit 400`;
    let moved = 0;
    for (const c of clashes) {
      const best = bestFree(await platformChoices(tx, now, c.trip_id, c.seq));
      if (!best || best.uses === 0) continue;
      await movePlatform(tx, c.trip_id, c.seq, best.id);
      moved++;
    }
    return moved;
  }

  const platformNote = (moved: number) =>
    moved ? `; ${moved} call${moved === 1 ? '' : 's'} moved to a free platform` : '';

  /** Moves one call of a trip to another platform at the same station. */
  async function editSetPlatform(
    tx: Sql,
    sc: Scenario,
    seq: number,
    body: { tripId: number; stopSeq: number; stopId: number },
  ) {
    const tripId = Number(body.tripId);
    const stopSeq = Number(body.stopSeq);
    const t = await describe(tx, tripId);
    const choice = (await platformChoices(tx, sc, tripId, stopSeq)).find(
      (c) => c.id === Number(body.stopId),
    );
    if (!choice) throw fail(400, 'That is not a platform at the same station');
    if (choice.current) throw fail(400, 'The trip already uses that platform');
    const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: true });
    await movePlatform(tx, idMap[tripId], stopSeq, choice.id);
    return {
      summary: `${t.label} now uses ${platformName(choice.name, choice.platformCode)} at ${stationName(choice.name)}${choice.free ? '' : ', which is busy at that time'}`,
      idMap,
      focusTripId: idMap[tripId],
    };
  }

  /**
   * Works out a line's vehicles again from nothing: every trip on the line comes off its vehicle and
   * the trips are chained afresh, each onto the vehicle that has been waiting the shortest time in
   * the right place. Useful after frequency changes, which add vehicles one edit at a time.
   */
  async function editReplan(tx: Sql, sc: Scenario, seq: number, body: { routeId: number }) {
    const routeId = Number(body.routeId);
    const [route] =
      await tx`select coalesce(short_name, long_name) as name from routes where id = ${routeId}`;
    if (!route) throw fail(404, 'Line not found');
    const vis = visible(tx, 't', sc);
    const rows =
      await tx`select t.id, t.vehicle_day_id from trips t where t.route_id = ${routeId} and t.baseline_id = ${sc.baselineId} and ${vis}`;
    if (!rows.length) throw fail(400, 'This line has no trips');
    const days = [...new Set(rows.map((r) => r.vehicle_day_id).filter((d) => d !== null))];
    const [{ shared }] = await tx`
      select count(distinct t.vehicle_day_id)::int as shared from trips t
      where t.vehicle_day_id = any(${days}) and t.route_id <> ${routeId} and ${vis}`;
    const [{ n: networkBefore }] =
      await tx`select count(distinct t.vehicle_day_id)::int as n from trips t where t.baseline_id = ${sc.baselineId} and ${vis}`;
    const idMap = await cloneTrips(
      tx,
      sc,
      seq,
      rows.map((r) => r.id),
      0,
      { replace: true, keepVehicle: false },
    );
    const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap), 'fresh');
    // The line's own figure can fall while the network's rises: a vehicle that also runs other
    // lines keeps those trips, and now counts on its own. So the network's change is said too.
    const [{ n: networkAfter }] = await tx`
      select count(distinct t.vehicle_day_id)::int as n from trips t where t.baseline_id = ${sc.baselineId} and ${visible(tx, 't', { ...sc, head: seq })}`;
    const net = networkAfter - networkBefore;
    return {
      summary: `${route.name}: vehicles worked out again for all ${rows.length} trips; ${fleet.added} vehicle${fleet.added === 1 ? '' : 's'} where there ${days.length === 1 ? 'was' : 'were'} ${days.length}${shared ? ` (${shared} of the old ones also run other lines and keep those trips)` : ''}; across the whole network that is ${net === 0 ? 'no change' : `${Math.abs(net)} ${net > 0 ? 'more' : 'fewer'}`}`,
      idMap,
    };
  }

  /** Puts a trip on a chosen vehicle, or on a new one. Whether the vehicle can make it is left to the clash check. */
  async function editMoveToVehicle(
    tx: Sql,
    sc: Scenario,
    seq: number,
    body: { tripId: number; vehicleDayId: number },
  ) {
    const tripId = Number(body.tripId);
    const dayId = Number(body.vehicleDayId);
    const t = await describe(tx, tripId);
    const [day] = await tx`
      select vd.id, vd.label, vd.mode_id, r.mode_id as trip_mode from vehicle_days vd, trips t join routes r on r.id = t.route_id
      where vd.id = ${dayId} and t.id = ${tripId} and vd.baseline_id = ${sc.baselineId}
        and (vd.scenario_id is null or (vd.scenario_id = ${sc.id} and vd.created_edit <= ${sc.head}))`;
    if (!day) throw fail(404, 'Vehicle not found');
    if (day.mode_id !== day.trip_mode)
      throw fail(400, 'That vehicle is a different kind from the one this trip needs');
    if (t.vehicle_day_id === dayId) throw fail(400, 'The trip is already on that vehicle');
    const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: false });
    await tx`update trips set vehicle_day_id = ${dayId} where id = ${idMap[tripId]}`;
    return { summary: `${t.label} moved to ${day.label}`, idMap, focusTripId: idMap[tripId] };
  }

  /** Adds a trip to a line at a given time: a copy of the trip nearest in time in that direction. */
  async function editAddTrip(
    tx: Sql,
    sc: Scenario,
    seq: number,
    body: { routeId: number; direction?: number; startSecs: number; patternId?: number },
  ) {
    const routeId = Number(body.routeId);
    const start = Math.round(Number(body.startSecs));
    if (!Number.isFinite(start) || start < 0 || start > 36 * 3600)
      throw fail(400, 'Bad departure time');
    const direction = Number(body.direction ?? 0);
    // The stop pattern asked for, otherwise the most-used one in that direction. A line whose trips have
    // all been deleted falls back to the published ones, so a trip can be made from nothing.
    const mostUsed = async (vis: unknown) => {
      const [row] = await tx`
        select t.pattern_id from trips t
        where t.route_id = ${routeId} and t.baseline_id = ${sc.baselineId} and coalesce(t.direction_id, 0) = ${direction}
          and t.pattern_id is not null and ${vis as never}
        group by t.pattern_id order by count(*) desc limit 1`;
      return row?.pattern_id as number | undefined;
    };
    const published = tx`t.scenario_id is null`;
    const pattern = body.patternId
      ? Number(body.patternId)
      : ((await mostUsed(visible(tx, 't', sc))) ?? (await mostUsed(published)));
    if (!pattern)
      throw fail(400, 'This line has no trip in that direction to model the new one on');
    const nearest = async (vis: unknown) => {
      const [row] = await tx`
        select t.id, t.start_secs from trips t
        where t.pattern_id = ${pattern} and t.route_id = ${routeId} and ${vis as never}
        order by abs(t.start_secs - ${start}), t.id limit 1`;
      return row;
    };
    const template = (await nearest(visible(tx, 't', sc))) ?? (await nearest(published));
    if (!template)
      throw fail(400, 'This line has no trip in that direction to model the new one on');
    const t = await describe(tx, template.id);
    const idMap = await cloneTrips(tx, sc, seq, [template.id], start - template.start_secs, {
      pinnedIds: [template.id],
      replace: false,
      keepVehicle: false,
    });
    const newId = idMap[template.id];
    // A line whose trips were all deleted is copied from the published ones, which may still call at
    // a stop this scenario has deleted. Such a trip is not made: nothing may call at a deleted stop.
    const [atDeleted] = await tx`
      select s.name from stop_times st join stops s on s.id = st.stop_id
      where st.trip_id = ${newId} and ${stopDeleted(tx, 's', sc)} limit 1`;
    if (atDeleted)
      throw fail(
        400,
        `The trip this would be copied from calls at ${atDeleted.name}, which this scenario has deleted`,
      );
    const fleet = await assignVehicles(tx, sc, seq, [newId]);
    const moved = await settlePlatforms(tx, sc, seq, [newId]);
    return {
      summary: `Added a ${t.line} trip departing ${formatSecs(start)}, timed like the ${formatSecs(template.start_secs)}${fleetNote(fleet)}${platformNote(moved)}`,
      idMap: {},
      focusTripId: newId,
    };
  }

  /**
   * Makes one trip call at a stop it passes: either one it runs through without stopping, or a stop
   * beside its path that is not in its stop pattern. The path does not change; later stops are that
   * much later.
   */
  async function editAddCall(
    tx: Sql,
    sc: Scenario,
    seq: number,
    body: { tripId: number; stopId: number },
  ) {
    const tripId = Number(body.tripId);
    const stopId = Number(body.stopId);
    const t = await describe(tx, tripId);
    const calls = await tx`
      select st.seq, st.stop_id, st.arr, st.dep, coalesce(st.dist, 0)::float8 as dist, (st.pickup_type = 1 and st.drop_off_type = 1) as passing
      from stop_times st where st.trip_id = ${tripId} order by st.seq`;
    const [stop] = await tx`
      select s.id, s.name, r.mode_id from stops s, trips t join routes r on r.id = t.route_id
      where s.id = ${stopId} and t.id = ${tripId} and s.baseline_id = ${sc.baselineId} and s.location_type = 0 and ${stopVisible(tx, 's', sc)}`;
    if (!stop) throw fail(404, 'Stop not found: choose a stop or a platform, not a whole station');
    const dwell = Math.max(
      await stopDwell(
        tx,
        sc.baselineId,
        stop.mode_id,
        stopId,
        deps.newLine[stop.mode_id]?.dwell ?? 20,
      ),
      0,
    );
    const penalty = deps.skipPenalty[t.rule_set] ?? 20;
    const cost = dwell + penalty;
    const name = String(stop.name).replace(/, Platform.*$/, '');
    const existing = calls.find((c) => c.stop_id === stopId);
    if (existing && !existing.passing) throw fail(400, 'This trip already stops there');

    const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, {
      pinnedIds: [tripId],
      replace: true,
      keepVehicle: true,
    });
    const newId = idMap[tripId];
    const half = Math.round(penalty / 2);
    if (existing) {
      // It was running through: stop there again.
      await tx`
        update stop_times set
          arr = arr + case when seq = ${existing.seq} then ${half}::int else ${cost}::int end,
          dep = case when seq = ${existing.seq} then arr + ${half + dwell}::int else dep + ${cost}::int end,
          pickup_type = case when seq = ${existing.seq} then 0 else pickup_type end,
          drop_off_type = case when seq = ${existing.seq} then 0 else drop_off_type end
        where trip_id = ${newId} and seq >= ${existing.seq}`;
    } else {
      const [pos] = await tx`
        select ST_LineLocatePoint(sh.geom, s.geom) * sh.length_m as along, ST_Distance(sh.geom::geography, s.geom::geography) as off
        from trips t join shapes sh on sh.id = t.shape_id, stops s where t.id = ${tripId} and s.id = ${stopId}`;
      if (!pos) throw fail(400, 'This trip has no path to place the stop on');
      if (pos.off > 150)
        throw fail(
          400,
          `${name} is ${Math.round(pos.off)} m from this trip's path. To send the line there, use "Change route" on the line.`,
        );
      const i = calls.findIndex((c) => c.dist > pos.along);
      if (i <= 0)
        throw fail(
          400,
          `${name} is beyond the end of this trip. To extend the line, use "Change route" on the line.`,
        );
      const a = calls[i - 1];
      const b = calls[i];
      const f = b.dist > a.dist ? (pos.along - a.dist) / (b.dist - a.dist) : 0.5;
      const arr = a.dep + Math.round((b.arr - a.dep) * f) + half;
      // Make room in the numbering, then put the stop in. Two steps, because the numbers must stay unique throughout.
      await tx`update stop_times set seq = -(seq + 1), arr = arr + ${cost}::int, dep = dep + ${cost}::int where trip_id = ${newId} and seq >= ${b.seq}`;
      await tx`update stop_times set seq = -seq where trip_id = ${newId} and seq < 0`;
      await tx`insert into stop_times (trip_id, seq, stop_id, arr, dep, dist) values (${newId}, ${b.seq}, ${stopId}, ${arr}, ${arr + dwell}, ${pos.along})`;
      // The trip now has a stop pattern of its own.
      const [pattern] = await tx`
        insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
        select p.baseline_id, p.route_id, p.direction_id, p.shape_id, p.headsign,
               array(select st.stop_id from stop_times st where st.trip_id = ${newId} order by st.seq), 1,
               ${`addcall-${sc.id}-${seq}`}, ${sc.id}, ${seq}
        from patterns p where p.id = ${t.pattern_id}
        returning id`;
      if (pattern) await tx`update trips set pattern_id = ${pattern.id} where id = ${newId}`;
    }
    await tx`update trips set end_secs = end_secs + ${cost}::int where id = ${newId}`;
    const mins = cost / 60;
    return {
      summary: `${t.label} now stops at ${name}, ${cost >= 60 ? `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min` : `${cost} seconds`} longer (estimated)`,
      idMap,
      focusTripId: newId,
    };
  }

  return {
    editSetPlatform,
    editReplan,
    editMoveToVehicle,
    editAddTrip,
    editAddCall,
    settlePlatforms,
    platformNote,
  };
}

/** Read-only helpers for the trip panel: which platforms a call could use, and which stops a trip could add. */
export function scheduleRoutes(app: FastifyInstance, sql: Sql) {
  app.get('/api/trips/:id/platforms', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const seq = Number((req.query as Record<string, string>).seq);
    if (!Number.isInteger(id) || !Number.isInteger(seq)) throw fail(400, 'Bad trip or stop');
    return platformChoices(sql, await scenarioOf(req, sql), id, seq);
  });

  app.get('/api/trips/:id/addable-stops', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw fail(400, 'Bad trip id');
    const sc = await scenarioOf(req, sql);
    const [trip] = await sql`
      select t.id, t.route_id, coalesce(t.direction_id, 0) as direction, t.shape_id, r.mode_id, m.rule_set, t.baseline_id
      from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id where t.id = ${id}`;
    if (!trip) throw fail(404, 'Trip not found');
    const calls = await sql`
      select st.seq, st.stop_id as "stopId", s.name, coalesce(s.parent_id, s.id) as station, coalesce(st.dist, 0)::float8 as dist,
             (st.pickup_type = 1 and st.drop_off_type = 1) as passing
      from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${id} order by st.seq`;
    if (calls.length < 2 || trip.shape_id === null) return [];
    const road = trip.rule_set === 'road';
    const near = await sql`
      select s.id, s.name, s.parent_id as "parentId", s.platform_code as "platformCode",
             ST_LineLocatePoint(sh.geom, s.geom) * sh.length_m as along,
             ST_Distance(sh.geom::geography, s.geom::geography) as off,
             (select count(*)::int from patterns p where p.route_id = ${trip.route_id} and coalesce(p.direction_id, 0) = ${trip.direction} and p.stop_ids @> array[s.id]) as uses,
             exists (select 1 from patterns p where p.route_id = ${trip.route_id} and coalesce(p.direction_id, 0) <> ${trip.direction} and p.stop_ids @> array[s.id]) as "otherWay"
      from shapes sh join stops s on ST_DWithin(s.geom, sh.geom, 0.0015)
      where sh.id = ${trip.shape_id} and s.baseline_id = ${trip.baseline_id} and s.location_type = 0
        and (${trip.mode_id} = any(s.mode_ids) or s.scenario_id is not null) and ${stopVisible(sql, 's', sc)}`;
    const called = new Set(calls.filter((c) => !c.passing).map((c) => c.station));
    const inTrip = new Set(calls.map((c) => c.stopId));
    const first = calls[0].dist;
    const last = calls[calls.length - 1].dist;
    const after = (along: number) =>
      [...calls].reverse().find((c) => !c.passing && c.dist <= along)?.name ?? calls[0].name;
    const out: { stopId: number; name: string; along: number; restore: boolean; after: string }[] =
      calls
        .filter((c) => c.passing)
        .map((c) => ({
          stopId: c.stopId,
          name: c.name,
          along: c.dist,
          restore: true,
          after: after(c.dist - 1),
        }));
    // One platform per station: the one this line already uses that way, otherwise the nearest to the path.
    const best = new Map<number, (typeof near)[number]>();
    for (const s of near) {
      if (inTrip.has(s.id) || called.has(s.parentId ?? s.id)) continue;
      // The stop across the road serves the other direction.
      if (road && s.otherWay && s.uses === 0) continue;
      if (s.off > (road ? 35 : 120) || s.along <= first + 30 || s.along >= last - 30) continue;
      const key = s.parentId ?? s.id;
      const held = best.get(key);
      if (!held || s.uses > held.uses || (s.uses === held.uses && s.off < held.off))
        best.set(key, s);
    }
    for (const s of best.values())
      out.push({
        stopId: s.id,
        name: s.name,
        along: s.along,
        restore: false,
        after: after(s.along),
      });
    return out.sort((a, b) => a.along - b.along).slice(0, 120);
  });
}
