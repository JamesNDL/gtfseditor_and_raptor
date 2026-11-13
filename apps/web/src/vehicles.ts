// Loads animation packs and works out where every vehicle is at a given time.
import { decodePack, tripPosition, type Pack } from '@gtfs-editor/core';
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

/** The scenario's own trips, across all modes, as one extra set of vehicles. */
export async function loadScenarioVehicles(scenarioId: number, routes: Map<number, RouteListItem>): Promise<ModeVehicles> {
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

function build(pack: Pack, modeId: string, routes: Map<number, RouteListItem>, fallbackColor: string): ModeVehicles {
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
  return {
    modeId,
    pack,
    tripColor,
    indexByTripId,
    positions: new Float64Array(n * 2),
    colors: new Uint8Array(n * 4),
    frameTrip: new Int32Array(n),
    count: 0,
    removed: null,
    tripMode: null,
  };
}

/** Fills the per-frame buffers with every vehicle running at `secs`. Returns how many there are. */
export function computeFrame(mv: ModeVehicles, secs: number, enabledModes?: Record<string, boolean>): number {
  const { pack, positions, colors, frameTrip, tripColor, removed, tripMode } = mv;
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
  for (let i = 0; i < lo; i++) {
    if (pack.tripEnd[i] < secs) continue;
    if (removed && removed[i]) continue;
    if (tripMode && enabledModes && !enabledModes[tripMode[i]]) continue;
    if (!tripPosition(pack, i, secs, positions, count * 2)) continue;
    colors[count * 4] = tripColor[i * 3];
    colors[count * 4 + 1] = tripColor[i * 3 + 1];
    colors[count * 4 + 2] = tripColor[i * 3 + 2];
    colors[count * 4 + 3] = 255;
    frameTrip[count] = i;
    count++;
  }
  mv.count = count;
  return count;
}

/** Number of vehicles running in each time bin across the day, for the scrubber backdrop. */
export function activityHistogram(all: ModeVehicles[], maxSecs: number, binSecs: number): Uint32Array {
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
