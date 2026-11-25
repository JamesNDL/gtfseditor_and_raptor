// What the map editor is dragging, and where the pointer is while a zone is drawn, kept apart
// from the app store because it changes with every move of the mouse. The map's place layers
// (map/use-analysis-layers.ts) draw from it: a pin or a zone where it is being dragged to, and the
// line from the last corner to the pointer.
import type { GeoJsonPosition } from '@gtfs-editor/core';
import { create } from 'zustand';

export interface MapDrag {
  /** The pointer over the map while a zone is being drawn, or null. */
  pointer: GeoJsonPosition | null;
  /** A saved point of interest being dragged, and where to. */
  poi: { id: number; at: GeoJsonPosition } | null;
  /** A saved zone being reshaped, and its outline so far. */
  zone: { id: number; ring: GeoJsonPosition[] } | null;
}

export const useMapDrag = create<MapDrag>(() => ({ pointer: null, poi: null, zone: null }));
