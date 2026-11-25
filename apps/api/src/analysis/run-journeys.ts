// The public transport side of an access analysis run (D21, D23, D30; docs/architecture/
// access-analysis.md §4.4): the pairs still pending, 500 at a time, to the journey router's
// /v1/journeys/bulk. Each answer gives the pair its public transport time and split, its stored
// legs, its status and, when it is ok, its access ratio. Each batch is stored with one update.
import {
  accessRatio,
  localFrame,
  pairStatus,
  ptSplit,
  type AnalysisSettings,
  type PairStatus,
  type PtSplit,
  type StoredLeg,
  type StoredStop,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  avoidedModes,
  bulkJourneys,
  type BulkJourney,
  type BulkSettings,
  type JourneyLine,
  type JourneyQuery,
} from './journeys-client.ts';
import type { AfterBatch } from './run-drives.ts';

/** Pairs per bulk request (D21): about a second each, for progress and cancel. */
const JOURNEY_BATCH = 500;

/** A pending pair: its two ends and its car time, already worked out. */
interface PendingRow {
  poiSeq: number;
  pointSeq: number;
  lon: number;
  lat: number;
  poiLon: number;
  poiLat: number;
  carSecs: number | null;
}

/** A pair's worked-out public transport side, ready to store. */
interface PairResult {
  status: Exclude<PairStatus, 'pending'>;
  split: PtSplit | null;
  legs: StoredLeg[] | null;
  ratio: number | null;
}

/** The query id of a pair: '<poi seq>:<point seq>'. */
const pairId = (row: Pick<PendingRow, 'poiSeq' | 'pointSeq'>): string =>
  `${row.poiSeq}:${row.pointSeq}`;

/** Straight-line metres between two places, with the flat-earth factors of the grid (D26). */
function straightMetres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const frame = localFrame((a.lon + b.lon) / 2, (a.lat + b.lat) / 2);
  const [ax, ay] = frame.toMetres([a.lon, a.lat]);
  const [bx, by] = frame.toMetres([b.lon, b.lat]);
  return Math.hypot(bx - ax, by - ay);
}

/** The parts of a stop kept (the router's answer has more, such as its id). */
const stopOf = ({ name, lat, lon, time }: StoredStop): StoredStop => ({ name, lat, lon, time });

/**
 * A journey's legs as stored (D30): walks, transfers and rides without the stops passed. A ride's
 * metres are the straight line from where it boards to where it alights.
 */
function storedLegs(journey: BulkJourney): StoredLeg[] {
  const legs: StoredLeg[] = [];
  for (const leg of journey.legs) {
    if (leg.type === 'ride') {
      legs.push({
        type: 'ride',
        route: leg.route,
        mode: leg.mode,
        board: stopOf(leg.board),
        alight: stopOf(leg.alight),
        secs: leg.alight.time - leg.board.time,
        metres: Math.round(straightMetres(leg.board, leg.alight)),
      });
    } else if (leg.type !== 'warning') {
      const secs = (leg.arrive ?? 0) - (leg.depart ?? 0);
      legs.push({ type: leg.type, secs, metres: Math.round(leg.metres ?? 0) });
    }
  }
  return legs;
}

/** What one answer line means for its pair (FR-11, FR-12). A line with an error stops the run. */
function resultOf(
  row: PendingRow,
  line: JourneyLine | undefined,
  settings: AnalysisSettings,
): PairResult {
  if (!line) throw new Error('The journey router did not answer every journey');
  if (line.status === 'error') {
    throw new Error(`The journey router could not plan a journey: ${line.reason}`);
  }
  const journey = line.status === 'ok' ? line.journey : null;
  const split = journey ? ptSplit(journey, settings.departSecs) : null;
  const status = pairStatus(
    { journeyFound: journey !== null, ptSecs: split?.ptSecs ?? null, carSecs: row.carSecs },
    settings,
  );
  const ratio =
    status === 'ok' && split && row.carSecs !== null
      ? accessRatio(split.ptSecs, row.carSecs)
      : null;
  return { status, split, legs: journey ? storedLegs(journey) : null, ratio };
}

/** Stores a batch's results with one update. */
async function store(
  sql: Sql,
  id: number,
  rows: PendingRow[],
  results: PairResult[],
): Promise<void> {
  const int = (pick: (split: PtSplit) => number): (number | null)[] =>
    results.map((r) => (r.split ? Math.round(pick(r.split)) : null));
  await sql`
    update analysis_results r
    set status = u.status, pt_secs = u.pt, walk_secs = u.walk, wait_secs = u.wait,
        ride_secs = u.ride, rides = u.rides, legs = u.legs::jsonb, ratio = u.ratio
    from unnest(
      ${rows.map((row) => row.poiSeq)}::int[], ${rows.map((row) => row.pointSeq)}::int[],
      ${results.map((r) => r.status)}::text[], ${int((s) => s.ptSecs)}::int[],
      ${int((s) => s.walkSecs)}::int[], ${int((s) => s.waitSecs)}::int[],
      ${int((s) => s.rideSecs)}::int[], ${int((s) => s.rides)}::int[],
      ${results.map((r) => (r.legs ? JSON.stringify(r.legs) : null))}::text[],
      ${results.map((r) => r.ratio)}::real[]
    ) as u(poi_seq, point_seq, status, pt, walk, wait, ride, rides, legs, ratio)
    where r.analysis_id = ${id} and r.poi_seq = u.poi_seq and r.point_seq = u.point_seq`;
}

/**
 * Plans every pending pair's journey, from the sample point to the point of interest leaving at
 * the departure time, within the analysis's limits (FR-8), and stores what each one means.
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
    const rows = await sql<PendingRow[]>`
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
    const queries: JourneyQuery[] = rows.map((row) => ({
      id: pairId(row),
      from: { lat: row.lat, lon: row.lon },
      to: { lat: row.poiLat, lon: row.poiLon },
      depart: settings.departSecs,
    }));
    const lines = new Map<string, JourneyLine>();
    for await (const line of bulkJourneys(shared, queries)) lines.set(line.id, line);
    const results = rows.map((row) => resultOf(row, lines.get(pairId(row)), settings));
    await store(sql, id, rows, results);
    done += rows.length;
    await afterBatch(done, counts?.total ?? done);
  }
}
