import { describe, expect, it } from 'vitest';
import { formatClock, formatSecs } from './time.ts';

describe('time formatting', () => {
  it('keeps hours past midnight for timetables and wraps them for the clock', () => {
    expect(formatSecs(25 * 3600 + 5 * 60)).toBe('25:05');
    expect(formatClock(25 * 3600 + 5 * 60)).toEqual({ time: '01:05', nextDay: true });
    expect(formatClock(8 * 3600)).toEqual({ time: '08:00', nextDay: false });
  });
});
