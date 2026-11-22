// What the results window and the map share: the choices made in the window, what the API answers,
// and the colours that mean the same thing in both. See docs/simulator-plan.md, section 18.
import { DAY_BANDS } from '@gtfs-editor/core';
import { useEffect, useState } from 'react';

export type ResultsTab = 'overview' | 'time' | 'lines' | 'patterns' | 'people';

/**
 * A set of people picked out of a run, to list in the People tab and to follow on the map: a
 * group of the change in arrival time, the riders of a line, or whoever goes through a stretch
 * or a stop.
 */
export type Who =
  | {
      kind:
        | 'changed'
        | 'later'
        | 'sooner'
        | 'soonerTruly'
        | 'soonerNearby'
        | 'lost'
        | 'gaveUp'
        | 'noJourney'
        | 'gained'
        | 'all';
    }
  | { kind: 'group'; group: number }
  | { kind: 'line'; id: number; name: string }
  | { kind: 'link'; from: number; to: number; name: string }
  | { kind: 'stop'; id: number; name: string }
  | { kind: 'user'; id: string };

/** Whether a set is of people who use something, which they may do in one run and not the other. */
export const whoHasSide = (who: Who) =>
  who.kind === 'line' || who.kind === 'link' || who.kind === 'stop';

/** The set as the API takes it. `side` says in which run they use it: this one (a) or the other (b). */
export function whoParam(who: Who, side: 'a' | 'b'): string {
  switch (who.kind) {
    case 'group':
      return `group:${who.group}`;
    case 'line':
      return `line:${who.id}:${side}`;
    case 'link':
      return `link:${who.from}-${who.to}:${side}`;
    case 'stop':
      return `stop:${who.id}:${side}`;
    case 'user':
      return `user:${who.id}`;
    default:
      return who.kind;
  }
}

/** The set in words, to follow "people who" or stand alone. */
export function whoLabel(who: Who, side: 'a' | 'b', compared: boolean): string {
  const when = !compared ? '' : side === 'a' ? ' now' : ' before';
  switch (who.kind) {
    case 'changed':
      return 'Everyone whose journey changed';
    case 'later':
      return 'People who arrive later';
    case 'sooner':
      return 'People who arrive sooner';
    case 'soonerTruly':
      return 'People who arrive sooner, and not just by using a nearby stop that was already quicker';
    case 'soonerNearby':
      return 'People who arrive sooner only by using a nearby stop that was already quicker on the published timetable';
    case 'lost':
      return 'People who can no longer travel';
    case 'gaveUp':
      return 'People who gave up because the journey is now too much later';
    case 'noJourney':
      return 'People who now have no journey, or were stranded';
    case 'gained':
      return 'People who can now travel';
    case 'all':
      return 'Everyone';
    case 'group':
      return `People who arrive ${GROUP_LABELS[who.group].toLowerCase().replace('the same, ', '')}`;
    case 'line':
      return `People who ride ${who.name}${when}`;
    case 'link':
      return `People who ride from ${who.name}${when}`;
    case 'stop':
      return `People who get on, off or change at ${who.name}${when}`;
    case 'user':
      return `The person called ${who.id}`;
  }
}

export interface SimResultsState {
  open: boolean;
  /** Folded to its title bar, so the map can be seen whole. */
  small: boolean;
  tab: ResultsTab;
  /** The run compared with: null for the usual one (a scenario run's BAU run), or a run's id. */
  vs: number | null;
  /** The part of the day, as an index into DAY_BANDS; null for all day. */
  band: number | null;
  /** The line opened in the Lines tab. */
  lineId: number | null;
  /** The people picked out, for the People tab and "Through here" on the map; null for none. */
  who: Who | null;
}

