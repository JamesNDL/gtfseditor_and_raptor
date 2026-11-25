// What the Access pane is showing (the one field it has in the app store), the small helpers that
// change it, and how an analysis reads in the list. See docs/architecture/access-analysis.md §5.2.
import {
  DEFAULT_ANALYSIS_SETTINGS,
  ringProblem,
  type AnalysisListItem,
  type AnalysisSettings,
  type AnalysisState,
  type GeoJsonPosition,
} from '@gtfs-editor/core';

/** The screens of the Access pane. */
export type AnalysisScreen = 'list' | 'setup' | 'results' | 'compare';

/** What a new analysis is being set up with, before it is run. */
export interface AnalysisSetupChoices {
  /** Left empty, the API gives the analysis a name. */
  name: string;
  /** The scenario to run on, or null for the published day. */
  scenarioId: number | null;
  zoneId: number | null;
  poiIds: number[];
  settings: AnalysisSettings;
}

/** The Access pane's state: `analysis` in the app store. */
export interface AnalysisView {
  screen: AnalysisScreen;
  /** The corners of a zone being drawn, or null when none is. */
  drawing: GeoJsonPosition[] | null;
  /** The outline being drawn is closed and waits for its name. */
  drawingClosed: boolean;
  /** Why the outline being drawn could not be closed (AC-FR-4.2), or null. */
  drawingProblem: string | null;
  /** The name of a point of interest waiting for a click on the map to place it, or null. */
  placingPoi: string | null;
  /** The point of interest whose next click on the map is its new place, or null. */
  movingPoiId: number | null;
  setup: AnalysisSetupChoices;
  /** The analysis whose results are shown. */
  openId: number | null;
  /** The open analysis's point of interest on show. */
  poiSeq: number;
  /** The lines of equal ratio on show; null for the analysis's own. */
  breaks: number[] | null;
  /** The sample point picked on the map. */
  pointSeq: number | null;
  /** The analysis the open one is compared with. */
  compareWith: number | null;
}

/** The starting view: the list, nothing open, and the starting settings (D34). */
export function defaultAnalysisView(): AnalysisView {
  return {
    screen: 'list',
    drawing: null,
    drawingClosed: false,
    drawingProblem: null,
    placingPoi: null,
    movingPoiId: null,
    setup: {
      name: '',
      scenarioId: null,
      zoneId: null,
      poiIds: [],
      // A copy, so that changing the setup never changes the starting values.
      settings: structuredClone(DEFAULT_ANALYSIS_SETTINGS),
    },
    openId: null,
    poiSeq: 0,
    breaks: null,
    pointSeq: null,
    compareWith: null,
  };
}

/** Leaving a screen stops anything waiting for a click on the map. */
const stopMapWork = {
  drawing: null,
  drawingClosed: false,
  drawingProblem: null,
  placingPoi: null,
  movingPoiId: null,
} as const;

/** Nothing of an open analysis is shown. */
const closeResults = {
  openId: null,
  poiSeq: 0,
  breaks: null,
  pointSeq: null,
  compareWith: null,
} as const;

/** Shows an analysis's results, starting at its first point of interest. */
export function openAnalysis(view: AnalysisView, id: number): AnalysisView {
  return { ...view, ...stopMapWork, ...closeResults, screen: 'results', openId: id };
}

/** Shows the setup with fresh choices, on the timetable open (a scenario, or the published day). */
export function newAnalysis(view: AnalysisView, scenarioId: number | null): AnalysisView {
  const setup = { ...defaultAnalysisView().setup, scenarioId };
  return { ...view, ...stopMapWork, ...closeResults, screen: 'setup', setup };
}

/** Goes back to the list of analyses. */
export function backToList(view: AnalysisView): AnalysisView {
  return { ...view, ...stopMapWork, ...closeResults, screen: 'list' };
}

/**
 * Lets go of analyses that are no longer listed (deleted, or of another day): back to the list
 * if the open one has gone, or back to its results if only the one compared with has.
 */
export function forgetMissing(view: AnalysisView, listedIds: number[]): AnalysisView {
  if (view.openId !== null && !listedIds.includes(view.openId)) return backToList(view);
  if (view.compareWith !== null && !listedIds.includes(view.compareWith)) {
    return {
      ...view,
      compareWith: null,
      screen: view.screen === 'compare' ? 'results' : view.screen,
    };
  }
  return view;
}

// ---- map work: drawing a zone, placing or moving a point of interest (FR-4, FR-5) -------------

/** How near the first corner, in pixels, a click closes the outline being drawn. */
export const CLOSE_REACH_PX = 10;

/** True while a click on the map belongs to the Access pane, and so does nothing else. */
export const isMapBusy = (view: AnalysisView): boolean =>
  view.drawing !== null || view.placingPoi !== null || view.movingPoiId !== null;

/** Stops drawing, placing or moving (Escape or Cancel). */
export const cancelMapWork = (view: AnalysisView): AnalysisView => ({ ...view, ...stopMapWork });

/** Starts drawing a zone with no corners yet. */
export const startDrawing = (view: AnalysisView): AnalysisView => ({
  ...view,
  ...stopMapWork,
  drawing: [],
});

