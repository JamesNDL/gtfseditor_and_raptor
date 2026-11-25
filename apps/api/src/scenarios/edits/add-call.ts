// addCall edits: one trip stops at a stop it passes.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { NEW_LINE, SKIP_PENALTY } from './assumptions.ts';
import { describe } from '../describe.ts';
import { stopVisible } from '../stops-visible.ts';
import { cloneTrips, type Scenario } from '../engine.ts';
import { stopDwell } from '../../routing/timings.ts';
import { fail } from '../../http.ts';

export interface AddCallBody {
  tripId: number;
  stopId: number;
}

/**
 * Makes one trip call at a stop it passes: either one it runs through without stopping, or a stop
 * beside its path that is not in its stop pattern. The path does not change; later stops are that
 * much later.
 */
export async function editAddCall(tx: Sql, sc: Scenario, seq: number, body: AddCallBody) {
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
    await stopDwell(tx, sc.baselineId, stop.mode_id, stopId, NEW_LINE[stop.mode_id]?.dwell ?? 20),
    0,
  );
  const penalty = SKIP_PENALTY[t.rule_set] ?? 20;
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