export interface SimMapState {
  layer: 'none' | 'flow' | 'places' | 'through' | 'vehicles';
  /** Passenger flow coloured by change against the other run, by passengers, or by how full. */
  flow: 'change' | 'passengers' | 'full';
  /** Who is affected, by stop or gathered into squares of this many metres. */
  by: 'stop' | '500' | '1000' | '2000';
  /** Placed by where people start, or where they are going. */
  end: 'origin' | 'destination';
  /** For people picked by what they use: whether they use it in this run (a) or the other (b). */
  side: 'a' | 'b';
}

/** The address of one of a run's results, with the comparison and part of the day chosen. */
export function resultsUrl(
  runId: number,
  what: string,
  state: Pick<SimResultsState, 'vs' | 'band'>,
  more: Record<string, string> = {},
) {
  const params = new URLSearchParams(more);
  if (state.vs !== null) params.set('vs', String(state.vs));
  if (state.band !== null) {
    const band = DAY_BANDS[state.band];
    params.set('from', String(band.from));
    if (Number.isFinite(band.to)) params.set('to', String(band.to));
  }
  const query = params.toString();
  return `/api/sim-runs/${runId}/results/${what}${query ? `?${query}` : ''}`;
}

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Fetches JSON, keeping the API's own words when it refuses. */
export async function fetchResults<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error((json as { message?: string }).message ?? `Request failed (${res.status})`);
  return json as T;
}

export function useResults<T>(url: string | null): Fetched<T> {
  const [state, setState] = useState<Fetched<T>>({ data: null, error: null, loading: !!url });
  useEffect(() => {
    if (!url) return setState({ data: null, error: null, loading: false });
    const controller = new AbortController();
    setState((prev) => ({ data: prev.data, error: null, loading: true }));
    fetchResults<T>(url, controller.signal).then(
      (data) => setState({ data, error: null, loading: false }),
      (err) => {
        if (!controller.signal.aborted)
          setState({ data: null, error: String(err.message ?? err), loading: false });
      },
    );
    return () => controller.abort();
  }, [url]);
  return state;
}

/** The same, to carry on a sentence: only its first letter is lowered, so that names keep theirs. */
export function whoPhrase(who: Who, side: 'a' | 'b', compared: boolean): string {
  const label = whoLabel(who, side, compared);
  return label[0].toLowerCase() + label.slice(1);
}

// ---- what the API answers ---------------------------------------------------
interface Parts {
  waitMinutes: number;
  walkMinutes: number;
  rideMinutes: number;
  journeyMinutes: number;
  vehicles: number;
}

/** People, the hours they gain or lose between them, and the average for one of them. */
export interface Change {
  people: number;
  hours: number;
  meanMinutes: number;
}

/** A run's trips, and how many of their capacities are placeholders or assumed. Null if not known. */
export type Capacities = { trips: number; placeholder: number } | null;

/** What to say wherever a figure rests on vehicle capacities; nothing when they are real. */
export const placeholderNote = (capacity: Capacities | undefined): string | null =>
  !capacity || capacity.placeholder === 0
    ? null
    : capacity.placeholder >= capacity.trips
      ? 'Every vehicle capacity is a round-number placeholder, so how full a vehicle is, and who is left behind, are illustrative.'
      : `${capacity.placeholder.toLocaleString('en-AU')} of ${capacity.trips.toLocaleString('en-AU')} trips have a placeholder or assumed capacity, so how full they are is illustrative.`;

