// Comparing two analyses and exporting one (FR-17, FR-18; docs/architecture/access-analysis.md
// §5.3, D31): the comparison point by point for one point of interest, and the downloads
// results.csv, points.geojson and lines.geojson, each named access-<id>-....
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  compareRatios,
  type CompareKind,
  type CompareResult,
  type GeoJsonFeatureCollection,
  type GeoJsonPoint,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { int } from '../http.ts';
import { comparedPoiSeqs } from './compare-read.ts';
import { csvOf, exportRowOf, type ExportPair, type ExportRow } from './export-rows.ts';
import { breaksOf, finishedAnalysis, pairsOf, poiOf } from './results-read.ts';
import { linesOf } from './results-routes.ts';

/** Route parameters or a query: an object of unknown fields, or nothing. */
const fieldsOf = (value: unknown): Partial<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};

/** A grid column and row as a map key. */
const placeKey = (p: { i: number; j: number }): string => `${p.i},${p.j}`;

/** An exported row's properties on its point feature: the row less its place. */
type ExportProperties = Omit<ExportRow, 'lat' | 'lon'>;

/** Sends `body` as a download called `fileName`. */
function download(reply: FastifyReply, type: string, fileName: string, body: string): string {
  reply.header('content-type', type);
  reply.header('content-disposition', `attachment; filename="${fileName}"`);
  reply.header('cache-control', 'no-store');
  return body;
}

const GEOJSON = 'application/geo+json; charset=utf-8';

/** Every pair of an analysis with its point of interest's name, by sample point then poi. */
function exportPairsOf(sql: Sql, analysisId: number): Promise<ExportPair[]> {
  // The legs are not exported, so they are not read.
  return sql<ExportPair[]>`
    select p.seq, p.i, p.j, p.lon, p.lat, r.poi_seq as "poiSeq", o.name as "poiName", r.status,
           r.pt_secs as "ptSecs", r.walk_secs as "walkSecs", r.wait_secs as "waitSecs",
           r.ride_secs as "rideSecs", r.rides, null as legs, r.drive_secs as "driveSecs",
           r.drive_metres as "driveMetres", r.car_secs as "carSecs", r.ratio,
           r.early_wait_secs as "earlyWaitSecs"
    from analysis_points p
    join analysis_results r on r.analysis_id = p.analysis_id and r.point_seq = p.seq
    join analysis_pois o on o.analysis_id = p.analysis_id and o.seq = r.poi_seq
    where p.analysis_id = ${analysisId}
    order by p.seq, r.poi_seq`;
}

/** The exported rows of a finished analysis. */
async function exportRowsOf(sql: Sql, id: number): Promise<ExportRow[]> {
  const analysis = await finishedAnalysis(sql, id);
  const pairs = await exportPairsOf(sql, id);
  return pairs.map((pair) => exportRowOf(pair, analysis.settings));
}

export function registerAnalysisExportRoutes(app: FastifyInstance, sql: Sql): void {
  // b is compared with a: `change` is b's ratio less a's, and a lower ratio is better (FR-17).
  app.get('/api/analyses/compare', async (req): Promise<CompareResult> => {
    const query = fieldsOf(req.query);
    const [aId, bId, poiId] = [int(query.a), int(query.b), int(query.poi)];
    const seqs = await comparedPoiSeqs(sql, aId, bId, poiId);
    const first = await pairsOf(sql, aId, seqs.a);
    const second = await pairsOf(sql, bId, seqs.b);
    const compared = new Map(compareRatios(first, second).map((p) => [placeKey(p), p]));
    // Every kind is counted, so each is named even when it is 0.
    const counts: Record<CompareKind, number> = {
      better: 0,
      worse: 0,
      same: 0,
      gainedService: 0,
      lostService: 0,
      bothNone: 0,
    };
    const features: CompareResult['points']['features'] = [];
    // In a's order, placed where a's sample point is; a point not in b is left out.
    for (const pair of first) {
      const point = compared.get(placeKey(pair));
      if (!point) continue;
      counts[point.kind]++;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pair.lon, pair.lat] },
        properties: point,
      });
    }
    return { points: { type: 'FeatureCollection', features }, counts };
  });

  app.get('/api/analyses/:id/export/results.csv', async (req, reply): Promise<string> => {
    const id = int(fieldsOf(req.params).id);
    const csv = csvOf(await exportRowsOf(sql, id));
    return download(reply, 'text/csv; charset=utf-8', `access-${id}-results.csv`, csv);
  });

  app.get('/api/analyses/:id/export/points.geojson', async (req, reply): Promise<string> => {
    const id = int(fieldsOf(req.params).id);
    const rows = await exportRowsOf(sql, id);
    const points: GeoJsonFeatureCollection<GeoJsonPoint, ExportProperties> = {
      type: 'FeatureCollection',
      features: rows.map(({ lat, lon, ...properties }) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties,
      })),
    };
    return download(reply, GEOJSON, `access-${id}-points.geojson`, JSON.stringify(points));
  });

  app.get('/api/analyses/:id/export/lines.geojson', async (req, reply): Promise<string> => {
    const id = int(fieldsOf(req.params).id);
    const analysis = await finishedAnalysis(sql, id);
    const query = fieldsOf(req.query);
    const poiSeq = int(query.poi);
    await poiOf(sql, id, poiSeq);
    const breaks = breaksOf(query.breaks, analysis.settings);
    const { lines } = linesOf(analysis, await pairsOf(sql, id, poiSeq), breaks);
    return download(reply, GEOJSON, `access-${id}-lines-${poiSeq}.geojson`, JSON.stringify(lines));
  });
}
