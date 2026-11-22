import { describe, expect, it } from 'vitest';
import { buildVehicleDays, type ChainTrip } from './vehicle-days.ts';
import { COORD_SCALE, decodePack, encodePack, tripPosition, type PackArrays } from './pack.ts';
import { simplifyIndices } from './simplify.ts';
import { formatClock, formatSecs } from './time.ts';

const A: [number, number] = [151.0, -33.8];
const B: [number, number] = [151.1, -33.8]; // about 9 km east of A

let nextId = 1;
function trip(
  from: [number, number],
  to: [number, number],
  start: number,
  end: number,
  extra: Partial<ChainTrip> = {},
): ChainTrip {
  return {
    id: nextId++,
    startSecs: start,
    endSecs: end,
    firstLon: from[0],
    firstLat: from[1],
    lastLon: to[0],
    lastLat: to[1],
    ruleSet: 'road',
    partition: 'bus|op1|',
    ...extra,
  };
}

describe('buildVehicleDays', () => {
  it('chains a trip onto the next one leaving from where it ended', () => {
    const out = trip(A, B, 0, 1000);
    const back = trip(B, A, 1300, 2300);
    const days = buildVehicleDays([back, out]);
    expect(days).toHaveLength(1);
    expect(days[0].tripIds).toEqual([out.id, back.id]);
    expect(days[0].source).toBe('inferred');
    expect(days[0].gapCount).toBe(0);
  });

  it('does not chain when the layover is too short, too long, or somewhere else', () => {
    expect(buildVehicleDays([trip(A, B, 0, 1000), trip(B, A, 1010, 2000)])).toHaveLength(2); // 10 s turnaround
    expect(buildVehicleDays([trip(A, B, 0, 1000), trip(B, A, 1000 + 2 * 3600, 9000)])).toHaveLength(
      2,
    ); // 2 h wait
    expect(buildVehicleDays([trip(A, B, 0, 1000), trip(A, B, 1300, 2300)])).toHaveLength(2); // starts at A, bus is at B
  });

  it('never chains across partitions', () => {
    const days = buildVehicleDays([
      trip(A, B, 0, 1000),
      trip(B, A, 1300, 2300, { partition: 'bus|op2|' }),
    ]);
    expect(days).toHaveLength(2);
  });

  it('gives the longest-waiting vehicle the next departure', () => {
    const first = trip(A, B, 0, 1000);
    const second = trip(A, B, 100, 1100);
    const next = trip(B, A, 1500, 2500);
    const days = buildVehicleDays([first, second, next]);
    expect(days.find((d) => d.tripIds.includes(next.id))!.tripIds).toEqual([first.id, next.id]);
  });

  it('keeps block-linked trips on one vehicle even with no layover', () => {
    const a = trip(A, B, 0, 1000, { blockId: 'blk' });
    const b = trip(B, A, 1000, 2000, { blockId: 'blk' });
    expect(buildVehicleDays([a, b])).toHaveLength(1);
  });

  it('uses run numbers as given and counts station jumps as gaps', () => {
    const rail = { ruleSet: 'rail' as const, partition: 'train|st|', runKey: '1--' };
    const days = buildVehicleDays([
      trip(A, B, 0, 1000, rail),
      trip(A, B, 5000, 6000, rail),
      trip(B, A, 6100, 7000, rail),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0].source).toBe('run_number');
    expect(days[0].tripIds).toHaveLength(3);
    expect(days[0].gapCount).toBe(1);
  });
});

describe('simplifyIndices', () => {
  it('drops points on a straight line and keeps corners', () => {
    const lon = [151.0, 151.001, 151.002, 151.002, 151.002];
    const lat = [-33.8, -33.8, -33.8, -33.801, -33.802];
    expect(simplifyIndices(lon, lat, 5)).toEqual([0, 2, 4]);
  });
});

describe('animation pack', () => {
  // One trip along a two-segment shape: 1000 m east, then 1000 m further east.
  const arrays: PackArrays = {
    tripId: Int32Array.of(42),
    tripRoute: Int32Array.of(7),
    tripStart: Int32Array.of(100),
    tripEnd: Int32Array.of(400),
    tripShape: Int32Array.of(0),
    tripStOffset: Uint32Array.of(0, 3),
    stArr: Int32Array.of(100, 200, 400),
    stDep: Int32Array.of(100, 260, 400),
    stDist: Float32Array.of(0, 1000, 2000),
    shapePtOffset: Uint32Array.of(0, 3),
    ptLon: Int32Array.of(151.0 * COORD_SCALE, 151.01 * COORD_SCALE, 151.02 * COORD_SCALE),
    ptLat: Int32Array.of(-33.8 * COORD_SCALE, -33.8 * COORD_SCALE, -33.8 * COORD_SCALE),
    ptDist: Float32Array.of(0, 1000, 2000),
  };
  const meta = {
    version: 1 as const,
    modeId: 'train',
    tripCount: 1,
    stopTimeCount: 3,
    shapeCount: 1,
    pointCount: 3,
  };

  it('survives encoding and decoding', () => {
    const bytes = encodePack(meta, arrays);
    const pack = decodePack(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    expect(pack.meta).toEqual(meta);
    expect(Array.from(pack.stDep)).toEqual([100, 260, 400]);
    expect(Array.from(pack.ptLon)).toEqual(Array.from(arrays.ptLon));
  });

  it('places a vehicle between stops, at a dwell, and nowhere outside its trip', () => {
    const pack = { meta, ...arrays };
    const out = new Float64Array(2);
    expect(tripPosition(pack, 0, 50, out, 0)).toBe(false);
    expect(tripPosition(pack, 0, 401, out, 0)).toBe(false);

    expect(tripPosition(pack, 0, 150, out, 0)).toBe(true); // halfway to the first stop
    expect(out[0]).toBeCloseTo(151.005, 5);

    tripPosition(pack, 0, 230, out, 0); // dwelling at the middle stop
    expect(out[0]).toBeCloseTo(151.01, 5);

    tripPosition(pack, 0, 330, out, 0); // halfway along the second leg
    expect(out[0]).toBeCloseTo(151.015, 5);
    expect(out[1]).toBeCloseTo(-33.8, 5);
  });
});

describe('time formatting', () => {
  it('keeps hours past midnight for timetables and wraps them for the clock', () => {
    expect(formatSecs(25 * 3600 + 5 * 60)).toBe('25:05');
    expect(formatClock(25 * 3600 + 5 * 60)).toEqual({ time: '01:05', nextDay: true });
    expect(formatClock(8 * 3600)).toEqual({ time: '08:00', nextDay: false });
  });
});
