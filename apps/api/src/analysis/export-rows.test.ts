// AA-22: the rows of the results export (FR-18, AC-FR-18.1; docs/architecture/access-analysis.md
// §5.3): one per sample point and point of interest, with the columns in the order §5.3 gives,
// minutes to a tenth, kilometres and ratios to two places, and empty cells where there is nothing.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS } from '@gtfs-editor/core';
import { EXPORT_COLUMNS, csvOf, exportRowOf, type ExportPair } from './export-rows.ts';

const okPair: ExportPair = {
  seq: 12,
  i: 3,
  j: 1,
  lon: 151.2034567,
  lat: -33.9123456,
  poiSeq: 1,
  poiName: 'Town hall',
  status: 'ok',
  ptSecs: 1234,
  walkSecs: 300,
  waitSecs: 240,
  rideSecs: 694,
  rides: 1,
  legs: null,
  driveSecs: 456.78,
  driveMetres: 5432.1,
  carSecs: 939.49,
  ratio: 1.3135,
  earlyWaitSecs: null,
};

const noRoadPair: ExportPair = {
  ...okPair,
  seq: 13,
  status: 'noRoad',
  poiName: 'Smith\'s "big", shop',
  driveSecs: null,
  driveMetres: null,
  carSecs: null,
  ratio: null,
};

const noServicePair: ExportPair = {
  ...okPair,
  seq: 14,
  status: 'noService',
  ptSecs: null,
  walkSecs: null,
  waitSecs: null,
  rideSecs: null,
  rides: null,
  ratio: null,
};

describe('exportRowOf', () => {
  it('gives the columns of §5.3 with times in minutes and distances in kilometres', () => {
    const row = exportRowOf(okPair, DEFAULT_ANALYSIS_SETTINGS);
    expect(Object.keys(row)).toEqual([...EXPORT_COLUMNS]);
    expect(row).toEqual({
      point: 12,
      lat: -33.9123456,
      lon: 151.2034567,
      poi: 1,
      poi_name: 'Town hall',
      status: 'ok',
      pt_mins: 20.6,
      walk_mins: 5,
      wait_mins: 4,
      ride_mins: 11.6,
      rides: 1,
      drive_mins_free_flow: 7.6,
      drive_km: 5.43,
      // 08:00 is in the morning peak.
      traffic_factor: 1.4,
      parking_mins: 5,
      car_mins: 15.7,
      ratio: 1.31,
      time_mode: 'depart',
      time: '08:00',
      early_wait_mins: null,
    });
  });

  it('leaves out what a pair with no road or no service does not have', () => {
    const noRoad = exportRowOf(noRoadPair, DEFAULT_ANALYSIS_SETTINGS);
    expect(noRoad).toMatchObject({
      status: 'noRoad',
      pt_mins: 20.6,
      drive_mins_free_flow: null,
      drive_km: null,
      car_mins: null,
      ratio: null,
    });
    const noService = exportRowOf(noServicePair, DEFAULT_ANALYSIS_SETTINGS);
    expect(noService).toMatchObject({
      status: 'noService',
      pt_mins: null,
      walk_mins: null,
      wait_mins: null,
      ride_mins: null,
      rides: null,
      car_mins: 15.7,
      ratio: null,
    });
  });

  it('takes the traffic factor and parking allowance from the settings', () => {
    const settings = { ...DEFAULT_ANALYSIS_SETTINGS, departSecs: 12 * 3600, parkingMins: 7.5 };
    expect(exportRowOf(okPair, settings)).toMatchObject({
      traffic_factor: 1.2,
      parking_mins: 7.5,
    });
  });
});

describe('csvOf', () => {
  const rows = [okPair, noRoadPair, noServicePair].map((p) =>
    exportRowOf(p, DEFAULT_ANALYSIS_SETTINGS),
  );
  const lines = csvOf(rows).split('\r\n');

  it('starts with the header and has one line per row, ending with a line break', () => {
    expect(lines[0]).toBe(
      'point,lat,lon,poi,poi_name,status,pt_mins,walk_mins,wait_mins,ride_mins,rides,' +
        'drive_mins_free_flow,drive_km,traffic_factor,parking_mins,car_mins,ratio,' +
        'time_mode,time,early_wait_mins',
    );
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('');
  });

  it('writes minutes to one place, kilometres and ratios to two, and nothing for null', () => {
    expect(lines[1]).toBe(
      '12,-33.9123456,151.2034567,1,Town hall,ok,20.6,5.0,4.0,11.6,1,7.6,5.43,1.4,5.0,15.7,1.31,' +
        'depart,08:00,',
    );
    expect(lines[3]).toBe(
      '14,-33.9123456,151.2034567,1,Town hall,noService,,,,,,7.6,5.43,1.4,5.0,15.7,,depart,08:00,',
    );
  });

  it('quotes a name that holds a comma or a quote, doubling the quotes', () => {
    expect(lines[2]).toBe(
      '13,-33.9123456,151.2034567,1,"Smith\'s ""big"", shop",noRoad,20.6,5.0,4.0,11.6,1,,,1.4,' +
        '5.0,,,depart,08:00,',
    );
  });

  it('puts a quote mark before a name a spreadsheet would take as a formula', () => {
    const nameCellOf = (poiName: string): string | undefined =>
      csvOf([exportRowOf({ ...okPair, poiName }, DEFAULT_ANALYSIS_SETTINGS)])
        .split('\r\n')[1]
        ?.split(',')[4];
    expect(nameCellOf('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(nameCellOf('+61 shop')).toBe("'+61 shop");
    expect(nameCellOf('-1 Main St')).toBe("'-1 Main St");
    expect(nameCellOf('@home')).toBe("'@home");
    expect(nameCellOf('Town hall = centre')).toBe('Town hall = centre');
  });

  it('gives just the header when there are no rows', () => {
    expect(csvOf([])).toBe(`${EXPORT_COLUMNS.join(',')}\r\n`);
  });
});
