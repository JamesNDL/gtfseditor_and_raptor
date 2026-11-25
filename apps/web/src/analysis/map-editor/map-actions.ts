// What the map editor saves (FR-4, FR-5): the name box's Save (a new zone, a new point of interest
// or a new name), its Cancel, a pin dragged to a new place and a zone reshaped by its handles.
// A new zone is picked for the analysis being set up and a new point of interest ticked, as the
// side panel did before the tool bar.
import { ringProblem, type GeoJsonPosition } from '@gtfs-editor/core';
import { useStore } from '../../app/store.ts';
import { movePoi, renamePoi, reshapeZone, saveZone, savePoi, usePlaces } from '../analysis-api.ts';
import { pickZone, togglePoi, type AnalysisView } from '../analysis-state.ts';
import { useMapDrag } from '../map-drag.ts';
import { NO_MAP_WORK } from '../map-work.ts';

const view = (): AnalysisView => useStore.getState().analysis;
const setView = (analysis: AnalysisView): void => useStore.getState().set({ analysis });
const done = (next: AnalysisView): void => setView({ ...next, work: NO_MAP_WORK });

/**
 * Saves what the name box is naming under `name`. Fails with the API's words, leaving the box
 * open, so that the box can show them.
 */
export async function saveName(name: string): Promise<void> {
  const { work } = view();
  if (work.tool === 'zone' && work.closed) {
    const zone = await saveZone({ name, ring: work.corners });
    done(pickZone(view(), zone.id));
  } else if (work.tool === 'poi' && work.pendingPoi) {
    const [lon, lat] = work.pendingPoi;
    const poi = await savePoi({ name, lon, lat });
    done(togglePoi(view(), poi.id));
  } else if (work.renamingPoiId !== null) {
    await renamePoi(work.renamingPoiId, name);
    done(view());
  }
}

/** Closes the name box, forgetting the outline or the pin waiting for a name. */
export const cancelName = (): void => done(view());

/** Saves a dragged pin's new place; a refusal shows in the side panel and the pin goes back. */
export async function movePoiTo(id: number, at: GeoJsonPosition): Promise<void> {
  usePlaces.setState({ poiError: null });
  try {
    await movePoi(id, at[0], at[1]);
  } catch (e) {
    usePlaces.setState({ poiError: e instanceof Error ? e.message : String(e) });
  } finally {
    useMapDrag.setState({ poi: null });
  }
}

/**
 * Saves a zone's new outline. One the API would refuse (AC-FR-4.2) is refused here at once, with
 * the same words; either way a refused outline goes back to the saved one.
 */
export async function reshapeZoneTo(id: number, ring: GeoJsonPosition[]): Promise<void> {
  usePlaces.setState({ zoneError: null });
  try {
    const problem = ringProblem(ring);
    if (problem) throw new Error(problem);
    await reshapeZone(id, ring);
  } catch (e) {
    usePlaces.setState({ zoneError: e instanceof Error ? e.message : String(e) });
  } finally {
    useMapDrag.setState({ zone: null });
  }
}
