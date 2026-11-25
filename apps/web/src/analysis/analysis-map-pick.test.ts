// AA-21 (FR-15; AC-FR-15.1, AC 4): a click on the map while an analysis's results are shown picks
// the nearest sample point within 12 pixels, and a click away from every sample point lets go of
// the one picked. Drawing, placing and moving still come first.
import type { GeoJsonPosition } from '@gtfs-editor/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../app/store.ts';
import { analysisMapClick } from './analysis-map.ts';
import { useAnalysisResults, type SamplePoints } from './analysis-results.ts';
import {
  defaultAnalysisView,
  openAnalysis,
  startDrawing,
  type AnalysisView,
} from './analysis-state.ts';

const view = (): AnalysisView => useStore.getState().analysis;
const setView = (analysis: AnalysisView) => useStore.getState().set({ analysis });

/** Three sample points in a row along a line of latitude. */
const POINTS: SamplePoints = {
  type: 'FeatureCollection',
  features: [1, 2, 3].map((seq) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [151 + seq / 100, -33.9] },
    properties: { seq, status: 'ok', ptMins: 30, carMins: 15, ratio: 2 },
  })),
};

/** Screen pixels from a click at this longitude: 1,000 pixels to 0.01 degrees. */
const from =
  (lon: number) =>
  (place: GeoJsonPosition): number =>
    Math.abs(place[0] - lon) * 100_000;

const results = (): AnalysisView => openAnalysis(defaultAnalysisView(), 5);

beforeEach(() => {
  useStore.getState().set({ leftPane: 'analysis' });
  setView(results());
  useAnalysisResults.setState({
    detail: null,
    poiSeq: 0,
    lines: null,
    points: POINTS,
    error: null,
  });
});

describe('analysisMapClick on the results', () => {
  it('picks the nearest sample point within 12 pixels, and uses the click (AC-FR-15.1)', () => {
    expect(analysisMapClick(151.0201, -33.9, from(151.0201))).toBe(true);
    expect(view().pointSeq).toBe(2);
    expect(analysisMapClick(151.02989, -33.9, from(151.02989))).toBe(true);
    expect(view().pointSeq).toBe(3);
  });

  it('picks nothing past 12 pixels, and leaves the click alone when nothing is picked', () => {
    expect(analysisMapClick(151.0213, -33.9, from(151.0213))).toBe(false);
    expect(view().pointSeq).toBeNull();
  });

  it('lets go of the picked sample point on a click away from every one (AC 4)', () => {
    setView({ ...results(), pointSeq: 2 });
    expect(analysisMapClick(151.5, -33.9, from(151.5))).toBe(true);
    expect(view().pointSeq).toBeNull();
  });

  it('picks nothing while the points shown are for another point of interest', () => {
    setView({ ...results(), poiSeq: 1 });
    expect(analysisMapClick(151.02, -33.9, from(151.02))).toBe(false);
    expect(view().pointSeq).toBeNull();
  });

  it('picks nothing when the results are not on screen', () => {
    useStore.getState().set({ leftPane: 'sim' });
    expect(analysisMapClick(151.02, -33.9, from(151.02))).toBe(false);
    setView({ ...results(), screen: 'list' });
    useStore.getState().set({ leftPane: 'analysis' });
    expect(analysisMapClick(151.02, -33.9, from(151.02))).toBe(false);
    expect(view().pointSeq).toBeNull();
  });

  it('adds a corner rather than picking while a zone is being drawn', () => {
    setView(startDrawing(results()));
    expect(analysisMapClick(151.02, -33.9, from(151.02))).toBe(true);
    expect(view().drawing).toEqual([[151.02, -33.9]]);
    expect(view().pointSeq).toBeNull();
  });
});
