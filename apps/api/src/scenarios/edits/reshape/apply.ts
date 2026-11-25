// Writing a planned reshape into the scenario, and how much it changes a typical trip's time.
import { retime, type OldCall } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { fail } from '../../../http.ts';
import type { Scenario } from '../../engine.ts';
import type { ReshapeDeps, ReshapePlan } from './types.ts';

const tidyName = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

interface OldRow extends OldCall {
  seq: number;
}

async function loadCalls(tx: Sql, tripIds: number[]): Promise<Map<number, OldRow[]>> {
  const rows = await tx`
    select st.trip_id, st.seq, st.arr, st.dep, st.pickup_type as pickup, st.drop_off_type as "dropOff"
    from stop_times st where st.trip_id = any(${tripIds}) order by st.trip_id, st.seq`;
  const byTrip = new Map<number, OldRow[]>();
  for (const r of rows) {
    let list = byTrip.get(r.trip_id);
    if (!list) byTrip.set(r.trip_id, (list = []));
    list.push({ seq: r.seq, arr: r.arr, dep: r.dep, pickup: r.pickup, dropOff: r.dropOff });
  }
  return byTrip;
}

const timing = (plan: ReshapePlan) => ({
  dwellSecs: plan.dwellSecs,
  skipPenaltySecs: plan.skipPenaltySecs,
});

/** How much longer (or shorter) a typical trip becomes, in seconds, judged from the middle trip of the day. */
export async function typicalChange(tx: Sql, plan: ReshapePlan): Promise<number> {
  const id = plan.tripIds[Math.floor(plan.tripIds.length / 2)];
  const old = (await loadCalls(tx, [id])).get(id) ?? [];
  if (old.length !== plan.oldStops.length) return 0;
  const calls = retime(old, plan.keptAt, plan.sections, timing(plan));
  return calls[calls.length - 1].arr - calls[0].dep - (old[old.length - 1].arr - old[0].dep);
}

/** Writes a planned reshape into the scenario: a new path, a new stop pattern, and every trip rebuilt. */
export async function applyReshape(
  tx: Sql,
  sc: Scenario,
  seq: number,
  plan: ReshapePlan,
  part: number,
  deps: ReshapeDeps,
  /**
   * A closure that splits trips in two rebuilds the same trips twice; the tag keeps their ids apart.
   * `routeId` puts the new stop pattern and its trips on another line: a part of the original.
   */
  options: { keepVehicle?: boolean; tag?: string; routeId?: number } = {},
) {
  const routeId = options.routeId ?? plan.routeId;
  const last = plan.stops[plan.stops.length - 1];
  const terminusChanged = last.id !== plan.oldStops[plan.oldStops.length - 1].id;
  const headsign = terminusChanged ? tidyName(last.name) : plan.headsign;
  const wkt = `LINESTRING(${plan.coords.map((p) => `${p[0]} ${p[1]}`).join(',')})`;
  const [shape] = await tx`
    insert into shapes (baseline_id, gtfs_id, geom, length_m, dists, scenario_id, created_edit)
    values (${plan.baselineId}, ${`RESHAPE-${sc.id}-${seq}-${part}`}, ST_GeomFromText(${wkt}, 4326),
            ${plan.lineDist[plan.lineDist.length - 1]}, ${plan.lineDist}::float8[], ${sc.id}, ${seq})
    returning id`;
  const stopIds = plan.stops.map((s) => s.id);
  const [pattern] = await tx`
    insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
    values (${plan.baselineId}, ${routeId}, ${plan.direction}, ${shape.id}, ${headsign}, ${stopIds}::bigint[], 0,
            ${`reshape-${sc.id}-${seq}-${part}`}, ${sc.id}, ${seq})
    returning id`;

  const calls = await loadCalls(tx, plan.tripIds);
  for (const id of plan.tripIds) {
    if ((calls.get(id)?.length ?? 0) !== plan.oldStops.length)
      throw fail(
        409,
        'A trip on this line does not match its stop pattern, so the line cannot be reshaped',
      );
  }
  const idMap = await deps.cloneTrips(tx, sc, seq, plan.tripIds, 0, {
    replace: true,
    keepVehicle: options.keepVehicle !== false,
    stopTimes: false,
    tag: options.tag,
  });

  const col = {
    trip: [] as number[],
    seq: [] as number[],
    stop: [] as number[],
    arr: [] as number[],
    dep: [] as number[],
    dist: [] as number[],
    pickup: [] as number[],
    dropOff: [] as number[],
    oldTrip: [] as number[],
    oldSeq: [] as number[],
  };
  const ids: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const changes: number[] = [];
  for (const oldId of plan.tripIds) {
    const old = calls.get(oldId)!;
    const next = retime(old, plan.keptAt, plan.sections, timing(plan));
    const newId = idMap[oldId];
    next.forEach((c, i) => {
      col.trip.push(newId);
      col.seq.push(i + 1);
      col.stop.push(stopIds[i]);
      col.arr.push(c.arr);
      col.dep.push(c.dep);
      col.dist.push(plan.stopDist[i]);
      col.pickup.push(c.pickup);
      col.dropOff.push(c.dropOff);
      col.oldTrip.push(c.carried ? oldId : -1);
      col.oldSeq.push(c.carried ? old[c.from].seq : -1);
    });
    ids.push(newId);
    starts.push(next[0].dep);
    ends.push(next[next.length - 1].arr);
    changes.push(next[next.length - 1].arr - next[0].dep - (old[old.length - 1].arr - old[0].dep));
  }
  // Timing points and notes carry over for stops that keep their place; stop headsigns are dropped
  // when the line ends somewhere new, because they would name the old destination.
  await tx`
    insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
    select u.trip_id, u.seq, u.stop_id, u.arr, u.dep, u.dist, u.pickup, u.drop_off, o.timepoint,
           case when ${terminusChanged} then null else o.headsign end, o.note
    from unnest(${col.trip}::bigint[], ${col.seq}::int[], ${col.stop}::bigint[], ${col.arr}::int[], ${col.dep}::int[], ${col.dist}::float4[],
                ${col.pickup}::int[], ${col.dropOff}::int[], ${col.oldTrip}::bigint[], ${col.oldSeq}::int[])
           as u(trip_id, seq, stop_id, arr, dep, dist, pickup, drop_off, old_trip, old_seq)
    left join stop_times o on o.trip_id = u.old_trip and o.seq = u.old_seq`;
  await tx`
    update trips t set pattern_id = ${pattern.id}, shape_id = ${shape.id}, route_id = ${routeId}, start_secs = u.s, end_secs = u.e,
           first_stop_id = ${stopIds[0]}, last_stop_id = ${stopIds[stopIds.length - 1]},
           headsign = case when ${terminusChanged} then ${headsign} else t.headsign end
    from unnest(${ids}::bigint[], ${starts}::int[], ${ends}::int[]) as u(id, s, e) where t.id = u.id`;
  return { idMap, patternId: pattern.id as number, trips: ids.length, changeSecs: median(changes) };
}
