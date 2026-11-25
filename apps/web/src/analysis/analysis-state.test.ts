// AA-17 (FR-16, FR-10, NFR-6): the Access pane's view state and how an analysis reads in the list.
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisListItem } from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import {
  backToList,
  defaultAnalysisView,
  forgetMissing,
  isAnalysisActive,
  newAnalysis,
  openAnalysis,
  progressShare,
  stateText,
  timetableText,
  type AnalysisView,
} from './analysis-state.ts';

const item = (over: Partial<AnalysisListItem> = {}): AnalysisListItem => ({
  id: 1,
  name: 'Town centre',
  baselineId: 1,
  scenarioId: null,
  scenarioName: null,
  zoneName: 'Centre',
  state: 'done',
  progress: null,
  error: null,
  sampleCount: 300,
  createdAt: '2026-11-26T00:00:00Z',
  finishedAt: '2026-11-26T00:01:00Z',
  ...over,
});

/** A view part-way through something, to show what each helper clears. */
const busy = (): AnalysisView => ({
  ...defaultAnalysisView(),
  screen: 'results',
  drawing: [[151.2, -33.9]],
  placingPoi: 'Hospital',
  movingPoiId: 4,
  openId: 7,
  poiSeq: 2,
  breaks: [1, 2],
  pointSeq: 30,
  compareWith: 8,
});

describe('defaultAnalysisView', () => {
  it('starts on the list with nothing open and the starting settings (D34)', () => {
    const view = defaultAnalysisView();
    expect(view).toEqual({
      screen: 'list',
      drawing: null,
      drawingClosed: false,
      drawingProblem: null,
      placingPoi: null,
      movingPoiId: null,
      setup: {
        name: '',
        scenarioId: null,
        zoneId: null,
        poiIds: [],
        settings: DEFAULT_ANALYSIS_SETTINGS,
      },
      openId: null,
      poiSeq: 0,
      breaks: null,
      pointSeq: null,
      compareWith: null,
    });
  });

  it('gives settings that can be changed without changing the starting values', () => {
    const view = defaultAnalysisView();
    view.setup.settings.breaks.push(5);
    view.setup.settings.trafficFactors.am = 2;
    expect(DEFAULT_ANALYSIS_SETTINGS.breaks).toEqual([1, 1.5, 2, 3, 4]);
    expect(DEFAULT_ANALYSIS_SETTINGS.trafficFactors.am).toBe(1.4);
  });
});

describe('openAnalysis', () => {
  it('shows the results of the analysis, starting at its first point of interest', () => {
    const view = openAnalysis(busy(), 12);
    expect(view.screen).toBe('results');
    expect(view.openId).toBe(12);
    expect(view.poiSeq).toBe(0);
    expect(view.breaks).toBeNull();
    expect(view.pointSeq).toBeNull();
    expect(view.compareWith).toBeNull();
  });

  it('stops any drawing, placing or moving on the map', () => {
    const view = openAnalysis(busy(), 12);
    expect(view.drawing).toBeNull();
    expect(view.placingPoi).toBeNull();
    expect(view.movingPoiId).toBeNull();
  });
});

describe('newAnalysis', () => {
  it('shows the setup with fresh choices on the timetable open', () => {
    const view = newAnalysis(busy(), 5);
    expect(view.screen).toBe('setup');
    expect(view.setup).toEqual({ ...defaultAnalysisView().setup, scenarioId: 5 });
    expect(view.openId).toBeNull();
    expect(view.pointSeq).toBeNull();
    expect(view.compareWith).toBeNull();
    expect(view.drawing).toBeNull();
    expect(view.placingPoi).toBeNull();
    expect(view.movingPoiId).toBeNull();
  });

  it('uses the published day when no scenario is open', () => {
    expect(newAnalysis(busy(), null).setup.scenarioId).toBeNull();
  });
});

describe('backToList', () => {
  it('goes back to the list, closing the analysis open', () => {
    const view = backToList(busy());
    expect(view.screen).toBe('list');
    expect(view.openId).toBeNull();
    expect(view.pointSeq).toBeNull();
    expect(view.compareWith).toBeNull();
    expect(view.drawing).toBeNull();
    expect(view.placingPoi).toBeNull();
    expect(view.movingPoiId).toBeNull();
  });
});

