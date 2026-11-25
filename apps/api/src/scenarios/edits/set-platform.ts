// setPlatform edits: one call of a trip moves to another platform at the same station.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { movePlatform, platformChoices } from '../platforms.ts';
import { describe } from '../describe.ts';
import { cloneTrips, type Scenario } from '../engine.ts';
import { fail } from '../../http.ts';

export interface SetPlatformBody {
  tripId: number;
  stopSeq: number;
  stopId: number;
}

const platformName = (name: string, code: string | null) =>
  code ? `platform ${code}` : name.replace(/^.*, /, '');
const stationName = (name: string) => name.replace(/, Platform.*$/, '').replace(/ Station.*$/, '');

/** Moves one call of a trip to another platform at the same station. */
export async function editSetPlatform(tx: Sql, sc: Scenario, seq: number, body: SetPlatformBody) {
  const tripId = Number(body.tripId);
  const stopSeq = Number(body.stopSeq);
  const t = await describe(tx, tripId);
  const choice = (await platformChoices(tx, sc, tripId, stopSeq)).find(
    (c) => c.id === Number(body.stopId),
  );
  if (!choice) throw fail(400, 'That is not a platform at the same station');
  if (choice.current) throw fail(400, 'The trip already uses that platform');
  const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: true });
  await movePlatform(tx, idMap[tripId], stopSeq, choice.id);
  return {
    summary: `${t.label} now uses ${platformName(choice.name, choice.platformCode)} at ${stationName(choice.name)}${choice.free ? '' : ', which is busy at that time'}`,
    idMap,
    focusTripId: idMap[tripId],
  };
}
