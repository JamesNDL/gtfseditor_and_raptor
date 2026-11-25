// Arrive-by on screen (FR-15, FR-21, AC-FR-21.1, AC-FR-21.3, NFR-6): the settings line and the
// list say "Arrive by 08:00" or "Depart 08:00"; a picked sample point's time split has an early
// wait part, its journey starts at the journey's own departure and ends with when it arrives and
// how long before the arrive-by time; the comparison says when the two analyses use time
// differently; and the setup's time box is named after the switch.
import {
  DEFAULT_ANALYSIS_SETTINGS,
  type AnalysisListItem,
  type AnalysisSettings,
  type PtSplit,
} from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { timetableTimeText } from '../analysis-state.ts';
import { factorNote, timeBoxLabel } from '../setup/setup-form.ts';
import { timeModeNote } from './compare-text.ts';
import { arrivalText, journeyStartSecs, splitParts } from './point-detail-text.ts';
import { settingsLine } from './results-text.ts';

const MIN = 60;
const EIGHT = 8 * 3600;

const ARRIVE_BY: AnalysisSettings = {
  ...structuredClone(DEFAULT_ANALYSIS_SETTINGS),
  timeMode: 'arriveBy',
  departSecs: EIGHT,
};

/** AC-FR-21.1: leave 07:05, arrive 07:35, arrive by 08:00. */
const PT: PtSplit = {
  ptSecs: 55 * MIN,
  walkSecs: 8 * MIN,
  waitSecs: 2 * MIN,
  rideSecs: 20 * MIN,
  earlyWaitSecs: 25 * MIN,
  rides: 1,
};

describe('settingsLine (AC-FR-21.3)', () => {
  it('says arrive by and the time', () => {
    expect(settingsLine({ scenarioName: null, settings: ARRIVE_BY })).toBe(
      'Published day · Arrive by 08:00 · 250 m · walk 800 m · parking 5 min · traffic 1.4',
    );
  });
});

describe('timetableTimeText (the list)', () => {
  const item = (over: Partial<AnalysisListItem>): AnalysisListItem => ({
    id: 1,
    name: 'Mayfield',
    baselineId: 1,
    scenarioId: null,
    scenarioName: null,
    zoneName: 'Mayfield',
    state: 'done',
    progress: null,
    error: null,
    sampleCount: 100,
    createdAt: '2026-11-26T00:00:00Z',
    finishedAt: null,
    timeMode: 'depart',
    timeSecs: EIGHT,
    ...over,
  });

  it('gives the timetable and the time', () => {
    expect(timetableTimeText(item({}))).toBe('Published day · Depart 08:00');
    expect(timetableTimeText(item({ timeMode: 'arriveBy', scenarioName: 'More buses' }))).toBe(
      'More buses · Arrive by 08:00',
    );
  });
});

describe('splitParts with an early wait (FR-15)', () => {
  it('adds the early wait as a part of its own, after the ride', () => {
    const parts = splitParts(PT);
    expect(parts.map((p) => [p.kind, p.label])).toEqual([
      ['walk', 'Walk 8 min'],
      ['wait', 'Wait 2 min'],
      ['ride', 'Ride 20 min'],
      ['early', 'Early wait 25 min'],
    ]);
    expect(parts.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1);
  });

  it('leaves the early wait out when there is none', () => {
    expect(splitParts({ ...PT, ptSecs: 30 * MIN, earlyWaitSecs: 0 }).map((p) => p.kind)).toEqual([
      'walk',
      'wait',
      'ride',
    ]);
  });
});

describe('journeyStartSecs and arrivalText (AC-FR-21.1)', () => {
  it('starts an arrive-by journey when it leaves, and a depart-at one at the departure', () => {
    expect(journeyStartSecs(ARRIVE_BY, PT)).toBe(7 * 3600 + 5 * MIN);
    expect(journeyStartSecs(DEFAULT_ANALYSIS_SETTINGS, { ...PT, earlyWaitSecs: 0 })).toBe(EIGHT);
  });

  it('says when an arrive-by journey arrives and how long before the time', () => {
    expect(arrivalText(ARRIVE_BY, PT)).toBe('Arrive 07:35, 25 min before 08:00');
  });

  it('says a journey that arrives on the dot is just in time', () => {
    expect(arrivalText(ARRIVE_BY, { ...PT, earlyWaitSecs: 0 })).toBe('Arrive 08:00, just in time');
  });

  it('says nothing for a depart-at journey', () => {
    expect(arrivalText(DEFAULT_ANALYSIS_SETTINGS, PT)).toBeNull();
  });
});

describe('timeModeNote (AC-FR-21.3)', () => {
  it('says plainly when one is arrive-by and the other depart-at', () => {
    expect(
      timeModeNote(
        { timeMode: 'arriveBy', timeSecs: EIGHT },
        { timeMode: 'depart', timeSecs: EIGHT },
      ),
    ).toBe('One is arrive by 08:00, the other depart 08:00.');
  });

  it('says nothing when both use the time the same way', () => {
    expect(
      timeModeNote({ timeMode: 'depart', timeSecs: EIGHT }, { timeMode: 'depart', timeSecs: 0 }),
    ).toBeNull();
  });
});

describe('the setup time box (FR-6)', () => {
  it('is named after the switch', () => {
    expect(timeBoxLabel('depart')).toBe('Departure time');
    expect(timeBoxLabel('arriveBy')).toBe('Arrive-by time');
  });

  it('says which time the traffic factor follows', () => {
    expect(factorNote('depart', 'morning peak')).toContain(
      'the departure falls in (the morning peak)',
    );
    expect(factorNote('arriveBy', null)).toContain('the arrive-by time falls in.');
  });
});
