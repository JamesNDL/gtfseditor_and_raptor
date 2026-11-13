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
