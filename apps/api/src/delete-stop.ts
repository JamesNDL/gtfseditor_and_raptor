// Deleting a station, a stop or single platforms: one edit kind, `deleteStop`.
//
// The rule, which is the cautious one:
//   - One platform of a station that has others: every call there moves to another platform of the
//     same station, one the line already uses and that is free at that time, otherwise the least bad.
//   - A stop, a whole station, or a station's last platform: trips that call there in the middle of
//     their run no longer do, timed the way "skip a stop" times it; a trip that starts or ends there
//     is cut short to its next or previous stop and keeps its times at the stops it keeps; a trip
//     left with fewer than two stops is removed.
// Nothing is re-routed: every trip keeps its path and its vehicle. The deleted stops are rows in
// `scenario_removed_stops`; the trips are changed in the same edit, so nothing in the scenario
// still calls at a deleted stop. What needs no database is in packages/core/src/delete-stop.ts.
import { choosePlatform, removeCalls, type PlatformOption, type RemovalCall } from '@gtfs-editor/core';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { scenarioOf, visible, type Scenario } from './scenarios.ts';
import { stopVisible } from './stops.ts';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export interface DeleteStopDeps {
  cloneTrips: (
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
    delta: number,
    options: { pinnedIds?: number[]; replace: boolean; keepVehicle: boolean; stopTimes?: boolean; tag?: string },
  ) => Promise<Record<number, number>>;
  removeTrips: (tx: Sql, sc: Scenario, seq: number, tripIds: number[]) => Promise<void>;
  skipPenalty: Record<string, number>;
  /** How many clashes the scenario has, as seen from inside the edit. */
  clashes: (tx: Sql, sc: Scenario) => Promise<number>;
}

export interface DeleteStopBody {
  /** A station (all of it goes), a stop, or one or more platforms of one station. */
  stopIds?: number[];
  stopId?: number;
}

// A line is warned about when its nearest remaining stop is further than this from the deleted one:
// about ten minutes on foot.
const AREA_M = 800;
// Metres a second that an estimated run time may never imply: 90 km/h on the road, 160 on rails,
// 55 on the water. Assumptions, there to stop a guess producing a vehicle no one has seen.
const TOP_SPEED: Record<string, number> = { road: 25, rail: 45, ferry: 15 };
const RAIL_MODES = ['train', 'metro', 'light_rail', 'ferry'];

const tidy = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;
const minutes = (secs: number) => {
  if (Math.abs(secs) < 60) return `${Math.round(Math.abs(secs))} second${Math.round(Math.abs(secs)) === 1 ? '' : 's'}`;
  const m = Math.round(Math.abs(secs) / 6) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};
const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const platformLabel = (name: string, code: string | null) => (code ? `platform ${code}` : name.replace(/^.*, /, ''));

interface PlannedTrip {
  id: number;
  routeId: number;
  patternId: number | null;
  vehicleDayId: number | null;
  blockId: string | null;
  /** Left with fewer than two stops. */
  removed: boolean;
  cutStart: boolean;
  cutEnd: boolean;
  skipped: number;
  savingSecs: number;
  estimated: boolean;
  /** How much shorter the whole trip is, start to end. */
  shorterSecs: number;
  /** Calls moved to another platform. */
  moves: { seq: number; stopId: number; free: boolean; usual: boolean }[];
  /** Stop time rows that go. */
  dropSeqs: number[];
  /** Rows whose time or platform changes. */
  changes: { seq: number; arr: number; dep: number; stopId: number }[];
  /** The stops it calls at afterwards, in order. */
  stopIds: number[];
}

export interface LineEffect {
  routeId: number;
  name: string;
  color: string;
  /** Trips that no longer call there in the middle of their run. */
  noLongerCall: number;
  cutShort: number;
  removed: number;
  /** Calls moved to another platform. */
  moved: number;
  /** Typical time saved by a trip that no longer calls, in seconds. */
  savingSecs: number;
  estimated: boolean;
  /** Typical time a cut-short trip is shorter by, in seconds. */
  shorterSecs: number;
  /** Trips the line has left in the scenario afterwards. */
  tripsLeft: number;
  /** The line's nearest remaining stop to the deleted one. */
  nearest: { name: string; metres: number } | null;
}

