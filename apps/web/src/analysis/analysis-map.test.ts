// FR-4, FR-5 (AC-FR-4.1, AC-FR-4.2, AC-FR-5.1, and AC 4: while a tool is in use, map clicks do
// nothing else): what a click on the map does with the map editor's tools. Draw zone adds corners
// and closes the outline; Place point of interest drops a pin; with no tool, a click on a saved
// pin opens its name box. Nothing is saved by a click: the name box does that (map-actions.ts).
import type { GeoJsonPosition, PointOfInterest } from '@gtfs-editor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../app/store.ts';
import { analysisMapClick } from './analysis-map.ts';
import { usePlaces } from './analysis-api.ts';
import { defaultAnalysisView, type AnalysisView } from './analysis-state.ts';
import { NO_MAP_WORK, pickTool, startRenaming, type MapWork } from './map-work.ts';

const view = (): AnalysisView => useStore.getState().analysis;
const setView = (analysis: AnalysisView) => useStore.getState().set({ analysis });
const setup = (work: MapWork = NO_MAP_WORK): AnalysisView => ({
  ...defaultAnalysisView(),
  screen: 'setup',
  work,
});
/** Every place is far from the click. */
const far = (): number => 500;

const poi = (id: number, name: string, lon: number, lat: number): PointOfInterest => ({
  id,
  name,
  kind: 'place',
  source: 'drawn',
  lon,
  lat,
});

/** Clicks these corners in turn, each far from the others. */
const clickCorners = (corners: GeoJsonPosition[]): void => {
  for (const [lon, lat] of corners) analysisMapClick(lon, lat, far);
};

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  usePlaces.setState({
    zones: [],
    pois: [poi(3, 'Library', 151.2, -33.9)],
    zoneError: null,
    poiError: null,
  });
  useStore.getState().set({ leftPane: 'analysis' });
  setView(setup());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analysisMapClick with no tool', () => {
  it('leaves a click away from every pin alone', () => {
    expect(analysisMapClick(151.25, -33.85, far)).toBe(false);
    expect(view()).toEqual(setup());
  });

  it('opens the name box of a saved pin clicked on the setup', () => {
    const onLibrary = (place: GeoJsonPosition): number => (place[0] === 151.2 ? 6 : 500);
    expect(analysisMapClick(151.2, -33.9, onLibrary)).toBe(true);
    expect(view().work).toEqual(startRenaming(NO_MAP_WORK, 3));
  });

  it('leaves pins alone off the setup or with the pane folded away', () => {
    const onLibrary = (): number => 0;
    setView({ ...setup(), screen: 'list' });
    expect(analysisMapClick(151.2, -33.9, onLibrary)).toBe(false);
    setView(setup());
    useStore.getState().set({ leftPane: 'sim' });
    expect(analysisMapClick(151.2, -33.9, onLibrary)).toBe(false);
  });

  it('closes a name box on a click elsewhere, and uses the click', () => {
    setView(setup(startRenaming(NO_MAP_WORK, 3)));
    expect(analysisMapClick(151.3, -33.8, far)).toBe(true);
    expect(view().work).toEqual(NO_MAP_WORK);
  });
});

describe('analysisMapClick with Draw zone', () => {
  beforeEach(() => setView(setup(pickTool(NO_MAP_WORK, 'zone'))));

  it('adds a corner for each click, and uses the click (AC-FR-4.1, AC 4)', () => {
    expect(analysisMapClick(151.2, -33.9, far)).toBe(true);
    expect(analysisMapClick(151.21, -33.9, far)).toBe(true);
    expect(view().work.corners).toEqual([
      [151.2, -33.9],
      [151.21, -33.9],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('takes a click within 4 pixels of the last corner as the second of a double click', () => {
    analysisMapClick(151.2, -33.9, far);
    const last = view().work.corners[0];
    expect(analysisMapClick(151.20001, -33.9, (p) => (p === last ? 3 : 500))).toBe(true);
    expect(view().work.corners).toHaveLength(1);
  });

  it('closes the outline on a click within 10 pixels of the first corner (AC-FR-4.1)', () => {
    clickCorners([
      [151.2, -33.9],
      [151.21, -33.9],
      [151.21, -33.89],
    ]);
    const first = view().work.corners[0];
    expect(analysisMapClick(151.2001, -33.9001, (p) => (p === first ? 8 : 500))).toBe(true);
    expect(view().work.closed).toBe(true);
    expect(view().work.corners).toHaveLength(3);
  });

  it('refuses to close an outline that crosses itself (AC-FR-4.2)', () => {
    clickCorners([
      [151.2, -33.9],
      [151.21, -33.89],
      [151.21, -33.9],
      [151.2, -33.89],
    ]);
    const first = view().work.corners[0];
    analysisMapClick(151.2, -33.9, (p) => (p === first ? 0 : 500));
    expect(view().work.closed).toBe(false);
    expect(view().work.problem).toMatch(/crosses itself/);
    expect(view().work.corners).toHaveLength(4);
  });

  it('uses the click, and changes nothing, while a closed outline waits for its name', () => {
    clickCorners([
      [151.2, -33.9],
      [151.21, -33.9],
      [151.21, -33.89],
    ]);
    analysisMapClick(151.2, -33.9, () => 0);
    const closed = view();
    expect(analysisMapClick(151.3, -33.8, far)).toBe(true);
    expect(view()).toBe(closed);
  });

  it('adds a corner rather than renaming a pin under the click', () => {
    expect(analysisMapClick(151.2, -33.9, () => 0)).toBe(true);
    expect(view().work.corners).toEqual([[151.2, -33.9]]);
    expect(view().work.renamingPoiId).toBeNull();
  });
});

describe('analysisMapClick with Place point of interest (AC-FR-5.1)', () => {
  beforeEach(() => setView(setup(pickTool(NO_MAP_WORK, 'poi'))));

  it('drops a pin where the map is clicked, waiting for its name, saving nothing yet', () => {
    expect(analysisMapClick(151.25, -33.85, far)).toBe(true);
    expect(view().work.pendingPoi).toEqual([151.25, -33.85]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('moves the waiting pin on another click', () => {
    analysisMapClick(151.25, -33.85, far);
    expect(analysisMapClick(151.26, -33.86, far)).toBe(true);
    expect(view().work.pendingPoi).toEqual([151.26, -33.86]);
  });
});
