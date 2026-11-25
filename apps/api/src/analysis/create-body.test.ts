// R-AA-1 (review finding F-4): the modes an analysis allows are the journey router's kinds of
// vehicle. A word the router does not know is refused with a 400 naming it, rather than stored and
// run with every pair coming back no service.
import { describe, expect, it } from 'vitest';
import { analysisBodyOf } from './create-body.ts';

const body = (modes: unknown): unknown => ({
  baselineId: 1,
  zoneId: 2,
  poiIds: [3],
  settings: { modes },
});

/** The status code and message `analysisBodyOf` refuses a body with. */
function refusal(given: unknown): { statusCode: number; message: string } | null {
  try {
    analysisBodyOf(given);
    return null;
  } catch (err) {
    const statusCode =
      err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number'
        ? err.statusCode
        : 0;
    return { statusCode, message: err instanceof Error ? err.message : String(err) };
  }
}

describe('analysisBodyOf: modes', () => {
  it('takes the router modes as given', () => {
    expect(analysisBodyOf(body(['bus', 'light_rail', 'school_bus'])).settings.modes).toEqual([
      'bus',
      'light_rail',
      'school_bus',
    ]);
  });

  it('refuses a mode the journey router does not know, naming it', () => {
    const refused = refusal(body(['bus', 'spaceship']));
    expect(refused?.statusCode).toBe(400);
    expect(refused?.message).toContain('spaceship');
  });

  it('names every unknown mode', () => {
    const refused = refusal(body(['buss', 'tram', 'train']));
    expect(refused?.statusCode).toBe(400);
    expect(refused?.message).toContain('buss');
    expect(refused?.message).toContain('tram');
  });
});

describe('analysisBodyOf: time mode (FR-21)', () => {
  const timed = (settings: unknown): unknown => ({
    baselineId: 1,
    zoneId: 2,
    poiIds: [3],
    settings,
  });

  it('reads a body with no time mode as depart-at', () => {
    expect(analysisBodyOf(timed({ departSecs: 28_800 })).settings.timeMode).toBe('depart');
  });

  it('takes arrive-by with its time', () => {
    const { settings } = analysisBodyOf(timed({ timeMode: 'arriveBy', departSecs: 28_800 }));
    expect(settings.timeMode).toBe('arriveBy');
    expect(settings.departSecs).toBe(28_800);
  });

  it('takes depart-at when it is named', () => {
    expect(analysisBodyOf(timed({ timeMode: 'depart' })).settings.timeMode).toBe('depart');
  });

  it('refuses any other time mode with a 400 naming the two', () => {
    for (const timeMode of ['arrive', 'ARRIVEBY', 3, null]) {
      const refused = refusal(timed({ timeMode }));
      expect(refused?.statusCode).toBe(400);
      expect(refused?.message).toContain('"depart" or "arriveBy"');
    }
  });
});
