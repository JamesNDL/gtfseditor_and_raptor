// Loads animation packs and works out where every vehicle is at a given time.
import {
  decodePack,
  tripPosition,
  VEHICLE_GONE,
  VEHICLE_WAITING,
  vehicleState,
  type Pack,
} from '@gtfs-editor/core';
import type { RouteListItem } from './api.ts';

export interface ModeVehicles {
  modeId: string;
  pack: Pack;
  /** RGB per trip, from its route colour. */
  tripColor: Uint8Array;
  /** Pack index by database trip id. */
  indexByTripId: Map<number, number>;
  // Per-frame output, reused between frames.
  positions: Float64Array;
  colors: Uint8Array;
  /** Pack trip index of each vehicle drawn this frame. */
  frameTrip: Int32Array;
  count: number;
  /** How many of those are standing at the end of a trip, waiting to start their next one. */
  waiting: number;
  /**
   * Per trip: the second its vehicle's next trip starts, when the vehicle waits where the trip ends
   * (see vehicleWaits in @gtfs-editor/core). 0 when there is no wait to draw.
   */
  holdUntil: Int32Array;
  /** Where each trip with a wait ends, [lon, lat], worked out once so a waiting vehicle costs a frame almost nothing. */
  endPos: Float64Array;
  /** 1 for trips the open scenario has removed or replaced; they are not drawn. */
  removed: Uint8Array | null;
  /** Mode of each trip, for packs that mix modes (the scenario's own trips). */
  tripMode: string[] | null;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

let removedTripIds: number[] = [];

function removedMask(mv: ModeVehicles): Uint8Array | null {
  let mask: Uint8Array | null = null;
  for (const id of removedTripIds) {
    const i = mv.indexByTripId.get(id);
    if (i === undefined) continue;
    mask ??= new Uint8Array(mv.pack.meta.tripCount);
    mask[i] = 1;
  }
  return mask;
}

/** Hides these baseline trips on the map (the open scenario has removed or replaced them). */
export function applyRemovedTrips(ids: number[]) {
  removedTripIds = ids;
  for (const mv of vehicleData.values()) if (mv.modeId !== 'scenario') mv.removed = removedMask(mv);
}

// Waits between trips, as pairs [trip id, the second the vehicle's next trip starts]. They come from
// the server separately from the packs, because they depend on the vehicle days, which a scenario changes.
let waits: Int32Array = new Int32Array(0);
let waitsRequest = 0;

/** Counts up whenever what is drawn at a given time has changed, so the map redraws even when paused. */
export const vehicleFrames = { version: 0 };

function setHolds(mv: ModeVehicles) {
  const { pack, holdUntil, endPos, indexByTripId } = mv;
  holdUntil.fill(0);
  for (let k = 0; k + 1 < waits.length; k += 2) {
    const i = indexByTripId.get(waits[k]);
    if (i === undefined) continue;
    if (tripPosition(pack, i, pack.tripEnd[i], endPos, i * 2)) holdUntil[i] = waits[k + 1];
  }
}

/**
 * Fetches how long each vehicle waits at the end of each trip, for the published timetable or for a
 * scenario, and applies it to the vehicles loaded. Without it the map still works: vehicles are then
 * drawn only while a trip is running.
 */
export async function loadWaits(baselineId: number, scenarioId: number | null): Promise<void> {
  const request = ++waitsRequest;
  try {
    const res = await fetch(
      `/api/baselines/${baselineId}/waits${scenarioId === null ? '' : `?s=${scenarioId}`}`,
    );
    if (!res.ok) throw new Error(`Vehicle waits responded ${res.status}`);
    const pairs = new Int32Array(await res.arrayBuffer());
    if (request !== waitsRequest) return; // a newer request has been made since
    waits = pairs;
  } catch (err) {
    console.error('Failed to load the waits between trips', err);
    if (request !== waitsRequest) return;
    waits = new Int32Array(0);
  }
  applyWaits();
}

/** Puts the waits last fetched onto every set of vehicles loaded; called again when a set is replaced. */
export function applyWaits() {
  for (const mv of vehicleData.values()) setHolds(mv);
  vehicleFrames.version++;
}

/** The scenario's own trips, across all modes, as one extra set of vehicles. */
export async function loadScenarioVehicles(
  scenarioId: number,
  routes: Map<number, RouteListItem>,
): Promise<ModeVehicles> {
  const res = await fetch(`/api/scenarios/${scenarioId}/pack`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Scenario vehicle data responded ${res.status}`);
  const mv = build(decodePack(await res.arrayBuffer()), 'scenario', routes, '888888');
  mv.tripMode = Array.from(mv.pack.tripRoute, (routeId) => routes.get(routeId)?.modeId ?? 'bus');
  return mv;
}

export async function loadModeVehicles(
  baselineId: number,
  modeId: string,
  routes: Map<number, RouteListItem>,
  fallbackColor: string,
): Promise<ModeVehicles> {
  const res = await fetch(`/api/baselines/${baselineId}/packs/${modeId}`);
  if (!res.ok) throw new Error(`Vehicle data for ${modeId} responded ${res.status}`);
  const mv = build(decodePack(await res.arrayBuffer()), modeId, routes, fallbackColor);
  mv.removed = removedMask(mv);
  return mv;
}

function build(
  pack: Pack,
  modeId: string,
  routes: Map<number, RouteListItem>,
  fallbackColor: string,
): ModeVehicles {
  const n = pack.meta.tripCount;
  const tripColor = new Uint8Array(n * 3);
  const indexByTripId = new Map<number, number>();
  const fallback = hexToRgb(fallbackColor);
  for (let i = 0; i < n; i++) {
    const route = routes.get(pack.tripRoute[i]);
    const [r, g, b] = route ? hexToRgb(route.color) : fallback;
    tripColor[i * 3] = r;
    tripColor[i * 3 + 1] = g;
    tripColor[i * 3 + 2] = b;
    indexByTripId.set(pack.tripId[i], i);
  }
  const mv: ModeVehicles = {
    modeId,
    pack,
    tripColor,
    indexByTripId,
    positions: new Float64Array(n * 2),
    colors: new Uint8Array(n * 4),
    frameTrip: new Int32Array(n),
    count: 0,
    waiting: 0,
    holdUntil: new Int32Array(n),
    endPos: new Float64Array(n * 2),
    removed: null,
    tripMode: null,
  };
  setHolds(mv);
  return mv;
}

/**
 * Where the vehicle of pack trip `i` is at `secs`, written into `out`: along its trip, or standing
 * where the trip ended while it waits for its next one. Returns false when it is not on the map.
 */
export function vehicleAt(
  mv: ModeVehicles,
  i: number,
  secs: number,
  out: Float64Array,
  outIndex: number,
): boolean {
  const state = vehicleState(mv.pack.tripStart[i], mv.pack.tripEnd[i], mv.holdUntil[i], secs);
  if (state === VEHICLE_GONE) return false;
  if (state === VEHICLE_WAITING) {
    out[outIndex] = mv.endPos[i * 2];
    out[outIndex + 1] = mv.endPos[i * 2 + 1];
    return true;
  }
  return tripPosition(mv.pack, i, secs, out, outIndex);
}

/** When the vehicle of pack trip `i` leaves on its next trip, if it is waiting for it at `secs`; otherwise null. */
export function waitingUntil(mv: ModeVehicles, i: number, secs: number): number | null {
  return vehicleState(mv.pack.tripStart[i], mv.pack.tripEnd[i], mv.holdUntil[i], secs) ===
    VEHICLE_WAITING
    ? mv.holdUntil[i]
    : null;
}

/**
 * Fills the per-frame buffers with every vehicle on the map at `secs`: those running a trip, and those
 * standing at the end of one until their next trip starts. Returns how many there are.
 */
export function computeFrame(
  mv: ModeVehicles,
  secs: number,
  enabledModes?: Record<string, boolean>,
): number {
  const { pack, positions, colors, frameTrip, tripColor, removed, tripMode, holdUntil, endPos } =
    mv;
  const n = pack.meta.tripCount;
  // Trips are sorted by start time: everything from `end` onward has not started yet.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pack.tripStart[mid] <= secs) lo = mid + 1;
    else hi = mid;
  }
  let count = 0;
  let waiting = 0;
  for (let i = 0; i < lo; i++) {
    // The same rule as vehicleState in @gtfs-editor/core, written out because this runs for every
    // trip that has started, every frame.
    const ended = pack.tripEnd[i] < secs;
    if (ended && holdUntil[i] <= secs) continue;
    if (removed && removed[i]) continue;
    if (tripMode && enabledModes && !enabledModes[tripMode[i]]) continue;
    if (ended) {
      positions[count * 2] = endPos[i * 2];
      positions[count * 2 + 1] = endPos[i * 2 + 1];
      waiting++;
    } else if (!tripPosition(pack, i, secs, positions, count * 2)) continue;
    colors[count * 4] = tripColor[i * 3];
    colors[count * 4 + 1] = tripColor[i * 3 + 1];
    colors[count * 4 + 2] = tripColor[i * 3 + 2];
    colors[count * 4 + 3] = 255;
    frameTrip[count] = i;
    count++;
  }
  mv.count = count;
  mv.waiting = waiting;
  return count;
}

/** Number of vehicles running in each time bin across the day, for the scrubber backdrop. */
export function activityHistogram(
  all: ModeVehicles[],
  maxSecs: number,
  binSecs: number,
): Uint32Array {
  const bins = new Uint32Array(Math.ceil(maxSecs / binSecs) + 1);
  for (const { pack, removed } of all) {
    for (let i = 0; i < pack.meta.tripCount; i++) {
      if (removed && removed[i]) continue;
      const from = Math.max(0, Math.floor(pack.tripStart[i] / binSecs));
      const to = Math.min(bins.length - 1, Math.floor(pack.tripEnd[i] / binSecs));
      for (let b = from; b <= to; b++) bins[b]++;
    }
  }
  return bins;
}

// Loaded vehicle data lives outside React: it is large and read every frame.
export const vehicleData = new Map<string, ModeVehicles>();
