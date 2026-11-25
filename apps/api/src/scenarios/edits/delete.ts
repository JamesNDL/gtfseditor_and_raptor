// delete edits: trips taken out of the scenario.
import { describe } from '../describe.ts';
import { removeTrips, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

export interface DeleteBody {
  tripIds: number[];
}

export async function editDelete(tx: Tx, sc: Scenario, seq: number, body: DeleteBody) {
  const ids = body.tripIds.map(Number);
  if (!ids.length) throw fail(400, 'No trips given');
  const first = await describe(tx, ids[0]);
  await removeTrips(tx, sc, seq, ids);
  return {
    summary:
      ids.length === 1
        ? `Deleted ${first.label}`
        : `Deleted ${ids.length} trips starting with ${first.label}`,
    idMap: {},
  };
}
