// AA-20 (FR-14, FR-19, FR-20): what the results screen and the legend say: the band ranges, the
// settings line, 'Lines at' checked by the same rules as the API, and the summary table, whose
// counts add up to the sample points.
import { DEFAULT_ANALYSIS_SETTINGS } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { bandColours } from '../analysis-colours.ts';
import type { ShownSummary } from '../analysis-results.ts';
import {
  OSM_CREDIT,
  bandLabel,
  bandRanges,
  breaksText,
  ratioText,
  readBreaks,
  settingsLine,
  summaryBreaks,
  summaryRows,
} from './results-text.ts';

const SETTINGS = structuredClone(DEFAULT_ANALYSIS_SETTINGS);

describe('bandRanges and bandLabel (AC-FR-19.1)', () => {
  it('gives a band below the first line, one between each two, and one above the last', () => {
    expect(bandRanges([1, 1.5, 2, 3, 4])).toEqual([
      { from: null, to: 1 },
      { from: 1, to: 1.5 },
      { from: 1.5, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: null },
    ]);
  });

  it('names each range in plain words', () => {
    expect(bandRanges([1, 1.5, 4]).map(bandLabel)).toEqual([
      'Under 1',
      '1 to 1.5',
      '1.5 to 4',
      '4 or more',
    ]);
  });
});

describe('settingsLine (AC-FR-19.1)', () => {
  it('reads like the architecture example for the published day and the starting settings', () => {
    expect(settingsLine({ scenarioName: null, settings: SETTINGS })).toBe(
      'Published day · 08:00 · 250 m · walk 800 m · parking 5 min · traffic 1.4',
    );
  });

  it("names the scenario, and uses the traffic factor for the departure's part of the day", () => {
    const settings = { ...SETTINGS, departSecs: 12 * 3600 + 30 * 60, spacingM: 1000 };
    expect(settingsLine({ scenarioName: 'More buses', settings })).toBe(
      'More buses · 12:30 · 1,000 m · walk 800 m · parking 5 min · traffic 1.2',
    );
  });
});

describe('the credit (AC-FR-19.1)', () => {
  it('names OpenStreetMap and its licence', () => {
    expect(OSM_CREDIT).toBe('Driving times © OpenStreetMap contributors (ODbL)');
  });
});

describe('readBreaks: Lines at (AC-FR-14.1)', () => {
  it('reads numbers with commas, spaces allowed', () => {
    expect(readBreaks('1, 2,3 ', SETTINGS)).toEqual({ breaks: [1, 2, 3] });
  });

  it('refuses what the API refuses, with the same words', () => {
    expect(readBreaks('2, 1', SETTINGS)).toEqual({
      problem: 'Each line must be higher than the one before.',
    });
    expect(readBreaks('1, 30', SETTINGS)).toEqual({
      problem: 'Each line must be between 0.1 and 20.',
    });
    expect(readBreaks('1,,2', SETTINGS)).toEqual({
      problem: 'Each line must be between 0.1 and 20.',
    });
    expect(readBreaks('1,2,3,4,5,6,7,8,9', SETTINGS)).toEqual({
      problem: 'Give between 1 and 8 lines.',
    });
  });

  it('writes breaks back as the input shows them', () => {
    expect(breaksText([1, 1.5, 2, 3, 4])).toBe('1, 1.5, 2, 3, 4');
  });
});

describe('summaryRows and ratioText (AC-FR-20.1)', () => {
  // As JSON brings it: the open band ends are null.
  const summary: ShownSummary = {
    bands: [
      { from: null, to: 1, label: '<1', count: 2 },
      { from: 1, to: 2, label: '1-2', count: 5 },
      { from: 2, to: null, label: '2 or more', count: 3 },
    ],
    noService: 4,
    noRoad: 1,
    okCount: 10,
    median: 1.4567,
  };

  it('lists each band with its colour, then no service and no road, and the total', () => {
    const { rows, total } = summaryRows(summary, [1, 2]);
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['Under 1', 2],
      ['1 to 2', 5],
      ['2 or more', 3],
      ['No service', 4],
      ['No road', 1],
    ]);
    // Three bands take the scale's two ends and its middle, as the map draws them.
    expect(rows.slice(0, 3).map((r) => r.colour)).toEqual(bandColours(3));
    expect(rows[0]?.colour).toBe('#2c7bb6');
    expect(rows[2]?.colour).toBe('#d73027');
    expect(rows.slice(3).map((r) => r.colour)).toEqual(['#7f7f7f', '#cccccc']);
    expect(total).toBe(15);
  });

  it('finds the breaks the summary was made for, so its rows and labels agree', () => {
    expect(summaryBreaks(summary)).toEqual([1, 2]);
  });

  it('gives the median to two places, or says there is none', () => {
    expect(ratioText(summary.median)).toBe('1.46');
    expect(ratioText(2)).toBe('2');
    expect(ratioText(null)).toBe('None');
  });
});
