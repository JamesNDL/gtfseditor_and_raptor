// The car side of an access analysis run (D22, docs/architecture/access-analysis.md §4.4): for
// each point of interest, the pairs not yet driven, 1,000 sample points at a time, to the road
// router's /v1/road/table. Each batch is stored with one update, so a stopped run carries on from
// the next batch.
import { carSecs, trafficFactorAt, type AnalysisSettings } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { roadTable } from './road-client.ts';

/** Sample points per road table request (D22): a second or two each, for progress and cancel. */
const DRIVE_BATCH = 1000;

/** Called after each batch with the pairs done so far; throws to stop the run. */
export type AfterBatch = (done: number, total: number) => Promise<void>;

/** A copied point of interest. */
interface PoiRow {
  seq: number;
  lon: number;
  lat: number;
}

/** A pair still to drive: its sample point. */
interface PointRow {
  pointSeq: number;
  lon: number;
  lat: number;
}

/** How many pairs the analysis has, and how many are already driven. */
async function driveCounts(sql: Sql, id: number): Promise<{ done: number; total: number }> {
  const [row] = await sql<{ done: number; total: number }[]>`
    select count(*) filter (where drive_checked)::int as done, count(*)::int as total
    from analysis_results where analysis_id = ${id}`;
  return row ?? { done: 0, total: 0 };
}

/**
 * Drives every pair not yet driven: drive time and metres (null where there is no road) and the
 * car time, with the traffic factor for the departure and the parking allowance (FR-9).
 */
export async function runDrives(
  sql: Sql,
  id: number,
  settings: AnalysisSettings,
  afterBatch: AfterBatch,
): Promise<void> {
  const factor = trafficFactorAt(settings.departSecs, settings.trafficFactors);
  const parkingSecs = settings.parkingMins * 60;
  const { total, done: doneBefore } = await driveCounts(sql, id);
  let done = doneBefore;
  const pois = await sql<PoiRow[]>`
    select seq, st_x(geom) as lon, st_y(geom) as lat
    from analysis_pois where analysis_id = ${id} order by seq`;
  for (const poi of pois) {
    for (;;) {
      const points = await sql<PointRow[]>`
        select r.point_seq as "pointSeq", p.lon, p.lat
        from analysis_results r
        join analysis_points p on p.analysis_id = r.analysis_id and p.seq = r.point_seq
        where r.analysis_id = ${id} and r.poi_seq = ${poi.seq} and not r.drive_checked
        order by r.point_seq
        limit ${DRIVE_BATCH}`;
      if (points.length === 0) break;
      const answer = await roadTable(
        points.map(({ lat, lon }) => ({ lat, lon })),
        [{ lat: poi.lat, lon: poi.lon }],
      );
      if (answer.durationsSecs.length !== points.length) {
        throw new Error('The road router did not answer every drive');
      }
      const secs = answer.durationsSecs.map((row) => row[0] ?? null);
      const metres = secs.map((s, k) => (s === null ? null : (answer.metres[k]?.[0] ?? null)));
      const cars = secs.map((s) => (s === null ? null : carSecs(s, factor, parkingSecs)));
      await sql`
        update analysis_results r
        set drive_secs = u.secs, drive_metres = u.metres, car_secs = u.car, drive_checked = true
        from unnest(${points.map((p) => p.pointSeq)}::int[], ${secs}::real[],
                    ${metres}::real[], ${cars}::real[]) as u(seq, secs, metres, car)
        where r.analysis_id = ${id} and r.poi_seq = ${poi.seq} and r.point_seq = u.seq`;
      done += points.length;
      await afterBatch(done, total);
    }
  }
}