describe('forgetMissing', () => {
  it('leaves the view alone when the analyses it shows are still listed', () => {
    const view = busy();
    expect(forgetMissing(view, [7, 8, 9])).toBe(view);
  });

  it('goes back to the list when the open analysis has gone', () => {
    const view = forgetMissing(busy(), [8]);
    expect(view.screen).toBe('list');
    expect(view.openId).toBeNull();
  });

  it('drops only the comparison when the analysis compared with has gone', () => {
    const view = forgetMissing({ ...busy(), screen: 'compare' }, [7]);
    expect(view.screen).toBe('results');
    expect(view.openId).toBe(7);
    expect(view.compareWith).toBeNull();
  });

  it('leaves the setup alone, as it shows no saved analysis', () => {
    const view: AnalysisView = { ...defaultAnalysisView(), screen: 'setup' };
    expect(forgetMissing(view, [])).toBe(view);
  });
});

describe('isAnalysisActive', () => {
  it('is true while queued, preparing or running', () => {
    expect(isAnalysisActive(item({ state: 'queued' }))).toBe(true);
    expect(isAnalysisActive(item({ state: 'preparing' }))).toBe(true);
    expect(isAnalysisActive(item({ state: 'running' }))).toBe(true);
  });

  it('is false once done, failed or cancelled', () => {
    expect(isAnalysisActive(item({ state: 'done' }))).toBe(false);
    expect(isAnalysisActive(item({ state: 'failed' }))).toBe(false);
    expect(isAnalysisActive(item({ state: 'cancelled' }))).toBe(false);
  });
});

describe('progressShare', () => {
  it('is the share done while running', () => {
    const running = item({ state: 'running', progress: { stage: 'drives', done: 25, total: 100 } });
    expect(progressShare(running)).toBe(0.25);
  });

  it('is never more than the whole', () => {
    const over = item({ state: 'running', progress: { stage: 'journeys', done: 120, total: 100 } });
    expect(progressShare(over)).toBe(1);
  });

  it('is null with no count to go on', () => {
    expect(progressShare(item({ state: 'done' }))).toBeNull();
    expect(
      progressShare(item({ state: 'preparing', progress: { stage: 'timetable', secs: 4 } })),
    ).toBeNull();
    expect(
      progressShare(item({ state: 'running', progress: { stage: 'drives', total: 0 } })),
    ).toBeNull();
  });

  it('counts nothing done as none', () => {
    const started = item({ state: 'running', progress: { stage: 'drives', total: 50 } });
    expect(progressShare(started)).toBe(0);
  });
});

describe('timetableText', () => {
  it('names the scenario, or the published day', () => {
    expect(timetableText(item({ scenarioId: 3, scenarioName: 'Faster buses' }))).toBe(
      'Faster buses',
    );
    expect(timetableText(item())).toBe('Published day');
  });

  it('keeps the name of a scenario deleted since', () => {
    expect(timetableText(item({ scenarioId: null, scenarioName: 'Old plan' }))).toBe('Old plan');
  });
});

describe('stateText', () => {
  it('says where each analysis stands in plain words', () => {
    expect(stateText(item({ state: 'queued' }))).toBe('Waiting to start');
    expect(stateText(item({ state: 'preparing' }))).toBe('Loading the timetable');
    expect(stateText(item({ state: 'running' }))).toBe('Running');
    expect(stateText(item({ state: 'done' }))).toBe('Finished');
    expect(stateText(item({ state: 'cancelled' }))).toBe('Cancelled');
  });

  it('names the stage a run is at (AA-19, AC-FR-10.1)', () => {
    const at = (state: 'preparing' | 'running', stage: 'timetable' | 'drives' | 'journeys') =>
      stateText(item({ state, progress: { stage, done: 5, total: 10 } }));
    expect(at('preparing', 'timetable')).toBe('Loading the timetable');
    expect(at('running', 'drives')).toBe('Drives');
    expect(at('running', 'journeys')).toBe('Journeys');
  });

  it('gives the reason a run failed', () => {
    expect(stateText(item({ state: 'failed', error: 'The road router is not running' }))).toBe(
      'Failed: The road router is not running',
    );
    expect(stateText(item({ state: 'failed' }))).toBe('Failed');
  });
});
