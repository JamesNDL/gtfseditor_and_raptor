// Lines and bands of equal access ratio from the sample grid by marching triangles (FR-12, FR-14,
// FR-18, NFR-4, D27). Missing values (NaN) are left out, so they never shape the lines.
import { describe, expect, it } from 'vitest';
import { ratioBands, ratioLines, type ContourGrid } from './contours.ts';
import { localFrame, type LonLat } from './local-metres.ts';

const frame = localFrame(151.0, -33.8);

/** A grid of `columns` by `rows` points, 250 m apart, the first at (-1000, -1000) local metres. */
function gridOf(columns: number, rows: number): ContourGrid {
  return { columns, rows, frame, origin: [-1000, -1000], spacingM: 250 };
}

/** The value at every point, from its column and row, indexed j * columns + i. */
function valuesOf(grid: ContourGrid, value: (i: number, j: number) => number): number[] {
  const values: number[] = [];
  for (let j = 0; j < grid.rows; j++)
    for (let i = 0; i < grid.columns; i++) values.push(value(i, j));
  return values;
}

/** The signed area of a ring in square metres (positive when anticlockwise). */
function areaM2(ring: readonly LonLat[]): number {
  const corners = ring.map((p) => frame.toMetres(p));
  let twice = 0;
  for (let a = 0; a < corners.length - 1; a++) {
    const [x0, y0] = corners[a];
    const [x1, y1] = corners[a + 1];
    twice += x0 * y1 - x1 * y0;
  }
  return twice / 2;
}

/** A ramp rising evenly west to east: 0.5 at the first column, up 0.625 a column (1 per 400 m). */
const ramp = (i: number): number => 0.5 + i * 0.625;

describe('ratioLines', () => {
  it('AC-1: a west-to-east ramp gives one straight north-south line at the break', () => {
    const grid = gridOf(9, 5);
    const [entry, ...rest] = ratioLines(grid, valuesOf(grid, ramp), [2]);
    expect(rest).toHaveLength(0);
    expect(entry.ratio).toBe(2);
    expect(entry.lines).toHaveLength(1);
    const metres = entry.lines[0].map((p) => frame.toMetres(p));
    // 2 is 1.5 above 0.5, so 600 m east of the first column.
    for (const [x] of metres) expect(Math.abs(x - -400)).toBeLessThan(1);
    const ys = metres.map(([, y]) => y);
    expect(Math.min(...ys)).toBeCloseTo(-1000, 0);
    expect(Math.max(...ys)).toBeCloseTo(0, 0);
  });

  it('AC-1: a break that lands exactly on a column of points still gives one straight line', () => {
    const grid = gridOf(9, 5);
    const [entry] = ratioLines(
      grid,
      valuesOf(grid, (i) => i),
      [2],
    );
    expect(entry.lines).toHaveLength(1);
    for (const p of entry.lines[0]) expect(Math.abs(frame.toMetres(p)[0] - -500)).toBeLessThan(1);
    expect(entry.lines[0].length).toBeGreaterThanOrEqual(2);
  });

  it('gives one entry per break, with no lines for a break outside the values', () => {
    const grid = gridOf(9, 5);
    const lines = ratioLines(grid, valuesOf(grid, ramp), [1, 2, 99]);
    expect(lines.map((l) => l.ratio)).toEqual([1, 2, 99]);
    expect(lines[0].lines).toHaveLength(1);
    expect(lines[2].lines).toHaveLength(0);
  });

  it('AC-3: a grid square with one missing corner gives no line segment', () => {
    const grid = gridOf(2, 2);
    const values = [1, 3, Number.NaN, 3];
    expect(ratioLines(grid, values, [2])).toEqual([{ ratio: 2, lines: [] }]);
  });

  it('AC-4: a ring-shaped value field gives one closed line per break', () => {
    const grid = gridOf(21, 21);
    const values = valuesOf(grid, (i, j) => Math.hypot(i - 10, j - 10));
    const result = ratioLines(grid, values, [3.3, 6.5]);
    for (const { ratio, lines } of result) {
      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line.length).toBeGreaterThan(8);
      expect(line[line.length - 1]).toEqual(line[0]);
      for (const p of line) {
        const [x, y] = frame.toMetres(p);
        const fromCentre = Math.hypot(x - 1500, y - 1500) / 250;
        expect(Math.abs(fromCentre - ratio)).toBeLessThan(0.2);
      }
    }
  });
});

