import { describe, expect, it } from 'vitest';
import { COORD_SCALE, type Pack } from './pack.ts';
import {
  MAX_DRAWN_WAIT_SECS,
  VEHICLE_GONE,
  VEHICLE_RUNNING,
  VEHICLE_WAITING,
  vehiclePosition,
  vehicleState,
  vehicleWaits,
  type WaitStop,
  type WaitTrip,
} from './waits.ts';

// Platforms 1 and 2 of one station, a stand 300 m from platform 1, and a stop 9 km away.
const stops = new Map<number, WaitStop>([
  [1, { parentId: 10, lon: 151.0, lat: -33.8 }],
  [2, { parentId: 10, lon: 151.0005, lat: -33.8 }],
  [3, { parentId: null, lon: 151.00324, lat: -33.8 }],
  [4, { parentId: null, lon: 151.1, lat: -33.8 }],
]);

const trip = (id: number, vehicleDayId: number, startSecs: number, endSecs: number, firstStopId: number | null, lastStopId: number | null): WaitTrip => ({
  id,
  vehicleDayId,
  startSecs,
  endSecs,
  firstStopId,
  lastStopId,
});

describe('vehicleWaits', () => {
  it('holds a vehicle at its terminus until its next trip starts', () => {
    // Given out of order, as a database may return them.
    const waits = vehicleWaits([trip(12, 7, 2000, 3000, 1, 4), trip(11, 7, 0, 1400, 4, 1)], stops);
    expect(Array.from(waits)).toEqual([11, 2000]);
  });

  it('counts another platform of the same station and a stand close by as the same place', () => {
    expect(Array.from(vehicleWaits([trip(1, 7, 0, 1000, 4, 1), trip(2, 7, 1300, 2000, 2, 4)], stops))).toEqual([1, 1300]);
    expect(Array.from(vehicleWaits([trip(1, 7, 0, 1000, 4, 1), trip(2, 7, 1300, 2000, 3, 4)], stops))).toEqual([1, 1300]);
  });

  it('does not hold a vehicle whose next trip starts somewhere else', () => {
    expect(vehicleWaits([trip(1, 7, 0, 1000, 1, 1), trip(2, 7, 1300, 2000, 4, 1)], stops)).toHaveLength(0);
    // Nothing known about where a trip ends or starts: no wait is drawn.
    expect(vehicleWaits([trip(1, 7, 0, 1000, 1, null), trip(2, 7, 1300, 2000, null, 1)], stops)).toHaveLength(0);
    expect(vehicleWaits([trip(1, 7, 0, 1000, 1, 98), trip(2, 7, 1300, 2000, 99, 1)], stops)).toHaveLength(0);
  });

  it('does not draw a vehicle parked for more than an hour as if it were in service', () => {
    const just = trip(2, 7, 1000 + MAX_DRAWN_WAIT_SECS, 9000, 1, 4);
    expect(Array.from(vehicleWaits([trip(1, 7, 0, 1000, 4, 1), just], stops))).toEqual([1, 1000 + MAX_DRAWN_WAIT_SECS]);
    const tooLong = trip(2, 7, 1001 + MAX_DRAWN_WAIT_SECS, 9000, 1, 4);
    expect(vehicleWaits([trip(1, 7, 0, 1000, 4, 1), tooLong], stops)).toHaveLength(0);
  });

  it('never links trips of different vehicles, or a trip that leaves the second the last one arrives', () => {
    expect(vehicleWaits([trip(1, 7, 0, 1000, 4, 1), trip(2, 8, 1300, 2000, 1, 4)], stops)).toHaveLength(0);
    expect(vehicleWaits([trip(1, 7, 0, 1000, 4, 1), trip(2, 7, 1000, 2000, 1, 4)], stops)).toHaveLength(0);
  });

  it('links each trip of a day to the one after it', () => {
    const day = [trip(1, 7, 0, 1000, 4, 1), trip(2, 7, 1200, 2000, 1, 4), trip(3, 7, 2100, 3000, 4, 1)];
    expect(Array.from(vehicleWaits(day, stops))).toEqual([1, 1200, 2, 2100]);
  });
});

describe('vehicleState', () => {
  it('is running during the trip, waiting until the next one starts, and gone otherwise', () => {
    expect(vehicleState(100, 400, 700, 99)).toBe(VEHICLE_GONE);
    expect(vehicleState(100, 400, 700, 100)).toBe(VEHICLE_RUNNING);
    expect(vehicleState(100, 400, 700, 400)).toBe(VEHICLE_RUNNING);
    expect(vehicleState(100, 400, 700, 400.5)).toBe(VEHICLE_WAITING);
    expect(vehicleState(100, 400, 700, 699.9)).toBe(VEHICLE_WAITING);
    // The next trip is drawn from 700 on, so this one must not be.
    expect(vehicleState(100, 400, 700, 700)).toBe(VEHICLE_GONE);
  });

  it('is gone as soon as the trip ends when there is no wait to draw', () => {
    expect(vehicleState(100, 400, 400, 400)).toBe(VEHICLE_RUNNING);
    expect(vehicleState(100, 400, 400, 400.5)).toBe(VEHICLE_GONE);
    expect(vehicleState(100, 400, 0, 401)).toBe(VEHICLE_GONE);
  });
});

describe('vehiclePosition', () => {
  // One trip 2000 m east along a straight line, 100 s to 400 s.
  const pack: Pack = {
    meta: { version: 1, modeId: 'train', tripCount: 1, stopTimeCount: 2, shapeCount: 1, pointCount: 2 },
    tripId: Int32Array.of(42),
    tripRoute: Int32Array.of(7),
    tripStart: Int32Array.of(100),
    tripEnd: Int32Array.of(400),
    tripShape: Int32Array.of(0),
    tripStOffset: Uint32Array.of(0, 2),
    stArr: Int32Array.of(100, 400),
    stDep: Int32Array.of(100, 400),
    stDist: Float32Array.of(0, 2000),
    shapePtOffset: Uint32Array.of(0, 2),
    ptLon: Int32Array.of(151.0 * COORD_SCALE, 151.02 * COORD_SCALE),
    ptLat: Int32Array.of(-33.8 * COORD_SCALE, -33.8 * COORD_SCALE),
    ptDist: Float32Array.of(0, 2000),
  };

  it('keeps the vehicle at its last stop for the whole wait', () => {
    const out = new Float64Array(2);
    expect(vehiclePosition(pack, 0, 250, 700, out, 0)).toBe(VEHICLE_RUNNING);
    expect(out[0]).toBeCloseTo(151.01, 5);
    for (const secs of [401, 550, 699]) {
      out.fill(0);
      expect(vehiclePosition(pack, 0, secs, 700, out, 0)).toBe(VEHICLE_WAITING);
      expect(out[0]).toBeCloseTo(151.02, 5);
      expect(out[1]).toBeCloseTo(-33.8, 5);
    }
    expect(vehiclePosition(pack, 0, 700, 700, out, 0)).toBe(VEHICLE_GONE);
    expect(vehiclePosition(pack, 0, 401, 400, out, 0)).toBe(VEHICLE_GONE);
  });
});
