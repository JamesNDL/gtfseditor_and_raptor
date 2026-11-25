// The access analysis request and answer types that the API (apps/api/src/analysis/) and the web
// app (apps/web/src/analysis/analysis-api.ts) share (D9, docs/architecture/access-analysis.md
// §4.2). Times are seconds since the start of the service day; coordinates are [lon, lat].
import type { CompareKind } from '../analysis/compare.ts';
import type { AnalysisSettings, TimeMode } from '../analysis/defaults.ts';
import type { PairStatus, PtSplit } from '../analysis/ratio.ts';
import type { PoiSummary } from '../analysis/summary.ts';

/** A position as [lon, lat]. */
export type GeoJsonPosition = [number, number];

/** A saved zone (FR-4): an outline drawn on the map, reused on any day (D25). */
export interface Zone {
  id: number;
  name: string;
  /** The corners, not closed (the first corner is not repeated at the end). */
  ring: GeoJsonPosition[];
  /** When it was saved, as an ISO 8601 timestamp. */
  createdAt: string;
}

/** The body that saves a zone. */
export interface ZoneBody {
  name: string;
  ring: GeoJsonPosition[];
}

/** A saved point of interest (FR-5), reused on any day (D25). */
export interface PointOfInterest {
  id: number;
  name: string;
  /** What sort of place it is; 'place' for now. */
  kind: string;
  /** Where it came from; 'drawn' for now. */
  source: string;
  lon: number;
  lat: number;
}

/** The body that saves a point of interest. */
export interface PoiBody {
  name: string;
  lon: number;
  lat: number;
  kind?: string;
}

/** Where an analysis stands; the `state` column of `analyses`. */
export type AnalysisState = 'queued' | 'preparing' | 'running' | 'done' | 'failed' | 'cancelled';

/** How far a run has got: the timetable (with seconds so far), then drives, then journeys. */
export interface AnalysisProgress {
  stage: 'timetable' | 'drives' | 'journeys';
  done?: number;
  total?: number;
  secs?: number;
}

/** The body that makes an analysis. Without a name, the API gives it one. */
export interface AnalysisCreateBody {
  name?: string;
  baselineId: number;
  /** The scenario to run on, or null for the published day itself. */
  scenarioId: number | null;
  zoneId: number;
  poiIds: number[];
  settings: AnalysisSettings;
}

/** An analysis in the list for a day. */
export interface AnalysisListItem {
  id: number;
  name: string;
  /** Null once the day or the scenario is deleted. */
  baselineId: number | null;
  scenarioId: number | null;
  /** The scenario's name as it was when the analysis was made; null for the published day. */
  scenarioName: string | null;
  zoneName: string;
  state: AnalysisState;
  /** Null when the analysis is not preparing or running (stored as an empty object). */
  progress: AnalysisProgress | null;
  error: string | null;
  sampleCount: number;
  createdAt: string;
  finishedAt: string | null;
  /** How its time is used (FR-21); 'depart' for analyses made before arrive-by. */
  timeMode: TimeMode;
  /** Its time: the departure or the arrive-by time (the settings' `departSecs`). */
  timeSecs: number;
}

/** An analysis as `GET /api/analyses?baseline=` lists it, with what it can be compared with. */
export interface AnalysisListEntry extends AnalysisListItem {
  /**
   * The other analyses of the day it can be compared with (FR-17, D31): both finished, the same
   * zone outline and spacing, and at least one saved point of interest in common. Rising ids.
   */
  comparableWith: number[];
}

/** The zone an analysis copied when it was made. */
export interface AnalysisZone {
  /** The saved zone it came from, or null once that is deleted. */
  id: number | null;
  name: string;
  ring: GeoJsonPosition[];
  /** md5 of the copied outline: analyses compare only when these and the spacings match (D31). */
  hash: string;
}

/** One of an analysis's points of interest, as copied, with its summary (FR-20). */
export interface AnalysisPoi {
  seq: number;
  /** The saved point of interest it came from, or null once that is deleted. */
  poiId: number | null;
  name: string;
  lon: number;
  lat: number;
  /** The summary for the analysis's own lines; null until the analysis is done. */
  summary: PoiSummary | null;
}

/** One analysis in full (FR-16). */
export interface AnalysisDetail extends AnalysisListItem {
  settings: AnalysisSettings;
  zone: AnalysisZone;
  pois: AnalysisPoi[];
}

/** A stop a ride is boarded or left at, and when. */
export interface StoredStop {
  /** The stop's GTFS id; missing in analyses run before ids were kept (D39). */
  stop?: string;
  name: string;
  lat: number;
  lon: number;
  time: number;
}

