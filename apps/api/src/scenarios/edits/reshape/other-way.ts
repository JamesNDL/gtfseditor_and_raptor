// Carrying a reshape across to the line's other direction.
import { distanceM, mirrorStops } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { ROAD_MODES } from '../../../routing/roads.ts';
import { visible, type Scenario } from '../../engine.ts';
import { planReshape } from './plan.ts';
import { acrossTheRoad, loadStops, pickPlatform } from './stops.ts';
import type { ReshapeDeps, ReshapeOptions, ReshapePlan, StopRow } from './types.ts';

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

  const stopRows = await loadStops(tx, sc, plan.baselineId, [
    ...new Set(candidates.flatMap((q) => q.stop_ids as number[])),
  ]);
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
  let best: { q: (typeof candidates)[number]; match: (number | null)[]; score: number } | null =
    null;
  for (const q of candidates) {
    const match = plan.oldStops.map((a) => matchIn(a, q.stop_ids as number[]));
    const score = match.filter((j) => j !== null).length;
    if (!best || score > best.score || (score === best.score && q.trips > best.q.trips))
      best = { q, match, score };
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
    else if (ROAD_MODES.has(plan.modeId))
      counterpart.push(((await acrossTheRoad(tx, s.id))?.id as number | undefined) ?? s.id);
    else if (s.parentId !== null)
      counterpart.push(
        (await pickPlatform(tx, sc, s.parentId, plan.routeId, best!.q.direction_id, 1, s.id)) ??
          s.id,
      );
    else counterpart.push(s.id);
  }
  const mirrored = mirrorStops({
    keptAt: plan.keptAt,
    matchOld: best!.match,
    counterpart,
    opposite,
  });
  if (!mirrored || mirrored.length < 2)
    return { reason: 'the change could not be matched to its stops' };
  if (mirrored.length === opposite.length && mirrored.every((id, i) => id === opposite[i]))
    return { same: true };
  try {
    return {
      plan: await planReshape(tx, sc, best!.q.id, mirrored, { ...options, platformIndex: 1 }, deps),
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 400)
      return { reason: (err as Error).message.toLowerCase() };
    throw err;
  }
}
