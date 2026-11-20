// Waits between trips: how long a vehicle that has finished one trip stands where it is before its
// next one, so the map can keep drawing it there. The animation pack only knows trips, and a trip is
// over the second it arrives; without this every vehicle disappears at its terminus and a new one
// appears when the next trip leaves.
//
// The vehicle days are the same ones the vehicle chart shows. For everything but suburban trains they
// are inferred, so a wait drawn here is a best guess at which vehicle forms which trip.
import { tripPosition, type Pack } from './pack.ts';
import { distanceM } from './vehicle-days.ts';

/**
 * Longest wait drawn, seconds. A vehicle that stands longer is taken to be out of service (parked, or
 * gone to a depot) and is not drawn until its next trip starts. The platform chart uses the same hour.
 */
export const MAX_DRAWN_WAIT_SECS = 3600;

/**
 * How far apart the end of one trip and the start of the next can be and still be drawn as one wait,
 * metres. The same reach as the widest rule used to chain trips into vehicle days.
 */
export const WAIT_SAME_PLACE_M = 500;

export interface WaitTrip {
  id: number;
  vehicleDayId: number;
  startSecs: number;
  endSecs: number;
  firstStopId: number | null;
  lastStopId: number | null;
}

export interface WaitStop {
  /** The station a platform belongs to, if any. */
  parentId: number | null;
  lon: number;
  lat: number;
}

function samePlace(a: number | null, b: number | null, stops: Map<number, WaitStop>): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const from = stops.get(a);
  const to = stops.get(b);
  if (!from || !to) return false;
  if ((from.parentId ?? a) === (to.parentId ?? b)) return true;
  return distanceM(from.lon, from.lat, to.lon, to.lat) <= WAIT_SAME_PLACE_M;
}

/**
 * For every trip whose vehicle stays where it is and then runs another trip: the trip's id and the
 * second that next trip starts, as pairs [tripId, untilSecs, tripId, untilSecs, ...].
 *
 * A trip is left out when it is the last of its vehicle's day, when the next trip starts somewhere
 * else (the vehicle runs empty to get there, and nothing says by which way), when the next trip
 * starts before this one ends, or when the wait is longer than MAX_DRAWN_WAIT_SECS.
 */
export function vehicleWaits(trips: WaitTrip[], stops: Map<number, WaitStop>): Int32Array {
  const sorted = [...trips].sort((a, b) => a.vehicleDayId - b.vehicleDayId || a.startSecs - b.startSecs || a.id - b.id);
  const pairs: number[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    const trip = sorted[k];
    const next = sorted[k + 1];
    if (next.vehicleDayId !== trip.vehicleDayId) continue;
    const wait = next.startSecs - trip.endSecs;
    if (wait <= 0 || wait > MAX_DRAWN_WAIT_SECS) continue;
    if (!samePlace(trip.lastStopId, next.firstStopId, stops)) continue;
    pairs.push(trip.id, next.startSecs);
  }
  return Int32Array.from(pairs);
}

/** What the vehicle of a trip is doing at a given time. */
export const VEHICLE_GONE = 0;
export const VEHICLE_RUNNING = 1;
export const VEHICLE_WAITING = 2;
export type VehicleState = typeof VEHICLE_GONE | typeof VEHICLE_RUNNING | typeof VEHICLE_WAITING;

/**
 * Whether the vehicle of a trip that runs from `tripStart` to `tripEnd` is drawn at `secs`.
 * `holdUntil` is when its next trip starts (from vehicleWaits), or anything up to `tripEnd` when it
 * has no wait to draw. The wait stops the instant the next trip starts, so the vehicle is never
 * drawn twice.
 */
export function vehicleState(tripStart: number, tripEnd: number, holdUntil: number, secs: number): VehicleState {
  if (secs < tripStart) return VEHICLE_GONE;
  if (secs <= tripEnd) return VEHICLE_RUNNING;
  return secs < holdUntil ? VEHICLE_WAITING : VEHICLE_GONE;
}

/**
 * Where the vehicle of trip `i` is at `secs`, written as [lon, lat] degrees into `out` at `outIndex`:
 * along the trip while it runs, then at the trip's last stop until `holdUntil`.
 */
export function vehiclePosition(
  pack: Pack,
  i: number,
  secs: number,
  holdUntil: number,
  out: Float64Array | Float32Array,
  outIndex: number,
): VehicleState {
  const state = vehicleState(pack.tripStart[i], pack.tripEnd[i], holdUntil, secs);
  if (state === VEHICLE_GONE) return state;
  return tripPosition(pack, i, state === VEHICLE_WAITING ? pack.tripEnd[i] : secs, out, outIndex) ? state : VEHICLE_GONE;
}
