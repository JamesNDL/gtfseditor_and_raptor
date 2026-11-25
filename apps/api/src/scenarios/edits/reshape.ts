// Reshaping an existing line: a stopping pattern is given a new list of stops, and every trip that
// uses it is rebuilt over the new list. Extending, cutting short, re-routing and adding or removing
// a stop are all the same operation.
//
// What stays and what is worked out:
// - Stretches between stops that did not change keep the published path and each trip's own times.
// - New stretches get a path (along roads for road vehicles where it can be found) and a run time
//   learned from published trips between the two stops, or estimated from the mode's typical speed.
// - Each trip still leaves the first stop it shares with the old line at the same time.
import { ROAD_MODES } from '../../routing/roads.ts';
import { cloneTrips, type Scenario, type Tx } from '../engine.ts';
import { NEW_LINE, SKIP_PENALTY } from './assumptions.ts';
import { applyReshape } from './reshape/apply.ts';
import { describeChange, describeNewStretches, describeStops } from './reshape/describe.ts';
import { planOtherWay } from './reshape/other-way.ts';
import { planReshape } from './reshape/plan.ts';
import type { ReshapeDeps } from './reshape/types.ts';

// What closures, new lines and the preview routes use from reshaping.
export { ROAD_MODES };
export { applyReshape, typicalChange } from './reshape/apply.ts';
export { describeChange, describeNewStretches, describeStops } from './reshape/describe.ts';
export { planOtherWay } from './reshape/other-way.ts';
export { planReshape } from './reshape/plan.ts';
export { acrossTheRoad } from './reshape/stops.ts';
export type { ReshapeDeps, ReshapePlan } from './reshape/types.ts';

export const reshapeDeps: ReshapeDeps = {
  cloneTrips,
  newLine: NEW_LINE,
  skipPenalty: SKIP_PENALTY,
};

export interface ReshapeBody {
  patternId: number;
  stopIds: number[];
  followRoads?: boolean;
  direct?: boolean;
  bothWays?: boolean;
}
export const reshapeOptions = (body: ReshapeBody) => ({
  followRoads: body.followRoads !== false,
  direct: body.direct === true,
  platformIndex: 0,
});

/**
 * Gives one of a line's stop patterns a new list of stops and rebuilds every trip that uses it:
 * extending, cutting short, re-routing, adding or removing a stop. Unless told otherwise the
 * line's other direction is changed to match.
 */
export async function editReshape(tx: Tx, sc: Scenario, seq: number, body: ReshapeBody) {
  const options = reshapeOptions(body);
  const plan = await planReshape(
    tx,
    sc,
    Number(body.patternId),
    body.stopIds ?? [],
    options,
    reshapeDeps,
  );
  const other =
    body.bothWays === false ? null : await planOtherWay(tx, sc, plan, options, reshapeDeps);
  const done = await applyReshape(tx, sc, seq, plan, 0, reshapeDeps);
  const idMap = { ...done.idMap };
  let otherNote = '';
  if (other && 'plan' in other) {
    const back = await applyReshape(tx, sc, seq, other.plan, 1, reshapeDeps);
    Object.assign(idMap, back.idMap);
    otherNote = `. The other direction changed to match: ${describeStops(other.plan)}, ${back.trips} trip${back.trips === 1 ? '' : 's'}, ${describeChange(back.changeSecs)}`;
  } else if (other && 'reason' in other) {
    otherNote = `. The other direction is unchanged: ${other.reason}`;
  }
  const stretches = describeNewStretches(plan);
  const towards = plan.stops[plan.stops.length - 1].name
    .replace(/,.*$/, '')
    .replace(/ Station$/, '');
  return {
    summary: `${plan.routeName} towards ${towards}: ${describeStops(plan)} on ${done.trips} trip${done.trips === 1 ? '' : 's'}, ${describeChange(done.changeSecs)}${stretches ? `; ${stretches}` : ''}${otherNote}`,
    idMap,
    routeId: plan.routeId,
  };
}
