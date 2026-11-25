// The colours of an analysis's results and of a comparison (docs/architecture/access-analysis.md
// §5.2 'Colours'), used by the map's layers, the legend and the comparison's key. They are fixed,
// so that they read the same on both basemaps and in a report.
import type { CompareKind } from '@gtfs-editor/core';

/** The bands for the starting six (five lines), from well served to poorly served. */
export const BAND_COLOURS: readonly string[] = [
  '#2c7bb6',
  '#abd9e9',
  '#ffffbf',
  '#fdae61',
  '#f46d43',
  '#d73027',
];

/** How solid the bands are drawn, so the streets show through. */
export const BAND_OPACITY = 0.55;

/** The lines of equal ratio. */
export const LINE_COLOUR = '#333333';
export const LINE_WIDTH_PX = 1.5;

/** No service (FR-12): grey points with a white ring. */
export const NO_SERVICE_COLOUR = '#7f7f7f';
export const NO_SERVICE_RING = '#ffffff';

/** No road: hollow light grey points. */
export const NO_ROAD_COLOUR = '#cccccc';

/** Comparison (FR-17): a fall in the ratio, light then full green. */
export const COMPARE_BETTER: readonly [string, string] = ['#a6d96a', '#1a9641'];
/** Comparison: a rise in the ratio, orange then red. */
export const COMPARE_WORSE: readonly [string, string] = ['#fdae61', '#d7191c'];
/** Comparison: about the same, the middle of the same diverging scale. */
export const COMPARE_SAME = '#ffffbf';
/** The change at and under which better or worse is the light colour, and at and over the full. */
export const COMPARE_LIGHT_AT = 0.25;
export const COMPARE_FULL_AT = 1;

/** A colour as red, green and blue, 0 to 255. */
const channels = (hex: string): number[] =>
  [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));

const hexOf = (rgb: number[]): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** The colour a share `t` (0 to 1) of the way from `from` to `to`, mixed straight. */
function mix(from: string, to: string, t: number): string {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const a = channels(from);
  const b = channels(to);
  return hexOf(a.map((c, k) => c + ((b[k] ?? c) - c) * t));
}

/** The colour a share `t` (0 to 1) of the way along the band scale, mixed straight between stops. */
function alongScale(t: number): string {
  const last = BAND_COLOURS.length - 1;
  const at = Math.min(Math.max(t, 0), 1) * last;
  const low = Math.floor(at);
  const lower = BAND_COLOURS[low] ?? BAND_COLOURS[0] ?? '#000000';
  const upper = BAND_COLOURS[Math.min(low + 1, last)] ?? lower;
  return mix(lower, upper, at - low);
}

/**
 * One colour for each of `count` bands, well served first. Six bands get the six colours; any
 * other number is spread evenly over the same scale, keeping its two ends.
 */
export function bandColours(count: number): string[] {
  if (count === BAND_COLOURS.length) return [...BAND_COLOURS];
  if (count <= 1) return [alongScale(0)];
  return Array.from({ length: count }, (_, k) => alongScale(k / (count - 1)));
}

/** How a compared sample point is drawn: its fill (null for none) and its ring (null for none). */
export interface CompareStyle {
  fill: string | null;
  ring: string | null;
}

/**
 * How a compared sample point is drawn (§5.2 'Colours', AC-FR-17.1). Better is green and worse
 * orange to red: the light colour up to a change of 0.25, the full colour from 1, mixed between.
 * Gained service is a green ring and lost service a red ring; no service in either is drawn as
 * no service is on the results map.
 */
export function compareStyle(kind: CompareKind, change: number | null): CompareStyle {
  const share = (Math.abs(change ?? 0) - COMPARE_LIGHT_AT) / (COMPARE_FULL_AT - COMPARE_LIGHT_AT);
  switch (kind) {
    case 'better':
      return { fill: mix(...COMPARE_BETTER, share), ring: null };
    case 'worse':
      return { fill: mix(...COMPARE_WORSE, share), ring: null };
    case 'same':
      return { fill: COMPARE_SAME, ring: null };
    case 'gainedService':
      return { fill: null, ring: COMPARE_BETTER[1] };
    case 'lostService':
      return { fill: null, ring: COMPARE_WORSE[1] };
    case 'bothNone':
      return { fill: NO_SERVICE_COLOUR, ring: NO_SERVICE_RING };
  }
}
