// deleteLine edits: every trip of a line taken out of the scenario.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { removeTrips, visible, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

export interface DeleteLineBody {
  routeId: number;
}

/** Takes a whole line out of the scenario: every trip it still runs, in both directions. */
export async function editDeleteLine(tx: Tx, sc: Scenario, seq: number, body: DeleteLineBody) {
  const routeId = Number(body.routeId);
  const [route] = await tx`
    select coalesce(short_name, long_name, 'the line') as name from routes where id = ${routeId} and baseline_id = ${sc.baselineId}`;
  if (!route) throw fail(404, 'Line not found');
  const trips =
    await tx`select t.id from trips t where t.route_id = ${routeId} and ${visible(tx as unknown as Sql, 't', sc)}`;
  if (!trips.length) throw fail(400, 'That line has no trips left to delete');
  await removeTrips(
    tx,
    sc,
    seq,
    trips.map((t) => t.id),
  );
  return {
    summary: `Deleted line ${route.name}: ${trips.length} trip${trips.length === 1 ? '' : 's'}`,
    idMap: {},
  };
}
