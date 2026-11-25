// A ride drawn along its vehicle's path (D35; docs/architecture/access-analysis.md §12): the calls a
// stored ride boards and alights at, and the part of the trip's shape between them, with loops,
// stops off the line and trips with no shape.
import { describe, expect, it } from 'vitest';
import { localFrame, type LonLat } from './local-metres.ts';
import { rideCalls, ridePath, type TripCall, type TripShape } from './ride-path.ts';

const FRAME = localFrame(151.2, -33.9);
/** A place `x` metres east and `y` metres north of 151.2, -33.9. */
const at = (x: number, y: number): LonLat => FRAME.toLonLat([x, y]);
/** How far apart two places are, in metres. */
const apart = (a: LonLat, b: LonLat): number => {
  const [ax, ay] = FRAME.toMetres(a);
  const [bx, by] = FRAME.toMetres(b);
  return Math.hypot(bx - ax, by - ay);
};
/** The length of a path, in metres. */
const lengthOf = (path: readonly LonLat[]): number =>
  path.slice(1).reduce((sum, p, k) => sum + apart(path[k], p), 0);

const call = (stop: string, place: LonLat, time: number, dist: number | null = null): TripCall => ({
  stop,
  lon: place[0],
  lat: place[1],
  arr: time,
  dep: time + 20,
  dist,
});

/** A shape through these points (metres), with the feed's distances along it when asked. */
function shapeOf(points: [number, number][], withDists: boolean): TripShape {
  const coords = points.map(([x, y]) => at(x, y));
  let along = 0;
  const dists = points.map(([x, y], k) => {
    if (k > 0) along += Math.hypot(x - points[k - 1][0], y - points[k - 1][1]);
    return along;
  });
  return { coords, dists: withDists ? dists : null };
}

describe('ridePath on a straight shape', () => {
  // A line 2 km east with a bend north at 1 km; stops at 0, 800 m, 1,500 m (on the bend) and the end.
  const shape = shapeOf(
    [
      [0, 0],
      [500, 0],
      [1000, 0],
      [1000, 500],
      [1000, 1000],
    ],
    false,
  );
  const calls = [
    call('A', at(0, 0), 100),
    call('B', at(800, 0), 200),
    call('C', at(1000, 500), 300),
    call('D', at(1000, 1000), 400),
  ];

  it('follows the shape between the two stops, through its bends', () => {
    const { path, from } = ridePath(shape, calls, 1, 3);
    expect(from).toBe('shape');
    expect(path.length).toBeGreaterThan(2);
    expect(apart(path[0], at(800, 0))).toBeLessThan(1);
    expect(apart(path[path.length - 1], at(1000, 1000))).toBeLessThan(1);
    // 200 m east to the bend, then 1 km north: not the straight 1,020 m.
    expect(lengthOf(path)).toBeCloseTo(1200, 0);
    expect(path.some((p) => apart(p, at(1000, 0)) < 1)).toBe(true);
  });

  it('gives the same piece from the feed distances', () => {
    const withDists = shapeOf(
      [
        [0, 0],
        [500, 0],
        [1000, 0],
        [1000, 500],
        [1000, 1000],
      ],
      true,
    );
    const measured = [
      call('A', at(0, 0), 100, 0),
      call('B', at(800, 0), 200, 800),
      call('C', at(1000, 500), 300, 1500),
      call('D', at(1000, 1000), 400, 2000),
    ];
    const { path, from } = ridePath(withDists, measured, 1, 3);
    expect(from).toBe('shape');
    expect(lengthOf(path)).toBeCloseTo(1200, 0);
  });
});

