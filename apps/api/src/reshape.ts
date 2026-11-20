// Reshaping an existing line: a stopping pattern is given a new list of stops, and every trip that
// uses it is rebuilt over the new list. Extending, cutting short, re-routing and adding or removing
// a stop are all the same operation.
//
// What stays and what is worked out:
// - Stretches between stops that did not change keep the published path and each trip's own times.
// - New stretches get a path (along roads for road vehicles where it can be found) and a run time
//   learned from published trips between the two stops, or estimated from the mode's typical speed.
// - Each trip still leaves the first stop it shares with the old line at the same time.
import {
  distanceM,
  distanceToPathM,
  keptIndexes,
  locateStops,
  mirrorStops,
  pathDistances,
  retime,
  slicePath,
  type Coord,
  type OldCall,
  type ReshapeSection,
  maxSpeedMs,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { describeMethod, entersAvoid, linePath,METHOD_STRENGTH, ROAD_MODES, type Avoid, type PathMethod } from './roads.ts';
import { visible, type Scenario } from './scenarios.ts';
import { stopVisible } from './stops.ts';
import { describeTimes, sectionTime, stopDwell, type SectionTime } from './timings.ts';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export { ROAD_MODES };

export interface ReshapeDeps {
  cloneTrips: (
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
    delta: number,
    options: { pinnedIds?: number[]; replace: boolean; keepVehicle: boolean; stopTimes?: boolean; tag?: string },
  ) => Promise<Record<number, number>>;
  /** Per mode: fallback speed (m/s) and time spent at a stop. */
  newLine: Record<string, { speed: number; dwell: number }>;
  /** Per rule set: seconds saved by not stopping, on top of the stop time itself. */
  skipPenalty: Record<string, number>;
}

export interface ReshapeOptions {
  /** New stretches follow roads (or, for trains, trams and ferries, the published network) rather than running straight between stops. */
  followRoads: boolean;
  /** Where stops are removed, take a new direct path between their neighbours instead of driving past. */
  direct: boolean;
  /** Which platform to use at a station that has no obvious one: 0 one way, 1 the other. */
  platformIndex: number;
  /** A closed area: any stretch of the published path that enters it is replaced by a way round. */
  avoid?: Avoid;
  /**
   * With `avoid`: the stops either side of a gap are joined by a new stretch with its own run time,
   * not by a detour timed from the stretch it replaces. For a line that went through a closure and
   * came back, and now turns round before it.
   */
  joinAcross?: boolean;
}

interface StopRow {
  id: number;
  name: string;
  lon: number;
  lat: number;
  locationType: number;
  parentId: number | null;
}

export interface ReshapePlan {
  patternId: number;
  routeId: number;
  routeName: string;
  modeId: string;
  ruleSet: string;
  direction: number | null;
  headsign: string | null;
  baselineId: number;
  oldStops: StopRow[];
  stops: StopRow[];
  /** For each new stop, its position in the old list, or -1 if it is new. */
  keptAt: number[];
  coords: Coord[];
  lineDist: number[];
  stopDist: number[];
  sections: ReshapeSection[];
  added: number;
  removed: number;
  /** New stretches timed from published trips, and those estimated from the typical speed. */
  learned: number;
  estimated: number;
  /** The run time of each new stretch, by part of the day, and where it came from. */
  timed: SectionTime[];
  /** How the new stretches' paths were found; null when there are none. */
  pathMethod: PathMethod | null;
  dwellSecs: number;
  skipPenaltySecs: number;
  /** Stretches sent a different way to stay out of a closed area. */
  rerouted: number;
  /** True when a stretch had to stay out of a closed area and no way round was found. */
  blocked: boolean;
  /** The trips that use the pattern, in departure order. */
  tripIds: number[];
}

const tidyName = (name: string) => name.replace(/,.*$/, '').replace(/ Station$/, '');

async function loadStops(tx: Sql, sc: Scenario | null, baselineId: number, ids: number[]): Promise<Map<number, StopRow>> {
  const rows = await tx`
    select s.id, s.name, s.location_type as "locationType", s.parent_id as "parentId", ST_X(s.geom) as lon, ST_Y(s.geom) as lat
    from stops s where s.id = any(${ids}) and s.baseline_id = ${baselineId} and ${stopVisible(tx, 's', sc)}`;
  return new Map(rows.map((r) => [r.id, r as unknown as StopRow]));
}

/**
 * The stop across the road: among the lines that call at a stop, the stop within 150 m that their
 * opposite direction calls at most often. Null for termini, one-way streets and loops.
 * A stop added by a scenario names its partner itself.
 */
export async function acrossTheRoad(tx: Sql, stopId: number) {
  const [named] = await tx`
    select o.id, o.name, o.location_type, ST_X(o.geom) as lon, ST_Y(o.geom) as lat, '{}'::bigint[] as platforms
    from stops s join stops o on o.id = s.partner_id where s.id = ${stopId}`;
  if (named) return named;
  const [partner] = await tx`
    select o.id, o.name, o.location_type, ST_X(o.geom) as lon, ST_Y(o.geom) as lat, '{}'::bigint[] as platforms,
           count(*) as uses, min(ST_Distance(o.geom::geography, s.geom::geography)) as metres
    from stops s
    join patterns p on p.baseline_id = s.baseline_id and p.scenario_id is null and p.stop_ids @> array[s.id]
    join patterns q on q.route_id = p.route_id and q.scenario_id is null and q.direction_id is distinct from p.direction_id
    join stops o on o.id = any(q.stop_ids) and o.id <> s.id and not (o.id = any(p.stop_ids))
      and ST_DWithin(o.geom::geography, s.geom::geography, 150)
    where s.id = ${stopId}
    group by o.id order by uses desc, metres limit 1`;
  return partner ?? null;
}

/** How long published trips take from one stop to a later one: how many do, and their median time. */
export async function publishedRunSecs(tx: Sql, fromStopId: number, toStopId: number): Promise<{ n: number; median: number }> {
  const [seen] = await tx`
    select count(*)::int as n, percentile_cont(0.5) within group (order by b.arr - a.dep) as median
    from stop_times a
    join stop_times b on b.trip_id = a.trip_id and b.seq > a.seq and b.stop_id = ${toStopId}
    join trips t on t.id = a.trip_id
    where a.stop_id = ${fromStopId} and t.scenario_id is null`;
  return { n: seen.n, median: Number(seen.median ?? 0) };
}

/**
 * The platform a line should use at a station: the one its trips in this direction already use
 * most, otherwise the first or second in platform order depending on direction.
 */
async function pickPlatform(tx: Sql, sc: Scenario | null, stationId: number, routeId: number, direction: number | null, index: number, avoid = -1): Promise<number | null> {
  const rows = await tx`
    select c.id,
           (select count(*)::int from patterns p
            where p.route_id = ${routeId} and p.direction_id is not distinct from ${direction}::int and p.stop_ids @> array[c.id]) as uses
    from stops c where c.parent_id = ${stationId} and c.location_type = 0
      -- Not a platform of another scenario, or one this scenario has deleted.
      and ${stopVisible(tx, 'c', sc)}
    order by (cardinality(c.mode_ids) = 0), length(c.platform_code), c.platform_code, c.id`;
  if (!rows.length) return null;
  const used = [...rows].sort((a, b) => b.uses - a.uses)[0];
  if (used.uses > 0) return used.id;
  const others = rows.filter((r) => r.id !== avoid);
  const list = others.length ? others : rows;
  return list[Math.min(index, list.length - 1)].id;
}

/** Works out everything a reshape would do, without changing anything. */
export async function planReshape(
  tx: Sql,
  sc: Scenario | null,
  patternId: number,
  stopIds: number[],
  options: ReshapeOptions,
  deps: ReshapeDeps,
): Promise<ReshapePlan> {
  const [pattern] = await tx`
    select p.id, p.route_id, p.direction_id, p.shape_id, p.headsign, p.stop_ids, p.baseline_id,
           coalesce(r.short_name, r.long_name, 'Line') as route_name, r.mode_id, m.rule_set
    from patterns p join routes r on r.id = p.route_id join modes m on m.id = r.mode_id
    where p.id = ${patternId}`;
  if (!pattern) throw fail(404, 'Stop pattern not found');
  if (sc && sc.baselineId !== pattern.baseline_id) throw fail(400, 'That line belongs to a different day');
  const baselineId: number = pattern.baseline_id;
  const model = deps.newLine[pattern.mode_id];
  if (!model) throw fail(400, 'Unknown mode');

  const trips = await tx`select t.id from trips t where t.pattern_id = ${patternId} and ${visible(tx, 't', sc)} order by t.start_secs, t.id`;
  if (!trips.length) throw fail(400, 'No trips use that stop pattern any more');
  const tripIds = trips.map((t) => t.id as number);

  const oldIds = pattern.stop_ids as number[];
  const wanted = stopIds.map(Number);
  if (wanted.length < 2) throw fail(400, 'A line needs at least two stops');
  if (wanted.length > 150) throw fail(400, 'That is too many stops for one line');
  const known = await loadStops(tx, sc, baselineId, [...new Set([...oldIds, ...wanted])]);
  if (wanted.some((id) => !known.has(id))) throw fail(400, 'One of those stops is not on this day');

  // A station was clicked rather than a platform: choose a platform for it.
  const inOld = new Set(oldIds);
  const newIds: number[] = [];
  for (const id of wanted) {
    const stop = known.get(id)!;
    if (inOld.has(id) || stop.locationType !== 1) {
      newIds.push(id);
      continue;
    }
    const platform = await pickPlatform(tx, sc, id, pattern.route_id, pattern.direction_id, options.platformIndex);
    if (platform === null) throw fail(400, `${stop.name} has no platforms to stop at`);
    newIds.push(platform);
  }
  for (const [id, row] of await loadStops(tx, sc, baselineId, newIds.filter((id) => !known.has(id)))) known.set(id, row);
  for (let i = 1; i < newIds.length; i++) {
    if (newIds[i] === newIds[i - 1]) throw fail(400, `${known.get(newIds[i])!.name} is listed twice in a row`);
  }
  if (!options.avoid && newIds.length === oldIds.length && newIds.every((id, i) => id === oldIds[i])) throw fail(400, 'Nothing has changed yet');

  const oldStops = oldIds.map((id) => known.get(id)!);
  const stops = newIds.map((id) => known.get(id)!);
  const keptAt = keptIndexes(oldIds, newIds);

  // The published path, and where each old stop sits along it.
  let oldCoords: Coord[] = [];
  let oldDists: number[] = [];
  let oldStopDist: number[] = [];
  if (pattern.shape_id) {
    const [shape] = await tx`
      select s.dists,
             array(select ST_X((dp).geom) from ST_DumpPoints(s.geom) dp order by (dp).path[1]) as lon,
             array(select ST_Y((dp).geom) from ST_DumpPoints(s.geom) dp order by (dp).path[1]) as lat
      from shapes s where s.id = ${pattern.shape_id}`;
    if (shape) {
      oldCoords = (shape.lon as number[]).map((lon, i) => [lon, (shape.lat as number[])[i]]);
      const stored = shape.dists as number[] | null;
      const calls = await tx`select st.dist from stop_times st where st.trip_id = ${tripIds[0]} order by st.seq`;
      const callDist = calls.map((c) => c.dist as number | null);
      const usable =
        stored !== null && stored.length === oldCoords.length && callDist.length === oldIds.length && callDist.every((d, i) => d !== null && (i === 0 || d >= callDist[i - 1]!));
      if (usable) {
        oldDists = stored!;
        oldStopDist = callDist as number[];
      } else if (oldCoords.length >= 2) {
        // No usable distances in the feed: measure the path and place the stops on it.
        oldDists = pathDistances(oldCoords);
        oldStopDist = locateStops(oldCoords, oldStops.map((s) => [s.lon, s.lat])).map((k) => oldDists[k]);
      }
    }
  }
  const hasOldPath = oldCoords.length >= 2 && oldStopDist.length === oldIds.length;

  const avoid = ROAD_MODES.has(pattern.mode_id) ? options.avoid : undefined;
  // Only road vehicles can leave their path; a train that no longer stops still runs along the track.
  const direct = ROAD_MODES.has(pattern.mode_id) && options.direct;
  const coords: Coord[] = [];
  /** Adds a piece to the path and returns where its first point landed. */
  const pushPiece = (piece: Coord[]): number => {
    const last = coords[coords.length - 1];
    const joined = last && last[0] === piece[0][0] && last[1] === piece[0][1];
    const base = joined ? coords.length - 1 : coords.length;
    for (let k = joined ? 1 : 0; k < piece.length; k++) coords.push(piece[k]);
    return base;
  };
  const inOrder = (i: number) => {
    const a0 = keptAt[i - 1];
    const a1 = keptAt[i];
    return hasOldPath && a0 >= 0 && a1 > a0 && oldStopDist[a1] >= oldStopDist[a0];
  };
  const oldPiece = (i: number) => slicePath(oldCoords, oldDists, oldStopDist[keptAt[i - 1]], oldStopDist[keptAt[i]]);
  const reusable = (i: number) => {
    if (!inOrder(i) || (keptAt[i] !== keptAt[i - 1] + 1 && direct)) return false;
    // A stretch that runs into a closed area cannot be used as it is.
    return !avoid || !entersAvoid(oldPiece(i), avoid);
  };
  const stopVertex: number[] = [0];
  const sections: ReshapeSection[] = [];
  let pathMethod: PathMethod | null = null;
  let rerouted = 0;
  let blocked = false;
  for (let i = 1; i < stops.length; ) {
    if (reusable(i)) {
      const base = pushPiece(oldPiece(i));
      if (i === 1) stopVertex[0] = base;
      stopVertex.push(coords.length - 1);
      sections.push({ kind: keptAt[i] === keptAt[i - 1] + 1 ? 'same' : 'passing' });
      i++;
      continue;
    }
    // A new stretch: everything up to the next stretch that can reuse the published path.
    let end = i;
    while (end + 1 < stops.length && !reusable(end + 1)) end++;
    const run = stops.slice(i - 1, end + 1);
    // A stretch between two stops the line keeps, sent another way because of a closure.
    const detour = avoid !== undefined && !options.joinAcross && run.length === 2 && inOrder(i);
    const found = await linePath(tx, baselineId, pattern.mode_id, run.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, stationId: s.parentId })), {
      follow: options.followRoads || avoid !== undefined,
      avoid,
    });
    const piece: Coord[] = found.coords;
    const method = found.method;
    if (found.blocked) blocked = true;
    if (pathMethod === null || METHOD_STRENGTH.indexOf(method) < METHOD_STRENGTH.indexOf(pathMethod)) pathMethod = method;
    const at = found.at ?? locateStops(piece, run.map((s) => [s.lon, s.lat]));
    const base = pushPiece(piece);
    if (i === 1) stopVertex[0] = base;
    for (let k = 1; k < run.length; k++) stopVertex.push(base + at[k]);
    if (detour) {
      rerouted++;
      const was = oldStopDist[keptAt[i]] - oldStopDist[keptAt[i - 1]];
      const now = pathDistances(piece);
      const length = now[now.length - 1];
      const factor = was > 0 ? length / was : 1;
      // No upper limit on the factor (it was 6 until 20 Nov): a way round ten times as long takes
      // that much longer. The lengths and speeds let each trip be timed no faster than it can go.
      sections.push({ kind: 'detour', factor: Math.max(0.5, factor), lengthM: length, extraM: length - was, speed: model.speed, maxSpeed: maxSpeedMs(pattern.mode_id) });
    } else {
      for (let k = 1; k < run.length; k++) sections.push({ kind: 'new', secs: 0 });
    }
    i = end + 1;
  }
  const lineDist = pathDistances(coords);
  const stopDist = stopVertex.map((k) => lineDist[Math.min(k, lineDist.length - 1)]);

  // Run times for the new stretches, by part of the day: published trips between the two stops,
  // otherwise the speed of services nearby, otherwise the typical speed of the mode.
  const dwellSecs = await stopDwell(tx, baselineId, pattern.mode_id, -1, model.dwell);
  const timed: SectionTime[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.kind !== 'new') continue;
    const run = await sectionTime(tx, baselineId, pattern.mode_id, stops[i], stops[i + 1], stopDist[i + 1] - stopDist[i], {
      speed: model.speed,
      dwellAtTo: dwellSecs,
    });
    section.byBand = run.byBand;
    section.secs = run.byBand[2];
    timed.push(run);
  }
  const learned = timed.filter((t) => t.source === 'published').length;
  const estimated = timed.length - learned;

  const kept = keptAt.filter((a) => a >= 0).length;
  return {
    patternId,
    routeId: pattern.route_id,
    routeName: pattern.route_name,
    modeId: pattern.mode_id,
    ruleSet: pattern.rule_set,
    direction: pattern.direction_id,
    headsign: pattern.headsign,
    baselineId,
    oldStops,
    stops,
    keptAt,
    coords,
    lineDist,
    stopDist,
    sections,
    added: stops.length - kept,
    removed: oldStops.length - kept,
    learned,
    estimated,
    pathMethod,
    dwellSecs,
    timed,
    skipPenaltySecs: deps.skipPenalty[pattern.rule_set] ?? 20,
    rerouted,
    blocked,
    tripIds,
  };
}

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

