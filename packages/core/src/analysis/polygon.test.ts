// The outline check (AC-FR-4.2, logic) and the point-inside test used by the sample grid.
import { describe, expect, it } from 'vitest';
import { pointInRing, ringProblem, type Ring } from './polygon.ts';

const square: Ring = [
  [151.0, -33.8],
  [151.01, -33.8],
  [151.01, -33.79],
  [151.0, -33.79],
];

// An L: the full 2 x 2 square with its north-east quarter (the notch) cut out.
const lShape: Ring = [
  [0, 0],
  [2, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 2],
];

describe('pointInRing', () => {
  it('finds a point inside a square', () => {
    expect(pointInRing([151.005, -33.795], square)).toBe(true);
  });

  it('finds points outside a square on every side', () => {
    expect(pointInRing([150.99, -33.795], square)).toBe(false);
    expect(pointInRing([151.02, -33.795], square)).toBe(false);
    expect(pointInRing([151.005, -33.81], square)).toBe(false);
    expect(pointInRing([151.005, -33.78], square)).toBe(false);
  });

  it('finds points in both arms of an L', () => {
    expect(pointInRing([1.5, 0.5], lShape)).toBe(true);
    expect(pointInRing([0.5, 1.5], lShape)).toBe(true);
    expect(pointInRing([0.5, 0.5], lShape)).toBe(true);
  });

  it('leaves out a point in the notch of an L', () => {
    expect(pointInRing([1.5, 1.5], lShape)).toBe(false);
  });

  it('gives the same answer when the closing corner is repeated', () => {
    const closed: Ring = [...lShape, lShape[0]];
    expect(pointInRing([1.5, 1.5], closed)).toBe(false);
    expect(pointInRing([0.5, 0.5], closed)).toBe(true);
  });
});

describe('ringProblem', () => {
  it('passes a valid L-shape', () => {
    expect(ringProblem(lShape)).toBeNull();
  });

  it('passes a square with its closing corner repeated', () => {
    expect(ringProblem([...square, square[0]])).toBeNull();
  });

  it('refuses a bow-tie with a plain-English reason', () => {
    const bowTie: Ring = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ];
    expect(ringProblem(bowTie)).toBe(
      'The outline crosses itself. Draw it again so that no side crosses another.',
    );
  });

  it('refuses an outline with fewer than 3 corners', () => {
    expect(
      ringProblem([
        [0, 0],
        [1, 1],
      ]),
    ).toBe('An outline needs at least 3 corners; this one has 2.');
  });

  it('counts a repeated closing corner only once', () => {
    expect(
      ringProblem([
        [0, 0],
        [1, 1],
        [0, 0],
      ]),
    ).toBe('An outline needs at least 3 corners; this one has 2.');
  });

  it('refuses an outline with more than 200 corners', () => {
    const many: Ring = Array.from({ length: 201 }, (_, k) => {
      const a = (2 * Math.PI * k) / 201;
      return [151 + 0.01 * Math.cos(a), -33.8 + 0.01 * Math.sin(a)] as const;
    });
    expect(ringProblem(many)).toBe('An outline can have at most 200 corners; this one has 201.');
  });

  it('passes a round outline with exactly 200 corners', () => {
    const most: Ring = Array.from({ length: 200 }, (_, k) => {
      const a = (2 * Math.PI * k) / 200;
      return [151 + 0.01 * Math.cos(a), -33.8 + 0.01 * Math.sin(a)] as const;
    });
    expect(ringProblem(most)).toBeNull();
  });

  it('refuses an outline with no area', () => {
    expect(
      ringProblem([
        [151.0, -33.8],
        [151.01, -33.8],
        [151.02, -33.8],
      ]),
    ).toBe('The outline has no area. Draw it again with its corners spread out.');
  });

  it('refuses an outline where one side doubles back over another', () => {
    const folded: Ring = [
      [0, 0],
      [3, 0],
      [1, 0],
      [1, 1],
    ];
    expect(ringProblem(folded)).toBe(
      'The outline crosses itself. Draw it again so that no side crosses another.',
    );
  });
});
