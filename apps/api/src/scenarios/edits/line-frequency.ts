// lineFrequency edits: how often a whole line runs, both ways, across several time bands.
import { platformNote, settlePlatforms } from './deps.ts';
import { assignVehicles } from '../vehicles.ts';
import { fleetNote } from '../wording.ts';
import { removeTrips, TRIP_COLUMNS, visible, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

/**
 * Sets how often a whole line runs, in both directions, across several time bands at once.
 * In each direction the most-used stopping pattern is the one regenerated; other patterns (branches,
 * expresses) are left alone. Vehicles are worked out across all the new trips together, so a trip
 * out and a trip back share one.
 */
export async function editLineFrequency(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: {
    routeId: number;
    bands: { fromSecs: number; toSecs: number; headwaySecs: number }[];
    /** Share the new departures between every stop pattern in each direction, in the proportions they run now. */
    allPatterns?: boolean;
  },
) {
  const routeId = Number(body.routeId);
  const bands = (body.bands ?? []).map((b) => ({
    from: Math.round(Number(b.fromSecs)),
    to: Math.round(Number(b.toSecs)),
    headway: Math.round(Number(b.headwaySecs)),
  }));
  if (!bands.length || bands.length > 12) throw fail(400, 'Give between one and twelve time bands');
  for (const b of bands) {
    if (!(b.to > b.from) || b.from < 0 || b.to > 30 * 3600)
      throw fail(
        400,
        'Each time band must end after it starts, and no later than 06:00 the next morning',
      );
    if (!(b.headway >= 60) || b.headway > 4 * 3600)
      throw fail(400, 'Each frequency must be between 1 minute and 4 hours');
  }
  const vis = visible(tx, 't', sc);
  const [route] =
    await tx`select coalesce(short_name, long_name) as name from routes where id = ${routeId}`;
  if (!route) throw fail(404, 'Line not found');
  const counted = await tx`
    select t.pattern_id, coalesce(t.direction_id, 0) as direction, count(*)::int as n
    from trips t where t.route_id = ${routeId} and t.pattern_id is not null and ${vis} group by 1, 2
    order by direction, n desc, t.pattern_id`;
  if (!counted.length) throw fail(400, 'This line has no trips to copy');
  const allPatterns = body.allPatterns === true;
  const directions = [...new Set(counted.map((c) => c.direction))];

  const createdIds: number[] = [];
  let replacedCount = 0;
  let keptPinned = 0;
  let batch = 0;
  let patternsUsed = 0;
  for (const direction of directions) {
    const inDirection = counted.filter((c) => c.direction === direction);
    // The most-used stop pattern, or every pattern when the new departures are to be shared between them.
    const patterns = (allPatterns ? inDirection : inDirection.slice(0, 1)).map(
      (c) => c.pattern_id as number,
    );
    patternsUsed = Math.max(patternsUsed, patterns.length);
    const existing = await tx`
      select t.id, t.start_secs, t.pinned, t.pattern_id from trips t where t.pattern_id = any(${patterns}) and ${vis} order by t.start_secs`;
    for (const band of bands) {
      const middle = (band.from + band.to) / 2;
      const inBand = existing.filter((t) => t.start_secs >= band.from && t.start_secs < band.to);
      const pinned = inBand.filter((t) => t.pinned);
      const replaced = inBand.filter((t) => !t.pinned).map((t) => t.id);
      const starts: number[] = [];
      for (let s = band.from; s < band.to; s += band.headway) {
        if (!pinned.some((p) => Math.abs(p.start_secs - s) < band.headway / 2)) starts.push(s);
      }
      await removeTrips(tx, sc, seq, replaced);
      replacedCount += replaced.length;
      keptPinned += pinned.length;
      if (!starts.length) continue;
      // Each pattern keeps the share of departures it has in this part of the day; a part of the day
      // with no trips at all goes to the most-used pattern. Departures are dealt out in turn, so
      // the patterns stay evenly mixed.
      const share = patterns.map((p) => inBand.filter((t) => t.pattern_id === p).length);
      const total = share.reduce((sum, n) => sum + n, 0);
      const weight =
        total > 0 ? share.map((n) => n / total) : patterns.map((_, i) => (i === 0 ? 1 : 0));
      const credit = patterns.map(() => 0);
      const dealt: number[][] = patterns.map(() => []);
      for (const start of starts) {
        let pick = 0;
        for (let i = 0; i < patterns.length; i++) {
          credit[i] += weight[i];
          if (credit[i] > credit[pick] + 1e-9) pick = i;
        }
        credit[pick] -= 1;
        dealt[pick].push(start);
      }
      for (let i = 0; i < patterns.length; i++) {
        if (!dealt[i].length) continue;
        const own = existing.filter((t) => t.pattern_id === patterns[i]);
        const template = own.reduce((best, t) =>
          Math.abs(t.start_secs - middle) < Math.abs(best.start_secs - middle) ? t : best,
        );
        batch++;
        const created = await tx.unsafe(
          `insert into trips (${TRIP_COLUMNS}, gtfs_id, start_secs, end_secs, scenario_id, cloned_from, created_edit)
           select ${TRIP_COLUMNS},
                  split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || $5::int || '-' || row_number() over (order by s.start),
                  s.start, end_secs + (s.start - start_secs), $1::int, id, $2::int
           from trips, unnest($4::int[]) as s(start) where id = $3::bigint
           returning id, start_secs`,
          [sc.id, seq, template.id, dealt[i], batch] as never[],
        );
        await tx`
          insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
          select n.id, st.seq, st.stop_id, st.arr + (n.start_secs - ${template.start_secs}), st.dep + (n.start_secs - ${template.start_secs}),
                 st.dist, st.pickup_type, st.drop_off_type, st.timepoint, st.headsign, st.note
          from trips n join stop_times st on st.trip_id = ${template.id}
          where n.id = any(${created.map((r) => r.id)})`;
        for (const r of created) createdIds.push(r.id);
      }
    }
  }
  const fleet = await assignVehicles(tx, sc, seq, createdIds);
  const settled = await settlePlatforms(tx, sc, seq, createdIds);
  return {
    summary: `${route.name}: new frequency in ${bands.length} time band${bands.length === 1 ? '' : 's'}, ${directions.length > 1 ? 'both directions' : 'one direction'}${allPatterns && patternsUsed > 1 ? `, shared between ${patternsUsed} stop patterns` : ''} (${createdIds.length} trips, replacing ${replacedCount}${keptPinned ? `, keeping ${keptPinned} placed by hand` : ''})${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
  };
}
