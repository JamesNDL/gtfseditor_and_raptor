// Lines and bands of equal access ratio over the sample grid, by marching triangles (FR-12, FR-14,
// D27). Each grid square whose four corners all have a value is cut into two triangles along the
// same diagonal every time; within a triangle the value is taken to change in a straight line, so
// each band piece is a convex polygon and each line crossing is one straight segment. A square with
// a missing corner (no point, no service, no road) gives nothing, so missing points never shape
// the lines. No library: d3-contour treats a missing value as below every break (D27).
import { chainSegments, type Segment } from './contour-lines.ts';
import type { LocalFrame, LonLat, Metres } from './local-metres.ts';

/** The sample grid as the contours need it: point (i, j) is at origin + (i, j) × spacing metres. */
export interface ContourGrid {
  columns: number;
  rows: number;
  /** The zone's local frame, for turning metres back into lon, lat. */
  frame: LocalFrame;
  /** Point (0, 0), in metres in `frame`. */
  origin: Metres;
  spacingM: number;
}

/** One value per grid point, indexed j × columns + i; NaN (or any non-finite value) is missing. */
export type GridValues = Float64Array | readonly number[];

/** The area with values from `from` up to but not including `to`, as convex pieces. */
export interface RatioBandPieces {
  /** -Infinity for the band below the first break. */
  from: number;
  /** Infinity for the band from the last break up. */
  to: number;
  /** Each piece is one closed, anticlockwise ring of [lon, lat]. */
  polygons: LonLat[][];
}

/** The line where the value equals `ratio`, as one or more lines of [lon, lat]. */
export interface RatioLine {
  ratio: number;
  lines: LonLat[][];
}

/** A triangle corner: its position in metres and its value. */
interface Corner {
  x: number;
  y: number;
  v: number;
}

type Triangle = readonly [Corner, Corner, Corner];

/** Below this many metres two points are the same point. */
const SAME_POINT_M = 1e-6;

/** Throws when the values do not fit the grid or the breaks are not finite and rising. */
function check(grid: ContourGrid, values: GridValues, breaks: readonly number[]): void {
  if (values.length !== grid.columns * grid.rows) {
    throw new RangeError(
      `There are ${values.length} values for a grid of ${grid.columns * grid.rows} points.`,
    );
  }
  breaks.forEach((b, k) => {
    if (!Number.isFinite(b) || (k > 0 && !(b > breaks[k - 1]))) {
      throw new RangeError(`The breaks must be numbers in rising order, not ${breaks.join(', ')}.`);
    }
  });
}

/** Calls `visit` with the two triangles of every grid square whose four corners have a value. */
function eachTriangle(grid: ContourGrid, values: GridValues, visit: (t: Triangle) => void): void {
  const { columns, rows, origin, spacingM } = grid;
  const corner = (i: number, j: number): Corner => ({
    x: origin[0] + i * spacingM,
    y: origin[1] + j * spacingM,
    v: values[j * columns + i],
  });
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < columns; i++) {
      const a = corner(i, j);
      const b = corner(i + 1, j);
      const c = corner(i + 1, j + 1);
      const d = corner(i, j + 1);
      if (![a, b, c, d].every((p) => Number.isFinite(p.v))) continue;
      // Always the south-west to north-east diagonal; both triangles run anticlockwise.
      visit([a, b, c]);
      visit([a, c, d]);
    }
  }
}

/** The point on p to q where the value is `level`, by straight-line interpolation. */
function pointAt(p: Corner, q: Corner, level: number): Corner {
  const t = (level - p.v) / (q.v - p.v);
  return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y), v: level };
}

/** Keeps the part of a convex polygon where `inside` holds (one Sutherland-Hodgman pass). */
function clip(polygon: readonly Corner[], level: number, keepAbove: boolean): Corner[] {
  const inside = (p: Corner): boolean => (keepAbove ? p.v >= level : p.v <= level);
  const kept: Corner[] = [];
  polygon.forEach((p, k) => {
    const q = polygon[(k + 1) % polygon.length];
    if (inside(p)) kept.push(p);
    if (inside(p) !== inside(q)) kept.push(pointAt(p, q, level));
  });
  return kept;
}

