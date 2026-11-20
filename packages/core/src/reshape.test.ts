import { describe, expect, it } from 'vitest';
import { bandOf, DAY_BANDS } from './time.ts';
import { distanceBetweenPathsM, distanceToPathM,keptIndexes, locateStops, mirrorStops, pathDistances, retime, slicePath, type Coord, type OldCall } from './reshape.ts';

const call = (arr: number, dep = arr, pickup = 0, dropOff = 0): OldCall => ({ arr, dep, pickup, dropOff });

describe('keptIndexes', () => {
  it('finds kept, added and removed stops', () => {
    expect(keptIndexes([1, 2, 3, 4], [1, 2, 9, 4, 5])).toEqual([0, 1, -1, 3, -1]);
  });
  it('treats a stop moved along the line as added again', () => {
    const kept = keptIndexes([1, 2, 3], [3, 1, 2]);
    expect(kept.filter((a) => a >= 0)).toEqual([0, 1]);
    expect(kept[0]).toBe(-1);
  });
  it('copes with a stop served twice', () => {
    expect(keptIndexes([1, 2, 1], [1, 2, 1])).toEqual([0, 1, 2]);
  });
});

describe('slicePath', () => {
  const path: Coord[] = [[151, -33.8], [151.01, -33.8], [151.02, -33.8]];
  const dists = pathDistances(path);
  it('cuts between two distances, interpolating the ends', () => {
    const piece = slicePath(path, dists, dists[1] / 2, dists[1] + (dists[2] - dists[1]) / 2);
    expect(piece.length).toBe(3);
    expect(piece[0][0]).toBeCloseTo(151.005, 6);
    expect(piece[1]).toEqual(path[1]);
    expect(piece[2][0]).toBeCloseTo(151.015, 6);
  });
  it('returns both ends even for an empty stretch', () => {
    expect(slicePath(path, dists, dists[1], dists[1]).length).toBe(2);
  });
});

describe('locateStops', () => {
  it('keeps stops in order along the path', () => {
    const path: Coord[] = [[151, -33.8], [151.01, -33.8], [151.02, -33.8], [151.03, -33.8]];
    expect(locateStops(path, [[151, -33.8], [151.021, -33.8001], [151.03, -33.8]])).toEqual([0, 2, 3]);
  });
});

describe('retime', () => {
  // Four stops a minute apart, half a minute at each middle stop.
  const old = [call(0, 0, 0, 1), call(60, 90), call(150, 180), call(240, 240, 1, 0)];
  const options = { dwellSecs: 20, skipPenaltySecs: 20 };

  it('leaves an unchanged trip exactly as it was', () => {
    const out = retime(old, [0, 1, 2, 3], [{ kind: 'same' }, { kind: 'same' }, { kind: 'same' }], options);
    expect(out.map((c) => [c.arr, c.dep])).toEqual(old.map((c) => [c.arr, c.dep]));
    expect(out[0].dropOff).toBe(1);
    expect(out[3].pickup).toBe(1);
  });

  it('extends at the end: same start, later finish, the old last stop opens to boarding', () => {
    const out = retime(old, [0, 1, 2, 3, -1], [{ kind: 'same' }, { kind: 'same' }, { kind: 'same' }, { kind: 'new', secs: 100 }], options);
    expect(out[0].dep).toBe(0);
    expect(out[3]).toMatchObject({ arr: 240, dep: 260, pickup: 0, dropOff: 0 });
    expect(out[4]).toMatchObject({ arr: 360, dep: 360, pickup: 1, from: -1 });
  });

  it('extends at the start: the old first stop keeps its departure time', () => {
    const out = retime(old.map((c) => ({ ...c, arr: c.arr + 1000, dep: c.dep + 1000 })), [-1, 0, 1, 2, 3], [{ kind: 'new', secs: 100 }, { kind: 'same' }, { kind: 'same' }, { kind: 'same' }], options);
    expect(out[1].dep).toBe(1000);
    expect(out[1].arr).toBe(980);
    expect(out[0]).toMatchObject({ arr: 880, dep: 880, dropOff: 1 });
    expect(out[4].arr).toBe(1240);
  });

  it('cut short at the start: begins when it used to pass the new first stop', () => {
    const out = retime(old, [1, 2, 3], [{ kind: 'same' }, { kind: 'same' }], options);
    expect(out[0]).toMatchObject({ arr: 90, dep: 90, pickup: 0, dropOff: 1 });
    expect(out[2].arr).toBe(240);
  });

  it('a removed stop the vehicle still passes saves its stop time and a little more', () => {
    const out = retime(old, [0, 1, 3], [{ kind: 'same' }, { kind: 'passing' }], options);
    // 150 s from leaving stop 2 to reaching stop 4, less 30 s stopped and 20 s slowing down.
    expect(out[2].arr).toBe(90 + 100);
  });

  it('never starts before the day does', () => {
    const out = retime(old, [-1, 0, 1], [{ kind: 'new', secs: 500 }, { kind: 'same' }], options);
    expect(out[0].arr).toBe(0);
    expect(out[1].dep).toBe(520);
  });
});

