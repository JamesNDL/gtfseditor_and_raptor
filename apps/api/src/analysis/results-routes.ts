// The reads behind the results map (FR-14, FR-15, FR-20; docs/architecture/access-analysis.md
// §5.1): one point of interest's sample points as GeoJSON, its bands and lines of equal ratio for
// the breaks asked for (worked out here, D28), and one pair in full with the car path asked from
// the road router (D30) and each ride's path looked up in the timetable (D39, ride-paths.ts).
// Only a finished analysis has results; the rest are a 409.
import type { FastifyInstance } from 'fastify';
import {
  ratioBands,
  ratioLines,
  summarise,
  trafficFactorAt,
  type AnalysisLines,
  type GeoJsonFeatureCollection,
  type GeoJsonPoint,
  type GeoJsonPosition,
  type LonLat,
  type PointDetail,
  type SamplePointProperties,
} from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { int, notFound } from '../http.ts';
import { roadRoute } from './road-client.ts';
import { legsWithPaths } from './ride-paths.ts';
import {
  breaksOf,
  contourGridOf,
  finishedAnalysis,
  pairsOf,
  poiOf,
  type FinishedAnalysis,
  type PairRow,
} from './results-read.ts';

/** Route parameters or a query: an object of unknown fields, or nothing. */
const fieldsOf = (value: unknown): Partial<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};

/** Seconds as minutes, to a tenth; null stays null. */
const minutes = (secs: number | null): number | null =>
  secs === null ? null : Math.round(secs / 6) / 10;

/** A position as GeoJSON writes it. */
const position = ([lon, lat]: LonLat): GeoJsonPosition => [lon, lat];

/** An open band end (±Infinity) is null, as JSON has no infinity. */
const bandEnd = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** The bands and lines of equal ratio for one point of interest's pairs (FR-14, and FR-18's export). */
export function linesOf(
  analysis: FinishedAnalysis,
  pairs: PairRow[],
  breaks: number[],
): Omit<AnalysisLines, 'summary'> {
  const grid = contourGridOf(analysis.ring, analysis.settings.spacingM, pairs);
  // Only a pair with a ratio has a value; no service and no road are missing (FR-12, D27).
  const values = new Float64Array(grid.columns * grid.rows).fill(NaN);
  for (const pair of pairs) {
    if (pair.status === 'ok' && pair.ratio !== null) {
      values[pair.j * grid.columns + pair.i] = pair.ratio;
    }
  }
  const bands: AnalysisLines['bands'] = {
    type: 'FeatureCollection',
    features: ratioBands(grid, values, breaks).map((band) => ({
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: band.polygons.map((ring) => [ring.map(position)]),
      },
      properties: { from: bandEnd(band.from), to: bandEnd(band.to) },
    })),
  };
  const lines: AnalysisLines['lines'] = {
    type: 'FeatureCollection',
    features: ratioLines(grid, values, breaks).map((line) => ({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: line.lines.map((l) => l.map(position)) },
      properties: { ratio: line.ratio },
    })),
  };
  return { bands, lines };
}

/** The drive's path from the road router, or null with the reason (D30). */
async function carPathOf(
  from: { lon: number; lat: number },
  to: { lon: number; lat: number },
): Promise<Pick<PointDetail, 'carPath' | 'carPathMessage'>> {
  try {
    const drive = await roadRoute({ lon: from.lon, lat: from.lat }, { lon: to.lon, lat: to.lat });
    if (drive.status === 'ok') return { carPath: drive.geometry, carPathMessage: null };
    return { carPath: null, carPathMessage: drive.reason ?? 'The road router found no drive.' };
  } catch (err) {
    return { carPath: null, carPathMessage: err instanceof Error ? err.message : String(err) };
  }
}

export function registerAnalysisResultRoutes(app: FastifyInstance, sql: Sql): void {
  /** The finished analysis named in the path and the point of interest in `?poi=`. */
  async function pick(req: { params: unknown; query: unknown }): Promise<{
    analysis: FinishedAnalysis;
    poiSeq: number;
    poi: { lon: number; lat: number };
  }> {
    const analysis = await finishedAnalysis(sql, int(fieldsOf(req.params).id));
    const poiSeq = int(fieldsOf(req.query).poi);
    const poi = await poiOf(sql, analysis.id, poiSeq);
    return { analysis, poiSeq, poi };
  }

  app.get(
    '/api/analyses/:id/points',
    async (req): Promise<GeoJsonFeatureCollection<GeoJsonPoint, SamplePointProperties>> => {
      const { analysis, poiSeq } = await pick(req);
      const pairs = await pairsOf(sql, analysis.id, poiSeq);
      return {
        type: 'FeatureCollection',
        features: pairs.map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: {
            seq: p.seq,
            status: p.status,
            ptMins: minutes(p.ptSecs),
            carMins: minutes(p.carSecs),
            ratio: p.ratio,
          },
        })),
      };
    },
  );

  app.get('/api/analyses/:id/lines', async (req): Promise<AnalysisLines> => {
    const { analysis, poiSeq } = await pick(req);
    const breaks = breaksOf(fieldsOf(req.query).breaks, analysis.settings);
    const pairs = await pairsOf(sql, analysis.id, poiSeq);
    return { ...linesOf(analysis, pairs, breaks), summary: summarise(pairs, breaks) };
  });

  app.get('/api/analyses/:id/points/:seq', async (req): Promise<PointDetail> => {
    const seq = int(fieldsOf(req.params).seq);
    const { analysis, poiSeq, poi } = await pick(req);
    const [pair] = await pairsOf(sql, analysis.id, poiSeq, seq);
    if (!pair) throw notFound('Sample point');
    const { settings } = analysis;
    const { ptSecs, walkSecs, waitSecs, rideSecs, rides } = pair;
    const hasJourney =
      ptSecs !== null &&
      walkSecs !== null &&
      waitSecs !== null &&
      rideSecs !== null &&
      rides !== null;
    return {
      seq: pair.seq,
      i: pair.i,
      j: pair.j,
      lon: pair.lon,
      lat: pair.lat,
      poiSeq,
      status: pair.status,
      pt: hasJourney ? { ptSecs, walkSecs, waitSecs, rideSecs, rides } : null,
      legs: await legsWithPaths(sql, analysis, pair.legs),
      driveSecs: pair.driveSecs,
      driveMetres: pair.driveMetres,
      carSecs: pair.carSecs,
      trafficFactor: trafficFactorAt(settings.departSecs, settings.trafficFactors),
      parkingSecs: settings.parkingMins * 60,
      ratio: pair.ratio,
      ...(await carPathOf(pair, poi)),
    };
  });
}
