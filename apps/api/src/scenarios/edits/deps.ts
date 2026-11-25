// What the edit kinds that are handed their helpers are given: closures, deleting a stop and the
// schedule edits. The edits endpoint and the preview routes share these.
import { reshapeDeps } from './reshape.ts';
import { scheduleEdits } from './schedule.ts';
import { NEW_LINE, SKIP_PENALTY } from './assumptions.ts';
import { conflictsIn } from '../clashes.ts';
import { describe } from '../describe.ts';
import { assignVehicles } from '../vehicles.ts';
import { fleetNote } from '../wording.ts';
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
export const schedule = scheduleEdits({
  cloneTrips,
  assignVehicles,
  describe: describe as never,
  fleetNote,
  skipPenalty: SKIP_PENALTY,
  newLine: NEW_LINE,
});
export const { settlePlatforms, platformNote } = schedule;
