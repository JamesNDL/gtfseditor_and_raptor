/** Formats seconds since the start of the service day as HH:MM (or HH:MM:SS). Hours can exceed 23. */
export function formatSecs(secs: number, withSeconds = false): string {
  const s = Math.max(0, Math.floor(secs));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(s % 60).padStart(2, '0')}`;
}

/** Clock-face version: 25:10 is shown as 01:10 with a "+1" day marker. */
export function formatClock(secs: number): { time: string; nextDay: boolean } {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return { time: `${String(h % 24).padStart(2, '0')}:${mm}`, nextDay: h >= 24 };
}

const DAY_SECS = 24 * 3600;
const HALF_DAY_SECS = 12 * 3600;

/**
 * The move, in seconds, that takes a time to a typed clock time (0:00 to 23:59), picking the
 * nearest such time either side of midnight. A trip at 23:50 set to 00:10 moves 20 minutes later,
 * not 23 hours 40 earlier. The move is always under 12 hours; at exactly 12 hours it moves later.
 * `fromSecs` may pass 24:00. The result can land before the service day begins: the caller (or the
 * shift edit) decides whether that is allowed.
 */
export function nearestShift(fromSecs: number, typedClockSecs: number): number {
  const ahead = (((typedClockSecs - fromSecs) % DAY_SECS) + DAY_SECS) % DAY_SECS;
  return ahead > HALF_DAY_SECS ? ahead - DAY_SECS : ahead;
}

/** The parts of the day that run times and frequencies are worked out for, in seconds since the day began. */
export const DAY_BANDS = [
  { id: 'early', label: 'early morning', from: 0, to: 6.5 * 3600 },
  { id: 'am', label: 'morning peak', from: 6.5 * 3600, to: 9.5 * 3600 },
  { id: 'day', label: 'middle of the day', from: 9.5 * 3600, to: 15 * 3600 },
  { id: 'pm', label: 'evening peak', from: 15 * 3600, to: 19 * 3600 },
  { id: 'evening', label: 'evening', from: 19 * 3600, to: Infinity },
] as const;

/** Which part of the day a time falls in, as an index into DAY_BANDS. */
export function bandOf(secs: number): number {
  const k = DAY_BANDS.findIndex((b) => secs < b.to);
  return k < 0 ? DAY_BANDS.length - 1 : k;
}
