// The rows of an analysis's results export (FR-18, AC-FR-18.1; docs/architecture/access-analysis.md
// §5.3): one per sample point and point of interest, with the columns §5.3 gives in that order.
// results.csv writes them as text; points.geojson puts them on point features.
import { trafficFactorAt, type AnalysisSettings, type PairStatus } from '@gtfs-editor/core';
import type { PairRow } from './results-read.ts';

/** One stored pair with the point of interest it is for. */
export interface ExportPair extends PairRow {
  poiSeq: number;
  poiName: string;
}

/** One exported row. Minutes to a tenth, kilometres and the ratio to two places; null for none. */
export interface ExportRow {
  /** The sample point's seq. */
  point: number;
  lat: number;
  lon: number;
  /** The point of interest's seq in the analysis (the `poi` the results reads take). */
  poi: number;
  poi_name: string;
  status: PairStatus;
  pt_mins: number | null;
  walk_mins: number | null;
  wait_mins: number | null;
  ride_mins: number | null;
  rides: number | null;
  drive_mins_free_flow: number | null;
  drive_km: number | null;
  traffic_factor: number;
  parking_mins: number;
  car_mins: number | null;
  ratio: number | null;
}

/** The columns, in the order of §5.3. */
export const EXPORT_COLUMNS = [
  'point',
  'lat',
  'lon',
  'poi',
  'poi_name',
  'status',
  'pt_mins',
  'walk_mins',
  'wait_mins',
  'ride_mins',
  'rides',
  'drive_mins_free_flow',
  'drive_km',
  'traffic_factor',
  'parking_mins',
  'car_mins',
  'ratio',
] as const satisfies readonly (keyof ExportRow)[];

/** How many places the CSV writes a column with; the rest are written as they are. */
const PLACES: Partial<Record<keyof ExportRow, number>> = {
  pt_mins: 1,
  walk_mins: 1,
  wait_mins: 1,
  ride_mins: 1,
  drive_mins_free_flow: 1,
  drive_km: 2,
  parking_mins: 1,
  car_mins: 1,
  ratio: 2,
};

/** Rounded to `places` places. */
const roundTo = (value: number, places: number): number =>
  Math.round(value * 10 ** places) / 10 ** places;

/** Rounded to `places` places; null stays null. */
const round = (value: number | null, places: number): number | null =>
  value === null ? null : roundTo(value, places);

/** Seconds as minutes to a tenth; null stays null. */
const mins = (secs: number | null): number | null => round(secs === null ? null : secs / 60, 1);

/** The exported row of one pair, with the traffic factor and parking allowance it was run with. */
export function exportRowOf(pair: ExportPair, settings: AnalysisSettings): ExportRow {
  return {
    point: pair.seq,
    lat: pair.lat,
    lon: pair.lon,
    poi: pair.poiSeq,
    poi_name: pair.poiName,
    status: pair.status,
    pt_mins: mins(pair.ptSecs),
    walk_mins: mins(pair.walkSecs),
    wait_mins: mins(pair.waitSecs),
    ride_mins: mins(pair.rideSecs),
    rides: pair.rides,
    drive_mins_free_flow: mins(pair.driveSecs),
    drive_km: round(pair.driveMetres === null ? null : pair.driveMetres / 1000, 2),
    traffic_factor: trafficFactorAt(settings.departSecs, settings.trafficFactors),
    parking_mins: roundTo(settings.parkingMins, 1),
    car_mins: mins(pair.carSecs),
    ratio: round(pair.ratio, 2),
  };
}

/**
 * A name as a CSV cell. One that starts with =, +, -, @, a tab or a carriage return gets a quote
 * mark first, so a spreadsheet shows it as text rather than running it as a formula. Then it is
 * quoted, with its quotes doubled, when it holds a comma, quote or break.
 */
function nameCell(name: string): string {
  const text = /^[=+\-@\t\r]/.test(name) ? `'${name}` : name;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One cell: empty for null, a number with its column's places, or the text. */
function cell(row: ExportRow, column: keyof ExportRow): string {
  const value = row[column];
  if (value === null) return '';
  if (column === 'poi_name') return nameCell(String(value));
  const places = PLACES[column];
  return typeof value === 'number' && places !== undefined ? value.toFixed(places) : String(value);
}

/** The rows as CSV: the header, then one line per row, each ending with a line break. */
export function csvOf(rows: ExportRow[]): string {
  const lines = [
    EXPORT_COLUMNS.join(','),
    ...rows.map((row) => EXPORT_COLUMNS.map((column) => cell(row, column)).join(',')),
  ];
  return lines.map((line) => `${line}\r\n`).join('');
}