describe('mirrorStops', () => {
  // Outbound 1-2-3-4; the way back 14-13-12-11 uses the stops across the road.
  const opposite = [14, 13, 12, 11];
  const matchOld = [3, 2, 1, 0];
  it('extends the other direction at its start', () => {
    const out = mirrorStops({ keptAt: [0, 1, 2, 3, -1, -1], matchOld, counterpart: [0, 0, 0, 0, 15, 16], opposite });
    expect(out).toEqual([16, 15, 14, 13, 12, 11]);
  });
  it('cuts the other direction short and swaps a stop in the middle', () => {
    expect(mirrorStops({ keptAt: [0, 1, 2], matchOld, counterpart: [0, 0, 0], opposite })).toEqual([13, 12, 11]);
    expect(mirrorStops({ keptAt: [0, -1, 2, 3], matchOld, counterpart: [0, 19, 0, 0], opposite })).toEqual([14, 13, 19, 11]);
  });
  it('gives up when there is nowhere to hang the change', () => {
    expect(mirrorStops({ keptAt: [0, 1, 2, 3, -1], matchOld: [3, 2, 1, null], counterpart: [0, 0, 0, 0, 15], opposite })).toBeNull();
  });
});

describe('stops on a path that doubles back', () => {
  it('puts each stop on the first pass, not the nearest point of the whole path', () => {
    // Out along a road and back along the same road: the second stop is 400 m out, the third at the far end.
    const out: Coord[] = [];
    for (let k = 0; k <= 10; k++) out.push([151 + k * 0.001, -33.8]);
    const path: Coord[] = [...out, ...[...out].reverse().slice(1).map((p) => [p[0], p[1] - 0.00002] as Coord)];
    // The stop sits a few metres to the side that the way back runs along, so the way back is nearer.
    const at = locateStops(path, [[151, -33.8], [151.004, -33.80003], [151.01, -33.8], [151.005, -33.80002], [151, -33.80002]]);
    expect(at[1]).toBe(4);
    expect(at[2]).toBe(10);
    expect(at[3]).toBe(15);
    expect(at[4]).toBe(path.length - 1);
  });
});

describe('a detour is never faster than the vehicle', () => {
  const old: OldCall[] = [
    { arr: 1000, dep: 1000, pickup: 0, dropOff: 0 },
    { arr: 1000, dep: 1000, pickup: 0, dropOff: 0 },
    { arr: 1060, dep: 1060, pickup: 0, dropOff: 0 },
  ];
  it('times a published nought-second stretch from the length of the way round', () => {
    // 3 km round where the timetable gave 0 s for 300 m: 2,700 m more at 6.5 m/s.
    const next = retime(old, [0, 1, 2], [{ kind: 'detour', factor: 10, lengthM: 3000, extraM: 2700, speed: 6.5, maxSpeed: 27.8 }, { kind: 'same' }], { dwellSecs: 0, skipPenaltySecs: 20 });
    expect(next[1].arr - next[0].dep).toBe(Math.round(2700 / 6.5));
    expect(next[2].arr - next[1].dep).toBe(60);
  });
  it('has no upper limit on how much longer the way round is', () => {
    const next = retime(old, [0, 2], [{ kind: 'detour', factor: 20, lengthM: 20000, extraM: 19000, speed: 6.5, maxSpeed: 27.8 }], { dwellSecs: 0, skipPenaltySecs: 20 });
    expect(next[1].arr - next[0].dep).toBe(Math.round(40 + 19000 / 6.5));
  });
});

