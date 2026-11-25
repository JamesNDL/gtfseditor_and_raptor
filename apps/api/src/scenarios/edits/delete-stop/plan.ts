// Over 300 lines: planDeleteStop is split in a later ticket.
//
// Working out what deleting a station, a stop or platforms would do, without changing anything.
import {
  choosePlatform,
  removeCalls,
  type PlatformOption,
  type RemovalCall,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { visible, type Scenario } from '../../engine.ts';
import { stopVisible } from '../../stops-visible.ts';
import { fail } from '../../../http.ts';
import { AREA_M, RAIL_MODES, TOP_SPEED } from './assumptions.ts';
import { describePlan, median, metres, platformLabel, tidy } from './describe.ts';
import type {
  DeleteStopBody,
  DeleteStopDeps,
  DeleteStopPlan,
  LineEffect,
  PlannedTrip,
} from './types.ts';

/** Works out everything a deletion would do, without changing anything. */
export async function planDeleteStop(
  tx: Sql,
  sc: Scenario | null,
  body: DeleteStopBody,
  deps: DeleteStopDeps,
): Promise<DeleteStopPlan> {
  const asked = [
    ...new Set((body.stopIds ?? (body.stopId !== undefined ? [body.stopId] : [])).map(Number)),
  ];
  if (!asked.length || asked.some((id) => !Number.isInteger(id)))
    throw fail(400, 'Say which stop to delete');
  if (asked.length > 40)
    throw fail(400, 'Delete one station, or the platforms of one station, at a time');
  const targets = await tx`
    select s.id, s.name, s.location_type, s.parent_id, s.platform_code, s.baseline_id
    from stops s where s.id = any(${asked}) and ${stopVisible(tx, 's', sc)}`;
  if (targets.length !== asked.length)
    throw fail(404, 'That stop is not in this timetable. It may already have been deleted.');
  const baselineId = targets[0].baseline_id as number;
  if (sc && sc.baselineId !== baselineId) throw fail(400, 'That stop belongs to a different day');
  const stationIds = new Set(
    targets.map((t) => (t.location_type === 1 ? t.id : (t.parent_id ?? t.id))),
  );
  if (stationIds.size > 1)
    throw fail(400, 'Delete one station, or the platforms of one station, at a time');
  if (targets.some((t) => t.location_type !== 0 && t.location_type !== 1))
    throw fail(400, 'Only a station, a stop or a platform can be deleted');
  const stationId = [...stationIds][0] as number;

  // Everything at the station: the station itself and whatever sits under it.
  const family = await tx`
    select s.id, s.name, s.location_type, s.parent_id, s.platform_code, s.mode_ids, (s.scenario_id is not null) as added,
           ST_X(s.geom) as lon, ST_Y(s.geom) as lat
    from stops s where (s.id = ${stationId} or s.parent_id = ${stationId}) and ${stopVisible(tx, 's', sc)}
    order by length(s.platform_code), s.platform_code, s.id`;
  const station = family.find((s) => s.id === stationId)!;
  const platforms = family.filter((s) => s.location_type === 0);
  const askedSet = new Set(asked);
  const staying = platforms.filter((p) => !askedSet.has(p.id));
  // Asking for the station, or for its last platforms, takes all of it: a station with nowhere to
  // board is not left behind, and nothing under it is left pointing at a parent that is gone.
  const whole = askedSet.has(stationId) || staying.length === 0;
  const going = whole ? family : family.filter((s) => askedSet.has(s.id));
  const removedStopIds = going.map((s) => s.id as number);
  const removedSet = new Set(removedStopIds);
  const goingPlatforms = going.filter((s) => s.location_type === 0);
  const rail = family.some((s) => (s.mode_ids as string[]).some((m) => RAIL_MODES.includes(m)));
  // Away from the railway a 'station' is only what the feed groups stops under, often the two stops
  // either side of a road, so one of them is called a stop, not a platform.
  const what: DeleteStopPlan['what'] = !whole
    ? rail
      ? 'platform'
      : 'stop'
    : platforms.length > 1 || (rail && station.location_type === 1)
      ? 'station'
      : 'stop';
  const label =
    what === 'platform'
      ? `${goingPlatforms.length === 1 ? platformLabel(goingPlatforms[0].name, goingPlatforms[0].platform_code) : `${goingPlatforms.length} platforms`} at ${station.name}`
      : !whole && goingPlatforms.length > 1
        ? `${goingPlatforms.length} stops at ${station.name}`
        : what === 'station'
          ? String(station.name)
          : String(goingPlatforms[0]?.name ?? station.name);

  // Every trip that has a row at one of those stops, with all its calls.
  const tripRows = await tx`
    select t.id, t.route_id, t.pattern_id, t.vehicle_day_id, t.feed_block_id, t.start_secs, t.end_secs, m.rule_set, r.mode_id
    from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
    where t.id in (select st.trip_id from stop_times st where st.stop_id = any(${removedStopIds})) and ${visible(tx, 't', sc)}
    order by t.id`;
  const tripIds = tripRows.map((t) => t.id as number);
  const callRows = tripIds.length
    ? await tx`
        select st.trip_id, st.seq, st.stop_id, st.arr, st.dep, (st.pickup_type = 1 and st.drop_off_type = 1) as passing,
               coalesce(s.parent_id, s.id) as station, st.dist::float8 as dist
        from stop_times st join stops s on s.id = st.stop_id
        where st.trip_id = any(${tripIds}) order by st.trip_id, st.seq`
    : [];
  type Call = {
    seq: number;
    stopId: number;
    arr: number;
    dep: number;
    passing: boolean;
    station: number;
    dist: number | null;
  };
  const callsOf = new Map<number, Call[]>();
  for (const c of callRows) {
    let list = callsOf.get(c.trip_id);
    if (!list) callsOf.set(c.trip_id, (list = []));
    list.push({
      seq: c.seq,
      stopId: c.stop_id,
      arr: c.arr,
      dep: c.dep,
      passing: c.passing,
      station: c.station,
      dist: c.dist,
    });
  }
  /**
   * The least time a trip may take between two of its stops when the saving is an estimate, so that
   * a guess never has the vehicle passing the deleted stop faster than it runs there today. The
   * speed allowed is the fastest the trip does now on the stretches around it: from the stop before
   * the gap, through the deleted stop, to the stop after the gap (stretches under 100 m are too
   * short to judge by), and never above the limit for its kind of vehicle. Where none of those
   * stretches can be measured the trip saves nothing. Zero, meaning no limit, only when the trip
   * has no distances at all.
   */
  const floorFor = (tripId: number, ruleSet: string) => {
    const real = callsOf.get(tripId)!.filter((c) => !c.passing);
    if (real.some((c) => c.dist === null)) return () => 0;
    const limit = TOP_SPEED[ruleSet] ?? TOP_SPEED.road;
    return (fromSeq: number, toSeq: number) => {
      const a = real.findIndex((c) => c.seq === fromSeq);
      const c = real.findIndex((r) => r.seq === toSeq);
      if (a < 0 || c <= a) return 0;
      let fastest = 0;
      for (let i = Math.max(1, a); i <= Math.min(real.length - 1, c + 1); i++) {
        const far = real[i].dist! - real[i - 1].dist!;
        const secs = real[i].arr - real[i - 1].dep;
        if (far >= 100 && secs > 0) fastest = Math.max(fastest, far / secs);
      }
      if (fastest === 0) return Infinity;
      return Math.max(0, real[c].dist! - real[a].dist!) / Math.min(fastest, limit);
    };
  };

  // Platform moves: only when the station keeps other platforms. Calls are placed in time order,
  // each one seeing the calls placed before it.
  const moveOf = new Map<string, { stopId: number; free: boolean; usual: boolean }>();
  const movedTo = new Map<number, number>();
  if (!whole && tripIds.length) {
    const optionIds = staying.map((p) => p.id as number);
    const busy = new Map<number, PlatformOption['busy']>(optionIds.map((id) => [id, []]));
    const there = await tx`
      select so.stop_id, so.trip_id, so.arr, so.dep from stop_times so join trips t on t.id = so.trip_id
      where so.stop_id = any(${optionIds}) and not (so.pickup_type = 1 and so.drop_off_type = 1) and ${visible(tx, 't', sc)}`;
    for (const c of there)
      busy.get(c.stop_id)!.push({ from: c.arr, to: c.dep, trips: [c.trip_id] });
    // A vehicle that ends a trip at a platform and starts its next from the same one holds it in between.
    const waits = await tx`
      select a.last_stop_id as stop_id, a.id as a, b.id as b, a.end_secs as "from", b.start_secs as "to"
      from trips a join trips b on b.vehicle_day_id = a.vehicle_day_id and b.first_stop_id = a.last_stop_id and b.id <> a.id
        and b.start_secs >= a.end_secs and b.start_secs <= a.end_secs + 3600
      where a.last_stop_id = any(${optionIds}) and ${visible(tx, 'a', sc)} and ${visible(tx, 'b', sc)}`;
    for (const w of waits) busy.get(w.stop_id)!.push({ from: w.from, to: w.to, trips: [w.a, w.b] });
    const routeIds = [...new Set(tripRows.map((t) => t.route_id as number))];
    const usesRows = await tx`
      select p.route_id, c.id, count(*)::int as uses
      from patterns p cross join unnest(${optionIds}::bigint[]) as c(id)
      where p.route_id = any(${routeIds}) and p.stop_ids @> array[c.id] group by 1, 2`;
    const uses = new Map(usesRows.map((u) => [`${u.route_id}|${u.id}`, u.uses as number]));
    const toMove = tripRows
      .flatMap((t) =>
        callsOf
          .get(t.id)!
          .filter((c) => removedSet.has(c.stopId) && !c.passing)
          .map((c) => ({ t, c })),
      )
      .sort((x, y) => x.c.arr - y.c.arr || x.t.id - y.t.id);
    for (const { t, c } of toMove) {
      // Buses and coaches are not moved: the other stops under a bus stop's station are usually the
      // ones across the road, which serve the other direction. Their calls go, as for a deleted stop.
      if (t.rule_set === 'road') continue;
      // Only platforms of the trip's own kind: a train does not move to a bus stand.
      const options = staying
        .filter((p) => p.added || (p.mode_ids as string[]).includes(t.mode_id))
        .map((p) => ({
          id: p.id as number,
          uses: uses.get(`${t.route_id}|${p.id}`) ?? 0,
          busy: busy.get(p.id)!,
        }));
      const pick = choosePlatform(options, { arr: c.arr, dep: c.dep, tripId: t.id });
      if (!pick) continue; // nowhere to move to: the call goes, as for a deleted stop
      moveOf.set(`${t.id}|${c.seq}`, { stopId: pick.id, free: pick.free, usual: pick.usual });
      movedTo.set(pick.id, (movedTo.get(pick.id) ?? 0) + 1);
      busy.get(pick.id)!.push({ from: c.arr, to: c.dep, trips: [t.id] });
    }
  }

  // Each trip without the deleted stop. A first pass finds which pairs of neighbouring stations
  // need a non-stop time from the published timetable, so that they can be asked for together.
  const removalCalls = (tripId: number): RemovalCall[] =>
    callsOf.get(tripId)!.map((c) => ({
      seq: c.seq,
      arr: c.arr,
      dep: c.dep,
      passing: c.passing,
      gone: removedSet.has(c.stopId) && !moveOf.has(`${tripId}|${c.seq}`),
    }));
  const stationAt = (tripId: number, seq: number) =>
    callsOf.get(tripId)!.find((c) => c.seq === seq)!.station;
  const pairs = new Set<string>();
  for (const t of tripRows) {
    removeCalls(
      removalCalls(t.id),
      (from, to) => {
        pairs.add(`${stationAt(t.id, from)}|${stationAt(t.id, to)}`);
        return null;
      },
      0,
    );
  }
  const learned = new Map<string, { secs: number; metres: number | null }>();
  if (pairs.size) {
    const fromStations = [...new Set([...pairs].map((p) => Number(p.split('|')[0])))];
    const toStations = [...new Set([...pairs].map((p) => Number(p.split('|')[1])))];
    // The same evidence as skipping a stop: published trips that run between the two stations
    // without stopping, three or more of them.
    const seen = await tx`
      with runs as (
        select st.trip_id, st.dep, st.dist, coalesce(s.parent_id, s.id) as station,
               lead(coalesce(s.parent_id, s.id)) over w as next_station, lead(st.arr) over w as next_arr, lead(st.dist) over w as next_dist
        from stop_times st join stops s on s.id = st.stop_id
        where st.trip_id in (
            select st2.trip_id from stop_times st2 join trips t2 on t2.id = st2.trip_id
            where st2.stop_id in (select x.id from stops x where x.id = any(${fromStations}) or x.parent_id = any(${fromStations}))
              and t2.scenario_id is null and t2.baseline_id = ${baselineId})
          and not (st.pickup_type = 1 and st.drop_off_type = 1)
        window w as (partition by st.trip_id order by st.seq))
      select station, next_station, count(*)::int as n, percentile_cont(0.5) within group (order by next_arr - dep) as median,
             percentile_cont(0.5) within group (order by (next_dist - dist)::float8) as metres
      from runs where station = any(${fromStations}) and next_station = any(${toStations}) group by 1, 2`;
    for (const row of seen) {
      if (row.n >= 3)
        learned.set(`${row.station}|${row.next_station}`, {
          secs: Number(row.median),
          metres: row.metres === null ? null : Number(row.metres),
        });
    }
  }

  const trips: PlannedTrip[] = tripRows.map((t) => {
    const calls = callsOf.get(t.id)!;
    const out = removeCalls(
      removalCalls(t.id),
      (from, to) => {
        const seen = learned.get(`${stationAt(t.id, from)}|${stationAt(t.id, to)}`);
        if (!seen) return null;
        // Published trips between the same two stops may go another way (this trip may have been
        // re-routed). Their time is only believed when their path is the same length as this trip's.
        const a = calls.find((c) => c.seq === from)!.dist;
        const b = calls.find((c) => c.seq === to)!.dist;
        if (
          a !== null &&
          b !== null &&
          seen.metres !== null &&
          Math.abs(b - a - seen.metres) > Math.max(100, 0.1 * (b - a))
        )
          return null;
        return seen.secs;
      },
      deps.skipPenalty[t.rule_set] ?? 20,
      floorFor(t.id, t.rule_set),
    );
    const moves = calls
      .filter((c) => moveOf.has(`${t.id}|${c.seq}`))
      .map((c) => ({ seq: c.seq, ...moveOf.get(`${t.id}|${c.seq}`)! }));
    const base = {
      id: t.id as number,
      routeId: t.route_id as number,
      patternId: t.pattern_id as number | null,
      vehicleDayId: t.vehicle_day_id as number | null,
      blockId: t.feed_block_id as string | null,
      cutStart: out.cutStart,
      cutEnd: out.cutEnd,
      skipped: out.skipped,
      savingSecs: out.savingSecs,
      estimated: out.estimated,
    };
    if (!out.kept)
      return {
        ...base,
        removed: true,
        cutStart: false,
        cutEnd: false,
        skipped: 0,
        savingSecs: 0,
        estimated: false,
        shorterSecs: 0,
        moves: [],
        dropSeqs: [],
        changes: [],
        stopIds: [],
      };
    const keptSeqs = new Set(out.kept.map((k) => k.seq));
    const bySeq = new Map(calls.map((c) => [c.seq, c]));
    const stopAt = (seq: number) => moveOf.get(`${t.id}|${seq}`)?.stopId ?? bySeq.get(seq)!.stopId;
    const changes = out.kept
      .filter((k) => {
        const was = bySeq.get(k.seq)!;
        return was.arr !== k.arr || was.dep !== k.dep || stopAt(k.seq) !== was.stopId;
      })
      .map((k) => ({ seq: k.seq, arr: k.arr, dep: k.dep, stopId: stopAt(k.seq) }));
    const last = out.kept[out.kept.length - 1];
    return {
      ...base,
      removed: false,
      // Only moves on calls the trip still makes count.
      moves: moves.filter((m) => keptSeqs.has(m.seq)),
      shorterSecs: t.end_secs - t.start_secs - (last.arr - out.kept[0].dep),
      dropSeqs: calls.filter((c) => !keptSeqs.has(c.seq)).map((c) => c.seq),
      changes,
      stopIds: out.kept.map((k) => stopAt(k.seq)),
    };
  });

  // What it does to each line.
  const routeIds = [...new Set(trips.map((t) => t.routeId))];
  const routeRows = routeIds.length
    ? await tx`
        select r.id, coalesce(r.short_name, r.long_name, 'Line') as name, coalesce(r.color, m.color) as color,
               (select count(*)::int from trips t where t.route_id = r.id and ${visible(tx, 't', sc)}) as trips
        from routes r join modes m on m.id = r.mode_id where r.id = any(${routeIds}) order by m.sort, r.short_name`
    : [];
  const losing = [
    ...new Set(
      trips
        .filter((t) => t.removed || t.cutStart || t.cutEnd || t.skipped > 0)
        .map((t) => t.routeId),
    ),
  ];
  const nearestRows = losing.length
    ? await tx`
        select distinct on (p.route_id) p.route_id, s.name,
               ST_Distance(s.geom::geography, ST_SetSRID(ST_MakePoint(${station.lon}, ${station.lat}), 4326)::geography) as metres
        from patterns p cross join lateral unnest(p.stop_ids) as u(id) join stops s on s.id = u.id
        where p.route_id = any(${losing}) and not (u.id = any(${removedStopIds}))
          and exists (select 1 from trips t where t.pattern_id = p.id and ${visible(tx, 't', sc)})
        order by p.route_id, metres`
    : [];
  const nearest = new Map(
    nearestRows.map((n) => [
      n.route_id as number,
      { name: String(n.name), metres: Number(n.metres) },
    ]),
  );
  const lines: LineEffect[] = routeRows.map((r) => {
    const own = trips.filter((t) => t.routeId === r.id);
    const skipping = own.filter((t) => !t.removed && t.skipped > 0 && !t.cutStart && !t.cutEnd);
    const cut = own.filter((t) => !t.removed && (t.cutStart || t.cutEnd));
    const removed = own.filter((t) => t.removed).length;
    return {
      routeId: r.id,
      name: r.name,
      color: r.color,
      noLongerCall: skipping.length,
      cutShort: cut.length,
      removed,
      moved: own.reduce((sum, t) => sum + t.moves.length, 0),
      savingSecs: median(skipping.map((t) => t.savingSecs)),
      estimated: skipping.some((t) => t.estimated),
      shorterSecs: median(cut.map((t) => t.shorterSecs)),
      tripsLeft: r.trips - removed,
      nearest: losing.includes(r.id) ? (nearest.get(r.id) ?? null) : null,
    };
  });
  lines.sort(
    (a, b) =>
      b.noLongerCall +
      b.cutShort +
      b.removed +
      b.moved -
      (a.noLongerCall + a.cutShort + a.removed + a.moved),
  );

  const allMoves = trips.flatMap((t) => t.moves);
  const totals = {
    trips: trips.length,
    noLongerCall: lines.reduce((sum, l) => sum + l.noLongerCall, 0),
    cutShort: lines.reduce((sum, l) => sum + l.cutShort, 0),
    removed: lines.reduce((sum, l) => sum + l.removed, 0),
    moved: allMoves.length,
    movedBusy: allMoves.filter((m) => !m.free).length,
    movedUnusual: allMoves.filter((m) => !m.usual).length,
  };

  // Vehicles stay on their trips. Removing a trip can leave a vehicle with nothing to do, and a trip
  // cut short leaves its vehicle starting or ending somewhere new.
  const removedIds = trips.filter((t) => t.removed).map((t) => t.id);
  const removedDays = [
    ...new Set(
      trips.filter((t) => t.removed && t.vehicleDayId !== null).map((t) => t.vehicleDayId!),
    ),
  ];
  const [{ n: noTripsLeft }] = removedDays.length
    ? await tx`
        select count(*)::int as n from (
          select t.vehicle_day_id from trips t where t.vehicle_day_id = any(${removedDays}) and ${visible(tx, 't', sc)}
          group by 1 having bool_and(t.id = any(${removedIds}))) x`
    : [{ n: 0 }];
  const turnShort = new Set(
    trips
      .filter((t) => !t.removed && (t.cutStart || t.cutEnd) && t.vehicleDayId !== null)
      .map((t) => t.vehicleDayId),
  ).size;

  // Stay-aboard groups (block_id in GTFS): passengers can stay on from one trip to the next where
  // the two meet. A trip cut short no longer meets its neighbour there, so the group is split at
  // that point; the first part keeps its name, and a part of one trip has none.
  const blocks = new Map<number, { block: string; part: number | null }>();
  let linksEnded = 0;
  const cutBlocks = [
    ...new Set(
      trips
        .filter((t) => t.blockId && (t.removed || t.cutStart || t.cutEnd))
        .map((t) => t.blockId!),
    ),
  ];
  if (cutBlocks.length) {
    const members = await tx`
      select t.id, t.feed_block_id as block from trips t
      where t.baseline_id = ${baselineId} and t.feed_block_id = any(${cutBlocks}) and ${visible(tx, 't', sc)}
      order by t.feed_block_id, t.start_secs, t.id`;
    const planned = new Map(trips.map((t) => [t.id, t]));
    let block: string | null = null;
    let parts: number[][] = [];
    const close = () => {
      if (block === null) return;
      let n = 0;
      parts
        .filter((p) => p.length)
        .forEach((p, i) => {
          if (i === 0) return;
          const part = p.length > 1 ? ++n : null;
          for (const id of p) blocks.set(id, { block: block!, part });
        });
    };
    let prev: PlannedTrip | undefined;
    let prevWasRemoved = false;
    let first = true;
    for (const m of members) {
      if (m.block !== block) {
        close();
        block = m.block;
        parts = [[]];
        prev = undefined;
        prevWasRemoved = false;
        first = true;
      }
      const p = planned.get(m.id);
      // The link from the trip before to this one ends when either is removed or no longer reaches the join.
      const broken =
        !first &&
        (prevWasRemoved || p?.removed === true || prev?.cutEnd === true || p?.cutStart === true);
      if (broken) linksEnded++;
      first = false;
      if (p?.removed) {
        prevWasRemoved = true;
        prev = undefined;
        continue;
      }
      if (parts[parts.length - 1].length && broken) parts.push([]);
      parts[parts.length - 1].push(m.id);
      prev = p;
      prevWasRemoved = false;
    }
    close();
  }

  // Said once each: two lines can share a name.
  const warned = new Set<string>();
  for (const l of lines) {
    if (l.removed > 0 && l.tripsLeft === 0)
      warned.add(`Line ${l.name} is left with no trips at all.`);
    else if (l.nearest === null && losing.includes(l.routeId))
      warned.add(`Line ${l.name} is left with no other stop.`);
    else if (l.nearest && l.nearest.metres > AREA_M) {
      warned.add(
        `This is line ${l.name}'s only stop in the area: its nearest other stop is ${tidy(l.nearest.name)}, ${metres(l.nearest.metres)} away.`,
      );
    }
  }
  const warnings = [...warned];

  const plan: DeleteStopPlan = {
    baselineId,
    what,
    rail,
    label,
    stationId,
    removedStopIds,
    // Only the ones something can call at: the feed also lists car parks and taxi ranks under a station.
    platforms: (goingPlatforms.some((p) => p.added || (p.mode_ids as string[]).length > 0)
      ? goingPlatforms.filter((p) => p.added || (p.mode_ids as string[]).length > 0)
      : goingPlatforms
    ).map((p) => String(p.name)),
    placeWord: goingPlatforms.every((p) => p.platform_code || (p.mode_ids as string[]).length === 0)
      ? 'platforms'
      : goingPlatforms.some((p) => p.platform_code)
        ? 'platforms and stops'
        : 'stops',
    trips,
    lines,
    movedTo: [...movedTo.entries()]
      .map(([id, calls]) => {
        const p = staying.find((s) => s.id === id)!;
        return { label: platformLabel(p.name, p.platform_code), calls };
      })
      .sort((a, b) => b.calls - a.calls),
    totals,
    vehicles: { noTripsLeft, turnShort },
    blocks,
    linksEnded,
    warnings,
    summary: '',
  };
  plan.summary = describePlan(plan);
  return plan;
}
