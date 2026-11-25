// The open analysis's results (FR-14, FR-20; docs/architecture/access-analysis.md §5.1): the
// analysis itself, and for the point of interest on show its bands and lines of equal ratio and
// its sample points. Kept here, beside the other feature-local stores, so that the results screen
// and the map's layers (map/use-analysis-result-layers.ts) read the same answers.
import type {
  AnalysisDetail,
  AnalysisLines,
  GeoJsonFeatureCollection,
  GeoJsonPoint,
  PoiSummary,
  RatioBand,
  SamplePointProperties,
} from '@gtfs-editor/core';
import { create } from 'zustand';
import { getJson } from '../shared/api-client.ts';

/** A summary band as JSON brings it: the open ends (±Infinity in core) arrive as null. */
export interface ShownBand extends Omit<RatioBand, 'from' | 'to'> {
  from: number | null;
  to: number | null;
}

/** A point of interest's summary (FR-20) as JSON brings it. */
export interface ShownSummary extends Omit<PoiSummary, 'bands'> {
  bands: ShownBand[];
}

/** The bands, lines and summary for one point of interest and some breaks. */
export interface ShownLines extends Omit<AnalysisLines, 'summary'> {
  summary: ShownSummary;
}

/** One point of interest's sample points, with their status and ratio. */
export type SamplePoints = GeoJsonFeatureCollection<GeoJsonPoint, SamplePointProperties>;

interface AnalysisResults {
  /** The open analysis, or null while it loads. */
  detail: AnalysisDetail | null;
  /** The point of interest the lines and points are for, or null before they first arrive. */
  poiSeq: number | null;
  lines: ShownLines | null;
  points: SamplePoints | null;
  /** Why the last fetch failed, or null. */
  error: string | null;
}

const EMPTY: AnalysisResults = {
  detail: null,
  poiSeq: null,
  lines: null,
  points: null,
  error: null,
};

/** The open analysis's results, as last fetched. */
export const useAnalysisResults = create<AnalysisResults>(() => EMPTY);

/** Count the fetches, so that an answer overtaken by a later choice is dropped. */
let latestDetail = 0;
let latestPoi = 0;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Forgets the results shown, as when an analysis is closed. */
export function clearResults(): void {
  latestDetail++;
  latestPoi++;
  useAnalysisResults.setState(EMPTY);
}

/** Fetches an analysis to show its results, forgetting the one shown before. */
export async function loadAnalysis(id: number): Promise<void> {
  const ticket = ++latestDetail;
  latestPoi++;
  useAnalysisResults.setState(EMPTY);
  try {
    const detail = await getJson<AnalysisDetail>(`/api/analyses/${id}`);
    if (ticket === latestDetail) useAnalysisResults.setState({ detail });
  } catch (e) {
    if (ticket === latestDetail) useAnalysisResults.setState({ error: messageOf(e) });
  }
}

/**
 * Fetches the bands, lines and sample points of one point of interest of an analysis, for these
 * breaks, or the analysis's own when null. What was shown stays until the answer arrives.
 */
export async function loadPoiResults(
  id: number,
  poiSeq: number,
  breaks: number[] | null,
): Promise<void> {
  const ticket = ++latestPoi;
  const asked = breaks === null ? '' : `&breaks=${breaks.join(',')}`;
  try {
    const [lines, points] = await Promise.all([
      getJson<ShownLines>(`/api/analyses/${id}/lines?poi=${poiSeq}${asked}`),
      getJson<SamplePoints>(`/api/analyses/${id}/points?poi=${poiSeq}`),
    ]);
    if (ticket === latestPoi) useAnalysisResults.setState({ poiSeq, lines, points, error: null });
  } catch (e) {
    if (ticket === latestPoi) useAnalysisResults.setState({ error: messageOf(e) });
  }
}
