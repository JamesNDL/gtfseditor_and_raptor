// AA-19 (FR-6, FR-8, FR-9, NFR-3, NFR-6): the setup screen's pure parts: the departure as text,
// the parts of the day, the live count line, why Run is refused and the body Run sends.
import {
  DAY_BANDS,
  DEFAULT_ANALYSIS_SETTINGS,
  gridCount,
  type GeoJsonPosition,
} from '@gtfs-editor/core';
import { describe, expect, it } from 'vitest';
import { defaultAnalysisView, type AnalysisSetupChoices } from '../analysis-state.ts';
import {
  bandText,
  clockSecs,
  clockText,
  countLine,
  createBody,
  setupCount,
  setupProblem,
} from './setup-form.ts';

/** A square about 1.1 km a side in Newcastle. */
const SQUARE: GeoJsonPosition[] = [
  [151.77, -32.93],
  [151.782, -32.93],
  [151.782, -32.92],
  [151.77, -32.92],
];

/** A box two degrees a side: far too many sample points at any close spacing. */
const HUGE: GeoJsonPosition[] = [
  [150, -34],
  [152, -34],
  [152, -32],
  [150, -32],
];

const setup = (over: Partial<AnalysisSetupChoices> = {}): AnalysisSetupChoices => ({
  ...defaultAnalysisView().setup,
  zoneId: 1,
  poiIds: [4, 5],
  ...over,
});

describe('clockText and clockSecs (the departure as text)', () => {
  it('shows seconds as HH:MM', () => {
    expect(clockText(8 * 3600)).toBe('08:00');
    expect(clockText(25 * 3600 + 30 * 60)).toBe('25:30');
  });

  it('reads HH:MM and H:MM, past midnight too', () => {
    expect(clockSecs('08:00')).toBe(8 * 3600);
    expect(clockSecs('8:05')).toBe(8 * 3600 + 5 * 60);
    expect(clockSecs(' 25:30 ')).toBe(25 * 3600 + 30 * 60);
    expect(clockSecs('00:00')).toBe(0);
  });

  it('refuses text that is not a time', () => {
    for (const text of ['', '8', '0800', '8:5', '08:60', 'eight', '-1:00', '8:00 am']) {
      expect(clockSecs(text)).toBeNull();
    }
  });

  it('reads back what it shows', () => {
    for (const secs of [0, 6.5 * 3600, 8 * 3600, 23 * 3600 + 59 * 60, 36 * 3600]) {
      expect(clockSecs(clockText(secs))).toBe(secs);
    }
  });
});

describe('bandText (the label of each traffic factor box)', () => {
  it('gives each part of the day its name and times', () => {
    expect(DAY_BANDS.map(bandText)).toEqual([
      'Early morning, 00:00 to 06:30',
      'Morning peak, 06:30 to 09:30',
      'Middle of the day, 09:30 to 15:00',
      'Evening peak, 15:00 to 19:00',
      'Evening, from 19:00',
    ]);
  });
});

describe('setupCount (AC-FR-6.1)', () => {
  it('counts the sample points as the API will lay them', () => {
    expect(setupCount(SQUARE, 250)).toEqual({
      samplePoints: gridCount(SQUARE, 250),
      approximate: false,
    });
    expect(setupCount(SQUARE, 100).samplePoints).toBe(gridCount(SQUARE, 100));
  });

  it('has no count without a zone, or with a spacing out of range', () => {
    expect(setupCount(null, 250)).toEqual({ samplePoints: null, approximate: false });
    expect(setupCount(SQUARE, 20).samplePoints).toBeNull();
    expect(setupCount(SQUARE, 5000).samplePoints).toBeNull();
    expect(setupCount(SQUARE, Number.NaN).samplePoints).toBeNull();
  });

  it('works out a huge zone at a close spacing from its area, quickly', () => {
    const started = performance.now();
    const count = setupCount(HUGE, 50);
    expect(performance.now() - started).toBeLessThan(200);
    expect(count.approximate).toBe(true);
    // About 186 km by 222 km at 50 m: some 16.5 million.
    expect(count.samplePoints).toBeGreaterThan(15_000_000);
    expect(count.samplePoints).toBeLessThan(18_000_000);
  });
});