export interface Overview {
  run: { id: number; name: string; kind: string };
  vs: { id: number; name: string; kind: string } | null;
  others: { id: number; name: string; kind: string; capacity: boolean }[];
  times: { a: JourneyTimes; b: JourneyTimes | null };
  /** Whether the journeys were made up, not observed. Null when the demand set has been removed. */
  madeUp: boolean | null;
  /**
   * On the published timetable (the BAU run): travellers, how many of them start or end at a stop
   * that one nearby already beat, and by how much on average, as the simulator scores a journey.
   */
  margin: { people: number; beaten: number; meanMinutes: number } | null;
  capacity: Capacities;
  // The rest is there only when the run is set against another.
  compared?: number;
  groups?: number[];
  /** Of each group, the people who arrive sooner only by a nearby stop that was already quicker. */
  nearbyGroups?: number[];
  /** Everyone who arrives sooner; `truly` and `nearby` split them. */
  sooner?: Change & { truly: Change; nearby: Change };
  later?: Change;
  /**
   * People who gave up, counted by how much later the journey they turned down would have been.
   * `atLeast` of them are counted at the limit, because the run did not record more: the hours
   * are then the least they can be.
   */
  gaveUp?: Change & { groups: number[]; atLeast: number; limitMinutes: number };
  /** Hours lost by those later or who gave up, less hours gained by those truly sooner. */
  net?: { hoursLost: number; hoursGained: number; hours: number; atLeast: boolean };
  lost?: { people: number; gaveUp: number; stranded: number };
  gained?: number;
  parts?: {
    all: { people: number; a: Parts; b: Parts };
    changed: { people: number; a: Parts; b: Parts };
  };
  byHour?: {
    hour: number;
    groups: number[];
    lost: number;
    gained: number;
    nearby: number;
    gaveUp: number;
  }[];
  byLength?: { length: number; people: number; groups: number[]; meanLaterMinutes: number }[];
}

export interface JourneyTimes {
  steps: number[];
  people: number;
  meanMinutes: number;
}

export interface LineRow {
  id: number;
  shortName: string | null;
  longName: string | null;
  modeId: string;
  color: string | null;
  isNew: boolean;
  a: number;
  b: number;
  aTrips: number;
  bTrips: number;
  aPeak: number | null;
  bPeak: number | null;
  aFull: number;
  bFull: number;
  aLeftBehind: number;
  bLeftBehind: number;
  parts: number;
}

export interface Shift {
  /** Everyone who rides the line in the first of the two runs. */
  riders: number;
  /** Those of them who do not ride it in the second. */
  people: number;
  lines: {
    id: number;
    shortName: string | null;
    longName: string | null;
    color: string | null;
    people: number;
  }[];
  notTravelling: number;
}

export interface LineDetail {
  line: number;
  hourly: { isA: boolean; hour: number; boardings: number }[];
  stops: {
    id: number;
    name: string;
    aOn: number;
    aOff: number;
    bOn: number;
    bOff: number;
    at: number;
  }[];
  went: Shift | null;
  cameFrom: Shift | null;
}

export interface Flows {
  run: number;
  vs: number | null;
  capacity?: Capacities;
  /** id, lon, lat, name */
  stops: [number, number, number, string][];
  /** from, to, passengers in this run, in the other, places offered in this run, mode */
  links: [number, number, number, number, number, string | null][];
}

export interface Places {
  run: number;
  vs: number;
  end: 'origin' | 'destination';
  cell: { metres: number; dLon: number; dLat: number } | null;
  /** lon, lat, name, people compared, mean minutes later, 5+ min later, 5+ min sooner, can no longer travel, now can */
  places: [number, number, string | null, number, number, number, number, number, number][];
}

/** What the chosen people do, for the map: the same shape as Flows, with where they start and end. */
export interface Trace extends Flows {
  journeys: number;
  people: number;
  /** lon, lat, name, people */
  origins: [number, number, string, number][];
  destinations: [number, number, string, number][];
}

export interface Patterns {
  run: number;
  vs: number | null;
  /** Passengers boarding, by mode. */
  byMode: { modeId: string; a: number; b: number }[];
  /** People by the number of vehicles they board, none to four or more. Null when a run is archived. */
  vehicles: { a: number[]; b: number[] | null } | null;
  /** People who use another stop than in the run compared with. */
  stopChange: {
    compared: number;
    origin: number;
    destination: number;
    moves: {
      end: 'origin' | 'destination';
      from: string;
      to: string;
      fromId: number;
      toId: number;
      people: number;
    }[];
  } | null;
  /** Stations and stops by passengers on and off, and changing there. */
  stations: {
    id: number;
    name: string;
    aOn: number;
    aOff: number;
    aChanges: number;
    bOn: number;
    bOff: number;
    bChanges: number;
  }[];
}