/** A walk, or a transfer between stops, in a stored journey. */
export interface StoredWalkLeg {
  type: 'walk' | 'transfer';
  secs: number;
  metres: number;
}

/** A ride in a stored journey, on a line (`route`) of a mode. */
export interface StoredRideLeg {
  type: 'ride';
  /** The trip's GTFS id; missing in analyses run before ids were kept (D39). */
  trip?: string;
  route: string;
  mode: string;
  board: StoredStop;
  alight: StoredStop;
  secs: number;
  metres: number;
}

/** One leg of a pair's journey, kept when the analysis runs, without the stops passed (D30). */
export type StoredLeg = StoredWalkLeg | StoredRideLeg;

/**
 * Where a ride's path on the map came from (D39): the trip's shape, its stops in order (a trip
 * with no shape, or a shape far from its stops), or a straight line when no trip was found.
 */
export type RidePathFrom = 'shape' | 'stops' | 'straight';

/** A ride as the picked sample point gives it: the stored ride and its path on the map (D39). */
export interface PointRideLeg extends StoredRideLeg {
  path: GeoJsonPosition[];
  pathFrom: RidePathFrom;
}

/** One leg of the picked sample point's journey. */
export type PointLeg = StoredWalkLeg | PointRideLeg;

/** One pair: a sample point and a point of interest, as shown when it is picked (FR-15). */
export interface PointDetail {
  /** The sample point, with its grid column and row. */
  seq: number;
  i: number;
  j: number;
  lon: number;
  lat: number;
  poiSeq: number;
  status: PairStatus;
  /** The public transport time and how it splits up; null when there is no journey. */
  pt: PtSplit | null;
  /** The stored legs, each ride with its path; null when there is no journey. */
  legs: PointLeg[] | null;
  /** The free-flow drive; null when there is no road. */
  driveSecs: number | null;
  driveMetres: number | null;
  /** The drive with the traffic factor and the parking allowance. */
  carSecs: number | null;
  /** The traffic factor and the parking allowance the car time was worked out with. */
  trafficFactor: number;
  parkingSecs: number;
  ratio: number | null;
  /** The drive's path from the road router, or null with the reason in `carPathMessage`. */
  carPath: GeoJsonPosition[] | null;
  carPathMessage: string | null;
}

/** A GeoJSON point. */
export interface GeoJsonPoint {
  type: 'Point';
  coordinates: GeoJsonPosition;
}

/** A GeoJSON feature with typed properties. */
export interface GeoJsonFeature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}

/** A GeoJSON feature collection with typed features. */
export interface GeoJsonFeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: GeoJsonFeature<G, P>[];
}

/** A GeoJSON multi-polygon: polygons, each a list of rings. */
export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: GeoJsonPosition[][][];
}

/** A GeoJSON multi-line: lines, each a list of positions. */
export interface GeoJsonMultiLineString {
  type: 'MultiLineString';
  coordinates: GeoJsonPosition[][];
}

/** One sample point's result for one point of interest, as drawn on the results map (FR-14). */
export interface SamplePointProperties {
  seq: number;
  status: PairStatus;
  /** Times in minutes, to a tenth; null when there is none. */
  ptMins: number | null;
  carMins: number | null;
  ratio: number | null;
}

/** A band of equal ratio: from `from` up to `to`; null for the open end below or above. */
export interface RatioBandProperties {
  from: number | null;
  to: number | null;
}

/** A line of equal ratio. */
export interface RatioLineProperties {
  ratio: number;
}

/** The bands and lines of equal ratio for one point of interest and some breaks (FR-14, FR-20). */
export interface AnalysisLines {
  /** One feature per band, below the first break up to above the last. */
  bands: GeoJsonFeatureCollection<GeoJsonMultiPolygon, RatioBandProperties>;
  /** One feature per break. */
  lines: GeoJsonFeatureCollection<GeoJsonMultiLineString, RatioLineProperties>;
  summary: PoiSummary;
}

/** How one sample point changed from the first analysis to the second (FR-17). */
export interface ComparedProperties {
  i: number;
  j: number;
  kind: CompareKind;
  /** The second ratio less the first, when both have one. */
  change: number | null;
}

/** Two analyses compared for one point of interest (FR-17, §5.3). */
export interface CompareResult {
  points: GeoJsonFeatureCollection<GeoJsonPoint, ComparedProperties>;
  counts: Record<CompareKind, number>;
}
