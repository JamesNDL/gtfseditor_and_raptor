// Records a finished baseline's counts and marks it ready to open.
import type { Tx } from '../db.ts';

/** Stores the baseline's counts (trips, stop times, vehicle days and so on) and marks it ready. */
export async function finishBaseline(tx: Tx, baselineId: number): Promise<Record<string, unknown>> {
  const [{ stats }] = await tx`
    select jsonb_build_object(
      'trips', (select count(*) from trips where baseline_id = ${baselineId}),
      'stopTimes', (select count(*) from stop_times st join trips t on t.id = st.trip_id where t.baseline_id = ${baselineId}),
      'routesRunning', (select count(*) from routes where baseline_id = ${baselineId} and trip_count > 0),
      'patterns', (select count(*) from patterns where baseline_id = ${baselineId}),
      'vehicleDays', (select count(*) from vehicle_days where baseline_id = ${baselineId}),
      'vehicleDaysInferred', (select count(*) from vehicle_days where baseline_id = ${baselineId} and source = 'inferred'),
      'baselineConflicts', (select count(*) from baseline_conflicts where baseline_id = ${baselineId}),
      'tripsWithAssumedVehicle', (select count(*) from trip_vehicle v join trips t on t.id = v.trip_id
                                  where t.baseline_id = ${baselineId} and v.assumed),
      'firstDeparture', (select min(start_secs) from trips where baseline_id = ${baselineId}),
      'lastArrival', (select max(end_secs) from trips where baseline_id = ${baselineId})
    ) as stats`;
  await tx`update baselines set stats = ${tx.json(stats)}, ready = true where id = ${baselineId}`;
  return stats;
}