describe('detours and closures', () => {
  it('scales the time of each trip when the vehicle goes a longer way round', () => {
    const old = [call(0), call(100, 120), call(300, 320), call(500)];
    // The third stop is closed and the way from the second to the last is half as long again.
    const next = retime(old, [0, 1, 3], [{ kind: 'same' }, { kind: 'detour', factor: 1.5 }], { dwellSecs: 20, skipPenaltySecs: 20 });
    expect(next.map((c) => c.dep)[1]).toBe(120);
    // 380 s as published, less 20 s standing and 20 s for stopping at the closed stop, times 1.5.
    expect(next[2].arr).toBe(120 + Math.round((380 - 40) * 1.5));
  });
  it('measures how close a path comes to a point', () => {
    const path: Coord[] = [[151, -33.9], [151.01, -33.9]];
    expect(distanceToPathM(path, 151.005, -33.9)).toBeLessThan(1);
    const off = distanceToPathM(path, 151.005, -33.901);
    expect(off).toBeGreaterThan(105);
    expect(off).toBeLessThan(116);
    expect(distanceToPathM(path, 151.02, -33.9)).toBeGreaterThan(900);
  });
  it('measures how close two paths come to each other', () => {
    const path: Coord[] = [[151, -33.9], [151.01, -33.9], [151.02, -33.9]];
    // A line drawn across the path, between its points.
    expect(distanceBetweenPathsM(path, [[151.005, -33.91], [151.005, -33.89]])).toBe(0);
    // One that stops about 110 m short of it.
    const short = distanceBetweenPathsM(path, [[151.005, -33.91], [151.005, -33.901]]);
    expect(short).toBeGreaterThan(105);
    expect(short).toBeLessThan(116);
    // One beyond its end.
    expect(distanceBetweenPathsM(path, [[151.03, -33.91], [151.03, -33.89]])).toBeGreaterThan(900);
  });
});

describe('run times by part of the day', () => {
  it('puts each time in its part of the day', () => {
    expect(DAY_BANDS[bandOf(5 * 3600)].id).toBe('early');
    expect(DAY_BANDS[bandOf(8 * 3600)].id).toBe('am');
    expect(DAY_BANDS[bandOf(12 * 3600)].id).toBe('day');
    expect(DAY_BANDS[bandOf(17 * 3600)].id).toBe('pm');
    expect(DAY_BANDS[bandOf(21 * 3600)].id).toBe('evening');
    // Times after midnight on the same service day are still the evening.
    expect(DAY_BANDS[bandOf(25 * 3600)].id).toBe('evening');
    expect(bandOf(6.5 * 3600)).toBe(1);
  });
  it('times a new stretch by when the trip sets out', () => {
    const byBand = [60, 180, 90, 150, 70];
    const sections = [{ kind: 'same' as const }, { kind: 'new' as const, secs: 90, byBand }];
    const at = (start: number) => {
      const old = [call(start), call(start + 300)];
      const next = retime(old, [0, 1, -1], sections, { dwellSecs: 0, skipPenaltySecs: 20 });
      return next[2].arr - next[1].dep;
    };
    expect(at(8 * 3600)).toBe(180);
    expect(at(12 * 3600)).toBe(90);
    expect(at(22 * 3600)).toBe(70);
  });
  it('falls back to the single time when none is given by part of the day', () => {
    const old = [call(8 * 3600), call(8 * 3600 + 300)];
    const next = retime(old, [0, 1, -1], [{ kind: 'same' }, { kind: 'new', secs: 90 }], { dwellSecs: 0, skipPenaltySecs: 20 });
    expect(next[2].arr - next[1].dep).toBe(90);
  });
});
