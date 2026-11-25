// setVehicleType edits: which vehicle type runs a line, a vehicle day or a trip.
import { describe } from '../describe.ts';
import { cloneTrips, visible, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

/** Runs a line, one vehicle's day, or one trip with a chosen vehicle type. */
export async function editSetVehicleType(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { scope: 'route' | 'vehicleDay' | 'trip'; id: number; vehicleTypeId: number },
) {
  const id = Number(body.id);
  const [type] = await tx`
    select v.id, v.name, m.rule_set, m.name as mode_name from vehicle_types v join modes m on m.id = v.mode_id where v.id = ${Number(body.vehicleTypeId)}`;
  if (!type) throw fail(400, 'Unknown vehicle type');
  const vis = visible(tx, 't', sc);
  let ids: number[];
  let what: string;
  if (body.scope === 'trip') {
    ids = [id];
    what = (await describe(tx, id)).label;
  } else if (body.scope === 'vehicleDay') {
    ids = (await tx`select t.id from trips t where t.vehicle_day_id = ${id} and ${vis}`).map(
      (r) => r.id,
    );
    const [vd] = await tx`select label from vehicle_days where id = ${id}`;
    what = vd?.label ?? 'Vehicle';
  } else if (body.scope === 'route') {
    ids = (
      await tx`select t.id from trips t where t.route_id = ${id} and t.baseline_id = ${sc.baselineId} and ${vis}`
    ).map((r) => r.id);
    const [r] =
      await tx`select coalesce(short_name, long_name) as name from routes where id = ${id}`;
    what = `Line ${r?.name ?? ''}`;
  } else {
    throw fail(400, 'Unknown scope');
  }
  if (!ids.length) throw fail(400, 'No trips to change');
  const [wrong] = await tx`
    select m.name from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
    where t.id = any(${ids}) and m.rule_set <> ${type.rule_set} limit 1`;
  if (wrong)
    throw fail(
      400,
      `${type.name} is a ${String(type.mode_name).toLowerCase()} vehicle, so it cannot run a ${String(wrong.name).toLowerCase()} service`,
    );
  const idMap = await cloneTrips(tx, sc, seq, ids, 0, { replace: true, keepVehicle: true });
  await tx`update trips set vehicle_type_id = ${type.id} where id = any(${Object.values(idMap)})`;
  return {
    summary: `${what} now runs with ${type.name}${ids.length > 1 ? ` (${ids.length} trips)` : ''}`,
    idMap,
    focusTripId: body.scope === 'trip' ? idMap[id] : undefined,
  };
}