describe('countLine (AC-FR-6.1, NFR-6)', () => {
  it('gives the sample points, points of interest and journeys, with thousands separators', () => {
    expect(countLine({ samplePoints: 312, approximate: false }, 2)).toBe(
      '312 sample points, 2 points of interest: 624 public transport journeys and 624 drives',
    );
    expect(countLine({ samplePoints: 5_000, approximate: false }, 3)).toBe(
      '5,000 sample points, 3 points of interest: 15,000 public transport journeys and 15,000 drives',
    );
  });

  it('uses the singular for one', () => {
    expect(countLine({ samplePoints: 1, approximate: false }, 1)).toBe(
      '1 sample point, 1 point of interest: 1 public transport journey and 1 drive',
    );
  });

  it('says when the count is worked out from the area', () => {
    expect(countLine({ samplePoints: 16_500_000, approximate: true }, 1)).toBe(
      'About 16,500,000 sample points, 1 point of interest: 16,500,000 public transport journeys and 16,500,000 drives',
    );
  });

  it('has no line without a count', () => {
    expect(countLine({ samplePoints: null, approximate: false }, 2)).toBeNull();
  });
});

describe('setupProblem (why Run is disabled; AC-NFR-3.1)', () => {
  const fine = { samplePoints: 312, approximate: false };

  it('is null when everything can run', () => {
    expect(setupProblem(setup(), fine)).toBeNull();
  });

  it('asks for a zone and a point of interest first', () => {
    expect(setupProblem(setup({ zoneId: null }), { samplePoints: null, approximate: false })).toBe(
      'Choose a zone.',
    );
    expect(setupProblem(setup({ poiIds: [] }), fine)).toBe(
      'Choose at least one point of interest.',
    );
  });

  it('gives the limits message for 10,001 sample points', () => {
    expect(setupProblem(setup(), { samplePoints: 10_001, approximate: false })).toBe(
      'This makes 10,001 sample points; the most is 10,000. Use a wider spacing or a smaller zone.',
    );
  });

  it('allows exactly 10,000 sample points', () => {
    expect(setupProblem(setup(), { samplePoints: 10_000, approximate: false })).toBeNull();
  });

  it('gives the spacing message for a spacing out of range', () => {
    const close = setup({ settings: { ...DEFAULT_ANALYSIS_SETTINGS, spacingM: 20 } });
    expect(setupProblem(close, { samplePoints: null, approximate: false })).toBe(
      'A spacing of 20 m is too close; the least is 50 m.',
    );
  });

  it('refuses more than 10 points of interest', () => {
    const many = setup({ poiIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    expect(setupProblem(many, fine)).toBe(
      'This has 11 points of interest; the most is 10. Remove some points of interest.',
    );
  });

  it('refuses settings out of range, and a bad departure time', () => {
    const walk = setup({ settings: { ...DEFAULT_ANALYSIS_SETTINGS, maxWalkM: 50 } });
    expect(setupProblem(walk, fine)).toBe('The longest walk must be between 100 and 2,000 m.');
    const depart = setup({ settings: { ...DEFAULT_ANALYSIS_SETTINGS, departSecs: Number.NaN } });
    expect(setupProblem(depart, fine)).toBe('The departure time must be between 00:00 and 36:00.');
  });

  it('needs at least one mode', () => {
    const none = setup({ settings: { ...DEFAULT_ANALYSIS_SETTINGS, modes: [] } });
    expect(setupProblem(none, fine)).toBe('Allow at least one mode.');
  });
});

describe('createBody (what Run posts)', () => {
  it('sends the day, timetable, zone, points of interest and settings', () => {
    const body = createBody(setup({ scenarioId: 3 }), 9);
    expect(body).toEqual({
      baselineId: 9,
      scenarioId: 3,
      zoneId: 1,
      poiIds: [4, 5],
      settings: DEFAULT_ANALYSIS_SETTINGS,
    });
    expect(body && 'name' in body).toBe(false);
  });

  it('sends a name only when one is given, trimmed', () => {
    expect(createBody(setup({ name: '  Morning check ' }), 9)?.name).toBe('Morning check');
    expect(createBody(setup({ name: '   ' }), 9)).not.toHaveProperty('name');
  });

  it('has no body without a zone', () => {
    expect(createBody(setup({ zoneId: null }), 9)).toBeNull();
  });
});
