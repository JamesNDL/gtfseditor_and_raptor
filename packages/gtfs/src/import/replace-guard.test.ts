import { describe, expect, it } from 'vitest';
import { dateProblem, isoDate, replaceRefusal } from './replace-guard.ts';

describe('dateProblem', () => {
  it('accepts a real YYYYMMDD date, including a leap day', () => {
    expect(dateProblem('20260707')).toBeUndefined();
    expect(dateProblem('20280229')).toBeUndefined();
  });

  it('refuses other shapes', () => {
    for (const bad of ['2026-07-07', '2026077', '202607071', 'tomorrow', '']) {
      expect(dateProblem(bad)).toMatch(/must be YYYYMMDD/);
    }
  });

  it('refuses dates that do not exist', () => {
    for (const bad of ['20261340', '20260230', '20270229', '20260700']) {
      expect(dateProblem(bad)).toBe(`${bad} is not a real date`);
    }
  });
});

describe('isoDate', () => {
  it('turns YYYYMMDD into YYYY-MM-DD, and throws on a bad date', () => {
    expect(isoDate('20260106')).toBe('2026-01-06');
    expect(() => isoDate('20261340')).toThrow('20261340 is not a real date');
  });
});

describe('replaceRefusal', () => {
  it('names the day and the number of scenarios', () => {
    expect(replaceRefusal('20260106', 1)).toBe(
      '2026-01-06 has 1 scenario. Re-importing the day deletes it. ' +
        'Run `npm run db:backup` first, then add --replace.',
    );
    expect(replaceRefusal('20260106', 2)).toMatch(
      /^2026-01-06 has 2 scenarios\. .* deletes them\./,
    );
  });
});
