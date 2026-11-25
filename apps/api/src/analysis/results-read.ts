// What the results reads (results-routes.ts, docs/architecture/access-analysis.md §5.1) take from
// the database, and the sample grid rebuilt for the lines of equal ratio (D28): a finished analysis,
// one of its points of interest, its pairs, the summaries for some breaks, and the breaks asked for.
import {
  localFrame,
  settingsProblem,
  summarise,
  type AnalysisSettings,
  type AnalysisState,
  type ContourGrid,
  type GeoJsonPosition,
  type PairStatus,
  type PoiSummary,
  type StoredLeg,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { fail, notFound } from '../http.ts';

/** A finished analysis, as the reads need it. */
export interface FinishedAnalysis {
  id: number;
  /** The timetable it ran on: its day (null once deleted) and its scenario, if any (D39). */
  baselineId: number | null;
  scenarioId: number | null;
  settings: AnalysisSettings;
  /** The copied zone's outline, closed (the first corner repeated at the end). */
  ring: GeoJsonPosition[];
}

/** One stored pair with its sample point. Times in seconds; null where there is none. */
export interface PairRow {
  seq: number;
  i: number;
  j: number;
  lon: number;
  lat: number;
  status: PairStatus;
  ptSecs: number | null;
  walkSecs: number | null;
  waitSecs: number | null;
  rideSecs: number | null;
  rides: number | null;
  legs: StoredLeg[] | null;
  driveSecs: number | null;
  driveMetres: number | null;
  carSecs: number | null;
  ratio: number | null;
}

/** An analysis that has not finished has no results to read (AA-16 AC 5). */
export const NOT_FINISHED = 'This analysis has not finished, so it has no results yet.';

/** The analysis, if it is done: a 404 when there is none, a 409 when it has not finished. */
export async function finishedAnalysis(sql: Sql, id: number): Promise<FinishedAnalysis> {
  const [row] = await sql<
    {
      state: AnalysisState;
      baselineId: number | null;
      scenarioId: number | null;
      settings: AnalysisSettings;
      rings: GeoJsonPosition[][];
    }[]
  >`
    select state, baseline_id as "baselineId", scenario_id as "scenarioId", settings,
           (st_asgeojson(zone_geom, 15)::json -> 'coordinates') as rings
    from analyses where id = ${id}`;
  if (!row) throw notFound('Analysis');
  if (row.state !== 'done') throw fail(409, NOT_FINISHED);
  const { baselineId, scenarioId, settings } = row;
  return { id, baselineId, scenarioId, settings, ring: row.rings[0] };
}

/** Where one of the analysis's points of interest is; a 404 when it has no such one. */
export async function poiOf(
  sql: Sql,
  analysisId: number,
  poiSeq: number,
): Promise<{ lon: number; lat: number }> {
  const [row] = await sql<{ lon: number; lat: number }[]>`
    select st_x(geom) as lon, st_y(geom) as lat
    from analysis_pois where analysis_id = ${analysisId} and seq = ${poiSeq}`;
  if (!row) throw notFound('Point of interest');
  return row;
}

/** The pairs of one point of interest in sample point order, or just the pair of `pointSeq`. */
export function pairsOf(
  sql: Sql,
  analysisId: number,
  poiSeq: number,
  pointSeq?: number,
): Promise<PairRow[]> {
  const onePoint = pointSeq === undefined ? sql`` : sql`and p.seq = ${pointSeq}`;
  return sql<PairRow[]>`
    select p.seq, p.i, p.j, p.lon, p.lat, r.status, r.pt_secs as "ptSecs",
           r.walk_secs as "walkSecs", r.wait_secs as "waitSecs", r.ride_secs as "rideSecs",
           r.rides, r.legs, r.drive_secs as "driveSecs", r.drive_metres as "driveMetres",
           r.car_secs as "carSecs", r.ratio
    from analysis_points p
    join analysis_results r on r.analysis_id = p.analysis_id and r.point_seq = p.seq
    where p.analysis_id = ${analysisId} and r.poi_seq = ${poiSeq} ${onePoint}
    order by p.seq`;
}

/** The summary of each point of interest for these breaks (FR-20), by its seq. */
export async function summariesOf(
  sql: Sql,
  analysisId: number,
  breaks: number[],
): Promise<Map<number, PoiSummary>> {
  const rows = await sql<{ poiSeq: number; status: PairStatus; ratio: number | null }[]>`
    select poi_seq as "poiSeq", status, ratio
    from analysis_results where analysis_id = ${analysisId}`;
  const byPoi = new Map<number, { status: PairStatus; ratio: number | null }[]>();
  for (const { poiSeq, status, ratio } of rows) {
    const pairs = byPoi.get(poiSeq) ?? [];
    pairs.push({ status, ratio });
    byPoi.set(poiSeq, pairs);
  }
  return new Map([...byPoi].map(([poiSeq, pairs]) => [poiSeq, summarise(pairs, breaks)]));
}

/**
 * The breaks from `?breaks=1,1.5,2`, or the analysis's own when none are asked for. They are
 * checked by the same rules as the settings' lines; a bad list is a 400 with the reason.
 */
export function breaksOf(asked: unknown, settings: AnalysisSettings): number[] {
  if (asked === undefined) return settings.breaks;
  if (typeof asked !== 'string') throw fail(400, 'Give the lines once, as numbers with commas.');
  const breaks = asked.split(',').map((part) => (part.trim() === '' ? NaN : Number(part)));
  const problem = settingsProblem({ ...settings, breaks });
  if (problem) throw fail(400, problem);
  return breaks;
}

/**
 * The sample grid as the contours need it (D26, D27), rebuilt from the stored zone and the
 * points' columns and rows: point (i, j) is at the south-west corner of the zone's box plus half a
 * spacing each way, plus (i, j) spacings, in local metres about the box's centre, as sampleGrid
 * lays it. Columns and rows past the last sample point hold no values, so they are left off.
 */
export function contourGridOf(
  ring: GeoJsonPosition[],
  spacingM: number,
  pairs: Pick<PairRow, 'i' | 'j'>[],
): ContourGrid {
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  const [west, east] = [Math.min(...lons), Math.max(...lons)];
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const frame = localFrame((west + east) / 2, (south + north) / 2);
  const [x0, y0] = frame.toMetres([west, south]);
  return {
    columns: pairs.reduce((most, p) => Math.max(most, p.i + 1), 0),
    rows: pairs.reduce((most, p) => Math.max(most, p.j + 1), 0),
    frame,
    origin: [x0 + spacingM / 2, y0 + spacingM / 2],
    spacingM,
  };
}
