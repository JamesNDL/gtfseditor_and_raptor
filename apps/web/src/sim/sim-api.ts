// What the editor's API says about the passenger simulator, and the calls that change it.
// See docs/simulator-plan.md, sections 6 and 7.
import { getJson } from '../shared/api-client.ts';
import { useStore } from '../app/store.ts';

export interface SimBox {
  name: string | null;
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface SimArea extends SimBox {
  id: number;
  name: string;
  provided: boolean;
}

export interface SimFolder {
  id: number;
  name: string;
  parentId: number | null;
  runs: number;
}

export interface DemandSet {
  id: number;
  name: string;
  state: 'checking' | 'generating' | 'ready' | 'failed';
  error: string | null;
  madeUp: boolean;
  rows: number;
  people: number;
  users: number;
  earliest: number | null;
  latest: number | null;
  report: {
    rowsRead?: number;
    rowsRefused?: number;
    refused?: Record<string, number>;
    examples?: string[];
    busiestHour?: number;
    busiestHourPeople?: number;
    /** Rows that start before 04:00, and what the check says about them and anything else. */
    rowsBefore4am?: number;
    warnings?: string[];
    /** Every user id has the form the generator writes. */
    madeUpIds?: boolean;
  };
  madeBy: string | null;
  createdAt: string;
  runs: number;
  unknownStops?: { stops: number; journeyEnds: number; examples: string[] };
}

export interface Coverage {
  journeyEnds: number;
  endsInside: number;
  noService: { stops: number; journeyEnds: number; withAnotherNear: number };
}

export type RunState =
  'queued' | 'preparing' | 'running' | 'importing' | 'done' | 'failed' | 'stopped';

/** The figures of a finished run, as the simulator wrote them. Only what the panels read is typed. */
export interface SimSummary {
  capacity: boolean;
  demand: {
    rowsInFile: number;
    rowsRefused: number;
    leftOutWhollyOutsideArea: number;
    leftOutOneEndInsideArea: number;
    rows: number;
    people: number;
    users: number;
  };
  people: { ok: number; noJourney: number; gaveUp: number; stranded: number };
  journeys: {
    medianMinutes: number;
    percentile90Minutes: number;
    meanMinutes: number;
    meanWaitMinutes: number;
    meanWalkMinutes: number;
    meanRides: number;
    meanVehiclesBoarded: number;
    boardings: number;
  };
  stops: {
    changedAtOrigin: number;
    changedAtDestination: number;
    becauseTheirStopWasGone: number;
    becauseAnotherWasBetter: number;
  };
  againstBau?: {
    compared: number;
    sooner: number;
    later: number;
    within1Minute: number;
    meanMinutesSooner: number;
    meanMinutesLater: number;
    gaveUp: number;
    newlyAbleToTravel: number;
    noLongerAbleToTravel: number;
  };
  plannedLoads: {
    tripsPlannedOverCapacity: number;
    departuresPlannedOverCapacity: number;
    furthestOver: {
      trip: string;
      line: string;
      plannedLoad: number;
      limit: number;
      firstOverAt: string;
      stop: string;
    }[];
  };
  capacityResults?: {
    replayRan: boolean;
    timesLeftBehind: number;
    peopleLeftBehindAtLeastOnce: number;
    shareLeftBehindPercent: number;
    arrivedAnotherWay: number;
    stranded: number;
    fullestLines: { line: string; peakPercent: number; tripsFull: number; boardings: number }[];
    stopsLeavingMostBehind: { stop: string; name: string; leftBehind: number }[];
  };
  capacities: { trips: number; placeholderOrAssumed: number };
  limits: string[];
}

export interface SimRun {
  id: number;
  name: string;
  kind: 'bau' | 'scenario';
  baselineId: number | null;
  scenarioId: number | null;
  scenarioName: string | null;
  demandSetId: number | null;
  demandSetName: string | null;
  bauRunId: number | null;
  bauRunName: string | null;
  plansRunId: number | null;
  capacity: boolean;
  settings: Record<string, unknown>;
  state: RunState;
  progress: { stage?: string; done?: number; total?: number; secs?: number; runsAhead?: number };
  error: string | null;
  folderId: number | null;
  madeBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  resultRows: number;
  sizeBytes: number;
  planRate: number | null;
  archived: boolean;
  area: SimBox | null;
  /** Whether its journeys were made up. Null when the demand set has been removed. */
  madeUp: boolean | null;
  /** Its trips, and how many have a placeholder or assumed capacity. Null until it has finished. */
  capacities: { trips: number; placeholderOrAssumed: number } | null;
  outOfDate: boolean;
  capacityOutOfDate: boolean;
  scenarioRuns: number;
  capacityRuns: number;
  /** In the list. */
  people?: SimSummary['people'] | null;
  /** At the run's own address. */
  summary?: SimSummary | null;
}

export interface SimLeg {
  leg: number;
  kind: 'walk' | 'change' | 'ride';
  tripId: number | null;
  routeId: number | null;
  routeName: string | null;
  fromStop: string | null;
  toStop: string | null;
  depart: number;
  arrive: number;
  metres: number;
  stayAboard: boolean;
  fromLon: number | null;
  fromLat: number | null;
  toLon: number | null;
  toLat: number | null;
}

export interface SimJourney {
  journeyId: string;
  part: number;
  people: number;
  status: 'ok' | 'noJourney' | 'gaveUp' | 'stranded';
  start: number;
  depart: number | null;
  arrive: number | null;
  journeySecs: number | null;
  rides: number;
  walkSecs: number;
  waitSecs: number | null;
  leftBehind: number;
  laterSecs: number | null;
  originChanged: boolean;
  destinationChanged: boolean;
  changeReason: string | null;
  noJourneyReason: string | null;
  strandedTime: number | null;
  legs: SimLeg[];
}

/** What is said wherever a run shows as out of date. */
export const OUT_OF_DATE =
  "Out of date: the timetable has been edited, or the router's rules for walks and changes have changed, since this run was made.";

/** The limits of a run's area, in words; empty for a run of the whole network. */
export function areaText(area: SimBox | null): string {
  if (!area) return '';
  const lat = (n: number) => `${Math.abs(n).toFixed(3)}°${n < 0 ? 'S' : 'N'}`;
  const lon = (n: number) => `${Math.abs(n).toFixed(3)}°${n < 0 ? 'W' : 'E'}`;
  return `Only journeys that start and end inside ${area.name ? `"${area.name}": ` : 'the box '}${lat(area.north)} to ${lat(area.south)}, ${lon(area.west)} to ${lon(area.east)}`;
}

/**
 * A walk's length for showing. The simulator keeps the straight line and times the walk at 1.3
 * times it, so the distance shown is that estimate, to the nearest 10 m, with the straight line.
 */
export function walkText(metres: number): string {
  const walked = Math.round((metres * 1.3) / 10) * 10;
  return metres < 20
    ? `${metres.toLocaleString('en-AU')} m`
    : `about ${walked.toLocaleString('en-AU')} m (${metres.toLocaleString('en-AU')} m in a straight line)`;
}

export const ACTIVE: RunState[] = ['queued', 'preparing', 'running', 'importing'];
export const isActive = (run: SimRun) => ACTIVE.includes(run.state);

/** Sends a change. Answers the body, or throws with the API's own words. */
export async function send<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: headers ?? (body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : headers ? (body as BodyInit) : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error((json as { message?: string }).message ?? `Request failed (${res.status})`);
  return json as T;
}

/** Fetches the library for the chosen day into the store. */
export async function refreshRuns(): Promise<SimRun[]> {
  const { baselineId, set } = useStore.getState();
  if (baselineId === null) return [];
  const runs = await getJson<SimRun[]>(`/api/sim-runs?baseline=${baselineId}`);
  if (useStore.getState().baselineId === baselineId) set({ simRuns: runs });
  return runs;
}

/** What a run is doing, in a few words. */
export function progressText(run: SimRun): string {
  const p = run.progress ?? {};
  const count = p.total
    ? `${(p.done ?? 0).toLocaleString('en-AU')} of ${p.total.toLocaleString('en-AU')}`
    : '';
  switch (run.state) {
    case 'queued':
      return 'Waiting to start';
    case 'preparing':
      return `Getting the timetable ready${p.secs ? ` (${p.secs} s)` : ''}`;
    case 'importing':
      return 'Copying the results in';
    case 'running':
      if (p.stage === 'queued')
        return p.runsAhead
          ? `Waiting behind ${p.runsAhead} other run${p.runsAhead === 1 ? '' : 's'}`
          : 'Starting';
      if (p.stage === 'plan') return `Planning journeys: ${count}`;
      if (p.stage === 'replay') return `Putting passengers on vehicles: ${count}`;
      if (p.stage === 'write') return 'Writing the results';
      if (p.stage === 'read' || p.stage === 'fetch') return 'Reading the journeys';
      return 'Running';
    default:
      return run.state;
  }
}

/** The name people type once so that runs say who made them. A label, not a login. */
export const madeBy = {
  get: () => {
    try {
      return localStorage.getItem('simMadeBy') ?? '';
    } catch {
      return '';
    }
  },
  set: (name: string) => {
    try {
      localStorage.setItem('simMadeBy', name);
    } catch {
      // Remembering it is a convenience only.
    }
  },
};

export const bytes = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${Math.round(n / 1e6)} MB`
      : n > 0
        ? `${Math.max(1, Math.round(n / 1e3))} kB`
        : 'nothing';

/** The part of the map on screen, kept up to date by the map itself. */
export const mapView: { bounds: SimBox | null } = { bounds: null };
