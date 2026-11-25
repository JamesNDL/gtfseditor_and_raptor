// moveToVehicle edits: a trip moves to another vehicle.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { describe } from '../describe.ts';
import { cloneTrips, type Scenario } from '../engine.ts';
import { fail } from '../../http.ts';

export interface MoveToVehicleBody {
  tripId: number;
  vehicleDayId: number;
}

/** Puts a trip on a chosen vehicle, or on a new one. Whether the vehicle can make it is left to the clash check. */
export async function editMoveToVehicle(
  tx: Sql,
  sc: Scenario,
  seq: number,
  body: MoveToVehicleBody,
) {
  const tripId = Number(body.tripId);
  const dayId = Number(body.vehicleDayId);
  const t = await describe(tx, tripId);
  const [day] = await tx`
    select vd.id, vd.label, vd.mode_id, r.mode_id as trip_mode from vehicle_days vd, trips t join routes r on r.id = t.route_id
    where vd.id = ${dayId} and t.id = ${tripId} and vd.baseline_id = ${sc.baselineId}
      and (vd.scenario_id is null or (vd.scenario_id = ${sc.id} and vd.created_edit <= ${sc.head}))`;
  if (!day) throw fail(404, 'Vehicle not found');
  if (day.mode_id !== day.trip_mode)
    throw fail(400, 'That vehicle is a different kind from the one this trip needs');
  if (t.vehicle_day_id === dayId) throw fail(400, 'The trip is already on that vehicle');
  const idMap = await cloneTrips(tx, sc, seq, [tripId], 0, { replace: true, keepVehicle: false });
  await tx`update trips set vehicle_day_id = ${dayId} where id = ${idMap[tripId]}`;
  return { summary: `${t.label} moved to ${day.label}`, idMap, focusTripId: idMap[tripId] };
}