export interface PersonRow {
  journeyId: string;
  user: string;
  people: number;
  start: number;
  /** In this run and the other: 'ok', 'noJourney', 'gaveUp' or 'stranded'; null where the run has no such journey. */
  aStatus: string | null;
  bStatus: string | null;
  aArrive: number | null;
  bArrive: number | null;
  aJourney: number | null;
  bJourney: number | null;
  /** Seconds later than in the other run; null when they do not travel in both. */
  later: number | null;
  aVehicles: number | null;
  bVehicles: number | null;
}

export interface PeopleList {
  run: number;
  vs: number | null;
  journeys: number;
  people: number;
  rows: PersonRow[];
}

/** How full each vehicle is through the day, as the steps of FULL_STEPS with 0 for empty. */
export interface VehicleLoads {
  run: number;
  /** For each trip that carries anyone: its id, places, the most aboard, then pairs of time and step from that time. */
  trips: number[][];
}

// ---- colours ------------------------------------------------------------------
// Two poles with grey between: blue for sooner or more, red for later or fewer. Light to dark is
// small to large. The same steps are used in the charts and on the map.
export const BLUES = ['#a9c9f3', '#6fa5ea', '#3c82de', '#1c5fc0'];
export const REDS = ['#f3b3aa', '#e98477', '#d9564a', '#b5352b'];
export const MIDDLE = '#7d8794';

/** The nine groups of change in arrival time, soonest first. */
export const GROUP_LABELS = [
  '30 min or more sooner',
  '15 to 30 min sooner',
  '5 to 15 min sooner',
  '1 to 5 min sooner',
  'The same, within a minute',
  '1 to 5 min later',
  '5 to 15 min later',
  '15 to 30 min later',
  '30 min or more later',
];
export const GROUP_COLORS = [
  BLUES[3],
  BLUES[2],
  BLUES[1],
  BLUES[0],
  MIDDLE,
  REDS[0],
  REDS[1],
  REDS[2],
  REDS[3],
];
export const SAME_GROUP = 4;

/** A colour for a value between -1 and 1: red below nothing, blue above, grey near it. */
export function divergingColor(share: number, nothing = 0.05): string {
  const size = Math.abs(share);
  if (size < nothing) return MIDDLE;
  const step = size < 0.15 ? 0 : size < 0.35 ? 1 : size < 0.7 ? 2 : 3;
  return (share > 0 ? BLUES : REDS)[step];
}

/** A colour for minutes later (red) or sooner (blue). */
export function minutesColor(minutesLater: number): string {
  const size = Math.abs(minutesLater);
  if (size < 1) return MIDDLE;
  const step = size < 5 ? 0 : size < 15 ? 1 : size < 30 ? 2 : 3;
  return (minutesLater > 0 ? REDS : BLUES)[step];
}

/** How full: the share of places taken, in four steps. */
export const FULL_STEPS = [
  { upTo: 0.5, color: '#6fa5ea', label: 'under half' },
  { upTo: 0.8, color: '#e9c46a', label: '50 to 80%' },
  { upTo: 1, color: '#ec835a', label: '80 to 100%' },
  { upTo: Infinity, color: '#d03b3b', label: 'over 100%' },
];
export const fullColor = (share: number) => FULL_STEPS.find((s) => share < s.upTo)!.color;

export const lineName = (line: { shortName: string | null; longName: string | null }) =>
  line.shortName ?? line.longName ?? '?';
export const signed = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-AU')}`;
export const mins = (n: number) =>
  `${n.toLocaleString('en-AU', { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 })} min`;
