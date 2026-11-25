// AA-23 (FR-17, D31): which analyses 'Compare with…' offers, how the view starts and stops
// comparing, the saved point of interest the comparison is asked for, and the compare request.
import type { AnalysisDetail, AnalysisListEntry, AnalysisPoi } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import {
  comparableAnalyses,
  compareUrl,
  savedPoiId,
  startComparing,
  stopComparing,
} from './analysis-compare.ts';
import { defaultAnalysisView, forgetMissing, type AnalysisView } from './analysis-state.ts';

const entry = (id: number, comparableWith: number[]): AnalysisListEntry => ({
  id,
  name: `Analysis ${id}`,
  baselineId: 1,
  scenarioId: null,
  scenarioName: null,
  zoneName: 'Centre',
  state: 'done',
  progress: null,
  error: null,
  sampleCount: 16,
  createdAt: '2026-11-26T00:00:00Z',
  finishedAt: '2026-11-26T00:01:00Z',
  timeMode: 'depart',
  timeSecs: 8 * 3600,
  comparableWith,
});

const results = (): AnalysisView => ({
  ...defaultAnalysisView(),
  screen: 'results',
  openId: 3,
  poiSeq: 1,
  pointSeq: 12,
});

describe('comparableAnalyses (FR-17, D31)', () => {
  // Newest first, as the list comes.
  const items = [entry(5, [3]), entry(4, []), entry(3, [1, 5]), entry(1, [3])];

  it('offers only the analyses the open one can be compared with, in list order', () => {
    expect(comparableAnalyses(items, 3).map((a) => a.id)).toEqual([5, 1]);
  });

  it('offers none when the open one can be compared with nothing', () => {
    expect(comparableAnalyses(items, 4)).toEqual([]);
  });

  it('offers none when the open one is not in the list', () => {
    expect(comparableAnalyses(items, 9)).toEqual([]);
  });

  it('never offers the open analysis itself', () => {
    expect(comparableAnalyses([entry(2, [2, 6]), entry(6, [2])], 2).map((a) => a.id)).toEqual([6]);
  });
});

describe('startComparing and stopComparing', () => {
  it('shows the comparison with the other analysis, letting go of the picked sample point', () => {
    const view = startComparing(results(), 5);
    expect(view).toMatchObject({ screen: 'compare', openId: 3, poiSeq: 1, compareWith: 5 });
    expect(view.pointSeq).toBeNull();
  });

  it('goes back to the open analysis’s own results', () => {
    const view = stopComparing(startComparing(results(), 5));
    expect(view).toMatchObject({ screen: 'results', openId: 3, poiSeq: 1, compareWith: null });
  });

  it('is undone by forgetMissing when the other analysis is deleted', () => {
    const view = forgetMissing(startComparing(results(), 5), [3]);
    expect(view).toMatchObject({ screen: 'results', compareWith: null, openId: 3 });
  });
});

describe('savedPoiId and compareUrl (§5.3)', () => {
  const poi = (seq: number, poiId: number | null): AnalysisPoi => ({
    seq,
    poiId,
    name: `Place ${seq}`,
    lon: 151.2,
    lat: -33.9,
    summary: null,
  });
  const detail: Pick<AnalysisDetail, 'pois'> = { pois: [poi(0, 7), poi(1, null)] };

  it('gives the saved id of the point of interest on show', () => {
    expect(savedPoiId(detail, 0)).toBe(7);
  });

  it('gives null when that point of interest has been deleted or is not there', () => {
    expect(savedPoiId(detail, 1)).toBeNull();
    expect(savedPoiId(detail, 4)).toBeNull();
  });

  it('asks for the other analysis less the open one, for the saved point of interest', () => {
    expect(compareUrl(3, 5, 7)).toBe('/api/analyses/compare?a=3&b=5&poi=7');
  });
});
