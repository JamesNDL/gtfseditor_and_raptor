// What the map shows on screen, kept up to date as it moves, for parts that list things near
// where the owner is looking (the Access pane's saved zones and points of interest, D41).
import { create } from 'zustand';

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The map's bounds after it last stopped moving, or null before it has loaded. */
export const useMapBounds = create<{ bounds: MapBounds | null }>(() => ({ bounds: null }));
