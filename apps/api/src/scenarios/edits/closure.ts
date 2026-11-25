// Closures: a line drawn on the map that nothing can run through, whatever kind of service it is.
// Each line it crosses is split there: the part on each side becomes a line of its own (B1 becomes
// B1-N and B1-S), with its own path and timetable, and its vehicles turn back at the last stop
// before the closure. Either part can be dropped. A bus or coach line can be sent round by other
// roads instead.
// (Two older forms are still taken: a stretch of road round a point, and one mode's line between
// two stations.)
//
// A closure is an area on the map. Every stop pattern whose path enters it is changed, using the
// same machinery as "Change route":
// - Road vehicles are sent another way between the last stop before the closure and the first stop
//   after it, and no longer call at the stops inside it.
// - Trains, trams and ferries cannot go round, so each trip is cut in two: one part that ends at the
//   last station before the closure, and one that starts from the first station after it.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { applyReshape, describeChange } from './reshape.ts';
import { entersAvoid } from '../../routing/roads.ts';
import { visible, type Scenario } from '../engine.ts';
import { fail } from '../../http.ts';
import { planClosure } from './closure/plan.ts';
import type { Action, CloseBody, ClosureDeps } from './closure/types.ts';
import { count, median, SIDE_NAME } from './closure/wording.ts';

export type { CloseBody, ClosureDeps } from './closure/types.ts';

