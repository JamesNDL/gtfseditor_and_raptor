import { create } from 'zustand';
import type { Baseline, Mode, RouteListItem } from './api.ts';
import type { ScenarioInfo, ScenarioSummary } from './scenario.ts';
import type { SimBox, SimJourney, SimRun } from './sim/simApi.ts';
import type { SimMapState, SimResultsState } from './sim/results.ts';

export type Selection =
  | { kind: 'route'; id: number }
  | { kind: 'trip'; id: number }
  | { kind: 'vehicleDay'; id: number }
  | { kind: 'station'; id: number }
  | { kind: 'routeList'; ids: number[] };

export const SPEEDS = [1, 10, 60, 300, 900];

/** A stop picked for a line being drawn or reshaped. */
export interface BuilderStop {
  id: number;
  name: string;
  lon: number;
  lat: number;
  /** The station a platform belongs to, where known. */
  parentId?: number | null;
}

/** The colours of the two sides of a closure being set up, on the map and in its panel. */
export const SIDE_COLORS = ['#30d5c8', '#ff9f0a'];

/** A closure being set up: a line drawn on the map that nothing runs through. */
export interface Closing {
  /** The points clicked so far, as [lon, lat]. Two or more make a closure. */
  line: [number, number][];
  /** How far either side of the line is closed, in metres. */
  widthM: number;
  /** Modes left running through it. */
  exceptModes: string[];
  /** Buses and coaches: each line is split at the closure, or sent round it by other roads. */
  roads: 'split' | 'detour';
  /** Which parts of a split line are kept: 'both', or one side of the closure ('N', 'S', 'E' or 'W'). */
  keep: string;
  /** A different choice for single lines, by route id. */
  lines: Record<number, { how?: 'split' | 'detour' | 'leave'; keep?: string }>;
  /** False for a closure that lasts part of the day, between the two times ("HH:MM"). */
  allDay: boolean;
  startAt: string;
  endAt: string;
}

export type TimelineTab = 'stringline' | 'platforms' | 'vehicles';

export interface TimelineState {
  open: boolean;
  tab: TimelineTab;
  /** Line shown in the stringline and vehicle views. */
  routeId: number | null;
  /** Stopping pattern used as the stringline's station axis; null picks the longest. */
  patternId: number | null;
  /** Station shown in the platform view. */
  stationId: number | null;
  /** Platform or stop to highlight within that station, when one was clicked directly. */
  focusStopId: number | null;
  /** Show other lines sharing the corridor; null means "decide by mode". */
  showOthers: boolean | null;
}

interface AppState {
  baselines: Baseline[];
  baselineId: number | null;
  modes: Mode[];
  enabledModes: Record<string, boolean>;
  routes: Map<number, RouteListItem>;
  /** Modes whose vehicle data has finished loading. */
  loadedModes: Record<string, boolean>;

  playing: boolean;
  speed: number;

  /** Navigation stack for the inspector; the last entry is what is shown. */
  history: Selection[];
  /** Route highlighted on the map (follows the selection where it makes sense). */
  highlightRouteId: number | null;
  /** Trip whose vehicle is ringed on the map and outlined in the timelines. */
  highlightTripId: number | null;
  /** Bounds the map should fit, set when a route is opened. */
  fitBounds: [number, number, number, number] | null;

  /** Scenarios for the chosen day, and the one being edited (null means the read-only baseline). */
  scenarios: ScenarioSummary[];
  scenarioId: number | null;
  scenarioInfo: ScenarioInfo | null;
  /** Bumped after every edit so that views refetch. */
  dataVersion: number;
  /** Which other trips move along with a retimed trip. */
  ripple: 'none' | 'vehicle' | 'line';
  /** Outline on the map the lines the scenario has changed. */
  showChanged: boolean;
  /** The dark or the light version of the interface. */
  theme: 'dark' | 'light';
  editBusy: boolean;
  editError: string | null;
  /** The vehicle catalogue screen. */
  fleetOpen: boolean;
  /** The screen that lists every scenario, to open, rename or delete. */
  scenariosOpen: boolean;
  /** A new line being drawn on the map, or null. Stops are in calling order. */
  builder: {
    name: string;
    modeId: string;
    color: string;
    headwayMin: number;
    /** Follow roads, or the track and ferry routes published services use, rather than running straight between stops. */
    followRoads: boolean;
    /** A new line that runs one way round and back to its first stop, with no return direction. */
    loop?: boolean;
    stops: BuilderStop[];
    /** Set when an existing line's stops are being changed rather than a new line drawn. */
    reshape?: {
      routeId: number;
      patternId: number;
      /** The stop pattern as it is now. */
      original: BuilderStop[];
      /** Where a stop clicked on the map joins the line. */
      insertAt: 'best' | 'end' | 'start';
      /** Where stops are removed, take the direct road rather than driving past them. */
      direct: boolean;
      /** Change the line's other direction to match. */
      bothWays: boolean;
    };
  } | null;
  /** The path the line being drawn would take, once worked out. */
  builderPath: { coords: [number, number][]; description: string; otherCoords?: [number, number][] | null } | null;
  /** A road or line being closed, or null. */
  closing: Closing | null;
  /** What the closure being set up would do, for the map. */
  closingPreview: {
    zone: GeoJSON.Geometry;
    /** Ways round, for lines that are sent round. */
    paths: [number, number][][];
    /** The part of each split line on each side, kept or dropped, and the stops where vehicles turn back. */
    parts: { side: string; kept: boolean; coords: [number, number][]; routeIds: number[] }[];
    /** Each line the closure crosses: its name, which side is kept, and its parts. */
    lines: { routeId: number; name: string; keep: string; parts: { side: string; kept: boolean }[] }[];
    turns: { name: string; lon: number; lat: number; side: string; kept: boolean }[];
    /** The two sides, in the order of their colours. */
    sides: string[];
  } | null;
  /** The line of a closure that the pointer is on, in the list or on the map: it stands out on both. */
  closingFocus: number | null;
  /** Lines picked by a click on the map where several run together: the list shows only these. */
  closingOnly: number[] | null;
  /** A new stop that has been named and is waiting for a click on the map to place it. */
  placing: { name: string; pair: boolean; platforms: number } | null;
  /** Whether skipping a stop changes one trip or every trip with the same stopping pattern. */
  stopScope: 'trip' | 'pattern';

