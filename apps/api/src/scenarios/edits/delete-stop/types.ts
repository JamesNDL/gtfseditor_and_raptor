// The shapes deleting a stop works with: its request body, the helpers it is handed, and the plan
// it works out before changing anything.
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Scenario } from '../../engine.ts';

export interface DeleteStopDeps {
  cloneTrips: (
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
    delta: number,
    options: {
      pinnedIds?: number[];
      replace: boolean;
      keepVehicle: boolean;
      stopTimes?: boolean;
      tag?: string;
    },
  ) => Promise<Record<number, number>>;
  removeTrips: (tx: Sql, sc: Scenario, seq: number, tripIds: number[]) => Promise<void>;
  skipPenalty: Record<string, number>;
  /** How many clashes the scenario has, as seen from inside the edit. */
  clashes: (tx: Sql, sc: Scenario) => Promise<number>;
}

export interface DeleteStopBody {
  /** A station (all of it goes), a stop, or one or more platforms of one station. */
  stopIds?: number[];
  stopId?: number;
}

export interface PlannedTrip {
  id: number;
  routeId: number;
  patternId: number | null;
  vehicleDayId: number | null;
  blockId: string | null;
  /** Left with fewer than two stops. */
  removed: boolean;
  cutStart: boolean;
  cutEnd: boolean;
  skipped: number;
  savingSecs: number;
  estimated: boolean;
  /** How much shorter the whole trip is, start to end. */
  shorterSecs: number;
  /** Calls moved to another platform. */
  moves: { seq: number; stopId: number; free: boolean; usual: boolean }[];
  /** Stop time rows that go. */
  dropSeqs: number[];
  /** Rows whose time or platform changes. */
  changes: { seq: number; arr: number; dep: number; stopId: number }[];
  /** The stops it calls at afterwards, in order. */
  stopIds: number[];
}

export interface LineEffect {
  routeId: number;
  name: string;
  color: string;
  /** Trips that no longer call there in the middle of their run. */
  noLongerCall: number;
  cutShort: number;
  removed: number;
  /** Calls moved to another platform. */
  moved: number;
  /** Typical time saved by a trip that no longer calls, in seconds. */
  savingSecs: number;
  estimated: boolean;
  /** Typical time a cut-short trip is shorter by, in seconds. */
  shorterSecs: number;
  /** Trips the line has left in the scenario afterwards. */
  tripsLeft: number;
  /** The line's nearest remaining stop to the deleted one. */
  nearest: { name: string; metres: number } | null;
}

export interface DeleteStopPlan {
  baselineId: number;
  what: 'station' | 'stop' | 'platform';
  /** Trains, trams or ferries call at the station. */
  rail: boolean;
  /** "Hamilton Station", or "platform 2 at Hamilton Station". */
  label: string;
  stationId: number;
  /** Every stop row that goes: the station itself, its platforms and its entrances. */
  removedStopIds: number[];
  /** Platforms and stops among them, by name, for the preview. */
  platforms: string[];
  /** What to call them together: 'platforms', 'stops', or 'platforms and stops' at an interchange. */
  placeWord: string;
  trips: PlannedTrip[];
  lines: LineEffect[];
  /** Where moved calls go: platform label to how many. */
  movedTo: { label: string; calls: number }[];
  totals: {
    trips: number;
    noLongerCall: number;
    cutShort: number;
    removed: number;
    moved: number;
    movedBusy: number;
    movedUnusual: number;
  };
  vehicles: { noTripsLeft: number; turnShort: number };
  /** Trips whose stay-aboard group changes, and the group each ends in: null for none, a number for a new group. */
  blocks: Map<number, { block: string; part: number | null }>;
  linksEnded: number;
  warnings: string[];
  summary: string;
}
