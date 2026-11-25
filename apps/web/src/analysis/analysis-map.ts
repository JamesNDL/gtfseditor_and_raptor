// What a click on the map does for the Access pane (docs/architecture/access-analysis.md §5.2,
// D29, D36): with Draw zone it adds a corner (or closes the outline); with Place point of interest
// it drops the pin; with no tool, on the setup, a click on a saved pin opens its name box. The
// map's click handler asks here first and does nothing else when the answer is true, so no vehicle
// or stop opens while a tool is in use. On the results, it picks the sample point clicked (FR-15).
import type { GeoJsonPosition } from '@gtfs-editor/core';
import { useStore } from '../app/store.ts';
import { usePlaces } from './analysis-api.ts';
import { useAnalysisResults } from './analysis-results.ts';
import type { AnalysisView } from './analysis-state.ts';
import {
  NO_MAP_WORK,
  REPEAT_REACH_PX,
  addCorner,
  closeDrawing,
  closesOutline,
  dropPoi,
  startRenaming,
  type MapWork,
} from './map-work.ts';

const view = (): AnalysisView => useStore.getState().analysis;
const setView = (analysis: AnalysisView): void => useStore.getState().set({ analysis });
const setWork = (work: MapWork): void => setView({ ...view(), work });

/** How near a saved pin, in pixels, a click opens its name box. */
export const PIN_REACH_PX = 10;

/** How near a sample point, in pixels, a click picks it (FR-15). */
export const PICK_REACH_PX = 12;

/**
 * On the results, picks the sample point nearest the click within PICK_REACH_PX (AC-FR-15.1), or
 * lets go of the one picked when the click is away from every one (AC 4). Answers whether it used
 * the click: a click away with nothing picked is left to the map.
 */
function pickSamplePoint(
  current: AnalysisView,
  pixelsTo: (place: GeoJsonPosition) => number,
): boolean {
  const { points, poiSeq } = useAnalysisResults.getState();
  const onResults =
    useStore.getState().leftPane === 'analysis' && current.screen === 'results' && points !== null;
  // The points still on show may be for the point of interest chosen before; wait for the new ones.
  if (!onResults || poiSeq !== current.poiSeq) return false;
  let nearest: { seq: number; px: number } | null = null;
  for (const sample of points.features) {
    const px = pixelsTo(sample.geometry.coordinates);
    if (px <= PICK_REACH_PX && (nearest === null || px < nearest.px)) {
      nearest = { seq: sample.properties.seq, px };
    }
  }
  if (nearest !== null) {
    setView({ ...current, pointSeq: nearest.seq });
    return true;
  }
  if (current.pointSeq === null) return false;
  setView({ ...current, pointSeq: null });
  return true;
}

/** A click while drawing a zone: a corner, the outline closed, or nothing once it is closed. */
function zoneClick(
  work: MapWork,
  at: GeoJsonPosition,
  pixelsTo: (place: GeoJsonPosition) => number,
): void {
  // A closed outline waiting for its name takes no more corners; the click still goes nowhere.
  if (work.closed) return;
  if (closesOutline(work, pixelsTo)) return setWork(closeDrawing(work));
  const last = work.corners[work.corners.length - 1];
  // The second click of a double click (which finishes the outline) is not a corner of its own.
  if (last && pixelsTo(last) <= REPEAT_REACH_PX) return;
  setWork(addCorner(work, at));
}

/** On the setup with no tool, the saved pin under the click, if any. */
function pinAt(current: AnalysisView, pixelsTo: (place: GeoJsonPosition) => number): number | null {
  if (useStore.getState().leftPane !== 'analysis' || current.screen !== 'setup') return null;
  let nearest: { id: number; px: number } | null = null;
  for (const poi of usePlaces.getState().pois ?? []) {
    const px = pixelsTo([poi.lon, poi.lat]);
    if (px <= PIN_REACH_PX && (nearest === null || px < nearest.px)) nearest = { id: poi.id, px };
  }
  return nearest?.id ?? null;
}

/**
 * Uses a click on the map at (lon, lat) for the Access pane, and answers whether it did.
 * `pixelsTo` measures, in screen pixels, from the click to a given place, so that a click on the
 * first corner closes the outline and a click on a pin opens its name box.
 */
export function analysisMapClick(
  lon: number,
  lat: number,
  pixelsTo: (place: GeoJsonPosition) => number,
): boolean {
  const current = view();
  const { work } = current;
  if (work.tool === 'zone') {
    zoneClick(work, [lon, lat], pixelsTo);
    return true;
  }
  if (work.tool === 'poi') {
    setWork(dropPoi(work, [lon, lat]));
    return true;
  }
  // A click away from an open name box closes it.
  if (work.renamingPoiId !== null) {
    setWork(NO_MAP_WORK);
    return true;
  }
  const pin = pinAt(current, pixelsTo);
  if (pin !== null) {
    setWork(startRenaming(work, pin));
    return true;
  }
  return pickSamplePoint(current, pixelsTo);
}
