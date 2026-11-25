// The shapes reshaping a line works with: the helpers it is handed, its options, and the plan it
// works out before changing anything.
import type { Coord, ReshapeSection } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Avoid, PathMethod } from '../../../routing/roads.ts';
import type { SectionTime } from '../../../routing/timings.ts';
import type { Scenario } from '../../engine.ts';

export interface ReshapeDeps {
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
  /** Per mode: fallback speed (m/s) and time spent at a stop. */
  newLine: Record<string, { speed: number; dwell: number }>;
  /** Per rule set: seconds saved by not stopping, on top of the stop time itself. */
  skipPenalty: Record<string, number>;
}

export interface ReshapeOptions {
  /** New stretches follow roads (or, for trains, trams and ferries, the published network) rather than running straight between stops. */
  followRoads: boolean;
  /** Where stops are removed, take a new direct path between their neighbours instead of driving past. */
  direct: boolean;
  /** Which platform to use at a station that has no obvious one: 0 one way, 1 the other. */
  platformIndex: number;
  /** A closed area: any stretch of the published path that enters it is replaced by a way round. */
  avoid?: Avoid;
  /**
   * With `avoid`: the stops either side of a gap are joined by a new stretch with its own run time,
   * not by a detour timed from the stretch it replaces. For a line that went through a closure and
   * came back, and now turns round before it.
   */
  joinAcross?: boolean;
}

export interface StopRow {
  id: number;
  name: string;
  lon: number;
  lat: number;
  locationType: number;
  parentId: number | null;
}

export interface ReshapePlan {
  patternId: number;
  routeId: number;
  routeName: string;
  modeId: string;
  ruleSet: string;
  direction: number | null;
  headsign: string | null;
  baselineId: number;
  oldStops: StopRow[];
  stops: StopRow[];
  /** For each new stop, its position in the old list, or -1 if it is new. */
  keptAt: number[];
  coords: Coord[];
  lineDist: number[];
  stopDist: number[];
  sections: ReshapeSection[];
  added: number;
  removed: number;
  /** New stretches timed from published trips, and those estimated from the typical speed. */
  learned: number;
  estimated: number;
  /** The run time of each new stretch, by part of the day, and where it came from. */
  timed: SectionTime[];
  /** How the new stretches' paths were found; null when there are none. */
  pathMethod: PathMethod | null;
  dwellSecs: number;
  skipPenaltySecs: number;
  /** Stretches sent a different way to stay out of a closed area. */
  rerouted: number;
  /** True when a stretch had to stay out of a closed area and no way round was found. */
  blocked: boolean;
  /** The trips that use the pattern, in departure order. */
  tripIds: number[];
}