/** Closes a road or a line and changes every trip that ran through it. */
export async function editClose(
  tx: Sql,
  sc: Scenario,
  seq: number,
  body: CloseBody,
  deps: ClosureDeps,
) {
  const plan = await planClosure(tx, sc, sc.baselineId, body, deps, 'all');
  if (
    !plan.items.some((i) => i.action !== 'blocked' && i.action !== 'failed' && i.action !== 'left')
  ) {
    throw fail(
      400,
      plan.items.length
        ? 'None of the lines through here could be changed'
        : 'Nothing runs through there, so there is nothing to change',
    );
  }
  const idMap: Record<number, number> = {};
  const replan: number[] = [];
  const changes: number[] = [];
  const tally = {
    detour: 0,
    shortened: 0,
    split: 0,
    joined: 0,
    removed: 0,
    blocked: 0,
    failed: 0,
    left: 0,
  } satisfies Record<Action, number>;
  const tripsBy = { ...tally };
  const lines = new Set<number>();
  const closedStops = new Set<string>();
  // The part of a line on one side of the closure is a line of its own, named after the original.
  const variants = new Map<string, { id: number; name: string }>();
  // For the vehicles: which side of the closure each part is on, and the trips the parts came from.
  const sideOfPart = new Map<number, string>();
  const splitFrom: number[] = [];
  const leftNames = { blocked: new Set<string>(), failed: new Set<string>() };
  const variantOf = async (routeId: number, side: string) => {
    const key = `${routeId}:${side}`;
    let made = variants.get(key);
    if (!made) {
      const [row] = await tx`
        insert into routes (baseline_id, gtfs_id, agency_gtfs_id, agency_name, short_name, long_name, description, route_type, mode_id,
                            color, text_color, vehicle_type_id, extra, scenario_id, created_edit)
        select baseline_id, gtfs_id || '~' || ${side} || '.' || ${sc.id}::int || '.' || ${seq}::int, agency_gtfs_id, agency_name,
               coalesce(short_name, long_name, 'Line') || '-' || ${side},
               coalesce(long_name, short_name, 'Line') || ${` (${SIDE_NAME[side] ?? side} of the closure)`},
               description, route_type, mode_id, color, text_color, vehicle_type_id,
               extra || jsonb_build_object('variantOf', id, 'side', ${side}::text), ${sc.id}, ${seq}
        from routes where id = ${routeId}
        returning id, short_name as name`;
      variants.set(key, (made = { id: row.id as number, name: row.name as string }));
    }
    return made;
  };
  let part = 0;
  for (const item of plan.items) {
    tally[item.action]++;
    tripsBy[item.action] += item.trips;
    if (item.action === 'blocked' || item.action === 'failed')
      leftNames[item.action].add(item.name);
    if (item.action === 'blocked' || item.action === 'failed' || item.action === 'left') continue;
    lines.add(item.routeId);
    for (const name of item.closedStops) closedStops.add(name);
    if (item.action === 'removed') {
      const ids =
        item.tripIds ??
        (
          await tx`select t.id from trips t where t.pattern_id = ${item.patternId} and ${visible(tx, 't', sc)}`
        ).map((t) => t.id as number);
      await deps.removeTrips(tx, sc, seq, ids);
    } else if (item.action === 'detour') {
      const done = await applyReshape(tx, sc, seq, item.plans[0], part++, deps);
      Object.assign(idMap, done.idMap);
      changes.push(done.changeSecs);
    } else if (item.action === 'joined') {
      // Still one trip from the same start to the same end, so it keeps its vehicle.
      const done = await applyReshape(tx, sc, seq, item.plans[0], part++, deps, {
        routeId: (await variantOf(item.routeId, item.planSides[0])).id,
      });
      Object.assign(idMap, done.idMap);
    } else if (item.plans.length === 1 && !plan.sides) {
      Object.assign(idMap, (await applyReshape(tx, sc, seq, item.plans[0], part++, deps)).idMap);
    } else {
      // Each trip becomes one trip for each part that is kept. No part can keep the vehicle, which
      // would have to cross the closure: they are given vehicles again below, which turn back at the closure.
      const parts: number[] = [];
      for (const [k, piecePlan] of item.plans.entries()) {
        const routeId = plan.sides
          ? (await variantOf(item.routeId, item.planSides[k])).id
          : undefined;
        const done = await applyReshape(tx, sc, seq, piecePlan, part++, deps, {
          keepVehicle: false,
          tag: 'ab'[k],
          routeId,
        });
        if (k === 0) Object.assign(idMap, done.idMap);
        parts.push(...Object.values(done.idMap));
        if (plan.sides)
          for (const id of Object.values(done.idMap)) sideOfPart.set(id, item.planSides[k]);
        if (k === 0) splitFrom.push(...piecePlan.tripIds);
      }
      // A trip that took its vehicle type from its vehicle keeps that type once it is taken off it.
      await tx`
        update trips n set vehicle_type_id = tv.vehicle_type_id
        from trip_vehicle tv
        where tv.trip_id = n.cloned_from and n.id = any(${parts}) and n.vehicle_type_id is null and not tv.assumed`;
      replan.push(...parts);
    }
  }
  // The parts are given vehicles. A vehicle stays on one side of the closure: it never takes a part
  // from the other side, nor one it could only reach by crossing. (Until 20 Nov the two halves of a
  // bus trip, a minute and a few hundred metres apart, were put back on one bus across the closure.)
  // The vehicles that ran the trips before may take the parts that are in the right place for them.
  const routeIds = [...lines, ...[...variants.values()].map((v) => v.id)];
  const figuresBefore = replan.length ? await deps.fleetFigures(tx, sc, routeIds) : null;
  const dayBefore = replan.length ? await deps.dayFigures(tx, sc.baselineId, sc) : null;
  const oldDays = splitFrom.length
    ? (
        await tx`select distinct vehicle_day_id as id from trips where id = any(${splitFrom}) and vehicle_day_id is not null`
      ).map((r) => r.id as number)
    : [];
  const zoneAvoid = plan.avoid;
  const fleet = replan.length
    ? await deps.assignVehicles(tx, sc, seq, replan, false, {
        groupOf: sideOfPart,
        crosses: zoneAvoid
          ? (ax, ay, bx, by) =>
              (ax !== bx || ay !== by) &&
              entersAvoid(
                [
                  [ax, ay],
                  [bx, by],
                ],
                zoneAvoid,
              )
          : undefined,
        alsoDays: oldDays,
      })
    : null;
  const figuresAfter = replan.length
    ? await deps.fleetFigures(tx, { ...sc, head: seq }, routeIds)
    : null;
  const dayAfter = replan.length
    ? await deps.dayFigures(tx, sc.baselineId, { ...sc, head: seq })
    : null;
  await tx`
    insert into scenario_closures (scenario_id, created_edit, kind, label, geom, from_secs, to_secs)
    values (${sc.id}, ${seq}, ${plan.what}, ${plan.label}, ST_Multi(ST_GeomFromText(${plan.zoneWkt}, 4326)),
            ${plan.window?.fromSecs ?? null}, ${plan.window?.toSecs ?? null})`;

  const parts: string[] = [];
  if (tally.detour)
    parts.push(
      `${count(tripsBy.detour, 'trip')} sent another way, ${describeChange(median(changes))}`,
    );
  if (tally.split)
    parts.push(`${count(tripsBy.split, 'trip')} now run in two parts, one either side`);
  if (tally.shortened) parts.push(`${count(tripsBy.shortened, 'trip')} cut short`);
  if (tally.joined) parts.push(`${count(tripsBy.joined, 'trip')} now turn round before it`);
  if (tally.removed) parts.push(`${count(tripsBy.removed, 'trip')} removed`);
  if (variants.size) {
    const made = [...variants.values()].map((v) => v.name);
    parts.push(
      `the parts run as ${made.slice(0, 6).join(', ')}${made.length > 6 ? ` and ${made.length - 6} more` : ''}`,
    );
  }
  if (closedStops.size) {
    const list = [...closedStops];
    parts.push(
      `${count(list.length, 'stop')} closed (${list.slice(0, 4).join(', ')}${list.length > 4 ? ` and ${list.length - 4} more` : ''})`,
    );
  }
  if (fleet && figuresBefore && figuresAfter && dayBefore && dayAfter) {
    const more = dayAfter.vehicles - dayBefore.vehicles;
    parts.push(
      `their vehicles were worked out again and stay on their own side of the closure: ${count(fleet.added, 'new vehicle')}, ${count(fleet.reused, 'part')} on vehicles already running; ` +
        `the network now uses ${dayAfter.vehicles.toLocaleString('en-AU')} vehicles, ${more === 0 ? 'the same as before' : `${Math.abs(more)} ${more > 0 ? 'more' : 'fewer'} than before`} (an estimate: each is a chain of trips one vehicle could run), ` +
        `and the most trips these lines have running at once went from ${figuresBefore.peak} to ${figuresAfter.peak}`,
    );
  }
  const named = (names: Set<string>) => {
    const list = [...names];
    return `${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}`;
  };
  if (tally.blocked)
    parts.push(
      `${count(tally.blocked, 'stop pattern')} (${count(tripsBy.blocked, 'trip')}) left running through it because no way round was found: ${named(leftNames.blocked)}`,
    );
  if (tally.failed)
    parts.push(
      `${count(tally.failed, 'stop pattern')} (${count(tripsBy.failed, 'trip')}) could not be changed and still run through it: ${named(leftNames.failed)}`,
    );
  if (plan.skipped)
    parts.push(
      `${count(plan.skipped, 'more stop pattern')} left as they are; close a smaller stretch to change them`,
    );
  return {
    summary: `${plan.label}: ${count(lines.size, 'line')} changed; ${parts.join('; ')}`,
    idMap,
  };
}
