// What the Access pane is showing (the one field it has in the app store), the small helpers that
// change it, and how an analysis reads in the list. See docs/architecture/access-analysis.md §5.2.
import {
  DEFAULT_ANALYSIS_SETTINGS,
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
const stopMapWork = { drawing: null, placingPoi: null, movingPoiId: null } as const;

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

/** Where the analysis stands, in plain words, with the reason when it failed. */
export function stateText(item: AnalysisListItem): string {
  const words = STATE_WORDS[item.state];
  return item.state === 'failed' && item.error ? `${words}: ${item.error}` : words;
}
