// Arrive-by in the results export (FR-18, FR-21, AC-FR-21.3, D40): each row says how the time was
// used and what it was, and an arrive-by pair has its early wait in minutes. The columns are added
// after the ones that were there, which keep their names and order.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from '@gtfs-editor/core';
import { EXPORT_COLUMNS, csvOf, exportRowOf, type ExportPair } from './export-rows.ts';

const pair: ExportPair = {
  seq: 5,
  i: 0,
  j: 1,
  lon: 151.2,
  lat: -33.9,
  poiSeq: 0,
  poiName: 'Westfield',
  status: 'ok',
  ptSecs: 55 * 60,
  walkSecs: 8 * 60,
  waitSecs: 2 * 60,
  rideSecs: 20 * 60,
  rides: 1,
  legs: null,
  driveSecs: 600,
  driveMetres: 7000,
  carSecs: 1140,
  ratio: 2.8947,
  earlyWaitSecs: 25 * 60,
};

const arriveBy: AnalysisSettings = {
  ...DEFAULT_ANALYSIS_SETTINGS,
  timeMode: 'arriveBy',
  departSecs: 8 * 3600,
};

describe('the export of an arrive-by analysis', () => {
  it('keeps the old columns first, in their order, and adds the time mode, time and early wait', () => {
    expect(EXPORT_COLUMNS.slice(-4)).toEqual(['ratio', 'time_mode', 'time', 'early_wait_mins']);
  });

  it('AC-FR-21.3: says arrive by and the time, with the early wait in minutes', () => {
    expect(exportRowOf(pair, arriveBy)).toMatchObject({
      pt_mins: 55,
      time_mode: 'arrive_by',
      time: '08:00',
      early_wait_mins: 25,
    });
  });

  it('leaves the early wait empty for a pair with no journey', () => {
    const none = { ...pair, status: 'noService' as const, ptSecs: null, earlyWaitSecs: null };
    expect(exportRowOf(none, arriveBy).early_wait_mins).toBeNull();
  });

  it('leaves the early wait empty for a depart-at analysis', () => {
    expect(exportRowOf({ ...pair, earlyWaitSecs: null }, DEFAULT_ANALYSIS_SETTINGS)).toMatchObject({
      time_mode: 'depart',
      time: '08:00',
      early_wait_mins: null,
    });
  });

  it('writes the new cells at the end of the CSV line', () => {
    const line = csvOf([exportRowOf(pair, arriveBy)]).split('\r\n')[1];
    expect(line?.endsWith(',2.89,arrive_by,08:00,25.0')).toBe(true);
  });
});
