// Joins the short line segments that marching triangles gives (contours.ts, D27) into continuous
// lines. Ends are matched on their position rounded to 1 mm, so the same crossing worked out in two
// neighbouring triangles counts as one point.
import type { Metres } from './local-metres.ts';

/** One straight piece of a line, from its start to its end, in local metres. */
export type Segment = readonly [start: Metres, end: Metres];

/** The key a segment end is matched on: its position rounded to the millimetre. */
function endKey([x, y]: Metres): string {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

/** Lists each segment under the key of one of its ends. */
function indexBy(segments: readonly Segment[], end: 0 | 1): Map<string, number[]> {
  const index = new Map<string, number[]>();
  segments.forEach((segment, s) => {
    const key = endKey(segment[end]);
    const list = index.get(key);
    if (list) list.push(s);
    else index.set(key, [s]);
  });
  return index;
}

/** Takes the first segment not yet used from those listed under `key`, marking it used. */
function take(index: Map<string, number[]>, key: string, used: boolean[]): number | undefined {
  const found = index.get(key)?.find((s) => !used[s]);
  if (found !== undefined) used[found] = true;
  return found;
}

/**
 * Joins segments end to end into lines. Segments must all run the same way round (contours.ts
 * keeps the higher values on the left), so one segment's end meets the next one's start. A line
 * that comes back to where it began is closed: its last point is its first. Segments are taken in
 * the order given, so the same segments always give the same lines (NFR-4).
 */
export function chainSegments(segments: readonly Segment[]): Metres[][] {
  const byStart = indexBy(segments, 0);
  const byEnd = indexBy(segments, 1);
  const used: boolean[] = segments.map(() => false);
  const lines: Metres[][] = [];
  segments.forEach(([start, end], s) => {
    if (used[s]) return;
    used[s] = true;
    const line: Metres[] = [start, end];
    const firstKey = endKey(start);
    let closed = false;
    for (let next = take(byStart, endKey(end), used); next !== undefined;) {
      const nextEnd = segments[next][1];
      if (endKey(nextEnd) === firstKey) {
        line.push(start);
        closed = true;
        break;
      }
      line.push(nextEnd);
      next = take(byStart, endKey(nextEnd), used);
    }
    if (!closed) {
      for (let prev = take(byEnd, firstKey, used); prev !== undefined;) {
        const prevStart = segments[prev][0];
        line.unshift(prevStart);
        prev = take(byEnd, endKey(prevStart), used);
      }
    }
    lines.push(line);
  });
  return lines;
}
