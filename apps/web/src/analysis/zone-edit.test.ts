// Reshaping a saved zone on the map (FR-4): its corner handles and the handles in the middle of
// each side, which one a press lands on, the outline after a drag, and where its name box sits.
import type { GeoJsonPosition } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import {
  HANDLE_REACH_PX,
  dragRing,
  edgeMiddles,
  handleAt,
  zoneAnchor,
  type ZoneHandle,
} from './zone-edit.ts';

const A: GeoJsonPosition = [151.2, -33.9];
const B: GeoJsonPosition = [151.22, -33.9];
const C: GeoJsonPosition = [151.22, -33.88];
const D: GeoJsonPosition = [151.2, -33.88];
const SQUARE = [A, B, C, D];

/** A place, to within rounding. */
const near = ([lon, lat]: GeoJsonPosition): unknown[] => [
  expect.closeTo(lon, 9),
  expect.closeTo(lat, 9),
];

/** Screen pixels from a press at `at`: 1,000 pixels to 0.01 degrees. */
const from =
  (at: GeoJsonPosition) =>
  (place: GeoJsonPosition): number =>
    Math.hypot(place[0] - at[0], place[1] - at[1]) * 100_000;

describe('edgeMiddles', () => {
  it('gives the middle of each side, the last side joining the last corner to the first', () => {
    const middles: GeoJsonPosition[] = [
      [151.21, -33.9],
      [151.22, -33.89],
      [151.21, -33.88],
      [151.2, -33.89],
    ];
    expect(edgeMiddles(SQUARE)).toEqual(middles.map(near));
  });
});

describe('handleAt', () => {
  it('finds the corner within reach of the press', () => {
    expect(handleAt(SQUARE, from([151.22004, -33.9]))).toEqual({ kind: 'corner', index: 1 });
  });

  it('finds the middle of a side within reach', () => {
    expect(handleAt(SQUARE, from([151.21, -33.88003]))).toEqual({ kind: 'middle', index: 2 });
  });

  it('prefers a corner over a middle at the same distance', () => {
    const close = (place: GeoJsonPosition): number =>
      place === C || Math.abs(place[1] + 33.89) < 1e-9 ? 2 : 99;
    expect(handleAt(SQUARE, close)).toEqual({ kind: 'corner', index: 2 });
  });

  it(`finds nothing further than ${HANDLE_REACH_PX} pixels away`, () => {
    expect(handleAt(SQUARE, from([151.205, -33.895]))).toBeNull();
  });
});

describe('dragRing', () => {
  it('moves a dragged corner', () => {
    const handle: ZoneHandle = { kind: 'corner', index: 2 };
    expect(dragRing(SQUARE, handle, [151.23, -33.87])).toEqual([A, B, [151.23, -33.87], D]);
  });

  it('adds a corner where the middle of a side is dragged', () => {
    const handle: ZoneHandle = { kind: 'middle', index: 3 };
    expect(dragRing(SQUARE, handle, [151.19, -33.89])).toEqual([A, B, C, D, [151.19, -33.89]]);
    const first: ZoneHandle = { kind: 'middle', index: 0 };
    expect(dragRing(SQUARE, first, [151.21, -33.91])).toEqual([A, [151.21, -33.91], B, C, D]);
  });

  it('leaves the outline it was given alone', () => {
    const ring = [...SQUARE];
    dragRing(ring, { kind: 'corner', index: 0 }, [0, 0]);
    expect(ring).toEqual(SQUARE);
  });
});

describe('zoneAnchor', () => {
  it('is the middle of the top edge of the box round the outline', () => {
    expect(zoneAnchor([A, B, [151.21, -33.85], D])).toEqual(near([151.21, -33.85]));
    expect(zoneAnchor(SQUARE)).toEqual(near([151.21, -33.88]));
  });
});
