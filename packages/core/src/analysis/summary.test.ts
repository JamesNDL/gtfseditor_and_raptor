// The summary figures for one point of interest (FR-20, AC-FR-20.1).
import { describe, expect, it } from 'vitest';
import type { PairStatus } from './ratio.ts';
import { summarise } from './summary.ts';

const BREAKS = [1, 1.5, 2, 3, 4];
const ok = (ratio: number): { status: PairStatus; ratio: number } => ({ status: 'ok', ratio });
const noService = { status: 'noService', ratio: null } as const;
const noRoad = { status: 'noRoad', ratio: null } as const;

describe('summarise', () => {
  it('labels one band below the first line, one between each pair, and one above the last', () => {
    const { bands } = summarise([], BREAKS);
    expect(bands.map((b) => b.label)).toEqual(['<1', '1-1.5', '1.5-2', '2-3', '3-4', '4 or more']);
    expect(bands[0]).toEqual({ from: -Infinity, to: 1, label: '<1', count: 0 });
    expect(bands[5]).toEqual({ from: 4, to: Infinity, label: '4 or more', count: 0 });
  });

  it('puts a ratio on a line in the band above it', () => {
    const { bands } = summarise([ok(0.9), ok(1), ok(1.49), ok(1.5), ok(4), ok(7.2)], BREAKS);
    expect(bands.map((b) => b.count)).toEqual([1, 2, 1, 0, 0, 2]);
  });

  it('AC-FR-20.1: band counts, no service and no road add up to the pairs', () => {
    const pairs = [ok(0.8), ok(1.2), ok(2.5), ok(3.5), noService, noService, noRoad];
    const summary = summarise(pairs, BREAKS);
    const inBands = summary.bands.reduce((sum, b) => sum + b.count, 0);
    expect(summary.noService).toBe(2);
    expect(summary.noRoad).toBe(1);
    expect(summary.okCount).toBe(4);
    expect(inBands + summary.noService + summary.noRoad).toBe(pairs.length);
  });

  it('AC-FR-20.1: gives the median of the ok ratios (odd count: the middle one)', () => {
    expect(summarise([ok(3), ok(1), noService, ok(2)], BREAKS).median).toBe(2);
  });

  it('AC-FR-20.1: gives the mean of the middle two for an even count', () => {
    expect(summarise([ok(4), ok(1), ok(2), ok(3), noRoad], BREAKS).median).toBe(2.5);
  });

  it('gives no median when no pair is ok', () => {
    expect(summarise([noService, noRoad], BREAKS).median).toBeNull();
  });
});
