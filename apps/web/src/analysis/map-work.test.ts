// The map editor's tools (FR-4, FR-5; AC-FR-4.1, AC-FR-4.2, AC-FR-5.1): picking the Draw zone or
// Place point of interest tool, drawing a zone corner by corner, dropping a pin, the name box each
// one opens, and the hint shown beside the tool bar. Saving is tested in map-actions.test.ts.
import { ringProblem, type GeoJsonPosition, type PointOfInterest } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import {
  NO_MAP_WORK,
  addCorner,
  closeDrawing,
  closesOutline,
  dropPoi,
  forgetPoiWork,
  isMapBusy,
  nameBoxFor,
  pickTool,
  startRenaming,
  toolHint,
  undoCorner,
  type MapWork,
} from './map-work.ts';

const A: GeoJsonPosition = [151.2, -33.9];
const B: GeoJsonPosition = [151.21, -33.9];
const C: GeoJsonPosition = [151.21, -33.89];
const D: GeoJsonPosition = [151.2, -33.89];

/** The Draw zone tool with these corners clicked in order. */
function drawn(...corners: GeoJsonPosition[]): MapWork {
  let work = pickTool(NO_MAP_WORK, 'zone');
  for (const corner of corners) work = addCorner(work, corner);
  return work;
}

const poi = (id: number, name: string, lon: number, lat: number): PointOfInterest => ({
  id,
  name,
  kind: 'place',
  source: 'drawn',
  lon,
  lat,
});

describe('picking a tool', () => {
  it('starts with no tool and nothing on the go', () => {
    expect(NO_MAP_WORK).toEqual({
      tool: null,
      corners: [],
      closed: false,
      problem: null,
      pendingPoi: null,
      renamingPoiId: null,
    });
    expect(isMapBusy(NO_MAP_WORK)).toBe(false);
  });

  it('picks the Draw zone tool with no corners yet', () => {
    const work = pickTool(NO_MAP_WORK, 'zone');
    expect(work.tool).toBe('zone');
    expect(work.corners).toEqual([]);
    expect(isMapBusy(work)).toBe(true);
  });

  it('picks the Place point of interest tool', () => {
    const work = pickTool(NO_MAP_WORK, 'poi');
    expect(work.tool).toBe('poi');
    expect(isMapBusy(work)).toBe(true);
  });

  it('switching tools forgets what the other one was doing', () => {
    const work = pickTool(drawn(A, B), 'poi');
    expect(work).toEqual({ ...NO_MAP_WORK, tool: 'poi' });
    const back = pickTool(dropPoi(pickTool(NO_MAP_WORK, 'poi'), A), 'zone');
    expect(back).toEqual({ ...NO_MAP_WORK, tool: 'zone' });
  });

  it('picking the tool in use again puts it down', () => {
    expect(pickTool(drawn(A, B), 'zone')).toEqual(NO_MAP_WORK);
    expect(pickTool(pickTool(NO_MAP_WORK, 'poi'), 'poi')).toEqual(NO_MAP_WORK);
  });

  it('picking a tool stops a rename', () => {
    expect(pickTool(startRenaming(NO_MAP_WORK, 3), 'zone').renamingPoiId).toBeNull();
  });
});

describe('drawing a zone (AC-FR-4.1, AC-FR-4.2)', () => {
  it('adds a corner for each click, in order', () => {
    expect(drawn(A, B, C).corners).toEqual([A, B, C]);
  });

  it('drops a corner that repeats the last one, as a double click gives', () => {
    expect(drawn(A, B, B, C, C).corners).toEqual([A, B, C]);
  });

  it('adds nothing unless the Draw zone tool is in use', () => {
    expect(addCorner(NO_MAP_WORK, A)).toBe(NO_MAP_WORK);
    const placing = pickTool(NO_MAP_WORK, 'poi');
    expect(addCorner(placing, A)).toBe(placing);
  });

  it('undoes the last corner (Backspace)', () => {
    expect(undoCorner(drawn(A, B, C)).corners).toEqual([A, B]);
    expect(undoCorner(drawn()).corners).toEqual([]);
  });

  it('closes a good outline, ready to be named', () => {
    const work = closeDrawing(drawn(A, B, C, D));
    expect(work.closed).toBe(true);
    expect(work.problem).toBeNull();
    expect(work.corners).toEqual([A, B, C, D]);
  });

  it("refuses an outline that crosses itself, with ringProblem's words, keeping its corners", () => {
    const work = closeDrawing(drawn(A, C, B, D));
    expect(work.closed).toBe(false);
    expect(work.problem).toBe(ringProblem([A, C, B, D]));
    expect(work.problem).toMatch(/crosses itself/);
    expect(work.corners).toEqual([A, C, B, D]);
  });

  it('refuses an outline of fewer than three corners', () => {
    const work = closeDrawing(drawn(A, B));
    expect(work.closed).toBe(false);
    expect(work.problem).toMatch(/at least 3 corners/);
  });

  it('clears the problem once a corner is undone or added', () => {
    const refused = closeDrawing(drawn(A, C, B, D));
    expect(undoCorner(refused).problem).toBeNull();
    expect(addCorner(closeDrawing(drawn(A, B)), C).problem).toBeNull();
  });

  it('does not count the first corner clicked again at the end as a corner', () => {
    const work = closeDrawing(drawn(A, B, C, A));
    expect(work.closed).toBe(true);
    expect(work.corners).toEqual([A, B, C]);
  });

  it('takes no more corners once closed, and undo opens it again', () => {
    const closed = closeDrawing(drawn(A, B, C));
    expect(addCorner(closed, D)).toBe(closed);
    const open = undoCorner(closed);
    expect(open.closed).toBe(false);
    expect(open.corners).toEqual([A, B, C]);
  });

  it('closes on a click within 10 pixels of the first corner, once there are three corners', () => {
    const at = (px: number) => (corner: GeoJsonPosition) => (corner === A ? px : 500);
    expect(closesOutline(drawn(A, B, C), at(10))).toBe(true);
    expect(closesOutline(drawn(A, B, C), at(10.5))).toBe(false);
    expect(closesOutline(drawn(A, B), at(0))).toBe(false);
    expect(closesOutline(closeDrawing(drawn(A, B, C)), at(0))).toBe(false);
    expect(closesOutline(NO_MAP_WORK, at(0))).toBe(false);
  });
});

