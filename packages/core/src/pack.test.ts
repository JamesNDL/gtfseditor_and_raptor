import { describe, expect, it } from 'vitest';
import { COORD_SCALE, decodePack, encodePack, tripPosition, type PackArrays } from './pack.ts';

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
