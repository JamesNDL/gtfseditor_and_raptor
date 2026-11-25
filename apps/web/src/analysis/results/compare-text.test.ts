// AA-23 (FR-17, AC-FR-17.1, NFR-6): what the comparison's counts and key say, and how each kind
// of change is drawn in them, the same as on the map.
import type { CompareKind } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { compareRows, compareTotal } from './compare-text.ts';

const COUNTS: Record<CompareKind, number> = {
  better: 6,
  worse: 3,
  same: 4,
  gainedService: 1,
  lostService: 1,
  bothNone: 1,
};

describe('compareRows (AC-FR-17.1)', () => {
  it('lists better and worse first, then the rest, each with its count', () => {
    expect(compareRows(COUNTS).map((row) => [row.label, row.count])).toEqual([
      ['Better', 6],
      ['Worse', 3],
      ['About the same', 4],
      ['Gained service', 1],
      ['Lost service', 1],
      ['No service in either', 1],
    ]);
  });

  it('shows a kind with none, so the counts always add up', () => {
    const rows = compareRows({ ...COUNTS, lostService: 0 });
    expect(rows.find((row) => row.kind === 'lostService')?.count).toBe(0);
    expect(compareTotal(COUNTS)).toBe(16);
  });

  it('draws better from light to full green and worse from orange to red', () => {
    const [better, worse] = compareRows(COUNTS);
    expect(better?.background).toBe('linear-gradient(90deg, #a6d96a, #1a9641)');
    expect(worse?.background).toBe('linear-gradient(90deg, #fdae61, #d7191c)');
  });

  it('draws gained and lost service as rings, as on the map', () => {
    const rows = compareRows(COUNTS);
    expect(rows.find((row) => row.kind === 'gainedService')).toMatchObject({
      background: null,
      ring: '#1a9641',
    });
    expect(rows.find((row) => row.kind === 'lostService')).toMatchObject({
      background: null,
      ring: '#d7191c',
    });
  });

  it('explains each kind in plain words', () => {
    for (const row of compareRows(COUNTS)) expect(row.title.length).toBeGreaterThan(10);
    expect(compareRows(COUNTS)[0]?.title).toMatch(/ratio fell/);
  });
});