const timing = (plan: ReshapePlan) => ({ dwellSecs: plan.dwellSecs, skipPenaltySecs: plan.skipPenaltySecs });

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
    if ((calls.get(id)?.length ?? 0) !== plan.oldStops.length) throw fail(409, 'A trip on this line does not match its stop pattern, so the line cannot be reshaped');
  }
  const idMap = await deps.cloneTrips(tx, sc, seq, plan.tripIds, 0, {
    replace: true,
    keepVehicle: options.keepVehicle !== false,
    stopTimes: false,
    tag: options.tag,
  });

  const col = {
    trip: [] as number[], seq: [] as number[], stop: [] as number[], arr: [] as number[], dep: [] as number[], dist: [] as number[],
    pickup: [] as number[], dropOff: [] as number[], oldTrip: [] as number[], oldSeq: [] as number[],
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

/**
 * The same change for the line's other direction, if it has one that lines up with this one.
 * Returns null when the line runs one way only, `{ reason }` when the change cannot be carried
 * across, and `{ same: true }` when the other direction already matches.
 */
export async function planOtherWay(
  tx: Sql,
  sc: Scenario | null,
  plan: ReshapePlan,
  options: ReshapeOptions,
  deps: ReshapeDeps,
): Promise<{ plan: ReshapePlan } | { reason: string } | { same: true } | null> {
  if (plan.direction === null) return null;
  const candidates = (
    await tx`
      select q.id, q.direction_id, q.stop_ids,
             (select count(*)::int from trips t where t.pattern_id = q.id and ${visible(tx, 't', sc)}) as trips
      from patterns q
      where q.route_id = ${plan.routeId} and q.direction_id is distinct from ${plan.direction} and q.direction_id is not null`
  ).filter((q) => q.trips > 0);
  if (!candidates.length) return null;

  const stopRows = await loadStops(tx, sc, plan.baselineId, [...new Set(candidates.flatMap((q) => q.stop_ids as number[]))]);
  const station = (s: StopRow) => s.parentId ?? s.id;
  /** Where an old stop's counterpart sits in a candidate: same station first, otherwise the nearest stop within 150 m. */
  const matchIn = (a: StopRow, ids: number[]): number | null => {
    let near: { j: number; d: number } | null = null;
    for (let j = 0; j < ids.length; j++) {
      const c = stopRows.get(ids[j]);
      if (!c) continue;
      if (c.id === a.id || station(c) === station(a)) return j;
      const d = distanceM(a.lon, a.lat, c.lon, c.lat);
      if (d <= 150 && (!near || d < near.d)) near = { j, d };
    }
    return near ? near.j : null;
  };
  let best: { q: (typeof candidates)[number]; match: (number | null)[]; score: number } | null = null;
  for (const q of candidates) {
    const match = plan.oldStops.map((a) => matchIn(a, q.stop_ids as number[]));
    const score = match.filter((j) => j !== null).length;
    if (!best || score > best.score || (score === best.score && q.trips > best.q.trips)) best = { q, match, score };
  }
  const opposite = best!.q.stop_ids as number[];
  if (best!.score < Math.max(2, Math.ceil(Math.min(plan.oldStops.length, opposite.length) / 2))) {
    return { reason: 'its stops do not line up with this direction' };
  }

  // The stop to use going the other way for each added stop.
  const counterpart: number[] = [];
  for (let i = 0; i < plan.stops.length; i++) {
    const s = plan.stops[i];
    if (plan.keptAt[i] >= 0) counterpart.push(s.id);
    else if (ROAD_MODES.has(plan.modeId)) counterpart.push(((await acrossTheRoad(tx, s.id))?.id as number | undefined) ?? s.id);
    else if (s.parentId !== null) counterpart.push((await pickPlatform(tx, sc, s.parentId, plan.routeId, best!.q.direction_id, 1, s.id)) ?? s.id);
    else counterpart.push(s.id);
  }
  const mirrored = mirrorStops({ keptAt: plan.keptAt, matchOld: best!.match, counterpart, opposite });
  if (!mirrored || mirrored.length < 2) return { reason: 'the change could not be matched to its stops' };
  if (mirrored.length === opposite.length && mirrored.every((id, i) => id === opposite[i])) return { same: true };
  try {
    return { plan: await planReshape(tx, sc, best!.q.id, mirrored, { ...options, platformIndex: 1 }, deps) };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 400) return { reason: (err as Error).message.toLowerCase() };
    throw err;
  }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 stops added, 1 removed" */
export const describeStops = (plan: { added: number; removed: number }) =>
  [plan.added ? `${count(plan.added, 'stop')} added` : '', plan.removed ? `${plan.removed}${plan.added ? '' : ` stop${plan.removed === 1 ? '' : 's'}`} removed` : '']
    .filter(Boolean)
    .join(', ') || 'stops reordered';

/** "trip times about 4 min longer" */
export const describeChange = (secs: number) => {
  const mins = Math.round(Math.abs(secs) / 60);
  if (mins === 0) return 'trip times about the same';
  return `trip times about ${mins} min ${secs > 0 ? 'longer' : 'shorter'}`;
};

/** How the new stretches were drawn and timed, or '' when the reshape only removed things. */
export const describeNewStretches = (plan: ReshapePlan) => {
  if (plan.pathMethod === null) return '';
  if (!plan.learned && !plan.estimated) return 'new path ' + describeMethod(plan.pathMethod);
  return `new path ${describeMethod(plan.pathMethod)}; run times: ${describeTimes(plan.timed, 'the new stretches take')}`;
};
