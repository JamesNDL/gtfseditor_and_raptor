// The map's basemap: the four to choose from, which one shows before any is chosen (the one that
// goes with the app's theme), how the choice is remembered, the satellite style built in code,
// and which set of map colours goes on top of each.
import type { RasterSourceSpecification, StyleSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import {
  BASEMAPS,
  basemapStyle,
  basemapTone,
  parseBasemap,
  shownBasemap,
  type Basemap,
} from './basemaps.ts';

describe('BASEMAPS', () => {
  it('lists light, streets, dark and satellite, in that order, with plain names', () => {
    expect(BASEMAPS.map((b) => [b.id, b.name])).toEqual([
      ['light', 'Light'],
      ['streets', 'Streets'],
      ['dark', 'Dark'],
      ['satellite', 'Satellite'],
    ]);
    for (const b of BASEMAPS) expect(b.hint.length).toBeGreaterThan(10);
  });
});

describe('shownBasemap', () => {
  it('follows the theme until one is chosen', () => {
    expect(shownBasemap(null, 'light')).toBe('light');
    expect(shownBasemap(null, 'dark')).toBe('dark');
  });

  it('shows the one chosen, whatever the theme', () => {
    expect(shownBasemap('satellite', 'light')).toBe('satellite');
    expect(shownBasemap('streets', 'dark')).toBe('streets');
  });
});

describe('parseBasemap', () => {
  it('reads back a remembered choice', () => {
    for (const b of ['light', 'streets', 'dark', 'satellite'] as Basemap[]) {
      expect(parseBasemap(b)).toBe(b);
    }
  });

  it('treats nothing, or anything else, as no choice', () => {
    expect(parseBasemap(null)).toBeNull();
    expect(parseBasemap('')).toBeNull();
    expect(parseBasemap('terrain')).toBeNull();
  });
});

describe('basemapStyle', () => {
  it('uses the OpenFreeMap styles for light, streets and dark', () => {
    expect(basemapStyle('light')).toBe('https://tiles.openfreemap.org/styles/positron');
    expect(basemapStyle('streets')).toBe('https://tiles.openfreemap.org/styles/liberty');
    expect(basemapStyle('dark')).toBe('https://tiles.openfreemap.org/styles/dark');
  });

  it("builds satellite from Esri's World Imagery, with its credit, and labels over it", () => {
    const style = basemapStyle('satellite') as StyleSpecification;
    expect(style.version).toBe(8);
    const imagery = style.sources.imagery as RasterSourceSpecification;
    expect(imagery.type).toBe('raster');
    expect(imagery.tiles).toEqual([
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ]);
    expect(imagery.tileSize).toBe(256);
    expect(imagery.maxzoom).toBe(19);
    expect(imagery.attribution).toContain('Esri');
    const labels = style.sources.labels as RasterSourceSpecification;
    expect(labels.tiles?.[0]).toContain('World_Boundaries_and_Places');
    expect(style.layers.map((l) => l.id)).toEqual(['imagery', 'labels']);
  });

  it('gives satellite the fonts that the map labels use', () => {
    const style = basemapStyle('satellite') as StyleSpecification;
    expect(style.glyphs).toBe('https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
  });
});

describe('basemapTone', () => {
  it('draws the light colours on light maps and the dark ones on dark maps and photos', () => {
    expect(basemapTone('light')).toBe('light');
    expect(basemapTone('streets')).toBe('light');
    expect(basemapTone('dark')).toBe('dark');
    expect(basemapTone('satellite')).toBe('dark');
  });
});
