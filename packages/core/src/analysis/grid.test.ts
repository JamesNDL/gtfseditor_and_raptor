// The sample grid (FR-7, D26): cell centres from the zone's south-west corner, kept if inside.
import { describe, expect, it } from 'vitest';
import { gridCount, sampleGrid } from './grid.ts';
import { localFrame } from './local-metres.ts';
import type { Ring } from './polygon.ts';

/** A square zone `sideM` metres across, centred on a point near Parramatta. */
function squareZone(sideM: number): Ring {
  const frame = localFrame(151.0, -33.8);
  const h = sideM / 2;
  return [
    frame.toLonLat([-h, -h]),
    frame.toLonLat([h, -h]),
    frame.toLonLat([h, h]),
    frame.toLonLat([-h, h]),
  ];
}

describe('sampleGrid', () => {
  it('AC-FR-7.1: a 1 km square at 250 m gives 16 points in 4 columns and 4 rows', () => {
    const grid = sampleGrid(squareZone(1000), 250);
    expect(grid.columns).toBe(4);
    expect(grid.rows).toBe(4);
    expect(grid.points).toHaveLength(16);
    const cells = grid.points.map((p) => `${p.i},${p.j}`);
    const expected: string[] = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) expected.push(`${i},${j}`);
    expect(cells).toEqual(expected);
  });

  it('puts each point at the centre of its cell, measured from the south-west corner', () => {
    const ring = squareZone(1000);
    const frame = localFrame(151.0, -33.8);
    const grid = sampleGrid(ring, 250);
    for (const p of grid.points) {
      const [x, y] = frame.toMetres([p.lon, p.lat]);
      expect(x).toBeCloseTo(-500 + 125 + p.i * 250, 6);
      expect(y).toBeCloseTo(-500 + 125 + p.j * 250, 6);
    }
  });

  it('orders points by row (j), then by column (i)', () => {
    const grid = sampleGrid(squareZone(1000), 250);
    for (let k = 1; k < grid.points.length; k++) {
      const a = grid.points[k - 1];
      const b = grid.points[k];
      expect(a.j < b.j || (a.j === b.j && a.i < b.i)).toBe(true);
    }
  });

  it('keeps only the points inside an L-shaped zone', () => {
    const frame = localFrame(151.0, -33.8);
    const l: Ring = [
      frame.toLonLat([0, 0]),
      frame.toLonLat([1000, 0]),
      frame.toLonLat([1000, 500]),
      frame.toLonLat([500, 500]),
      frame.toLonLat([500, 1000]),
      frame.toLonLat([0, 1000]),
    ];
    const grid = sampleGrid(l, 250);
    expect(grid.columns).toBe(4);
    expect(grid.rows).toBe(4);
    expect(grid.points).toHaveLength(12);
    expect(grid.points.some((p) => p.i >= 2 && p.j >= 2)).toBe(false);
  });

  it('gives the same result for a repeated closing corner', () => {
    const ring = squareZone(1000);
    expect(sampleGrid([...ring, ring[0]], 250)).toEqual(sampleGrid(ring, 250));
  });

  it('gives no points when the spacing is wider than the zone', () => {
    const grid = sampleGrid(squareZone(100), 250);
    expect(grid.points).toHaveLength(0);
  });

  it('NFR-4: the same outline and spacing always give the same points in the same order', () => {
    const ring = squareZone(1700);
    const first = sampleGrid(ring, 130);
    const second = sampleGrid(
      ring.map(([lon, lat]) => [lon, lat] as const),
      130,
    );
    expect(second).toEqual(first);
  });

  it('refuses a spacing that is not a positive number', () => {
    expect(() => sampleGrid(squareZone(1000), 0)).toThrow(RangeError);
    expect(() => sampleGrid(squareZone(1000), Number.NaN)).toThrow(RangeError);
  });
});

describe('gridCount', () => {
  it('equals the number of points sampleGrid lays', () => {
    for (const [side, spacing] of [
      [1000, 250],
      [1700, 130],
      [5000, 333],
      [100, 250],
    ] as const) {
      const ring = squareZone(side);
      expect(gridCount(ring, spacing)).toBe(sampleGrid(ring, spacing).points.length);
    }
  });

  it('equals the number of points for an L-shaped zone', () => {
    const l: Ring = [
      [151.0, -33.8],
      [151.03, -33.8],
      [151.03, -33.79],
      [151.01, -33.79],
      [151.01, -33.77],
      [151.0, -33.77],
    ];
    expect(gridCount(l, 200)).toBe(sampleGrid(l, 200).points.length);
  });
});
