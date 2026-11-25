// duplicate edits: a copy of a trip at another time.
import { formatSecs } from '@gtfs-editor/core';
import { platformNote, settlePlatforms } from '../platforms.ts';
import { describe } from '../describe.ts';
import { assignVehicles } from '../vehicles.ts';
import { fleetNote } from '../wording.ts';
import { cloneTrips, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

export interface DuplicateBody {
  tripId: number;
  startSecs: number;
}

export async function editDuplicate(tx: Tx, sc: Scenario, seq: number, body: DuplicateBody) {
  const t = await describe(tx, Number(body.tripId));
  const start = Math.round(Number(body.startSecs));
  if (!Number.isFinite(start) || start < 0 || start > 36 * 3600)
    throw fail(400, 'Bad departure time');
  const idMap = await cloneTrips(tx, sc, seq, [Number(body.tripId)], start - t.start_secs, {
    pinnedIds: [Number(body.tripId)],
    replace: false,
    keepVehicle: false,
  });
  const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap));
  const settled = await settlePlatforms(tx, sc, seq, Object.values(idMap));
  return {
    summary: `Added a copy of ${t.label} departing ${formatSecs(start)}${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
    focusTripId: idMap[Number(body.tripId)],
  };
}
