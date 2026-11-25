// The colours of an analysis's results (docs/architecture/access-analysis.md §5.2 'Colours'), used
// by the map's layers and by the legend. They are fixed, so that they read the same on both
// basemaps and in a report.

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

/** A colour as red, green and blue, 0 to 255. */
const channels = (hex: string): number[] =>
  [1, 3, 5].map((k) => Number.parseInt(hex.slice(k, k + 2), 16));

const hexOf = (rgb: number[]): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** The colour a share `t` (0 to 1) of the way along the band scale, mixed straight between stops. */
function alongScale(t: number): string {
  const last = BAND_COLOURS.length - 1;
  const at = Math.min(Math.max(t, 0), 1) * last;
  const low = Math.floor(at);
  const lower = BAND_COLOURS[low] ?? BAND_COLOURS[0] ?? '#000000';
  const upper = BAND_COLOURS[Math.min(low + 1, last)] ?? lower;
  const mix = at - low;
  if (mix === 0) return lower;
  const a = channels(lower);
  const b = channels(upper);
  return hexOf(a.map((c, k) => c + ((b[k] ?? c) - c) * mix));
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