/** Waits for a click to place a new point of interest with this name. */
export const startPlacingPoi = (view: AnalysisView, name: string): AnalysisView => ({
  ...view,
  ...stopMapWork,
  placingPoi: name,
});

/** Waits for a click to move a saved point of interest. */
export const startMovingPoi = (view: AnalysisView, id: number): AnalysisView => ({
  ...view,
  ...stopMapWork,
  movingPoiId: id,
});

const samePlace = (a: GeoJsonPosition, b: GeoJsonPosition): boolean =>
  a[0] === b[0] && a[1] === b[1];

/** Adds a corner to an open outline. A corner repeating the last one (a double click) is dropped. */
export function addCorner(view: AnalysisView, corner: GeoJsonPosition): AnalysisView {
  const corners = view.drawing;
  if (corners === null || view.drawingClosed) return view;
  const last = corners[corners.length - 1];
  if (last && samePlace(last, corner)) return view;
  return { ...view, drawing: [...corners, corner], drawingProblem: null };
}

/** Opens a closed outline again, or else takes off its last corner. */
export function undoCorner(view: AnalysisView): AnalysisView {
  if (view.drawing === null) return view;
  if (view.drawingClosed) return { ...view, drawingClosed: false };
  return { ...view, drawing: view.drawing.slice(0, -1), drawingProblem: null };
}

/**
 * Closes the outline, ready to be named, or keeps it open with the reason it cannot be a zone
 * (AC-FR-4.2). The first corner clicked again at the end is not a corner of its own.
 */
export function closeDrawing(view: AnalysisView): AnalysisView {
  if (view.drawing === null || view.drawingClosed) return view;
  const corners = view.drawing;
  const ring =
    corners.length > 1 && samePlace(corners[0], corners[corners.length - 1])
      ? corners.slice(0, -1)
      : corners;
  const problem = ringProblem(ring);
  if (problem) return { ...view, drawingProblem: problem };
  return { ...view, drawing: ring, drawingClosed: true, drawingProblem: null };
}

/** Whether a click closes the outline: it has three corners and the click is by the first. */
export function closesOutline(
  view: AnalysisView,
  pixelsTo: (corner: GeoJsonPosition) => number,
): boolean {
  const corners = view.drawing;
  if (corners === null || view.drawingClosed || corners.length < 3) return false;
  return pixelsTo(corners[0]) <= CLOSE_REACH_PX;
}

// ---- the setup's zone and points of interest -----------------------------------------------

const withSetup = (view: AnalysisView, setup: Partial<AnalysisSetupChoices>): AnalysisView => ({
  ...view,
  setup: { ...view.setup, ...setup },
});

/** Picks the zone to analyse, or none. */
export const pickZone = (view: AnalysisView, zoneId: number | null): AnalysisView =>
  withSetup(view, { zoneId });

/** Picks a point of interest, or unpicks it if it was picked. */
export function togglePoi(view: AnalysisView, id: number): AnalysisView {
  const ids = view.setup.poiIds;
  return withSetup(view, { poiIds: ids.includes(id) ? ids.filter((p) => p !== id) : [...ids, id] });
}

/** Lets go of a deleted zone. */
export const forgetZone = (view: AnalysisView, id: number): AnalysisView =>
  view.setup.zoneId === id ? pickZone(view, null) : view;

/** Lets go of a deleted point of interest, and stops moving it. */
export function forgetPoi(view: AnalysisView, id: number): AnalysisView {
  const next = withSetup(view, { poiIds: view.setup.poiIds.filter((p) => p !== id) });
  return view.movingPoiId === id ? { ...next, movingPoiId: null } : next;
}

const ACTIVE_STATES: AnalysisState[] = ['queued', 'preparing', 'running'];

/** True while the analysis is waiting or running. */
export const isAnalysisActive = (item: AnalysisListItem): boolean =>
  ACTIVE_STATES.includes(item.state);

/** How much of a running analysis's current step is done, from 0 to 1; null with no count. */
export function progressShare(item: AnalysisListItem): number | null {
  const total = item.progress?.total;
  if (item.state !== 'running' || !total) return null;
  return Math.min(1, (item.progress?.done ?? 0) / total);
}

/** The timetable the analysis ran on: its scenario's name, or the published day. */
export const timetableText = (item: AnalysisListItem): string =>
  item.scenarioName ?? 'Published day';

const STATE_WORDS: Record<AnalysisState, string> = {
  queued: 'Waiting to start',
  preparing: 'Loading the timetable',
  running: 'Running',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STAGE_WORDS: Record<NonNullable<AnalysisListItem['progress']>['stage'], string> = {
  timetable: 'Loading the timetable',
  drives: 'Drives',
  journeys: 'Journeys',
};

/** Where the analysis stands, in plain words: the stage it is at, or the reason it failed. */
export function stateText(item: AnalysisListItem): string {
  if (isAnalysisActive(item) && item.progress) return STAGE_WORDS[item.progress.stage];
  const words = STATE_WORDS[item.state];
  return item.state === 'failed' && item.error ? `${words}: ${item.error}` : words;
}
