// Comparing two analyses of the same zone and point of interest, point by point (FR-17, D31).
import { describe, expect, it } from 'vitest';
import { compareRatios, type ComparedPoint } from './compare.ts';
import type { PairStatus } from './ratio.ts';

interface Pair {
  i: number;
  j: number;
  status: PairStatus;
  ratio: number | null;
}

const ok = (i: number, j: number, ratio: number): Pair => ({ i, j, status: 'ok', ratio });
const none = (i: number, j: number, status: PairStatus = 'noService'): Pair => ({
  i,
  j,
  status,
  ratio: null,
});

/** The result for grid column i and row j. */
const at = (result: ComparedPoint[], i: number, j: number): ComparedPoint | undefined =>
  result.find((p) => p.i === i && p.j === j);

describe('compareRatios', () => {
  it('AC-FR-17.1: a ratio that fell by more than 0.05 is better, one that rose is worse', () => {
    const result = compareRatios([ok(0, 0, 2.0), ok(1, 0, 1.5)], [ok(0, 0, 1.6), ok(1, 0, 1.8)]);
    expect(at(result, 0, 0)?.kind).toBe('better');
    expect(at(result, 0, 0)?.change).toBeCloseTo(-0.4, 9);
    expect(at(result, 1, 0)?.kind).toBe('worse');
    expect(at(result, 1, 0)?.change).toBeCloseTo(0.3, 9);
  });

  it('a change of 0.05 or less either way is the same', () => {
    const result = compareRatios(
      [ok(0, 0, 2.0), ok(1, 0, 2.0), ok(2, 0, 2.0)],
      [ok(0, 0, 1.95), ok(1, 0, 2.05), ok(2, 0, 2.0)],
    );
    expect(result.map((p) => p.kind)).toEqual(['same', 'same', 'same']);
  });

  it('marks gained and lost service, and no service in both', () => {
    const result = compareRatios(
      [none(0, 0), ok(1, 0, 2.0), none(2, 0), none(3, 0, 'noRoad')],
      [ok(0, 0, 2.5), none(1, 0), none(2, 0, 'noRoad'), none(3, 0)],
    );
    expect(at(result, 0, 0)).toEqual({ i: 0, j: 0, kind: 'gainedService', change: null });
    expect(at(result, 1, 0)).toEqual({ i: 1, j: 0, kind: 'lostService', change: null });
    expect(at(result, 2, 0)?.kind).toBe('bothNone');
    expect(at(result, 3, 0)?.kind).toBe('bothNone');
  });

  it('matches points on grid column and row, not on their order', () => {
    const result = compareRatios([ok(0, 1, 3.0), ok(1, 0, 1.0)], [ok(1, 0, 1.0), ok(0, 1, 2.0)]);
    expect(at(result, 0, 1)?.kind).toBe('better');
    expect(at(result, 1, 0)?.kind).toBe('same');
  });

  it('leaves out a point that is in only one analysis', () => {
    const result = compareRatios([ok(0, 0, 1.0), ok(5, 5, 1.0)], [ok(0, 0, 1.0), ok(6, 6, 1.0)]);
    expect(result).toEqual([{ i: 0, j: 0, kind: 'same', change: 0 }]);
  });
});
