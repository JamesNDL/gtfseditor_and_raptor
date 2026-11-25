// replan edits: a line's vehicles worked out again from nothing.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { assignVehicles } from '../vehicles.ts';
import { cloneTrips, visible, type Scenario } from '../engine.ts';
import { fail } from '../../http.ts';

export interface ReplanBody {
  routeId: number;
}

/**
 * Works out a line's vehicles again from nothing: every trip on the line comes off its vehicle and
 * the trips are chained afresh, each onto the vehicle that has been waiting the shortest time in
 * the right place. Useful after frequency changes, which add vehicles one edit at a time.
 */
export async function editReplan(tx: Sql, sc: Scenario, seq: number, body: ReplanBody) {
  const routeId = Number(body.routeId);
  const [route] =
    await tx`select coalesce(short_name, long_name) as name from routes where id = ${routeId}`;
  if (!route) throw fail(404, 'Line not found');
  const vis = visible(tx, 't', sc);
  const rows =
    await tx`select t.id, t.vehicle_day_id from trips t where t.route_id = ${routeId} and t.baseline_id = ${sc.baselineId} and ${vis}`;
  if (!rows.length) throw fail(400, 'This line has no trips');
  const days = [...new Set(rows.map((r) => r.vehicle_day_id).filter((d) => d !== null))];
  const [{ shared }] = await tx`
    select count(distinct t.vehicle_day_id)::int as shared from trips t
    where t.vehicle_day_id = any(${days}) and t.route_id <> ${routeId} and ${vis}`;
  const [{ n: networkBefore }] =
    await tx`select count(distinct t.vehicle_day_id)::int as n from trips t where t.baseline_id = ${sc.baselineId} and ${vis}`;
  const idMap = await cloneTrips(
    tx,
    sc,
    seq,
    rows.map((r) => r.id),
    0,
    { replace: true, keepVehicle: false },
  );
  const fleet = await assignVehicles(tx, sc, seq, Object.values(idMap), 'fresh');
  // The line's own figure can fall while the network's rises: a vehicle that also runs other
  // lines keeps those trips, and now counts on its own. So the network's change is said too.
  const [{ n: networkAfter }] = await tx`
    select count(distinct t.vehicle_day_id)::int as n from trips t where t.baseline_id = ${sc.baselineId} and ${visible(tx, 't', { ...sc, head: seq })}`;
  const net = networkAfter - networkBefore;
  return {
    summary: `${route.name}: vehicles worked out again for all ${rows.length} trips; ${fleet.added} vehicle${fleet.added === 1 ? '' : 's'} where there ${days.length === 1 ? 'was' : 'were'} ${days.length}${shared ? ` (${shared} of the old ones also run other lines and keep those trips)` : ''}; across the whole network that is ${net === 0 ? 'no change' : `${Math.abs(net)} ${net > 0 ? 'more' : 'fewer'}`}`,
    idMap,
  };
}
