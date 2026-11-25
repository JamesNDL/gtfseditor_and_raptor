// A ride drawn along its vehicle's path (D39; docs/architecture/access-analysis.md §12). A stored
// ride names its trip and the stops it boards and alights at; the picked sample point finds the two
// calls on the trip and cuts the trip's shape between them. Each call is placed on the shape by
// the feed's distances when they can be used, otherwise by snapping every call from the trip's
// first in order, so a loop that passes the same place twice is cut on the right pass. A trip with
// no shape, or a shape far from its stops, is drawn stop to stop through every stop in between.
import { localFrame, type LonLat } from './local-metres.ts';

/** One call of a trip, in order: the stop's GTFS id and place, its times and distance along. */
export interface TripCall {
  stop: string;
  lon: number;
  lat: number;
  arr: number;
  dep: number;
  /** The feed's distance along the shape (`shape_dist_traveled`), or null. */
  dist: number | null;
}

/** A trip's shape: its points, and the feed's distance at each point when known. */
export interface TripShape {
  coords: LonLat[];
  dists: number[] | null;
}

/** One end of a stored ride: the stop's id when it was kept, its place, and the time. */
export interface RideEnd {
  stop?: string;
  lon: number;
  lat: number;
  time: number;
}

/** Where the path came from: the shape, or the stops in order. */
export type TripPathFrom = 'shape' | 'stops';

/** A stop matched by place, with no id, is at most this far from the stored one. */
const SAME_PLACE_M = 10;
/** A stop further than this from the shape means the shape is not this trip's way. */
const OFF_LINE_M = 150;

/** A place on the shape: segment `seg` (from point seg to seg + 1), `t` of the way along it. */
interface OnShape {
  seg: number;
  t: number;
  point: LonLat;
  offM: number;
}

/**
 * The calls a stored ride boards and alights at: the first call at the boarding stop that leaves
 * at the boarding time, then the first later call at the alighting stop that arrives at the
 * alighting time. A stop is matched by id when the ride kept it, otherwise by place.
 */
export function rideCalls(
  calls: readonly TripCall[],
  board: RideEnd,
  alight: RideEnd,
): { board: number; alight: number } | null {
  const frame = localFrame(board.lon, board.lat);
  const isAt = (c: TripCall, end: RideEnd): boolean => {
    if (end.stop !== undefined) return c.stop === end.stop;
    const [ax, ay] = frame.toMetres([c.lon, c.lat]);
    const [bx, by] = frame.toMetres([end.lon, end.lat]);
    return Math.hypot(ax - bx, ay - by) <= SAME_PLACE_M;
  };
  const b = calls.findIndex((c) => c.dep === board.time && isAt(c, board));
  if (b < 0) return null;
  const a = calls.findIndex((c, k) => k > b && c.arr === alight.time && isAt(c, alight));
  return a < 0 ? null : { board: b, alight: a };
}

/** Places calls 0..last on the shape by the feed's distances, or null when they cannot be used. */
function byDistances(shape: TripShape, calls: readonly TripCall[], last: number): OnShape[] | null {
  const { coords, dists } = shape;
  if (!dists || dists.length !== coords.length) return null;
  if (dists.some((d, k) => k > 0 && d < dists[k - 1])) return null;
  const placed: OnShape[] = [];
  for (const c of calls.slice(0, last + 1)) {
    if (c.dist === null) return null;
    let seg = 0;
    while (seg < coords.length - 2 && dists[seg + 1] < c.dist) seg++;
    const span = dists[seg + 1] - dists[seg];
    const t = span > 0 ? Math.max(0, Math.min(1, (c.dist - dists[seg]) / span)) : 0;
    placed.push(onSegment(shape.coords, seg, t, c));
  }
  return placed;
}

/** The place `t` of the way along segment `seg`, and how far the call is from it. */
function onSegment(coords: readonly LonLat[], seg: number, t: number, c: TripCall): OnShape {
  const [a, b] = [coords[seg], coords[seg + 1]];
  const point: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const frame = localFrame(c.lon, c.lat);
  const [x, y] = frame.toMetres(point);
  return { seg, t, point, offM: Math.hypot(x, y) };
}

/**
 * Places calls 0..last on the shape in order: each call on a segment at or after the one before,
 * the set of segments chosen to be as near the calls as it can be in all (least squared distance,
 * by dynamic programming). A loop's way back is then used for the stops on the way back.
 */
