// Comparing two analyses of the same zone, spacing and point of interest, sample point by sample
// point (FR-17, D31). Points are matched on their grid column and row.
import type { PairStatus } from './ratio.ts';

/** One sample point's result for one point of interest, with its grid column and row. */
export interface GridPairResult {
  i: number;
  j: number;
  status: PairStatus;
  ratio: number | null;
}

/** How a sample point changed from the first analysis to the second. */
export type CompareKind =
  'better' | 'worse' | 'same' | 'gainedService' | 'lostService' | 'bothNone';

/** One sample point's comparison. `change` is the second ratio less the first, when both have one. */
export interface ComparedPoint {
  i: number;
  j: number;
  kind: CompareKind;
  change: number | null;
}

/** A change this small either way is the same (§4.1). */
const SAME_WITHIN = 0.05;
/** Room for rounding, so 2.0 to 1.95 counts as a change of 0.05, not a hair more. */
const ROUNDING = 1e-9;

/** The ratio of a pair that has one. */
const ratioOf = (pair: GridPairResult): number | null =>
  pair.status === 'ok' && pair.ratio !== null ? pair.ratio : null;

/** How one matched point changed. */
function comparePoint(a: GridPairResult, b: GridPairResult): ComparedPoint {
  const before = ratioOf(a);
  const after = ratioOf(b);
  const where = { i: a.i, j: a.j };
  if (before === null && after === null) return { ...where, kind: 'bothNone', change: null };
  if (before === null) return { ...where, kind: 'gainedService', change: null };
  if (after === null) return { ...where, kind: 'lostService', change: null };
  const change = after - before;
  if (Math.abs(change) <= SAME_WITHIN + ROUNDING) return { ...where, kind: 'same', change };
  return { ...where, kind: change < 0 ? 'better' : 'worse', change };
}

/**
 * Compares analysis b with analysis a, point by point, in a's order. A lower ratio is better.
 * A point in only one of them is left out.
 */
export function compareRatios(a: GridPairResult[], b: GridPairResult[]): ComparedPoint[] {
  const key = (p: GridPairResult): string => `${p.i},${p.j}`;
  const second = new Map(b.map((p) => [key(p), p]));
  const result: ComparedPoint[] = [];
  for (const first of a) {
    const match = second.get(key(first));
    if (match) result.push(comparePoint(first, match));
  }
  return result;
}
