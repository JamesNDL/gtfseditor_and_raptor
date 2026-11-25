// The public transport side of an access analysis run (D21, D23, D30, D39; docs/architecture/
// access-analysis.md §4.4): the pairs still pending, 500 at a time, to the journey router's
// /v1/journeys/bulk. Each answer gives the pair its public transport time and split, its stored
// legs (stored-legs.ts), its status and, when it is ok, its access ratio (pair-result.ts). An
// arrive-by analysis asks for journeys that arrive by its time, and stores each one's early wait
// (FR-21, D40). Each batch is stored with one update.
import type { AnalysisSettings, PtSplit } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  avoidedModes,
  bulkJourneys,
  type BulkSettings,
  type JourneyLine,
} from './journeys-client.ts';
import {
  journeyQueryOf,
  pairId,
  pairResultOf,
  type PairResult,
  type PendingPair,
} from './pair-result.ts';
import type { AfterBatch } from './run-drives.ts';

/** Pairs per bulk request (D21): about a second each, for progress and cancel. */
const JOURNEY_BATCH = 500;

/** Stores a batch's results with one update. */
async function store(
  sql: Sql,
  id: number,
  timeMode: AnalysisSettings['timeMode'],
  rows: PendingPair[],
  results: PairResult[],
): Promise<void> {
  const int = (pick: (split: PtSplit) => number): (number | null)[] =>
    results.map((r) => (r.split ? Math.round(pick(r.split)) : null));
  // Only arrive-by pairs with a journey have an early wait; depart-at ones store none.
  const early = timeMode === 'arriveBy' ? int((s) => s.earlyWaitSecs) : results.map(() => null);
  await sql`
    update analysis_results r
    set status = u.status, pt_secs = u.pt, walk_secs = u.walk, wait_secs = u.wait,
        ride_secs = u.ride, rides = u.rides, legs = u.legs::jsonb, ratio = u.ratio,
        early_wait_secs = u.early
    from unnest(
      ${rows.map((row) => row.poiSeq)}::int[], ${rows.map((row) => row.pointSeq)}::int[],
      ${results.map((r) => r.status)}::text[], ${int((s) => s.ptSecs)}::int[],
      ${int((s) => s.walkSecs)}::int[], ${int((s) => s.waitSecs)}::int[],
      ${int((s) => s.rideSecs)}::int[], ${int((s) => s.rides)}::int[],
      ${results.map((r) => (r.legs ? JSON.stringify(r.legs) : null))}::text[],
      ${results.map((r) => r.ratio)}::real[], ${early}::int[]
    ) as u(poi_seq, point_seq, status, pt, walk, wait, ride, rides, legs, ratio, early)
    where r.analysis_id = ${id} and r.poi_seq = u.poi_seq and r.point_seq = u.point_seq`;
}

/**
 * Plans every pending pair's journey, from the sample point to the point of interest leaving at
 * the departure time or arriving by the arrive-by time, within the analysis's limits (FR-8), and
 * stores what each one means.
 */
export async function runJourneys(
  sql: Sql,
  id: number,
  timetable: string,
  settings: AnalysisSettings,
  afterBatch: AfterBatch,
): Promise<void> {
  const shared: BulkSettings = {
    timetable,
    maxWalkMetres: settings.maxWalkM,
    maxRides: settings.maxChanges + 1,
    avoid: avoidedModes(settings.modes),
    capacity: { mode: 'off' },
    detail: 'summary',
  };
  const [counts] = await sql<{ done: number; total: number }[]>`
    select count(*) filter (where status <> 'pending')::int as done, count(*)::int as total
    from analysis_results where analysis_id = ${id}`;
  let done = counts?.done ?? 0;
  for (;;) {
    const rows = await sql<PendingPair[]>`
      select r.poi_seq as "poiSeq", r.point_seq as "pointSeq", p.lon, p.lat,
             st_x(o.geom) as "poiLon", st_y(o.geom) as "poiLat",
             r.car_secs as "carSecs"
      from analysis_results r
      join analysis_points p on p.analysis_id = r.analysis_id and p.seq = r.point_seq
      join analysis_pois o on o.analysis_id = r.analysis_id and o.seq = r.poi_seq
      where r.analysis_id = ${id} and r.status = 'pending'
      order by r.poi_seq, r.point_seq
      limit ${JOURNEY_BATCH}`;
    if (rows.length === 0) return;
    const queries = rows.map((row) => journeyQueryOf(row, settings));
    const lines = new Map<string, JourneyLine>();
    for await (const line of bulkJourneys(shared, queries)) lines.set(line.id, line);
    const results = rows.map((row) => pairResultOf(row, lines.get(pairId(row)), settings));
    await store(sql, id, settings.timeMode, rows, results);
    done += rows.length;
    await afterBatch(done, counts?.total ?? done);
  }
}
