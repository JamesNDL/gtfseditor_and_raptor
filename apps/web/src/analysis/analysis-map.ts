// What a click on the map does for the Access pane (docs/architecture/access-analysis.md §5.2,
// D29): it adds a corner to the zone being drawn (or closes it), places a new point of interest,
// or moves one. The map's click handler asks here first and does nothing else when the answer is
// true, so no vehicle or stop opens while drawing or placing. On the results, it picks the sample
// point clicked (FR-15).
import type { GeoJsonPosition } from '@gtfs-editor/core';
import { useStore } from '../app/store.ts';
import { movePoi, savePoi, usePlaces } from './analysis-api.ts';
import { useAnalysisResults } from './analysis-results.ts';
import {
  addCorner,
  closeDrawing,
  closesOutline,
  isMapBusy,
  togglePoi,
  type AnalysisView,
} from './analysis-state.ts';

const view = (): AnalysisView => useStore.getState().analysis;
const setView = (analysis: AnalysisView): void => useStore.getState().set({ analysis });

/** Places the new point of interest, and picks it for the analysis being set up. */
async function place(name: string, lon: number, lat: number): Promise<void> {
  const poi = await savePoi({ name, lon, lat });
  setView(togglePoi(view(), poi.id));
}

/** Runs a change to a point of interest, showing the API's words if it fails. */
function poiChange(change: Promise<void>): void {
  usePlaces.setState({ poiError: null });
  change.catch((e: Error) => usePlaces.setState({ poiError: e.message }));
}

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

/**
 * Uses a click on the map at (lon, lat) for the Access pane's map work, and answers whether it did.
 * `pixelsTo` measures, in screen pixels, from the click to a given place, so that a click on the
 * first corner closes the outline.
 */
export function analysisMapClick(
  lon: number,
  lat: number,
  pixelsTo: (place: GeoJsonPosition) => number,
): boolean {
  const current = view();
  if (!isMapBusy(current)) return pickSamplePoint(current, pixelsTo);
  if (current.drawing !== null) {
    // A closed outline waiting for its name takes no more corners; the click still goes nowhere.
    if (current.drawingClosed) return true;
    setView(
      closesOutline(current, pixelsTo) ? closeDrawing(current) : addCorner(current, [lon, lat]),
    );
    return true;
  }
  // The wait ends with this click, so a second click cannot place or move it twice.
  setView({ ...current, placingPoi: null, movingPoiId: null });
  if (current.placingPoi !== null) poiChange(place(current.placingPoi, lon, lat));
  else if (current.movingPoiId !== null) poiChange(movePoi(current.movingPoiId, lon, lat));
  return true;
}
