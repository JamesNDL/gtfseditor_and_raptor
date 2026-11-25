// Reshaping a saved zone on the map (FR-4; D37). The picked zone shows a handle at each corner
// and a smaller one in the middle of each side. Dragging a corner moves it; dragging the middle of
// a side adds a corner there. The new outline is saved when the drag ends (map-actions.ts).
import type { GeoJsonPosition } from '@gtfs-editor/core';

/** How near a handle, in pixels, a press picks it up. */
export const HANDLE_REACH_PX = 9;

/** A corner (by its place in the ring) or the middle of a side (side i runs from corner i). */
export interface ZoneHandle {
  kind: 'corner' | 'middle';
  index: number;
}

/** The middle of each side, side i joining corner i to the next (the last to the first). */
export const edgeMiddles = (ring: readonly GeoJsonPosition[]): GeoJsonPosition[] =>
  ring.map(([lon, lat], i) => {
    const [nextLon, nextLat] = ring[(i + 1) % ring.length];
    return [(lon + nextLon) / 2, (lat + nextLat) / 2];
  });

/** The handle a press lands on, corners before middles, or null when none is within reach. */
export function handleAt(
  ring: readonly GeoJsonPosition[],
  pixelsTo: (place: GeoJsonPosition) => number,
): ZoneHandle | null {
  const nearest = (places: readonly GeoJsonPosition[]): { index: number; px: number } | null => {
    let best: { index: number; px: number } | null = null;
    for (const [index, place] of places.entries()) {
      const px = pixelsTo(place);
      if (px <= HANDLE_REACH_PX && (best === null || px < best.px)) best = { index, px };
    }
    return best;
  };
  const corner = nearest(ring);
  const middle = nearest(edgeMiddles(ring));
  if (corner && (!middle || corner.px <= middle.px)) return { kind: 'corner', index: corner.index };
  return middle ? { kind: 'middle', index: middle.index } : null;
}

/** The outline with the handle dragged to `at`: a corner moved, or a corner added mid-side. */
export function dragRing(
  ring: readonly GeoJsonPosition[],
  handle: ZoneHandle,
  at: GeoJsonPosition,
): GeoJsonPosition[] {
  if (handle.kind === 'corner') return ring.map((corner, i) => (i === handle.index ? at : corner));
  return [...ring.slice(0, handle.index + 1), at, ...ring.slice(handle.index + 1)];
}

/** Where a zone's name box sits: the middle of the top edge of the box round the outline. */
export function zoneAnchor(ring: readonly GeoJsonPosition[]): GeoJsonPosition {
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, Math.max(...lats)];
}
