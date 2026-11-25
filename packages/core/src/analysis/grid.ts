// The sample grid (FR-7, D26): a square grid in local metres over the zone's bounding box, from
// its south-west corner, one point at the centre of each cell, kept if inside the zone. Each point
// keeps its column (i) and row (j), so two analyses of the same zone line up point for point.
import { localFrame, type LonLat } from './local-metres.ts';
import { openRing, pointInRing, type Ring } from './polygon.ts';

/** One sample point: its grid column (i, west to east) and row (j, south to north). */
export interface SamplePoint {
  i: number;
  j: number;
  lon: number;
  lat: number;
}

/** The sample points inside a zone, in row then column order, and the size of the whole grid. */
export interface SampleGrid {
  points: SamplePoint[];
  columns: number;
  rows: number;
}

/** Allows for rounding when a cell centre lands exactly on the box's far edge. */
const EDGE_SLACK_M = 1e-6;

/** How many cell centres fit along a side `lengthM` long. */
function cellsAlong(lengthM: number, spacingM: number): number {
  return Math.max(0, Math.floor((lengthM - spacingM / 2 + EDGE_SLACK_M) / spacingM) + 1);
}

/** Calls `visit` for every cell centre inside the zone, row by row (j), then column by column (i). */
function eachPointInside(
  ring: Ring,
  spacingM: number,
  visit: (i: number, j: number, point: LonLat) => void,
): { columns: number; rows: number } {
  if (!(spacingM > 0) || !Number.isFinite(spacingM)) {
    throw new RangeError(`The spacing must be a positive number of metres, not ${spacingM}.`);
  }
  const corners = openRing(ring);
  if (corners.length === 0) return { columns: 0, rows: 0 };
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const frame = localFrame((west + east) / 2, (south + north) / 2);
  const [x0, y0] = frame.toMetres([west, south]);
  const [x1, y1] = frame.toMetres([east, north]);
  const columns = cellsAlong(x1 - x0, spacingM);
  const rows = cellsAlong(y1 - y0, spacingM);
  for (let j = 0; j < rows; j++) {
    const y = y0 + spacingM / 2 + j * spacingM;
    for (let i = 0; i < columns; i++) {
      const point = frame.toLonLat([x0 + spacingM / 2 + i * spacingM, y]);
      if (pointInRing(point, corners)) visit(i, j, point);
    }
  }
  return { columns, rows };
}

/** Lays the sample points over a zone at the given spacing in metres (D26). */
export function sampleGrid(ring: Ring, spacingM: number): SampleGrid {
  const points: SamplePoint[] = [];
  const { columns, rows } = eachPointInside(ring, spacingM, (i, j, [lon, lat]) => {
    points.push({ i, j, lon, lat });
  });
  return { points, columns, rows };
}

/** How many sample points `sampleGrid` would lay, without keeping them (for the setup screen). */
export function gridCount(ring: Ring, spacingM: number): number {
  let count = 0;
  eachPointInside(ring, spacingM, () => {
    count++;
  });
  return count;
}
