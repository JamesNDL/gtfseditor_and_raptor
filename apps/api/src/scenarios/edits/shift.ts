// shift edits: trips moved earlier or later, with the vehicle or line behind them if asked.
import { describe } from '../describe.ts';
import { minutes } from '../wording.ts';
import { cloneTrips, visible, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

type Ripple = 'none' | 'vehicle' | 'line';

export async function editShift(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { tripIds: number[]; delta: number; ripple?: Ripple },
) {
  const delta = Math.round(Number(body.delta));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 6 * 3600)
    throw fail(400, 'Shift must be between 1 second and 6 hours');
  const chosen = body.tripIds.map(Number);
  if (!chosen.length) throw fail(400, 'No trips given');
  const ids = new Set<number>(chosen);
  const vis = visible(tx, 't', sc);
  for (const id of chosen) {
    const t = await describe(tx, id);
    if (body.ripple === 'vehicle' && t.vehicle_day_id) {
      const rows =
        await tx`select t.id from trips t where t.vehicle_day_id = ${t.vehicle_day_id} and t.start_secs > ${t.start_secs} and ${vis}`;
      for (const r of rows) ids.add(r.id);
    } else if (body.ripple === 'line') {
      const rows = await tx`
        select t.id from trips t where t.baseline_id = ${sc.baselineId} and t.route_id = ${t.route_id}
          and t.direction_id is not distinct from ${t.direction_id} and t.start_secs > ${t.start_secs} and ${vis}`;
      for (const r of rows) ids.add(r.id);
    }
  }
  const all = [...ids];
  const [{ earliest, latest }] =
    await tx`select min(start_secs) as earliest, max(end_secs) as latest from trips where id = any(${all})`;
  if (earliest + delta < 0) throw fail(400, 'That would start before the service day begins');
  if (delta > 0 && latest + delta > 36 * 3600)
    throw fail(
      400,
      'That would run past midday the next day, which is later than a service day can go',
    );
  const first = await describe(tx, chosen[0]);
  const idMap = await cloneTrips(tx, sc, seq, all, delta, {
    pinnedIds: chosen,
    replace: true,
    keepVehicle: true,
  });
  const extra = all.length - chosen.length;
  return {
    summary: `Moved ${first.label} ${minutes(delta)} ${delta > 0 ? 'later' : 'earlier'}${extra > 0 ? ` with ${extra} following trip${extra === 1 ? '' : 's'}` : ''}`,
    idMap,
    focusTripId: idMap[chosen[0]],
  };
}
