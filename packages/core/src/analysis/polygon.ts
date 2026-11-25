// A zone's outline: whether a point is inside it, and whether the outline itself is usable
// (FR-4, AC-FR-4.2).
import { ANALYSIS_LIMITS } from './limits.ts';
import { localFrame, type LonLat } from './local-metres.ts';

/**
 * An outline as corners in order, [lon, lat]. It should not repeat the first corner at the end,
 * but a caller may pass one: every function here drops it.
 */
export type Ring = readonly LonLat[];

/** Below this many square metres an outline counts as having no area (allows for rounding). */
const MIN_AREA_M2 = 1;

/** The ring without a repeated closing corner. */
export function openRing(ring: Ring): Ring {
  const n = ring.length;
  if (n < 2) return ring;
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[n - 1];
  return firstLon === lastLon && firstLat === lastLat ? ring.slice(0, n - 1) : ring;
}

/** Whether a point is inside the outline, by the even-odd rule (a ray cast to the east). */
export function pointInRing(point: LonLat, ring: Ring): boolean {
  const [x, y] = point;
  const corners = openRing(ring);
  let inside = false;
  for (let a = 0, b = corners.length - 1; a < corners.length; b = a++) {
    const [xa, ya] = corners[a];
    const [xb, yb] = corners[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/** Which side of the line p-q the point r is on: positive, negative or 0 when in line. */
function turn(p: LonLat, q: LonLat, r: LonLat): number {
  return Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
}

/** Whether r, already in line with p-q, lies within the box p-q spans. */
function onSegment(p: LonLat, q: LonLat, r: LonLat): boolean {
  return (
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1])
  );
}

/** Whether sides p1-q1 and p2-q2 meet anywhere: crossing, touching or overlapping. */
function sidesMeet(p1: LonLat, q1: LonLat, p2: LonLat, q2: LonLat): boolean {
  const d1 = turn(p1, q1, p2);
  const d2 = turn(p1, q1, q2);
  const d3 = turn(p2, q2, p1);
  const d4 = turn(p2, q2, q1);
  if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
  return (
    (d1 === 0 && onSegment(p1, q1, p2)) ||
    (d2 === 0 && onSegment(p1, q1, q2)) ||
    (d3 === 0 && onSegment(p2, q2, p1)) ||
    (d4 === 0 && onSegment(p2, q2, q1))
  );
}

/** Whether any two sides that are not neighbours meet. O(n²), which is fine at 200 corners. */
function crossesItself(corners: Ring): boolean {
  const n = corners.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 2; b < n; b++) {
      if (a === 0 && b === n - 1) continue; // the last side is the first side's neighbour
      if (sidesMeet(corners[a], corners[(a + 1) % n], corners[b], corners[(b + 1) % n]))
        return true;
    }
  }
  return false;
}

/** The outline's area in square metres (shoelace formula in local metres). */
function areaM2(corners: Ring): number {
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const frame = localFrame(
    (Math.min(...lons) + Math.max(...lons)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  );
  const xy = corners.map((c) => frame.toMetres(c));
  let twice = 0;
  for (let a = 0, b = xy.length - 1; a < xy.length; b = a++) {
    twice += xy[b][0] * xy[a][1] - xy[a][0] * xy[b][1];
  }
  return Math.abs(twice) / 2;
}

/** Why an outline cannot be used as a zone, in plain English, or null when it is fine. */
export function ringProblem(ring: Ring): string | null {
  const corners = openRing(ring);
  const { minCorners, maxCorners } = ANALYSIS_LIMITS;
  if (corners.length < minCorners) {
    return `An outline needs at least ${minCorners} corners; this one has ${corners.length}.`;
  }
  if (corners.length > maxCorners) {
    return `An outline can have at most ${maxCorners} corners; this one has ${corners.length}.`;
  }
  if (crossesItself(corners)) {
    return 'The outline crosses itself. Draw it again so that no side crosses another.';
  }
  if (areaM2(corners) < MIN_AREA_M2) {
    return 'The outline has no area. Draw it again with its corners spread out.';
  }
  return null;
}
