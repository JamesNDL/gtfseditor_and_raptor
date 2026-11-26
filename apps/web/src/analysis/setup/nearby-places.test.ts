// D41: the setup lists the saved places near where the map is looking, plus the picked ones, and
// "Show all" lists every one.
import type { GeoJsonPosition, PointOfInterest, Zone } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import type { MapBounds } from '../../shared/map-bounds.ts';
import { nearbyPois, nearbyZones } from './nearby-places.ts';

const square = (lon: number, lat: number): GeoJsonPosition[] => [
  [lon, lat],
  [lon + 0.02, lat],
  [lon + 0.02, lat + 0.02],
  [lon, lat + 0.02],
];
const zone = (id: number, name: string, lon: number, lat: number): Zone => ({
  id,
  name,
  ring: square(lon, lat),
  createdAt: '2026-11-26T00:00:00Z',
});
const poi = (id: number, name: string, lon: number, lat: number): PointOfInterest => ({
  id,
  name,
  kind: 'place',
  source: 'drawn',
  lon,
  lat,
});

const ZONES = [zone(1, 'Mayfield', 151.73, -32.9), zone(2, 'Dee Why', 151.28, -33.76)];
const POIS = [
  poi(3, 'Westfield Kotara', 151.7, -32.94),
  poi(4, 'Dee Why beach', 151.3, -33.75),
  poi(5, 'Northern Beaches Hospital', 151.24, -33.75),
];
/** Looking at Dee Why and Frenchs Forest. */
const DEE_WHY: MapBounds = { west: 151.2, south: -33.8, east: 151.33, north: -33.7 };
const names = (places: { name: string }[]) => places.map((p) => p.name);

describe('nearbyZones', () => {
  it('lists only the zones on screen', () => {
    expect(nearbyZones(ZONES, DEE_WHY, null, false)).toEqual({ shown: [ZONES[1]], hidden: 1 });
  });

  it('keeps the picked zone listed wherever it is', () => {
    expect(names(nearbyZones(ZONES, DEE_WHY, 1, false).shown)).toEqual(['Mayfield', 'Dee Why']);
  });

  it('counts a zone that only crosses into the screen as near', () => {
    const edge: MapBounds = { west: 151.29, south: -33.75, east: 151.4, north: -33.7 };
    expect(names(nearbyZones(ZONES, edge, null, false).shown)).toEqual(['Dee Why']);
  });

  it('lists every zone with Show all, or before the map has loaded', () => {
    expect(nearbyZones(ZONES, DEE_WHY, null, true)).toEqual({ shown: ZONES, hidden: 0 });
    expect(nearbyZones(ZONES, null, null, false)).toEqual({ shown: ZONES, hidden: 0 });
  });
});

describe('nearbyPois', () => {
  it('lists only the points of interest on screen', () => {
    const { shown, hidden } = nearbyPois(POIS, DEE_WHY, [], false);
    expect(names(shown)).toEqual(['Dee Why beach', 'Northern Beaches Hospital']);
    expect(hidden).toBe(1);
  });

  it('counts a point just off screen as near', () => {
    // A quarter of the screen's width beyond its west edge still counts.
    const west: MapBounds = { ...DEE_WHY, west: 151.25 };
    expect(names(nearbyPois(POIS, west, [], false).shown)).toContain('Northern Beaches Hospital');
  });

  it('keeps picked points listed wherever they are', () => {
    expect(names(nearbyPois(POIS, DEE_WHY, [3], false).shown)).toEqual(names(POIS));
  });

  it('lists every point with Show all', () => {
    expect(nearbyPois(POIS, DEE_WHY, [], true)).toEqual({ shown: POIS, hidden: 0 });
  });
});