describe('placing a point of interest (AC-FR-5.1)', () => {
  it('drops a pin where the map is clicked, waiting for its name', () => {
    const work = dropPoi(pickTool(NO_MAP_WORK, 'poi'), A);
    expect(work.pendingPoi).toEqual(A);
    expect(work.tool).toBe('poi');
  });

  it('a second click moves the pin still waiting for its name', () => {
    const work = dropPoi(dropPoi(pickTool(NO_MAP_WORK, 'poi'), A), B);
    expect(work.pendingPoi).toEqual(B);
  });

  it('drops nothing unless the tool is in use', () => {
    expect(dropPoi(NO_MAP_WORK, A)).toBe(NO_MAP_WORK);
    const drawing = drawn(A);
    expect(dropPoi(drawing, B)).toBe(drawing);
  });
});

describe('renaming a point of interest from the map', () => {
  it('opens the name box for it, putting down any tool', () => {
    const work = startRenaming(drawn(A, B), 3);
    expect(work).toEqual({ ...NO_MAP_WORK, renamingPoiId: 3 });
    expect(isMapBusy(work)).toBe(true);
  });

  it('forgets a deleted point of interest being renamed', () => {
    expect(forgetPoiWork(startRenaming(NO_MAP_WORK, 3), 3)).toEqual(NO_MAP_WORK);
    const other = startRenaming(NO_MAP_WORK, 4);
    expect(forgetPoiWork(other, 3)).toBe(other);
  });
});

describe('nameBoxFor: the name box on the map', () => {
  const pois = [poi(3, 'Library', 151.3, -33.8)];

  it('shows none while nothing waits for a name', () => {
    expect(nameBoxFor(NO_MAP_WORK, pois)).toBeNull();
    expect(nameBoxFor(drawn(A, B, C), pois)).toBeNull();
    expect(nameBoxFor(pickTool(NO_MAP_WORK, 'poi'), pois)).toBeNull();
  });

  it('shows one above a closed outline, at its top edge in the middle', () => {
    const box = nameBoxFor(closeDrawing(drawn(A, B, C, D)), pois);
    expect(box).toEqual({
      kind: 'zone',
      anchor: [expect.closeTo(151.205, 9), expect.closeTo(-33.89, 9)],
      label: 'Name of the zone',
      initial: '',
    });
  });

  it('shows one above a pin waiting for its name', () => {
    const box = nameBoxFor(dropPoi(pickTool(NO_MAP_WORK, 'poi'), A), pois);
    expect(box).toEqual({
      kind: 'new-poi',
      anchor: A,
      label: 'Name of the point of interest',
      initial: '',
    });
  });

  it('shows one above a saved point of interest being renamed, with its name', () => {
    const box = nameBoxFor(startRenaming(NO_MAP_WORK, 3), pois);
    expect(box).toEqual({
      kind: 'rename-poi',
      anchor: [151.3, -33.8],
      label: 'New name for the point of interest',
      initial: 'Library',
    });
  });

  it('shows none for a point of interest that is no longer listed', () => {
    expect(nameBoxFor(startRenaming(NO_MAP_WORK, 9), pois)).toBeNull();
    expect(nameBoxFor(startRenaming(NO_MAP_WORK, 3), null)).toBeNull();
  });
});

describe('toolHint: what to do next, beside the tool bar', () => {
  it('says nothing with no tool in use', () => {
    expect(toolHint(NO_MAP_WORK)).toBeNull();
  });

  it('walks through drawing a zone', () => {
    expect(toolHint(drawn())).toMatch(/first corner/);
    expect(toolHint(drawn(A))).toMatch(/next corner/);
    expect(toolHint(drawn(A, B, C))).toMatch(/first corner or double-click/);
    expect(toolHint(closeDrawing(drawn(A, B, C)))).toMatch(/Name the zone/);
  });

  it('gives the reason an outline was refused', () => {
    expect(toolHint(closeDrawing(drawn(A, C, B, D)))).toMatch(/crosses itself/);
  });

  it('walks through placing a point of interest', () => {
    expect(toolHint(pickTool(NO_MAP_WORK, 'poi'))).toMatch(/Click the map where/);
    expect(toolHint(dropPoi(pickTool(NO_MAP_WORK, 'poi'), A))).toMatch(/Name the point/);
  });
});
