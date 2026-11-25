// What the results screen and the legend say (FR-14, FR-19, FR-20): the band ranges, the settings
// in one line, the credit for the drive times, 'Lines at' read and checked by the same rules as
// the API (`breaksOf` in apps/api/src/analysis/results-read.ts), the summary table's rows, and the
// downloads (FR-18).
import {
  settingsProblem,
  timeText,
  trafficFactorAt,
  type AnalysisDetail,
  type AnalysisSettings,
  type PoiSummary,
} from '@gtfs-editor/core';
import { NO_ROAD_COLOUR, NO_SERVICE_COLOUR, bandColours } from '../analysis-colours.ts';

/** The credit the drive times need (FR-19, A4). */
export const OSM_CREDIT = 'Driving times © OpenStreetMap contributors (ODbL)';

/** A band of ratios; a null end is open (below the first line, or above the last). */
export interface BandRange {
  from: number | null;
  to: number | null;
}

/** The bands the lines make: one below the first, one between each two, and one above the last. */
export function bandRanges(breaks: readonly number[]): BandRange[] {
  const ends: (number | null)[] = [null, ...breaks, null];
  return ends.slice(1).map((to, k) => ({ from: ends[k] ?? null, to }));
}

/** A band's range in words: 'Under 1', '1 to 1.5', '4 or more'. */
export function bandLabel({ from, to }: BandRange): string {
  if (from === null) return to === null ? 'All' : `Under ${to}`;
  return to === null ? `${from} or more` : `${from} to ${to}`;
}

const n = (value: number): string => value.toLocaleString('en-AU');

/**
 * The analysis's settings in one line for the legend (FR-19): the timetable, the time ("Depart
 * 08:00" or "Arrive by 08:00", FR-21), spacing, longest walk, parking allowance and the traffic
 * factor used at that time.
 */
export function settingsLine({
  scenarioName,
  settings: s,
}: Pick<AnalysisDetail, 'scenarioName' | 'settings'>): string {
  return [
    scenarioName ?? 'Published day',
    timeText(s),
    `${n(s.spacingM)} m`,
    `walk ${n(s.maxWalkM)} m`,
    `parking ${n(s.parkingMins)} min`,
    `traffic ${n(trafficFactorAt(s.departSecs, s.trafficFactors))}`,
  ].join(' · ');
}

/**
 * Reads 'Lines at' ('1, 1.5, 2') into breaks, or the reason it cannot be used, in the API's own
 * words. A gap between commas is not a number, as the API has it.
 */
export function readBreaks(
  text: string,
  settings: AnalysisSettings,
): { breaks: number[] } | { problem: string } {
  const breaks = text.split(',').map((part) => (part.trim() === '' ? NaN : Number(part)));
  const problem = settingsProblem({ ...settings, breaks });
  return problem === null ? { breaks } : { problem };
}

/** The breaks a summary was made for: where each band after the first starts. */
export const summaryBreaks = (summary: PoiSummary): number[] =>
  summary.bands.slice(1).flatMap((band) => (band.from === null ? [] : [band.from]));

/** Breaks as 'Lines at' shows them. */
export const breaksText = (breaks: readonly number[]): string => breaks.join(', ');

/** A ratio to two places at most ('1.46', '2'), or 'None' when there is none. */
export const ratioText = (ratio: number | null): string =>
  ratio === null ? 'None' : String(Number(ratio.toFixed(2)));

/** One row of the summary table, with the colour it has on the map. */
export interface SummaryRow {
  label: string;
  count: number;
  colour: string;
}

/**
 * The summary table (FR-20): each band with its count, then no service and no road, and the
 * total, which is every sample point of a finished analysis (AC-FR-20.1).
 */
export function summaryRows(
  summary: PoiSummary,
  breaks: readonly number[],
): { rows: SummaryRow[]; total: number } {
  const ranges = bandRanges(breaks);
  const colours = bandColours(ranges.length);
  const rows: SummaryRow[] = ranges.map((range, k) => ({
    label: bandLabel(range),
    count: summary.bands[k]?.count ?? 0,
    colour: colours[k] ?? NO_SERVICE_COLOUR,
  }));
  rows.push(
    { label: 'No service', count: summary.noService, colour: NO_SERVICE_COLOUR },
    { label: 'No road', count: summary.noRoad, colour: NO_ROAD_COLOUR },
  );
  return { rows, total: rows.reduce((sum, row) => sum + row.count, 0) };
}

/** A download of the open analysis (FR-18): its words, what it holds, and the API's export. */
export interface DownloadLink {
  label: string;
  title: string;
  href: string;
}

/**
 * The three downloads (AC-FR-18.1): every sample point and point of interest as CSV and as
 * GeoJSON points, and the lines on show (this point of interest, these breaks) as GeoJSON.
 */
export function downloadLinks(
  id: number,
  poiSeq: number,
  breaks: readonly number[],
): DownloadLink[] {
  const base = `/api/analyses/${id}/export`;
  return [
    {
      label: 'Download results (CSV)',
      title:
        'One row per sample point and point of interest: both times, how they split up, and the ratio',
      href: `${base}/results.csv`,
    },
    {
      label: 'Sample points (GeoJSON)',
      title: 'The same rows as points, to open in a GIS',
      href: `${base}/points.geojson`,
    },
    {
      label: 'Lines (GeoJSON)',
      title: 'The lines of equal ratio on show, for this point of interest',
      href: `${base}/lines.geojson?poi=${poiSeq}&breaks=${breaks.join(',')}`,
    },
  ];
}
