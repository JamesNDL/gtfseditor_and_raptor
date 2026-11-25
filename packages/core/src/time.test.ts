import { describe, expect, it } from 'vitest';
import { formatClock, formatSecs, nearestShift } from './time.ts';

describe('time formatting', () => {
  it('keeps hours past midnight for timetables and wraps them for the clock', () => {
    expect(formatSecs(25 * 3600 + 5 * 60)).toBe('25:05');
    expect(formatClock(25 * 3600 + 5 * 60)).toEqual({ time: '01:05', nextDay: true });
    expect(formatClock(8 * 3600)).toEqual({ time: '08:00', nextDay: false });
  });
});

const hm = (h: number, m: number): number => h * 3600 + m * 60;

// FR-11: "Depart at" moves a trip to the nearest such time, either side of midnight.
describe('nearestShift', () => {
  it('AC-FR-11.1: 23:50 set to 00:10 moves 20 minutes later', () => {
    expect(nearestShift(hm(23, 50), hm(0, 10))).toBe(20 * 60);
  });

  it('moves back across midnight: 24:10 set to 23:50 moves 20 minutes earlier', () => {
    expect(nearestShift(hm(24, 10), hm(23, 50))).toBe(-20 * 60);
  });

  it('works on times past 24:00 without crossing midnight', () => {
    expect(nearestShift(hm(25, 30), hm(1, 45))).toBe(15 * 60);
    expect(nearestShift(hm(26, 0), hm(1, 0))).toBe(-60 * 60);
  });

  it('crosses the second midnight: 47:50 set to 00:10 moves 20 minutes later', () => {
    expect(nearestShift(hm(47, 50), hm(0, 10))).toBe(20 * 60);
  });

  it('keeps ordinary moves within the day as they were', () => {
    expect(nearestShift(hm(8, 0), hm(8, 15))).toBe(15 * 60);
    expect(nearestShift(hm(8, 0), hm(7, 30))).toBe(-30 * 60);
    expect(nearestShift(hm(8, 0), hm(8, 0))).toBe(0);
  });

  it('always picks the move of under 12 hours', () => {
    expect(nearestShift(hm(8, 0), hm(19, 59))).toBe(hm(11, 59));
    expect(nearestShift(hm(8, 0), hm(20, 1))).toBe(-hm(11, 59));
    expect(nearestShift(hm(20, 0), hm(7, 0))).toBe(hm(11, 0));
  });

  it('moves later when both ways are exactly 12 hours', () => {
    expect(nearestShift(hm(6, 0), hm(18, 0))).toBe(hm(12, 0));
    expect(nearestShift(hm(18, 0), hm(6, 0))).toBe(hm(12, 0));
  });

  it('gives the nearest move even when it lands before the service day begins', () => {
    // The shift edit itself refuses a start before 00:00; this only picks the nearest time.
    expect(nearestShift(hm(0, 10), hm(23, 50))).toBe(-20 * 60);
  });
});