/** Rounds to 6 decimals (about 0.1 m), turning -0 into 0. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6 + 0;
}

/** The points as rounded [lon, lat], dropping any that round onto the point before. */
function toLonLat(frame: LocalFrame, points: readonly Metres[]): LonLat[] {
  const out: LonLat[] = [];
  for (const point of points) {
    const [lon, lat] = frame.toLonLat(point);
    const next: LonLat = [round6(lon), round6(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== next[0] || last[1] !== next[1]) out.push(next);
  }
  return out;
}

/**
 * The bands between the breaks: below the first, between each pair, and from the last up. A value
 * exactly on a break belongs to the band that starts there, so a square lying flat on a break is
 * counted once.
 */
export function ratioBands(
  grid: ContourGrid,
  values: GridValues,
  breaks: readonly number[],
): RatioBandPieces[] {
  check(grid, values, breaks);
  const bands: RatioBandPieces[] = [-Infinity, ...breaks].map((from, k) => ({
    from,
    to: k < breaks.length ? breaks[k] : Infinity,
    polygons: [],
  }));
  eachTriangle(grid, values, (triangle) => {
    for (const band of bands) {
      let piece: Corner[] = [...triangle];
      if (band.from > -Infinity) piece = clip(piece, band.from, true);
      if (band.to < Infinity) piece = clip(piece, band.to, false);
      if (piece.length < 3 || piece.every((p) => p.v >= band.to)) continue;
      const ring = toLonLat(
        grid.frame,
        piece.map((p): Metres => [p.x, p.y]),
      );
      // A cut through a corner can repeat the first point at the end; the ring is closed below.
      const [first, last] = [ring[0], ring[ring.length - 1]];
      if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
      if (ring.length < 3) continue;
      band.polygons.push([...ring, ring[0]]);
    }
  });
  return bands;
}

/** The segment where a triangle crosses `level`, with the higher values on its left, if any. */
function crossing(triangle: Triangle, level: number): Segment | null {
  const ends: Metres[] = [];
  triangle.forEach((p, k) => {
    const q = triangle[(k + 1) % 3];
    if (p.v >= level === q.v >= level) return;
    // Worked out from the lower end every time, so both triangles beside an edge agree.
    const [below, above] = p.v < q.v ? [p, q] : [q, p];
    const { x, y } = pointAt(below, above, level);
    ends.push([x, y]);
  });
  if (ends.length !== 2) return null;
  const [s, e] = ends;
  if (Math.hypot(e[0] - s[0], e[1] - s[1]) < SAME_POINT_M) return null;
  // The way the value rises across the triangle, from its plane through the three corners.
  const [a, b, c] = triangle;
  const [e1x, e1y, dv1] = [b.x - a.x, b.y - a.y, b.v - a.v];
  const [e2x, e2y, dv2] = [c.x - a.x, c.y - a.y, c.v - a.v];
  const gx = dv1 * e2y - dv2 * e1y;
  const gy = e1x * dv2 - e2x * dv1;
  // Both grid triangles run anticlockwise, so their determinant is positive and can be left out.
  const risesToLeft = (e[0] - s[0]) * gy - (e[1] - s[1]) * gx > 0;
  return risesToLeft ? [s, e] : [e, s];
}

/** One entry per break: the line where the value equals it, joined into continuous lines. */
export function ratioLines(
  grid: ContourGrid,
  values: GridValues,
  breaks: readonly number[],
): RatioLine[] {
  check(grid, values, breaks);
  const segments: Segment[][] = breaks.map(() => []);
  eachTriangle(grid, values, (triangle) => {
    breaks.forEach((level, k) => {
      const segment = crossing(triangle, level);
      if (segment) segments[k].push(segment);
    });
  });
  return breaks.map((ratio, k) => ({
    ratio,
    lines: chainSegments(segments[k])
      .map((line) => toLonLat(grid.frame, line))
      .filter((line) => line.length >= 2),
  }));
}
