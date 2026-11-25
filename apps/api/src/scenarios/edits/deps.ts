// What the edit kinds that are handed their helpers are given: closures and deleting a stop. The
// edits endpoint and the preview routes share these.
import { reshapeDeps } from './reshape.ts';
import { SKIP_PENALTY } from './assumptions.ts';
import { conflictsIn } from '../clashes.ts';
import { assignVehicles } from '../vehicles.ts';
import {
  cloneTrips,
  dayFigures,
  fleetFigures,
  removeTrips,
  type Scenario,
  type Tx,
} from '../engine.ts';

export const closureDeps = {
  ...reshapeDeps,
  assignVehicles,
  removeTrips,
  fleetFigures,
  dayFigures,
};
export const deleteStopDeps = {
  cloneTrips,
  removeTrips,
  skipPenalty: SKIP_PENALTY,
  clashes: async (tx: Tx, sc: Scenario) => (await conflictsIn(tx, sc, false)).conflicts.length,
};
