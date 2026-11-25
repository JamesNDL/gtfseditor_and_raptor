// AA-18 (FR-4, FR-5; AC-FR-4.1, AC-FR-4.2, AC-FR-5.1): the helpers in analysis-state.ts for map
// work: drawing a zone corner by corner, placing and moving a point of interest, and picking zones
// and points of interest for the setup. The list helpers are tested in analysis-state.test.ts.
import { ringProblem, type GeoJsonPosition } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import {
  addCorner,
  backToList,
  cancelMapWork,
  closeDrawing,
  closesOutline,
  defaultAnalysisView,
  forgetPoi,
  forgetZone,
  isMapBusy,
  pickZone,
  startDrawing,
  startMovingPoi,
  startPlacingPoi,
  togglePoi,
  undoCorner,
  type AnalysisView,
} from './analysis-state.ts';

const A: GeoJsonPosition = [151.2, -33.9];
const B: GeoJsonPosition = [151.21, -33.9];
const C: GeoJsonPosition = [151.21, -33.89];
const D: GeoJsonPosition = [151.2, -33.89];

/** A view drawing with the given corners, clicked in order. */
function drawn(...corners: GeoJsonPosition[]): AnalysisView {
  let view = startDrawing({ ...defaultAnalysisView(), screen: 'setup' });
  for (const corner of corners) view = addCorner(view, corner);
  return view;
}

describe('drawing a zone (AC-FR-4.1, AC-FR-4.2)', () => {
  it('starts with no corners, and stops placing or moving a point of interest', () => {
    const busy = startPlacingPoi(defaultAnalysisView(), 'Hospital');
    const view = startDrawing(busy);
    expect(view.drawing).toEqual([]);
    expect(view.drawingClosed).toBe(false);
    expect(view.drawingProblem).toBeNull();
    expect(view.placingPoi).toBeNull();
    expect(view.movingPoiId).toBeNull();
  });

  it('adds a corner for each click, in order', () => {
    expect(drawn(A, B, C).drawing).toEqual([A, B, C]);
  });

  it('drops a corner that repeats the last one, as a double click gives', () => {
    expect(drawn(A, B, B, C, C).drawing).toEqual([A, B, C]);
  });

  it('adds nothing when no zone is being drawn', () => {
    const view = defaultAnalysisView();
    expect(addCorner(view, A)).toBe(view);
  });

  it('undoes the last corner', () => {
    expect(undoCorner(drawn(A, B, C)).drawing).toEqual([A, B]);
    expect(undoCorner(drawn()).drawing).toEqual([]);
  });

  it('closes a good outline, ready to be named', () => {
    const view = closeDrawing(drawn(A, B, C, D));
    expect(view.drawingClosed).toBe(true);
    expect(view.drawingProblem).toBeNull();
    expect(view.drawing).toEqual([A, B, C, D]);
  });

  it("refuses to close an outline that crosses itself, with ringProblem's words, keeping its corners", () => {
    const view = closeDrawing(drawn(A, C, B, D));
    expect(view.drawingClosed).toBe(false);
    expect(view.drawingProblem).toBe(ringProblem([A, C, B, D]));
    expect(view.drawingProblem).toMatch(/crosses itself/);
    expect(view.drawing).toEqual([A, C, B, D]);
  });

  it('refuses an outline of fewer than three corners', () => {
    const view = closeDrawing(drawn(A, B));
    expect(view.drawingClosed).toBe(false);
    expect(view.drawingProblem).toMatch(/at least 3 corners/);
  });

  it('lets the last corner be undone after a refusal, and then closes', () => {
    let view = closeDrawing(drawn(A, C, B, D));
    expect(view.drawingProblem).not.toBeNull();
    view = undoCorner(view);
    expect(view.drawingProblem).toBeNull();
    expect(view.drawing).toEqual([A, C, B]);
    view = closeDrawing(view);
    expect(view.drawingClosed).toBe(true);
  });

  it('does not count the first corner clicked again at the end as a corner', () => {
    const view = closeDrawing(drawn(A, B, C, A));
    expect(view.drawingClosed).toBe(true);
    expect(view.drawing).toEqual([A, B, C]);
  });

  it('takes no more corners once closed, and undo opens it again', () => {
    const closed = closeDrawing(drawn(A, B, C));
    expect(addCorner(closed, D)).toBe(closed);
    const open = undoCorner(closed);
    expect(open.drawingClosed).toBe(false);
    expect(open.drawing).toEqual([A, B, C]);
  });

  it('closes on a click within 10 pixels of the first corner, once there are three corners', () => {
    const at = (px: number) => (corner: GeoJsonPosition) => (corner === A ? px : 500);
    expect(closesOutline(drawn(A, B, C), at(10))).toBe(true);
    expect(closesOutline(drawn(A, B, C), at(10.5))).toBe(false);
    expect(closesOutline(drawn(A, B), at(0))).toBe(false);
    expect(closesOutline(closeDrawing(drawn(A, B, C)), at(0))).toBe(false);
    expect(closesOutline(defaultAnalysisView(), at(0))).toBe(false);
  });
});

describe('placing and moving a point of interest (AC-FR-5.1)', () => {
  it('waits for a click to place a named point of interest, stopping any drawing', () => {
    const view = startPlacingPoi(drawn(A, B), 'Hospital');
    expect(view.placingPoi).toBe('Hospital');
    expect(view.drawing).toBeNull();
    expect(view.movingPoiId).toBeNull();
  });

  it('waits for a click to move a point of interest', () => {
    const view = startMovingPoi(startPlacingPoi(defaultAnalysisView(), 'Hospital'), 3);
    expect(view.movingPoiId).toBe(3);
    expect(view.placingPoi).toBeNull();
  });
});

describe('map work (AC 4: while drawing or placing, map clicks do nothing else)', () => {
  it('is busy while drawing, placing or moving, and not otherwise', () => {
    expect(isMapBusy(defaultAnalysisView())).toBe(false);
    expect(isMapBusy(drawn())).toBe(true);
    expect(isMapBusy(closeDrawing(drawn(A, B, C)))).toBe(true);
    expect(isMapBusy(startPlacingPoi(defaultAnalysisView(), 'Hospital'))).toBe(true);
    expect(isMapBusy(startMovingPoi(defaultAnalysisView(), 3))).toBe(true);
  });

  it('cancels all of it at once (Escape or Cancel)', () => {
    const view = cancelMapWork(closeDrawing(drawn(A, C, B, D)));
    expect(view.drawing).toBeNull();
    expect(view.drawingClosed).toBe(false);
    expect(view.drawingProblem).toBeNull();
    expect(isMapBusy(cancelMapWork(startMovingPoi(defaultAnalysisView(), 3)))).toBe(false);
  });

  it('leaving the setup also stops the map work', () => {
    const view = backToList(closeDrawing(drawn(A, C, B, D)));
    expect(isMapBusy(view)).toBe(false);
    expect(view.drawingClosed).toBe(false);
    expect(view.drawingProblem).toBeNull();
  });
});

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

  it('forgets a deleted zone or point of interest', () => {
    let view = togglePoi(togglePoi(pickZone(defaultAnalysisView(), 4), 2), 5);
    view = forgetZone(view, 9);
    expect(view.setup.zoneId).toBe(4);
    view = forgetZone(view, 4);
    expect(view.setup.zoneId).toBeNull();
    view = startMovingPoi(view, 5);
    view = forgetPoi(view, 5);
    expect(view.setup.poiIds).toEqual([2]);
    expect(view.movingPoiId).toBeNull();
  });
});