describe('ratioBands', () => {
  it('AC-2: band pieces for breaks [1, 2] cover the grid squares exactly once', () => {
    const grid = gridOf(9, 5);
    const bands = ratioBands(grid, valuesOf(grid, ramp), [1, 2]);
    expect(bands.map((b) => [b.from, b.to])).toEqual([
      [-Infinity, 1],
      [1, 2],
      [2, Infinity],
    ]);
    const areas = bands.map((b) => b.polygons.reduce((sum, ring) => sum + areaM2(ring), 0));
    const total = 8 * 4 * 250 * 250;
    expect(Math.abs(areas[0] + areas[1] + areas[2] - total) / total).toBeLessThan(0.001);
    // Below 1 is the first 200 m, 1 to 2 the next 400 m, the rest is 2 and over; 1,000 m tall.
    const expected = [200_000, 400_000, 1_400_000];
    areas.forEach((area, k) =>
      expect(Math.abs(area - expected[k]) / expected[k]).toBeLessThan(0.001),
    );
  });

  it('gives closed, anticlockwise rings of at least three corners', () => {
    const grid = gridOf(9, 5);
    for (const band of ratioBands(grid, valuesOf(grid, ramp), [1, 2])) {
      for (const ring of band.polygons) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[ring.length - 1]).toEqual(ring[0]);
        expect(areaM2(ring)).toBeGreaterThan(0);
      }
    }
  });

  it('repeats no corner when breaks land exactly on grid points', () => {
    const grid = gridOf(9, 5);
    const bands = ratioBands(
      grid,
      valuesOf(grid, (i) => i),
      [1, 2],
    );
    const areas = bands.map((b) => b.polygons.reduce((sum, ring) => sum + areaM2(ring), 0));
    expect(areas.map((a) => Math.round(a / 1000) * 1000)).toEqual([250_000, 250_000, 1_500_000]);
    for (const ring of bands.flatMap((b) => b.polygons)) {
      const corners = ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`);
      expect(new Set(corners).size).toBe(corners.length);
      expect(corners.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('counts a square lying exactly on a break once, in the band that starts there', () => {
    const grid = gridOf(2, 2);
    const bands = ratioBands(grid, [2, 2, 2, 2], [1, 2, 3]);
    const counts = bands.map((b) => b.polygons.length);
    expect(counts[2]).toBeGreaterThan(0);
    expect(counts[0] + counts[1] + counts[3]).toBe(0);
    const area = bands[2].polygons.reduce((sum, ring) => sum + areaM2(ring), 0);
    // Within 0.5%: one lone square's corners carry the 6-decimal rounding (about 0.1 m).
    expect(Math.abs(area - 250 * 250) / (250 * 250)).toBeLessThan(0.005);
  });

  it('AC-3: a grid square with one missing corner gives no band piece', () => {
    const grid = gridOf(2, 2);
    const bands = ratioBands(grid, [1, 3, Number.NaN, 3], [2]);
    expect(bands.every((b) => b.polygons.length === 0)).toBe(true);
  });

  it('AC-3: a missing point leaves out the four squares round it, and nothing else', () => {
    const grid = gridOf(9, 5);
    const values = valuesOf(grid, (i, j) => (i === 4 && j === 2 ? Number.NaN : ramp(i)));
    const bands = ratioBands(grid, values, [1, 2]);
    const area = bands.flatMap((b) => b.polygons).reduce((sum, ring) => sum + areaM2(ring), 0);
    const expected = (8 * 4 - 4) * 250 * 250;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.001);
  });
});

describe('output', () => {
  it('AC-5: coordinates are lon, lat rounded to 6 decimals, and the same input gives the same output', () => {
    const grid = gridOf(21, 21);
    const values = valuesOf(grid, (i, j) => Math.hypot(i - 10.3, j - 9.7) / 3);
    const breaks = [1, 1.5, 2, 3];
    const first = {
      bands: ratioBands(grid, values, breaks),
      lines: ratioLines(grid, values, breaks),
    };
    const second = {
      bands: ratioBands(grid, values, breaks),
      lines: ratioLines(grid, values, breaks),
    };
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const coords = [
      ...first.bands.flatMap((b) => b.polygons.flat()),
      ...first.lines.flatMap((l) => l.lines.flat()),
    ];
    expect(coords.length).toBeGreaterThan(0);
    for (const [lon, lat] of coords) {
      expect(Math.round(lon * 1e6) / 1e6).toBe(lon);
      expect(Math.round(lat * 1e6) / 1e6).toBe(lat);
      expect(lon).toBeGreaterThan(150.9);
      expect(lon).toBeLessThan(151.1);
      expect(lat).toBeGreaterThan(-33.9);
      expect(lat).toBeLessThan(-33.7);
    }
  });

  it('takes a Float64Array as well as a number array', () => {
    const grid = gridOf(9, 5);
    const values = valuesOf(grid, ramp);
    expect(ratioLines(grid, Float64Array.from(values), [2])).toEqual(ratioLines(grid, values, [2]));
  });

  it('refuses values of the wrong length, and breaks that are not finite and rising', () => {
    const grid = gridOf(2, 2);
    expect(() => ratioLines(grid, [1, 2, 3], [2])).toThrow(RangeError);
    expect(() => ratioBands(grid, [1, 2, 3, 4], [2, 1])).toThrow(RangeError);
    expect(() => ratioBands(grid, [1, 2, 3, 4], [1, 1])).toThrow(RangeError);
    expect(() => ratioLines(grid, [1, 2, 3, 4], [Number.NaN])).toThrow(RangeError);
  });
});
