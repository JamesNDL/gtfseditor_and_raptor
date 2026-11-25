// The closure edit's types: what it is sent, what it is handed, and the plan it works out.
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { ReshapeDeps, ReshapePlan } from '../reshape.ts';
import type { Avoid } from '../../../routing/roads.ts';
import type { Scenario } from '../../engine.ts';

export interface ClosureDeps extends ReshapeDeps {
  assignVehicles: (
    tx: Sql,
    sc: Scenario,
    seq: number,
    tripIds: number[],
    forceNew?: boolean,
    extra?: {
      groupOf?: Map<number, string>;
      crosses?: (ax: number, ay: number, bx: number, by: number) => boolean;
      alsoDays?: number[];
    },
  ) => Promise<{ reused: number; added: number }>;
  removeTrips: (tx: Sql, sc: Scenario, seq: number, tripIds: number[]) => Promise<void>;
  fleetFigures: (
    tx: Sql,
    sc: Scenario,
    routeIds: number[],
  ) => Promise<{ chains: number; peak: number }>;
  dayFigures: (
    tx: Sql,
    baselineId: number,
    sc: Scenario | null,
  ) => Promise<{ vehicles: number; peak: number }>;
}

export interface CloseBody {
  /** 'cut' for a line drawn on the map; or 'road', or the mode whose line is closed: train, metro, light_rail or ferry. */
  what: string;
  baselineId?: number;
  /** Cut: the points of the drawn line, how far either side of it is closed, and the modes to leave running. */
  line?: [number, number][];
  widthM?: number;
  exceptModes?: string[];
  /** Cut: what happens to buses and coaches: each line is split at the closure (the default), or sent round it. */
  roads?: 'split' | 'detour';
  /** Cut: which parts of a split line are kept: 'both', one side of the closure ('N', 'S', 'E' or 'W'), or 'none'. */
  keep?: string;
  /** Cut: a different choice for single lines, by route id. 'leave' leaves the line running through. */
  lines?: Record<string, { how?: 'split' | 'detour' | 'leave'; keep?: string }>;
  /** Road: the middle of the closed stretch and how far it reaches. */
  lon?: number;
  lat?: number;
  radiusM?: number;
  /** Line: the two stations the closure lies between. */
  fromStopId?: number;
  toStopId?: number;
  /**
   * Part of the day: the closure starts and ends at these times, in seconds since the start of the
   * service day (so an end after midnight is more than 24 hours). Left out, it lasts all day.
   */
  fromSecs?: number;
  toSecs?: number;
}

// joined: a line that crossed the closure and came back now turns round before it, as one trip.
// left: the line was chosen to be left running through.
export type Action =
  'detour' | 'shortened' | 'split' | 'joined' | 'removed' | 'blocked' | 'failed' | 'left';

/** One part of a line that a closure splits. */
interface Piece {
  /** The side of the closure it is on: 'N', 'S', 'E' or 'W'; empty for a closure that has no sides. */
  side: string;
  stopIds: number[];
  /** The stop where its vehicles now turn back. */
  turnsAt: { name: string; lon: number; lat: number };
  kept: boolean;
  /** The stretches of the published path it keeps, as fractions of its length: for the map. */
  ranges: [number, number][];
}

export interface Item {
  patternId: number;
  routeId: number;
  name: string;
  color: string;
  modeId: string;
  /** A bus or coach line, which can be sent round by other roads. */
  road: boolean;
  /** What was chosen for the line, and which parts of it are kept. */
  how: 'split' | 'detour' | 'leave';
  keep: string;
  pieces: Piece[];
  trips: number;
  /** For a closure that lasts part of the day: the trips that would be in it then. The rest are left alone. */
  tripIds?: number[];
  closedStops: string[];
  action: Action;
  /** Why a pattern could not be changed. */
  reason?: string;
  /** One plan for a detour or a line cut short; two when trips are split either side of the closure. */
  plans: ReshapePlan[];
  /** The side of the closure each plan is for, where the closure has sides. */
  planSides: string[];
}

export interface ClosurePlan {
  what: string;
  label: string;
  zoneWkt: string;
  zone: unknown;
  /** The times it starts and ends, or null when it lasts all day. */
  window: { fromSecs: number; toSecs: number } | null;
  items: Item[];
  /** Stop patterns over the limit, left as they are. */
  skipped: number;
  /** Every mode with services through the closed area, whether or not it was left running. */
  modes: { id: string; name: string; lines: number }[];
  /** The two sides of a drawn closure, or null for one that has none. */
  sides: [string, string] | null;
  /** The closed area as the road router is given it, where the closure has one. */
  avoid?: Avoid;
}
