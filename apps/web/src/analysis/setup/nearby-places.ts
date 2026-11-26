// Which saved zones and points of interest an analysis's setup shows (D41). Places are saved for
// reuse across analyses, but a Dee Why analysis has no use for Newcastle's: the lists show the
// places on screen plus the ones already picked, and "Show all" brings back the rest.
import type { PointOfInterest, Zone } from '@gtfs-editor/core';
import type { MapBounds } from '../../shared/map-bounds.ts';

/** How much bigger than the screen, on each side, still counts as near. */
const MARGIN = 0.25;

function widened(b: MapBounds): MapBounds {
  const dx = (b.east - b.west) * MARGIN;
  const dy = (b.north - b.south) * MARGIN;
  return { west: b.west - dx, south: b.south - dy, east: b.east + dx, north: b.north + dy };
}

const inside = (b: MapBounds, lon: number, lat: number): boolean =>
  lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;

/** Whether any of a zone's outline box overlaps the bounds. */
function zoneTouches(b: MapBounds, zone: Zone): boolean {
  const lons = zone.ring.map((p) => p[0]);
  const lats = zone.ring.map((p) => p[1]);
  return (
    Math.min(...lons) <= b.east &&
    Math.max(...lons) >= b.west &&
    Math.min(...lats) <= b.north &&
    Math.max(...lats) >= b.south
  );
}

export interface Shown<T> {
  /** The places to list, in their saved order. */
  shown: T[];
  /** How many saved places are left out. */
  hidden: number;
}

function choose<T extends { id: number }>(
  all: T[],
  picked: (id: number) => boolean,
  near: (place: T) => boolean,
  showAll: boolean,
): Shown<T> {
  if (showAll) return { shown: all, hidden: 0 };
  const shown = all.filter((place) => picked(place.id) || near(place));
  return { shown, hidden: all.length - shown.length };
}

/** The zones to list: those on or near the screen, and the picked one. With no bounds, all. */
export function nearbyZones(
  zones: Zone[],
  bounds: MapBounds | null,
  zoneId: number | null,
  showAll: boolean,
): Shown<Zone> {
  if (!bounds) return { shown: zones, hidden: 0 };
  const b = widened(bounds);
  return choose(
    zones,
    (id) => id === zoneId,
    (z) => zoneTouches(b, z),
    showAll,
  );
}

/** The points of interest to list: those on or near the screen, and the picked ones. */
export function nearbyPois(
  pois: PointOfInterest[],
  bounds: MapBounds | null,
  poiIds: number[],
  showAll: boolean,
): Shown<PointOfInterest> {
  if (!bounds) return { shown: pois, hidden: 0 };
  const b = widened(bounds);
  return choose(
    pois,
    (id) => poiIds.includes(id),
    (p) => inside(b, p.lon, p.lat),
    showAll,
  );
}