describe('ridePath on a loop', () => {
  // Out 1 km east, round a turn and back west 15 m north of the way out, to where it started.
  const points: [number, number][] = [
    [0, 0],
    [500, 0],
    [1000, 0],
    [1010, 8],
    [1000, 15],
    [500, 15],
    [0, 15],
  ];
  const calls = (dists: boolean): TripCall[] => [
    call('A', at(0, 0), 100, dists ? 0 : null),
    call('B', at(200, 0), 150, dists ? 200 : null),
    call('C', at(800, 0), 250, dists ? 800 : null),
    call('D', at(800, 15), 350, dists ? 1225 : null),
    call('E', at(200, 15), 450, dists ? 1825 : null),
    call('F', at(0, 15), 500, dists ? 2025 : null),
  ];

  for (const withDists of [false, true]) {
    const how = withDists ? 'from the feed distances' : 'by snapping in stop order';
    it(`goes round the turn rather than across it (${how})`, () => {
      // C to D are 15 m apart in a straight line but 2 x 200 m round the turn, plus the turn.
      const { path } = ridePath(shapeOf(points, withDists), calls(withDists), 2, 3);
      expect(apart(path[0], at(800, 0))).toBeLessThan(1);
      expect(apart(path[path.length - 1], at(800, 15))).toBeLessThan(1);
      expect(lengthOf(path)).toBeGreaterThan(420);
      expect(path.some((p) => apart(p, at(1010, 8)) < 1)).toBe(true);
    });

    it(`keeps a ride on the way out off the way back (${how})`, () => {
      const { path } = ridePath(shapeOf(points, withDists), calls(withDists), 1, 2);
      expect(lengthOf(path)).toBeCloseTo(600, 0);
      expect(path.every((p) => FRAME.toMetres(p)[1] < 1)).toBe(true);
    });

    it(`rides the whole loop from the start back to beside it (${how})`, () => {
      const { path } = ridePath(shapeOf(points, withDists), calls(withDists), 0, 5);
      expect(lengthOf(path)).toBeGreaterThan(2000);
    });
  }
});

describe('ridePath with stops off the line', () => {
  const shape = shapeOf(
    [
      [0, 0],
      [1000, 0],
      [2000, 0],
    ],
    false,
  );

  it('starts and ends on the line beside stops a little way off it', () => {
    const calls = [call('A', at(300, 40), 100), call('B', at(1700, -30), 200)];
    const { path, from } = ridePath(shape, calls, 0, 1);
    expect(from).toBe('shape');
    expect(apart(path[0], at(300, 0))).toBeLessThan(1);
    expect(apart(path[path.length - 1], at(1700, 0))).toBeLessThan(1);
    expect(path.length).toBe(3);
  });

  it('draws stop to stop when a stop is far from the shape (the wrong shape)', () => {
    const calls = [
      call('A', at(300, 0), 100),
      call('B', at(900, 600), 150),
      call('C', at(1700, 900), 200),
    ];
    const { path, from } = ridePath(shape, calls, 0, 2);
    expect(from).toBe('stops');
    expect(path).toEqual([at(300, 0), at(900, 600), at(1700, 900)]);
  });
});

describe('ridePath with no shape', () => {
  it('joins every stop from boarding to alighting, in order', () => {
    const calls = [
      call('A', at(0, 0), 100),
      call('B', at(300, 100), 150),
      call('C', at(600, 0), 200),
      call('D', at(900, 100), 250),
    ];
    for (const shape of [null, { coords: [at(0, 0)], dists: null }]) {
      const { path, from } = ridePath(shape, calls, 1, 3);
      expect(from).toBe('stops');
      expect(path).toEqual([at(300, 100), at(600, 0), at(900, 100)]);
    }
  });
});

describe('rideCalls', () => {
  // A loop that calls at stop L twice: first at 100, again at 400.
  const calls = [
    call('L', at(0, 0), 100),
    call('M', at(500, 0), 200),
    call('N', at(500, 500), 300),
    call('L', at(0, 0), 400),
    call('P', at(-500, 0), 500),
  ];
  const end = (stop: string | undefined, place: LonLat, time: number) => ({
    ...(stop === undefined ? {} : { stop }),
    lon: place[0],
    lat: place[1],
    time,
  });

  it('finds the calls by stop id and time, boarding at departure and alighting at arrival', () => {
    expect(rideCalls(calls, end('M', at(500, 0), 220), end('L', at(0, 0), 400))).toEqual({
      board: 1,
      alight: 3,
    });
    expect(rideCalls(calls, end('L', at(0, 0), 420), end('P', at(-500, 0), 500))).toEqual({
      board: 3,
      alight: 4,
    });
  });

  it('finds them by place when the stored stop has no id (analyses run before ids were kept)', () => {
    const near = at(3, 2);
    expect(rideCalls(calls, end(undefined, near, 420), end(undefined, at(-500, 0), 500))).toEqual({
      board: 3,
      alight: 4,
    });
  });

  it('finds nothing when the times, the stops or the order do not fit', () => {
    expect(rideCalls(calls, end('M', at(500, 0), 221), end('L', at(0, 0), 400))).toBeNull();
    expect(rideCalls(calls, end('X', at(500, 0), 220), end('L', at(0, 0), 400))).toBeNull();
    expect(
      rideCalls(calls, end(undefined, at(560, 0), 220), end('N', at(500, 500), 300)),
    ).toBeNull();
    expect(rideCalls(calls, end('N', at(500, 500), 320), end('M', at(500, 0), 200))).toBeNull();
  });
});
