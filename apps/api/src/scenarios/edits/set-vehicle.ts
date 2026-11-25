// setVehicle edits: one trip moved to a new vehicle, or to one with spare time.
import { cloneTrips, type Scenario, type Tx } from '../engine.ts';
import { describe } from '../describe.ts';
import { assignVehicles } from '../vehicles.ts';

export interface SetVehicleBody {
  tripId: number;
  mode: 'new' | 'auto';
}

export async function editSetVehicle(tx: Tx, sc: Scenario, seq: number, body: SetVehicleBody) {
  const tripId = Number(body.tripId);
  const t = await describe(tx, tripId);
  const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: false });
  const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap), body.mode === 'new');
  return {
    summary: fleet.added
      ? `${t.label} now runs on a new vehicle`
      : `${t.label} moved to a vehicle with spare time`,
    idMap,
    focusTripId: idMap[tripId],
  };
}