  /** The simulation library for the chosen day, refreshed while a run is going. */
  simRuns: SimRun[];
  /** The run whose passenger figures are shown on lines, trips and stations; null for none. */
  simRunId: number | null;
  /** The library or the wizard, when one is open. */
  simScreen: 'library' | 'wizard' | null;
  /** True while a box for a run's area is being dragged on the map; the wizard steps aside. */
  simDrawing: boolean;
  /** The area of the run being set up, drawn on the map. */
  simBox: SimBox | null;
  /** One person's journeys in the chosen run, drawn on the map. */
  simPerson: { user: string; journeys: SimJourney[]; /** The same journeys in the run compared with, drawn underneath. */ before?: SimJourney[] } | null;
  /** The results window of the chosen run: what it shows and what the run is set against. */
  simResults: SimResultsState;
  /** What the results draw on the map. */
  simMap: SimMapState;
  /** Bumped by the map each time it has drawn the results, so that the key shows the scale in use. */
  simMapDrawn: number;
  /** Trips in the timelines are coloured by how full they are in the chosen run. */
  simTripColours: boolean;

  timeline: TimelineState;
  /** Time window shown by every timeline view, in seconds since the start of the service day. */
  view: [number, number];

  set: (partial: Partial<AppState>) => void;
  toggleMode: (id: string) => void;
  open: (selection: Selection, options?: { replace?: boolean }) => void;
  back: () => void;
  close: () => void;
  openTimeline: (partial?: Partial<TimelineState>) => void;
  closeTimeline: () => void;
  setView: (start: number, end: number) => void;
}

const CLOSED_TIMELINE: TimelineState = {
  open: false,
  tab: 'stringline',
  routeId: null,
  patternId: null,
  stationId: null,
  focusStopId: null,
  showOthers: null,
};

export const useStore = create<AppState>((set) => ({
  baselines: [],
  baselineId: null,
  modes: [],
  enabledModes: {},
  routes: new Map(),
  loadedModes: {},
  playing: true,
  speed: 60,
  history: [],
  highlightRouteId: null,
  highlightTripId: null,
  fitBounds: null,
  scenarios: [],
  scenarioId: null,
  scenarioInfo: null,
  dataVersion: 0,
  ripple: 'none',
  showChanged: true,
  theme: (() => {
    try {
      return localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  })(),
  editBusy: false,
  editError: null,
  fleetOpen: false,
  scenariosOpen: false,
  builder: null,
  builderPath: null,
  closing: null,
  closingPreview: null,
  closingFocus: null,
  closingOnly: null,
  placing: null,
  stopScope: 'trip',
  simRuns: [],
  simRunId: null,
  simScreen: null,
  simDrawing: false,
  simBox: null,
  simPerson: null,
  simResults: { open: false, small: false, tab: 'overview', vs: null, band: null, lineId: null, who: null },
  simMap: { layer: 'none', flow: 'change', by: 'stop', end: 'origin', side: 'b' },
  simTripColours: false,
  simMapDrawn: 0,
  timeline: CLOSED_TIMELINE,
  view: [6 * 3600, 10 * 3600],

  set: (partial) => set(partial),
  toggleMode: (id) => set((s) => ({ enabledModes: { ...s.enabledModes, [id]: !s.enabledModes[id] } })),
  open: (selection, options) =>
    set((s) => ({
      history: options?.replace ? [selection] : [...s.history, selection],
      ...(selection.kind === 'route' ? { highlightRouteId: selection.id, highlightTripId: null } : {}),
      ...(selection.kind === 'trip' ? { highlightTripId: selection.id } : {}),
    })),
  back: () => set((s) => ({ history: s.history.slice(0, -1) })),
  close: () => set({ history: [], highlightRouteId: null, highlightTripId: null }),
  openTimeline: (partial) =>
    set((s) => {
      const next = { ...s.timeline, ...partial, open: true };
      // A different line has different stopping patterns.
      if (partial?.routeId !== undefined && partial.routeId !== s.timeline.routeId && partial.patternId === undefined) {
        next.patternId = null;
      }
      // Choosing a station without naming a platform clears any earlier platform focus.
      if (partial?.stationId !== undefined && partial.focusStopId === undefined) next.focusStopId = null;
      return { timeline: next };
    }),
  closeTimeline: () => set((s) => ({ timeline: { ...s.timeline, open: false } })),
  setView: (start, end) => set({ view: [start, end] }),
}));

export const currentSelection = (s: AppState): Selection | null => s.history[s.history.length - 1] ?? null;