function bySnapping(
  coords: readonly LonLat[],
  calls: readonly TripCall[],
  last: number,
): OnShape[] {
  const frame = localFrame(coords[0][0], coords[0][1]);
  const xy = coords.map((p) => frame.toMetres(p));
  const segs = coords.length - 1;
  /** The nearest place on each segment to a call: its fraction and squared distance. */
  const nearest = (c: TripCall): { t: number; d2: number }[] => {
    const [px, py] = frame.toMetres([c.lon, c.lat]);
    return Array.from({ length: segs }, (_, k) => {
      const [[ax, ay], [bx, by]] = [xy[k], xy[k + 1]];
      const [dx, dy] = [bx - ax, by - ay];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      return { t, d2: (ax + dx * t - px) ** 2 + (ay + dy * t - py) ** 2 };
    });
  };
  const near = calls.slice(0, last + 1).map(nearest);
  // cost[n][k]: the least total for calls 0..n with call n on segment k; from[n][k]: where call
  // n - 1 went then (the best segment at or before k).
  let cost = near[0].map((p) => p.d2);
  const from: number[][] = [];
  for (let n = 1; n < near.length; n++) {
    const back: number[] = [];
    const prev = cost;
    let best = 0;
    cost = near[n].map((p, k) => {
      if (prev[k] < prev[best]) best = k;
      back.push(best);
      return prev[best] + p.d2;
    });
    from.push(back);
  }
  let seg = cost.indexOf(Math.min(...cost));
  const segOf: number[] = [seg];
  for (let n = near.length - 1; n > 0; n--) {
    seg = from[n - 1][seg];
    segOf.unshift(seg);
  }
  return segOf.map((k, n) => onSegment(coords, k, near[n][k].t, calls[n]));
}

/** Whether place `a` comes before place `b` along the shape. */
const before = (a: OnShape, b: OnShape): boolean => a.seg < b.seg || (a.seg === b.seg && a.t < b.t);

/** The calls from `board` to `alight` joined in order. */
const stopToStop = (calls: readonly TripCall[], board: number, alight: number): LonLat[] =>
  calls.slice(board, alight + 1).map((c): LonLat => [c.lon, c.lat]);

/**
 * The path of a ride on a trip from call `board` to call `alight`: the part of the shape between
 * the two stops' places on it, or the stops in order when there is no usable shape.
 */
export function ridePath(
  shape: TripShape | null,
  calls: readonly TripCall[],
  board: number,
  alight: number,
): { path: LonLat[]; from: TripPathFrom } {
  const stops = { path: stopToStop(calls, board, alight), from: 'stops' as const };
  if (!shape || shape.coords.length < 2) return stops;
  const fits = (placed: OnShape[] | null): placed is OnShape[] =>
    placed !== null &&
    placed[board].offM <= OFF_LINE_M &&
    placed[alight].offM <= OFF_LINE_M &&
    before(placed[board], placed[alight]);
  let placed = byDistances(shape, calls, alight);
  if (!fits(placed)) placed = bySnapping(shape.coords, calls, alight);
  if (!fits(placed)) return stops;
  const [start, end] = [placed[board], placed[alight]];
  const path: LonLat[] = [start.point];
  for (let k = start.seg + 1; k <= end.seg; k++) path.push(shape.coords[k]);
  path.push(end.point);
  const same = (p: LonLat, q: LonLat): boolean => p[0] === q[0] && p[1] === q[1];
  return { path: path.filter((p, k) => k === 0 || !same(p, path[k - 1])), from: 'shape' };
}

/**
 * One stored ride's path (D39): along its trip when the trip was found and calls at the ride's
 * two stops at its times, otherwise the straight line from boarding to alighting.
 */
export function legPath(
  leg: { board: RideEnd; alight: RideEnd },
  trip: { shape: TripShape | null; calls: readonly TripCall[] } | null,
): { path: LonLat[]; from: TripPathFrom | 'straight' } {
  const found = trip ? rideCalls(trip.calls, leg.board, leg.alight) : null;
  if (!trip || !found) {
    return {
      path: [
        [leg.board.lon, leg.board.lat],
        [leg.alight.lon, leg.alight.lat],
      ],
      from: 'straight',
    };
  }
  return ridePath(trip.shape, trip.calls, found.board, found.alight);
}