export interface DeleteStopPlan {
  baselineId: number;
  what: 'station' | 'stop' | 'platform';
  /** Trains, trams or ferries call at the station. */
  rail: boolean;
  /** "Hamilton Station", or "platform 2 at Hamilton Station". */
  label: string;
  stationId: number;
  /** Every stop row that goes: the station itself, its platforms and its entrances. */
  removedStopIds: number[];
  /** Platforms and stops among them, by name, for the preview. */
  platforms: string[];
  /** What to call them together: 'platforms', 'stops', or 'platforms and stops' at an interchange. */
  placeWord: string;
  trips: PlannedTrip[];
  lines: LineEffect[];
  /** Where moved calls go: platform label to how many. */
  movedTo: { label: string; calls: number }[];
  totals: { trips: number; noLongerCall: number; cutShort: number; removed: number; moved: number; movedBusy: number; movedUnusual: number };
  vehicles: { noTripsLeft: number; turnShort: number };
  /** Trips whose stay-aboard group changes, and the group each ends in: null for none, a number for a new group. */
  blocks: Map<number, { block: string; part: number | null }>;
  linksEnded: number;
  warnings: string[];
  summary: string;
}

/** Works out everything a deletion would do, without changing anything. */
export async function planDeleteStop(tx: Sql, sc: Scenario | null, body: DeleteStopBody, deps: DeleteStopDeps): Promise<DeleteStopPlan> {
  const asked = [...new Set((body.stopIds ?? (body.stopId !== undefined ? [body.stopId] : [])).map(Number))];
  if (!asked.length || asked.some((id) => !Number.isInteger(id))) throw fail(400, 'Say which stop to delete');
  if (asked.length > 40) throw fail(400, 'Delete one station, or the platforms of one station, at a time');
  const targets = await tx`
    select s.id, s.name, s.location_type, s.parent_id, s.platform_code, s.baseline_id
    from stops s where s.id = any(${asked}) and ${stopVisible(tx, 's', sc)}`;
  if (targets.length !== asked.length) throw fail(404, 'That stop is not in this timetable. It may already have been deleted.');
  const baselineId = targets[0].baseline_id as number;
  if (sc && sc.baselineId !== baselineId) throw fail(400, 'That stop belongs to a different day');
  const stationIds = new Set(targets.map((t) => (t.location_type === 1 ? t.id : (t.parent_id ?? t.id))));
  if (stationIds.size > 1) throw fail(400, 'Delete one station, or the platforms of one station, at a time');
  if (targets.some((t) => t.location_type !== 0 && t.location_type !== 1)) throw fail(400, 'Only a station, a stop or a platform can be deleted');
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
  const what: DeleteStopPlan['what'] = !whole ? (rail ? 'platform' : 'stop') : platforms.length > 1 || (rail && station.location_type === 1) ? 'station' : 'stop';
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
  type Call = { seq: number; stopId: number; arr: number; dep: number; passing: boolean; station: number; dist: number | null };
  const callsOf = new Map<number, Call[]>();
  for (const c of callRows) {
    let list = callsOf.get(c.trip_id);
    if (!list) callsOf.set(c.trip_id, (list = []));
    list.push({ seq: c.seq, stopId: c.stop_id, arr: c.arr, dep: c.dep, passing: c.passing, station: c.station, dist: c.dist });
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
    for (const c of there) busy.get(c.stop_id)!.push({ from: c.arr, to: c.dep, trips: [c.trip_id] });
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
      .flatMap((t) => callsOf.get(t.id)!.filter((c) => removedSet.has(c.stopId) && !c.passing).map((c) => ({ t, c })))
      .sort((x, y) => x.c.arr - y.c.arr || x.t.id - y.t.id);
    for (const { t, c } of toMove) {
      // Buses and coaches are not moved: the other stops under a bus stop's station are usually the
      // ones across the road, which serve the other direction. Their calls go, as for a deleted stop.
      if (t.rule_set === 'road') continue;
      // Only platforms of the trip's own kind: a train does not move to a bus stand.
      const options = staying
        .filter((p) => p.added || (p.mode_ids as string[]).includes(t.mode_id))
        .map((p) => ({ id: p.id as number, uses: uses.get(`${t.route_id}|${p.id}`) ?? 0, busy: busy.get(p.id)! }));
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
    callsOf.get(tripId)!.map((c) => ({ seq: c.seq, arr: c.arr, dep: c.dep, passing: c.passing, gone: removedSet.has(c.stopId) && !moveOf.has(`${tripId}|${c.seq}`) }));
  const stationAt = (tripId: number, seq: number) => callsOf.get(tripId)!.find((c) => c.seq === seq)!.station;
  const pairs = new Set<string>();
  for (const t of tripRows) {
    removeCalls(removalCalls(t.id), (from, to) => {
      pairs.add(`${stationAt(t.id, from)}|${stationAt(t.id, to)}`);
      return null;
    }, 0);
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
      if (row.n >= 3) learned.set(`${row.station}|${row.next_station}`, { secs: Number(row.median), metres: row.metres === null ? null : Number(row.metres) });
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
        if (a !== null && b !== null && seen.metres !== null && Math.abs(b - a - seen.metres) > Math.max(100, 0.1 * (b - a))) return null;
        return seen.secs;
      },
      deps.skipPenalty[t.rule_set] ?? 20,
      floorFor(t.id, t.rule_set),
    );
    const moves = calls.filter((c) => moveOf.has(`${t.id}|${c.seq}`)).map((c) => ({ seq: c.seq, ...moveOf.get(`${t.id}|${c.seq}`)! }));
    const base = {
      id: t.id as number, routeId: t.route_id as number, patternId: t.pattern_id as number | null, vehicleDayId: t.vehicle_day_id as number | null,
      blockId: t.feed_block_id as string | null, cutStart: out.cutStart, cutEnd: out.cutEnd, skipped: out.skipped, savingSecs: out.savingSecs,
      estimated: out.estimated,
    };
    if (!out.kept) return { ...base, removed: true, cutStart: false, cutEnd: false, skipped: 0, savingSecs: 0, estimated: false, shorterSecs: 0, moves: [], dropSeqs: [], changes: [], stopIds: [] };
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
      shorterSecs: (t.end_secs - t.start_secs) - (last.arr - out.kept[0].dep),
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
  const losing = [...new Set(trips.filter((t) => t.removed || t.cutStart || t.cutEnd || t.skipped > 0).map((t) => t.routeId))];
  const nearestRows = losing.length
    ? await tx`
        select distinct on (p.route_id) p.route_id, s.name,
               ST_Distance(s.geom::geography, ST_SetSRID(ST_MakePoint(${station.lon}, ${station.lat}), 4326)::geography) as metres
        from patterns p cross join lateral unnest(p.stop_ids) as u(id) join stops s on s.id = u.id
        where p.route_id = any(${losing}) and not (u.id = any(${removedStopIds}))
          and exists (select 1 from trips t where t.pattern_id = p.id and ${visible(tx, 't', sc)})
        order by p.route_id, metres`
    : [];
  const nearest = new Map(nearestRows.map((n) => [n.route_id as number, { name: String(n.name), metres: Number(n.metres) }]));
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
  lines.sort((a, b) => b.noLongerCall + b.cutShort + b.removed + b.moved - (a.noLongerCall + a.cutShort + a.removed + a.moved));

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
  const removedDays = [...new Set(trips.filter((t) => t.removed && t.vehicleDayId !== null).map((t) => t.vehicleDayId!))];
  const [{ n: noTripsLeft }] = removedDays.length
    ? await tx`
        select count(*)::int as n from (
          select t.vehicle_day_id from trips t where t.vehicle_day_id = any(${removedDays}) and ${visible(tx, 't', sc)}
          group by 1 having bool_and(t.id = any(${removedIds}))) x`
    : [{ n: 0 }];
  const turnShort = new Set(trips.filter((t) => !t.removed && (t.cutStart || t.cutEnd) && t.vehicleDayId !== null).map((t) => t.vehicleDayId)).size;

  // Stay-aboard groups (block_id in GTFS): passengers can stay on from one trip to the next where
  // the two meet. A trip cut short no longer meets its neighbour there, so the group is split at
  // that point; the first part keeps its name, and a part of one trip has none.
  const blocks = new Map<number, { block: string; part: number | null }>();
  let linksEnded = 0;
  const cutBlocks = [...new Set(trips.filter((t) => t.blockId && (t.removed || t.cutStart || t.cutEnd)).map((t) => t.blockId!))];
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
      parts.filter((p) => p.length).forEach((p, i) => {
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
      const broken = !first && (prevWasRemoved || p?.removed === true || prev?.cutEnd === true || p?.cutStart === true);
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
    if (l.removed > 0 && l.tripsLeft === 0) warned.add(`Line ${l.name} is left with no trips at all.`);
    else if (l.nearest === null && losing.includes(l.routeId)) warned.add(`Line ${l.name} is left with no other stop.`);
    else if (l.nearest && l.nearest.metres > AREA_M) {
      warned.add(`This is line ${l.name}'s only stop in the area: its nearest other stop is ${tidy(l.nearest.name)}, ${metres(l.nearest.metres)} away.`);
    }
  }
  const warnings = [...warned];

  const plan: DeleteStopPlan = {
    baselineId, what, rail, label, stationId, removedStopIds,
    // Only the ones something can call at: the feed also lists car parks and taxi ranks under a station.
    platforms: (goingPlatforms.some((p) => p.added || (p.mode_ids as string[]).length > 0)
      ? goingPlatforms.filter((p) => p.added || (p.mode_ids as string[]).length > 0)
      : goingPlatforms
    ).map((p) => String(p.name)),
    placeWord: goingPlatforms.every((p) => p.platform_code || (p.mode_ids as string[]).length === 0) ? 'platforms' : goingPlatforms.some((p) => p.platform_code) ? 'platforms and stops' : 'stops',
    trips, lines,
    movedTo: [...movedTo.entries()].map(([id, calls]) => {
      const p = staying.find((s) => s.id === id)!;
      return { label: platformLabel(p.name, p.platform_code), calls };
    }).sort((a, b) => b.calls - a.calls),
    totals,
    vehicles: { noTripsLeft, turnShort },
    blocks, linksEnded, warnings,
    summary: '',
  };
  plan.summary = describePlan(plan);
  return plan;
}

/** The change in a sentence or two, for the list of changes. The preview says the same things at more length. */
function describePlan(plan: DeleteStopPlan): string {
  const t = plan.totals;
  const parts: string[] = [];
  if (t.moved) {
    const where = plan.movedTo.map((m) => `${m.calls.toLocaleString('en-AU')} to ${m.label}`).join(', ');
    parts.push(`${count(t.moved, 'call')} moved to another platform there (${where})${t.movedBusy ? `, ${t.movedBusy.toLocaleString('en-AU')} of them onto a platform that is in use within a minute of that time (two trips there at once show as clashes)` : ', none onto a platform in use at that time'}${t.movedUnusual ? `; ${t.movedUnusual.toLocaleString('en-AU')} onto a platform their line does not normally use` : ''}`);
  }
  if (t.noLongerCall) {
    const skipping = plan.lines.filter((l) => l.noLongerCall > 0);
    const saving = median(skipping.map((l) => l.savingSecs));
    parts.push(`${count(t.noLongerCall, 'trip')} on ${count(skipping.length, 'line')} no longer call${t.noLongerCall === 1 ? 's' : ''} there, ${saving > 0 ? `typically ${minutes(saving)} quicker` : 'typically no quicker'}${skipping.some((l) => l.estimated) ? ' (estimated, and never faster past there than they run today)' : ''}`);
  }
  if (t.cutShort) parts.push(`${count(t.cutShort, 'trip')} that started or ended there ${t.cutShort === 1 ? 'is' : 'are'} cut short to the next or previous stop, at the times ${t.cutShort === 1 ? 'it' : 'they'} already had`);
  if (t.removed) parts.push(`${count(t.removed, 'trip')} removed, left with fewer than two stops`);
  if (!parts.length) parts.push('nothing called there, so no trip changes');
  const tail: string[] = [];
  if (t.noLongerCall || t.cutShort || t.removed) tail.push('Nothing is re-routed and vehicles stay on their trips');
  if (plan.vehicles.noTripsLeft) tail.push(`${count(plan.vehicles.noTripsLeft, 'vehicle')} ${plan.vehicles.noTripsLeft === 1 ? 'has' : 'have'} no trips left and ${plan.vehicles.noTripsLeft === 1 ? 'is' : 'are'} no longer needed`);
  else if (t.trips) tail.push('the number of vehicles does not change');
  if (plan.vehicles.turnShort) tail.push(`${count(plan.vehicles.turnShort, 'vehicle')} now ${plan.vehicles.turnShort === 1 ? 'starts or ends' : 'start or end'} a trip short of there`);
  if (plan.linksEnded) tail.push(`${count(plan.linksEnded, 'stay-aboard link')} ended, because the trips no longer meet there`);
  const head = `Deleted ${plan.label}${plan.what === 'station' && plan.platforms.length > 1 ? ` and its ${plan.platforms.length} ${plan.placeWord}` : ''}`;
  // The preview lists every warning; the list of changes carries the first few.
  const more = plan.warnings.length - 3;
  const warning = plan.warnings.length
    ? `. Warning: ${plan.warnings.slice(0, 3).join(' ').replace(/\.$/, '')}${more > 0 ? `; and ${count(more, 'more warning')}` : ''}`
    : '';
  const after = tail.join('; ');
  return `${head}: ${parts.join('; ')}${after ? `. ${after[0].toUpperCase()}${after.slice(1)}` : ''}${warning}`;
}

/** Deletes a station, a stop or platforms, and changes every trip that called there. One undoable edit. */
export async function editDeleteStop(tx: Sql, sc: Scenario, seq: number, body: DeleteStopBody, deps: DeleteStopDeps) {
  const plan = await planDeleteStop(tx, sc, body, deps);
  const clashesBefore = await deps.clashes(tx, sc);
  await tx`
    insert into scenario_removed_stops (scenario_id, stop_id, edit_seq)
    select ${sc.id}, u.id, ${seq} from unnest(${plan.removedStopIds}::bigint[]) as u(id)
    on conflict (scenario_id, stop_id) do update set edit_seq = excluded.edit_seq`;

  await deps.removeTrips(tx, sc, seq, plan.trips.filter((t) => t.removed).map((t) => t.id));
  const changed = plan.trips.filter((t) => !t.removed);
  const changedIds = new Set(changed.map((t) => t.id));
  // Trips that only leave a stay-aboard group are copied too, so that the group can be renamed on them.
  const relinked = [...plan.blocks.keys()].filter((id) => !changedIds.has(id));
  const idMap = await deps.cloneTrips(tx, sc, seq, [...changedIds, ...relinked], 0, { replace: true, keepVehicle: true });

  // Stop times: rows at the deleted stop go, and the rows whose time or platform changed are rewritten.
  const drops = changed.flatMap((t) => t.dropSeqs.map((s) => ({ trip: idMap[t.id], seq: s })));
  for (let i = 0; i < drops.length; i += 20_000) {
    const chunk = drops.slice(i, i + 20_000);
    await tx`
      delete from stop_times st using unnest(${chunk.map((d) => d.trip)}::bigint[], ${chunk.map((d) => d.seq)}::int[]) as u(trip_id, seq)
      where st.trip_id = u.trip_id and st.seq = u.seq`;
  }
  const rows = changed.flatMap((t) => t.changes.map((c) => ({ trip: idMap[t.id], ...c })));
  for (let i = 0; i < rows.length; i += 20_000) {
    const chunk = rows.slice(i, i + 20_000);
    await tx`
      update stop_times st set arr = u.arr, dep = u.dep, stop_id = u.stop_id
      from unnest(${chunk.map((r) => r.trip)}::bigint[], ${chunk.map((r) => r.seq)}::int[], ${chunk.map((r) => r.arr)}::int[],
                  ${chunk.map((r) => r.dep)}::int[], ${chunk.map((r) => r.stopId)}::bigint[]) as u(trip_id, seq, arr, dep, stop_id)
      where st.trip_id = u.trip_id and st.seq = u.seq`;
  }
  const newIds = changed.map((t) => idMap[t.id]);
  if (newIds.length) {
    await tx`
      update trips t set start_secs = f.dep, end_secs = l.arr, first_stop_id = f.stop_id, last_stop_id = l.stop_id
      from unnest(${newIds}::bigint[]) as u(id)
      join lateral (select st.dep, st.stop_id from stop_times st where st.trip_id = u.id order by st.seq limit 1) f on true
      join lateral (select st.arr, st.stop_id from stop_times st where st.trip_id = u.id order by st.seq desc limit 1) l on true
      where t.id = u.id`;
  }

  // Each changed trip gets a stop pattern without the deleted stop, shared by the trips that now
  // call at the same stops. A trip that ends somewhere new is signed for where it now ends.
  const groups = new Map<string, { patternId: number; stopIds: number[]; cutEnd: boolean; trips: number[] }>();
  for (const t of changed) {
    if (t.patternId === null) continue;
    const key = `${t.patternId}|${t.stopIds.join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { patternId: t.patternId, stopIds: t.stopIds, cutEnd: t.cutEnd, trips: [] }));
    g.trips.push(idMap[t.id]);
  }
  const lastStops = [...new Set(changed.filter((t) => t.cutEnd).map((t) => t.stopIds[t.stopIds.length - 1]))];
  const names = new Map((lastStops.length ? await tx`select id, name from stops where id = any(${lastStops})` : []).map((s) => [s.id as number, tidy(String(s.name))]));
  let n = 0;
  for (const g of groups.values()) {
    const headsign = g.cutEnd ? (names.get(g.stopIds[g.stopIds.length - 1]) ?? null) : null;
    const [pattern] = await tx`
      insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
      select p.baseline_id, p.route_id, p.direction_id, p.shape_id, coalesce(${headsign}, p.headsign), ${g.stopIds}::bigint[], ${g.trips.length},
             ${`delstop-${sc.id}-${seq}-${++n}`}, ${sc.id}, ${seq}
      from patterns p where p.id = ${g.patternId}
      returning id`;
    if (!pattern) continue;
    await tx`update trips set pattern_id = ${pattern.id}, headsign = coalesce(${headsign}, headsign) where id = any(${g.trips})`;
  }
  // Trips with no stop pattern of their own still need the new headsign.
  for (const t of changed.filter((c) => c.cutEnd && c.patternId === null)) {
    const headsign = names.get(t.stopIds[t.stopIds.length - 1]);
    if (headsign) await tx`update trips set headsign = ${headsign} where id = ${idMap[t.id]}`;
  }

  // Stay-aboard groups split where the trips no longer meet.
  const renamed = new Map<string, number[]>();
  for (const [id, to] of plan.blocks) {
    if (idMap[id] === undefined) continue;
    const key = to.part === null ? '' : `${to.block}~${sc.id}.${seq}.${to.part}`;
    let list = renamed.get(key);
    if (!list) renamed.set(key, (list = []));
    list.push(idMap[id]);
  }
  for (const [block, ids] of renamed) await tx`update trips set feed_block_id = ${block === '' ? null : block} where id = any(${ids})`;

  // Trips that move can land on top of others, here or further along the line. The list of clashes
  // shows each one; the summary says how many there are now, so that none arrives unannounced.
  const clashesAfter = await deps.clashes(tx, { ...sc, head: seq });
  const many = (n: number) => (n >= 200 ? `${n} or more` : String(n));
  const clashNote =
    clashesAfter === clashesBefore
      ? ` The scenario has ${clashesAfter === 0 ? 'no clashes' : `${many(clashesAfter)} clash${clashesAfter === 1 ? '' : 'es'}, as before`}.`
      : ` Clashes in the scenario: ${many(clashesBefore)} before, ${many(clashesAfter)} now.`;
  return { summary: `${plan.summary}.${clashNote}`, idMap };
}

/** The preview request and what the map needs to draw deleted stops. */
export function deleteStopRoutes(
  app: FastifyInstance,
  sql: Sql,
  ctx: { loadScenario: (id: number) => Promise<Scenario>; idParam: (req: never) => number; deps: DeleteStopDeps },
) {
  /** What deleting a stop would do, with ?s= for a scenario. Changes nothing. */
  app.post('/api/delete-stop-preview', async (req) => {
    const sc = await scenarioOf(req, sql);
    const plan = await planDeleteStop(sql, sc, req.body as DeleteStopBody, ctx.deps);
    return {
      what: plan.what,
      label: plan.label,
      stationId: plan.stationId,
      stopIds: plan.removedStopIds,
      platforms: plan.platforms,
      placeWord: plan.placeWord,
      totals: plan.totals,
      lines: plan.lines.slice(0, 200),
      linesInAll: plan.lines.length,
      movedTo: plan.movedTo,
      vehicles: plan.vehicles,
      linksEnded: plan.linksEnded,
      warnings: plan.warnings,
      summary: plan.summary,
    };
  });

  /**
   * Stops this scenario has deleted, as GeoJSON for the map, with the same properties as the stops
   * in the map tiles. A bus stop's station row is left out, as it is from the tiles.
   */
  app.get('/api/scenarios/:id/deleted-stops', async (req) => {
    const sc = await ctx.loadScenario(ctx.idParam(req as never));
    const rows = await sql`
      select s.id, s.name, s.mode_ids[1] as mode, s.location_type, s.parent_id, s.platform_code,
             (s.mode_ids && ${RAIL_MODES}::text[]) as rail, ST_X(s.geom) as lon, ST_Y(s.geom) as lat, g.edit_seq
      from scenario_removed_stops g join stops s on s.id = g.stop_id
      where g.scenario_id = ${sc.id} and g.edit_seq <= ${sc.head} and s.location_type in (0, 1)
        and (s.location_type = 0 or s.mode_ids && ${RAIL_MODES}::text[])`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: {
          stop_id: r.id,
          name: r.name,
          mode: r.mode,
          station: r.location_type === 1,
          rail: r.rail,
          platform: r.location_type === 0 && r.rail,
          code: r.platform_code,
          edit: r.edit_seq,
        },
      })),
    };
  });
}
