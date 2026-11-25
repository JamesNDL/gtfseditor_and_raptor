// The basemap: the picture of streets, land and water under everything the app draws. It is
// chosen apart from the app's light or dark theme; until one is chosen it follows the theme, as
// it always did. Light, Streets and Dark are OpenFreeMap styles; Satellite is Esri's World
// Imagery (no key), built here as a style of its own. See docs/architecture/system.md D35.
import type { StyleSpecification } from 'maplibre-gl';
import type { Theme } from '../app/theme.ts';

export type Basemap = 'light' | 'streets' | 'dark' | 'satellite';

interface BasemapInfo {
  id: Basemap;
  name: string;
  /** What it shows, for the button's tip. */
  hint: string;
}

/** The basemaps to choose from, in the order the picker lists them. */
export const BASEMAPS: readonly BasemapInfo[] = [
  { id: 'light', name: 'Light', hint: 'A pale map that keeps the lines easy to read' },
  {
    id: 'streets',
    name: 'Streets',
    hint: 'Buildings, shops, hospitals and house numbers',
  },
  { id: 'dark', name: 'Dark', hint: 'A dark map that keeps the lines easy to read' },
  { id: 'satellite', name: 'Satellite', hint: 'Aerial photos, with place names' },
];

const OPENFREEMAP = 'https://tiles.openfreemap.org';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

/** The basemap on show: the one chosen, or else the one that goes with the theme. */
export const shownBasemap = (choice: Basemap | null, theme: Theme): Basemap =>
  choice ?? (theme === 'light' ? 'light' : 'dark');

/** A remembered choice read back, or null for none (or for one this version does not know). */
export function parseBasemap(stored: string | null): Basemap | null {
  return BASEMAPS.find((b) => b.id === stored)?.id ?? null;
}

/** Esri's aerial photos, with its place names and borders on top. */
function satelliteStyle(): StyleSpecification {
  const raster = (path: string, attribution?: string) => ({
    type: 'raster' as const,
    tiles: [`${ESRI}/${path}/MapServer/tile/{z}/{y}/{x}`],
    tileSize: 256,
    maxzoom: 19,
    ...(attribution && { attribution }),
  });
  return {
    version: 8,
    // The app's own labels use OpenFreeMap's fonts, as on the other basemaps.
    glyphs: `${OPENFREEMAP}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      imagery: raster(
        'World_Imagery',
        'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      ),
      labels: raster('Reference/World_Boundaries_and_Places'),
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'labels', type: 'raster', source: 'labels' },
    ],
  };
}

/** The MapLibre style for a basemap: an OpenFreeMap style's address, or satellite's own style. */
export function basemapStyle(basemap: Basemap): string | StyleSpecification {
  switch (basemap) {
    case 'light':
      return `${OPENFREEMAP}/styles/positron`;
    case 'streets':
      return `${OPENFREEMAP}/styles/liberty`;
    case 'dark':
      return `${OPENFREEMAP}/styles/dark`;
    case 'satellite':
      return satelliteStyle();
  }
}

/**
 * Which set of map colours (`MAP_PALETTE`) is drawn over a basemap: the light set over the pale
 * maps, and the dark set (white labels with dark halos) over the dark map and the photos.
 */
export const basemapTone = (basemap: Basemap): Theme =>
  basemap === 'light' || basemap === 'streets' ? 'light' : 'dark';
