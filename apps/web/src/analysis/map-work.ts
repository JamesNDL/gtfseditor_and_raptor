// The Access pane's map editor tools (FR-4, FR-5; D36): Draw zone and Place point of interest,
// picked from the tool bar on the map. Draw zone takes a click per corner and closes on the first
// corner (or a double click); Place point of interest drops a pin. Either then opens a name box on
// the map, which also renames a saved pin that is clicked. This is `work` in the pane's view
// state; what is saved is in map-editor/map-actions.ts.
import { ringProblem, type GeoJsonPosition, type PointOfInterest } from '@gtfs-editor/core';
import { zoneAnchor } from './zone-edit.ts';

export type MapTool = 'zone' | 'poi';

/** What the map editor is doing. */
export interface MapWork {
  /** The tool in use, or null. */
  tool: MapTool | null;
  /** The corners of the zone being drawn, in the order clicked. */
  corners: GeoJsonPosition[];
  /** The outline is closed and waits for its name. */
  closed: boolean;
  /** Why the outline could not be closed (AC-FR-4.2), or null. */
  problem: string | null;
  /** Where a new point of interest's pin was dropped, waiting for its name, or null. */
  pendingPoi: GeoJsonPosition | null;
  /** The saved point of interest whose name box is open, or null. */
  renamingPoiId: number | null;
}

/** No tool in use and nothing waiting. */
export const NO_MAP_WORK: MapWork = {
  tool: null,
  corners: [],
  closed: false,
  problem: null,
  pendingPoi: null,
  renamingPoiId: null,
};

/** How near the first corner, in pixels, a click closes the outline being drawn. */
export const CLOSE_REACH_PX = 10;
/** A click this near the last corner, in pixels, is the second click of a double click. */
export const REPEAT_REACH_PX = 4;

/** True while a click on the map belongs to the map editor, and so does nothing else. */
export const isMapBusy = (work: MapWork): boolean =>
  work.tool !== null || work.renamingPoiId !== null;

/** Picks a tool, forgetting anything else on the go; picking the tool in use puts it down. */
export const pickTool = (work: MapWork, tool: MapTool): MapWork =>
  work.tool === tool ? NO_MAP_WORK : { ...NO_MAP_WORK, tool };

const samePlace = (a: GeoJsonPosition, b: GeoJsonPosition): boolean =>
  a[0] === b[0] && a[1] === b[1];

/** Adds a corner to an open outline. A corner repeating the last one (a double click) is dropped. */
export function addCorner(work: MapWork, corner: GeoJsonPosition): MapWork {
  if (work.tool !== 'zone' || work.closed) return work;
  const last = work.corners[work.corners.length - 1];
  if (last && samePlace(last, corner)) return work;
  return { ...work, corners: [...work.corners, corner], problem: null };
}

/** Opens a closed outline again, or else takes off its last corner (Backspace). */
export function undoCorner(work: MapWork): MapWork {
  if (work.tool !== 'zone') return work;
  if (work.closed) return { ...work, closed: false };
  return { ...work, corners: work.corners.slice(0, -1), problem: null };
}

/**
 * Closes the outline, ready to be named, or keeps it open with the reason it cannot be a zone
 * (AC-FR-4.2). The first corner clicked again at the end is not a corner of its own.
 */
export function closeDrawing(work: MapWork): MapWork {
  if (work.tool !== 'zone' || work.closed) return work;
  const corners = work.corners;
  const ring =
    corners.length > 1 && samePlace(corners[0], corners[corners.length - 1])
      ? corners.slice(0, -1)
      : corners;
  const problem = ringProblem(ring);
  if (problem) return { ...work, problem };
  return { ...work, corners: ring, closed: true, problem: null };
}

/** Whether a click closes the outline: it has three corners and the click is by the first. */
export function closesOutline(
  work: MapWork,
  pixelsTo: (corner: GeoJsonPosition) => number,
): boolean {
  if (work.tool !== 'zone' || work.closed || work.corners.length < 3) return false;
  return pixelsTo(work.corners[0]) <= CLOSE_REACH_PX;
}

/** Drops (or moves) the new point of interest's pin, which then waits for its name. */
export const dropPoi = (work: MapWork, at: GeoJsonPosition): MapWork =>
  work.tool === 'poi' ? { ...work, pendingPoi: at } : work;

/** Opens the name box of a saved point of interest, putting down any tool. */
export const startRenaming = (_work: MapWork, id: number): MapWork => ({
  ...NO_MAP_WORK,
  renamingPoiId: id,
});

/** Lets go of a deleted point of interest whose name box is open. */
export const forgetPoiWork = (work: MapWork, id: number): MapWork =>
  work.renamingPoiId === id ? NO_MAP_WORK : work;

/** What the name box is for, the place it sits above, and what it starts with. */
export interface NameBoxSpec {
  kind: 'zone' | 'new-poi' | 'rename-poi';
  anchor: GeoJsonPosition;
  /** Read out by screen readers and shown as the box's placeholder. */
  label: string;
  initial: string;
}

/** The name box to show, or null when nothing waits for a name. */
export function nameBoxFor(work: MapWork, pois: PointOfInterest[] | null): NameBoxSpec | null {
  if (work.tool === 'zone' && work.closed) {
    return {
      kind: 'zone',
      anchor: zoneAnchor(work.corners),
      label: 'Name of the zone',
      initial: '',
    };
  }
  if (work.tool === 'poi' && work.pendingPoi) {
    const label = 'Name of the point of interest';
    return { kind: 'new-poi', anchor: work.pendingPoi, label, initial: '' };
  }
  const poi = pois?.find((p) => p.id === work.renamingPoiId);
  if (!poi) return null;
  return {
    kind: 'rename-poi',
    anchor: [poi.lon, poi.lat],
    label: 'New name for the point of interest',
    initial: poi.name,
  };
}

/** What to do next with the tool in use, shown beside the tool bar; null with no tool. */
export function toolHint(work: MapWork): string | null {
  if (work.tool === 'poi') {
    return work.pendingPoi
      ? 'Name the point of interest. Click elsewhere to move the pin.'
      : 'Click the map where the point of interest is.';
  }
  if (work.tool !== 'zone') return null;
  if (work.closed) return 'Name the zone.';
  const count = work.corners.length;
  const next =
    count === 0
      ? 'Click the map to place the first corner of the zone.'
      : count < 3
        ? 'Click the map to place the next corner. Backspace takes off the last.'
        : 'Click the first corner or double-click to finish. Backspace takes off the last corner.';
  return work.problem ? `${work.problem} ${next}` : next;
}
