// Builds vehicle days for a baseline and writes them back to the database.
import { buildVehicleDays, type ChainTrip, type RuleSet } from '@gtfs-editor/core';
import type { Tx } from '../db.ts';

export async function importVehicleDays(
  tx: Tx,
  baselineId: number,
  log: (m: string) => void,
): Promise<void> {
  const started = Date.now();
  const rows = await tx`
    select t.id, t.start_secs, t.end_secs, t.run_key, t.feed_block_id, t.vehicle_type_id,
           r.mode_id, r.agency_gtfs_id, m.rule_set,
           ST_X(coalesce(fp.geom, f.geom)) as first_lon, ST_Y(coalesce(fp.geom, f.geom)) as first_lat,
           ST_X(coalesce(lp.geom, l.geom)) as last_lon, ST_Y(coalesce(lp.geom, l.geom)) as last_lat
    from trips t
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    join stops f on f.id = t.first_stop_id
    join stops l on l.id = t.last_stop_id
    -- Rail and ferry terminals are compared at the station, so any platform matches any other.
    left join stops fp on fp.id = f.parent_id and m.rule_set <> 'road'
    left join stops lp on lp.id = l.parent_id and m.rule_set <> 'road'
    where t.baseline_id = ${baselineId}`;

  const modeOf = new Map<number, string>();
  const typeOf = new Map<number, number | null>();
  const trips: ChainTrip[] = rows.map((r) => {
    modeOf.set(r.id, r.mode_id);
    typeOf.set(r.id, r.vehicle_type_id);
    return {
      id: r.id,
      startSecs: r.start_secs,
      endSecs: r.end_secs,
      firstLon: r.first_lon,
      firstLat: r.first_lat,
      lastLon: r.last_lon,
      lastLat: r.last_lat,
      ruleSet: r.rule_set as RuleSet,
      // Never chain across modes, operators or known vehicle types.
      partition: `${r.mode_id}|${r.agency_gtfs_id ?? ''}|${r.vehicle_type_id ?? ''}`,
      runKey: r.run_key,
      blockId: r.feed_block_id,
    };
  });

  const days = buildVehicleDays(trips);

  const counters = new Map<string, number>();
  const dayRows = days.map((d) => {
    const modeId = modeOf.get(d.tripIds[0])!;
    const n = (counters.get(modeId) ?? 0) + 1;
    counters.set(modeId, n);
    // A vehicle day only gets a type when every trip on it agrees.
    const types = new Set(d.tripIds.map((id) => typeOf.get(id) ?? null));
    const [onlyType] = types;
    return {
      baseline_id: baselineId,
      mode_id: modeId,
      label: d.runKey ? `Run ${d.runKey}` : `${modeId.replace('_', ' ')} ${n}`,
      source: d.source,
      vehicle_type_id: types.size === 1 ? onlyType : null,
      trip_count: d.tripIds.length,
      start_secs: d.startSecs,
      end_secs: d.endSecs,
      gap_count: d.gapCount,
    };
  });

  const ids: number[] = [];
  for (let i = 0; i < dayRows.length; i += 2000) {
    const inserted =
      await tx`insert into vehicle_days ${tx(dayRows.slice(i, i + 2000))} returning id`;
    for (const row of inserted) ids.push(row.id);
  }

  const tripIds: number[] = [];
  const dayIds: number[] = [];
  const seqs: number[] = [];
  days.forEach((d, i) =>
    d.tripIds.forEach((tripId, seq) => {
      tripIds.push(tripId);
      dayIds.push(ids[i]);
      seqs.push(seq + 1);
    }),
  );
  for (let i = 0; i < tripIds.length; i += 20000) {
    await tx`
      update trips t set vehicle_day_id = u.day_id, vehicle_day_seq = u.seq
      from unnest(${tripIds.slice(i, i + 20000)}::bigint[], ${dayIds.slice(i, i + 20000)}::bigint[], ${seqs.slice(i, i + 20000)}::int[])
        as u(trip_id, day_id, seq)
      where t.id = u.trip_id`;
  }

  const fromRuns = days.filter((d) => d.source === 'run_number').length;
  log(
    `  vehicle days: ${days.length.toLocaleString()} (${fromRuns} from train run numbers, ` +
      `${(days.length - fromRuns).toLocaleString()} inferred) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
