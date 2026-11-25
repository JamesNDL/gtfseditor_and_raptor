// AA-18 (FR-4, FR-5; AC-FR-4.1, AC-FR-5.1): picking zones and points of interest for the setup,
// and what leaving the setup does to the map editor's tools. The tools are tested in
// map-work.test.ts; the list helpers in analysis-state.test.ts.
import { describe, expect, it } from 'vitest';
import {
  backToList,
  defaultAnalysisView,
  forgetPoi,
  forgetZone,
  pickZone,
  togglePoi,
} from './analysis-state.ts';
import { NO_MAP_WORK, addCorner, pickTool, startRenaming } from './map-work.ts';

describe('picking zones and points of interest for the setup (AC-FR-4.1, AC-FR-5.1)', () => {
  it('picks one zone, or none', () => {
    const view = pickZone(defaultAnalysisView(), 4);
    expect(view.setup.zoneId).toBe(4);
    expect(pickZone(view, null).setup.zoneId).toBeNull();
  });

  it('picks and unpicks points of interest, keeping their order', () => {
    let view = togglePoi(defaultAnalysisView(), 2);
    view = togglePoi(view, 5);
    expect(view.setup.poiIds).toEqual([2, 5]);
    expect(togglePoi(view, 2).setup.poiIds).toEqual([5]);
  });

  it('forgets a deleted zone or point of interest, and stops renaming it', () => {
    let view = togglePoi(togglePoi(pickZone(defaultAnalysisView(), 4), 2), 5);
    view = forgetZone(view, 9);
    expect(view.setup.zoneId).toBe(4);
    view = forgetZone(view, 4);
    expect(view.setup.zoneId).toBeNull();
    view = { ...view, work: startRenaming(NO_MAP_WORK, 5) };
    view = forgetPoi(view, 5);
    expect(view.setup.poiIds).toEqual([2]);
    expect(view.work).toEqual(NO_MAP_WORK);
  });
});

describe('leaving the setup', () => {
  it('puts down the tool in use', () => {
    const drawing = addCorner(pickTool(NO_MAP_WORK, 'zone'), [151.2, -33.9]);
    const view = backToList({ ...defaultAnalysisView(), screen: 'setup', work: drawing });
    expect(view.work).toEqual(NO_MAP_WORK);
  });
});
