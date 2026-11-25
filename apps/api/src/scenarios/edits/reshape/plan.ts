// Working out what a reshape would do, without changing anything: the new stops, the new path, and
// the run time of each new stretch.
import {
  keptIndexes,
  locateStops,
  pathDistances,
  slicePath,
  type Coord,
  type ReshapeSection,
  maxSpeedMs,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  entersAvoid,
  linePath,
  METHOD_STRENGTH,
  ROAD_MODES,
  type PathMethod,
} from '../../../routing/roads.ts';
import { sectionTime, stopDwell, type SectionTime } from '../../../routing/timings.ts';
import { fail } from '../../../http.ts';
import { visible, type Scenario } from '../../engine.ts';
import { loadStops, pickPlatform } from './stops.ts';
import type { ReshapeDeps, ReshapeOptions, ReshapePlan } from './types.ts';

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
  if (sc && sc.baselineId !== pattern.baseline_id)
    throw fail(400, 'That line belongs to a different day');
  const baselineId: number = pattern.baseline_id;
  const model = deps.newLine[pattern.mode_id];
  if (!model) throw fail(400, 'Unknown mode');

  const trips =
    await tx`select t.id from trips t where t.pattern_id = ${patternId} and ${visible(tx, 't', sc)} order by t.start_secs, t.id`;
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
    const platform = await pickPlatform(
      tx,
      sc,
      id,
      pattern.route_id,
      pattern.direction_id,
      options.platformIndex,
    );
    if (platform === null) throw fail(400, `${stop.name} has no platforms to stop at`);
    newIds.push(platform);
  }
  for (const [id, row] of await loadStops(
    tx,
    sc,
    baselineId,
    newIds.filter((id) => !known.has(id)),
  ))
    known.set(id, row);
  for (let i = 1; i < newIds.length; i++) {
    if (newIds[i] === newIds[i - 1])
      throw fail(400, `${known.get(newIds[i])!.name} is listed twice in a row`);
  }
  if (
    !options.avoid &&
    newIds.length === oldIds.length &&
    newIds.every((id, i) => id === oldIds[i])
  )
    throw fail(400, 'Nothing has changed yet');

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
      const calls =
        await tx`select st.dist from stop_times st where st.trip_id = ${tripIds[0]} order by st.seq`;
      const callDist = calls.map((c) => c.dist as number | null);
      const usable =
        stored !== null &&
        stored.length === oldCoords.length &&
        callDist.length === oldIds.length &&
        callDist.every((d, i) => d !== null && (i === 0 || d >= callDist[i - 1]!));
      if (usable) {
        oldDists = stored!;
        oldStopDist = callDist as number[];
      } else if (oldCoords.length >= 2) {
        // No usable distances in the feed: measure the path and place the stops on it.
        oldDists = pathDistances(oldCoords);
        oldStopDist = locateStops(
          oldCoords,
          oldStops.map((s) => [s.lon, s.lat]),
        ).map((k) => oldDists[k]);
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
  const oldPiece = (i: number) =>
    slicePath(oldCoords, oldDists, oldStopDist[keptAt[i - 1]], oldStopDist[keptAt[i]]);
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
  for (let i = 1; i < stops.length;) {
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
    const found = await linePath(
      tx,
      baselineId,
      pattern.mode_id,
      run.map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, stationId: s.parentId })),
      {
        follow: options.followRoads || avoid !== undefined,
        avoid,
      },
    );
    const piece: Coord[] = found.coords;
    const method = found.method;
    if (found.blocked) blocked = true;
    if (
      pathMethod === null ||
      METHOD_STRENGTH.indexOf(method) < METHOD_STRENGTH.indexOf(pathMethod)
    )
      pathMethod = method;
    const at =
      found.at ??
      locateStops(
        piece,
        run.map((s) => [s.lon, s.lat]),
      );
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
      sections.push({
        kind: 'detour',
        factor: Math.max(0.5, factor),
        lengthM: length,
        extraM: length - was,
        speed: model.speed,
        maxSpeed: maxSpeedMs(pattern.mode_id),
      });
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
    const run = await sectionTime(
      tx,
      baselineId,
      pattern.mode_id,
      stops[i],
      stops[i + 1],
      stopDist[i + 1] - stopDist[i],
      {
        speed: model.speed,
        dwellAtTo: dwellSecs,
      },
    );
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
