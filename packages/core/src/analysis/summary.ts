// The summary figures for one point of interest (FR-20): sample points per ratio band, no service,
// no road, and the median access ratio.
import type { PairStatus } from './ratio.ts';

/** One pair's result, as the summary reads it. */
export interface PairResult {
  status: PairStatus;
  ratio: number | null;
}

/**
 * A ratio band: ratios from `from` (included) up to `to` (not included). The open end below the
 * first line and above the last is null, as it goes over the wire (JSON has no infinity).
 */
export interface RatioBand {
  from: number | null;
  to: number | null;
  label: string;
  count: number;
}

/** The figures for one point of interest. */
export interface PoiSummary {
  bands: RatioBand[];
  noService: number;
  noRoad: number;
  okCount: number;
  /** The median of the ok ratios, or null when no pair is ok. */
  median: number | null;
}

/** The empty bands for the lines: '<1', '1-1.5', ... '4 or more'. */
function emptyBands(breaks: number[]): RatioBand[] {
  const first = breaks[0];
  const last = breaks[breaks.length - 1];
  if (first === undefined || last === undefined) {
    return [{ from: null, to: null, label: 'all', count: 0 }];
  }
  const bands: RatioBand[] = [{ from: null, to: first, label: `<${first}`, count: 0 }];
  for (let k = 1; k < breaks.length; k++) {
    const from = breaks[k - 1] ?? first;
    const to = breaks[k] ?? last;
    bands.push({ from, to, label: `${from}-${to}`, count: 0 });
  }
  bands.push({ from: last, to: null, label: `${last} or more`, count: 0 });
  return bands;
}

/** The middle value of the sorted ratios; the mean of the middle two for an even count. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

/**
 * Counts the pairs of one point of interest by band (a ratio on a line goes in the band above
 * it), no service and no road, and gives the median ratio. Pending pairs are counted nowhere, so
 * for a finished analysis the counts add up to the pairs (AC-FR-20.1).
 */
export function summarise(pairs: PairResult[], breaks: number[]): PoiSummary {
  const bands = emptyBands(breaks);
  const ratios: number[] = [];
  let noService = 0;
  let noRoad = 0;
  for (const pair of pairs) {
    if (pair.status === 'noService') noService++;
    else if (pair.status === 'noRoad') noRoad++;
    else if (pair.status === 'ok' && pair.ratio !== null) {
      const ratio = pair.ratio;
      const band = bands.find(
        (b) => (b.from === null || ratio >= b.from) && (b.to === null || ratio < b.to),
      );
      if (band) band.count++;
      ratios.push(ratio);
    }
  }
  ratios.sort((a, b) => a - b);
  return { bands, noService, noRoad, okCount: ratios.length, median: median(ratios) };
}
