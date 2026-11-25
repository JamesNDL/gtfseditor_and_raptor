// AA-20 (FR-14, FR-12; docs/architecture/access-analysis.md §5.2 'Colours'): the six band colours
// for the starting lines, the same scale spread over other numbers of lines, and the fixed styles
// of the lines, no service and no road.
import { describe, expect, it } from 'vitest';
import {
  BAND_COLOURS,
  BAND_OPACITY,
  COMPARE_BETTER,
  COMPARE_SAME,
  COMPARE_WORSE,
  LINE_COLOUR,
  LINE_WIDTH_PX,
  NO_ROAD_COLOUR,
  NO_SERVICE_COLOUR,
  NO_SERVICE_RING,
  bandColours,
  compareStyle,
} from './analysis-colours.ts';

const SIX = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#f46d43', '#d73027'];

/** A colour's red, green and blue, 0 to 255. */
const rgb = (hex: string): number[] => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));

describe('the band colours (AC-FR-14.1)', () => {
  it('are the six colours, well served to poorly served, at 55%', () => {
    expect(BAND_COLOURS).toEqual(SIX);
    expect(BAND_OPACITY).toBe(0.55);
  });

  it('are exactly the six for the starting five lines (six bands)', () => {
    expect(bandColours(6)).toEqual(SIX);
  });

  it('spread over the same scale for two bands: the two ends', () => {
    expect(bandColours(2)).toEqual(['#2c7bb6', '#d73027']);
  });

  it('spread over the same scale for three bands: the ends and the middle', () => {
    const [first, middle, last] = bandColours(3);
    expect(first).toBe('#2c7bb6');
    expect(last).toBe('#d73027');
    // Halfway along the scale is halfway between #ffffbf and #fdae61.
    const [r, g, b] = rgb(middle ?? '');
    expect(r).toBeCloseTo((0xff + 0xfd) / 2, -0.5);
    expect(g).toBeCloseTo((0xff + 0xae) / 2, -0.5);
    expect(b).toBeCloseTo((0xbf + 0x61) / 2, -0.5);
  });

  it('give one distinct colour per band for nine bands (eight lines), ends included', () => {
    const colours = bandColours(9);
    expect(colours).toHaveLength(9);
    expect(new Set(colours).size).toBe(9);
    expect(colours[0]).toBe('#2c7bb6');
    expect(colours[8]).toBe('#d73027');
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('give the well-served colour to a single band', () => {
    expect(bandColours(1)).toEqual(['#2c7bb6']);
  });
});

describe('the fixed styles (AC-FR-14.1, AC-FR-12.1)', () => {
  it('draws lines dark grey, 1.5 px', () => {
    expect(LINE_COLOUR).toBe('#333333');
    expect(LINE_WIDTH_PX).toBe(1.5);
  });

  it('draws no service grey with a white ring, and no road light grey', () => {
    expect(NO_SERVICE_COLOUR).toBe('#7f7f7f');
    expect(NO_SERVICE_RING).toBe('#ffffff');
    expect(NO_ROAD_COLOUR).toBe('#cccccc');
  });
});

// AA-23 (FR-17, AC-FR-17.1; §5.2 'Colours'): a compared sample point's style. Better is green and
// worse orange to red, lighter at a change of 0.25 or less and full at a change of 1 or more;
// gained service is a green ring and lost service a red ring.
describe('compareStyle (AC-FR-17.1)', () => {
  it('keeps the comparison colours', () => {
    expect(COMPARE_BETTER).toEqual(['#a6d96a', '#1a9641']);
    expect(COMPARE_WORSE).toEqual(['#fdae61', '#d7191c']);
    expect(COMPARE_SAME).toBe('#ffffbf');
  });

  it('colours a small fall light green and a fall of 1 or more full green', () => {
    expect(compareStyle('better', -0.1)).toEqual({ fill: '#a6d96a', ring: null });
    expect(compareStyle('better', -0.25)).toEqual({ fill: '#a6d96a', ring: null });
    expect(compareStyle('better', -1)).toEqual({ fill: '#1a9641', ring: null });
    expect(compareStyle('better', -3.5)).toEqual({ fill: '#1a9641', ring: null });
  });

  it('colours a small rise orange and a rise of 1 or more red', () => {
    expect(compareStyle('worse', 0.1)).toEqual({ fill: '#fdae61', ring: null });
    expect(compareStyle('worse', 0.25)).toEqual({ fill: '#fdae61', ring: null });
    expect(compareStyle('worse', 1)).toEqual({ fill: '#d7191c', ring: null });
    expect(compareStyle('worse', 2)).toEqual({ fill: '#d7191c', ring: null });
  });

  it('mixes between the two colours for changes between 0.25 and 1', () => {
    const fill = compareStyle('better', -0.625).fill ?? '';
    const [r, g, b] = rgb(fill);
    expect(r).toBeCloseTo((0xa6 + 0x1a) / 2, -0.5);
    expect(g).toBeCloseTo((0xd9 + 0x96) / 2, -0.5);
    expect(b).toBeCloseTo((0x6a + 0x41) / 2, -0.5);
    expect(compareStyle('worse', 0.5).fill).not.toBe(compareStyle('worse', 0.75).fill);
  });

  it('colours about the same pale yellow', () => {
    expect(compareStyle('same', 0.02)).toEqual({ fill: '#ffffbf', ring: null });
  });

  it('rings gained service green and lost service red, with no fill', () => {
    expect(compareStyle('gainedService', null)).toEqual({ fill: null, ring: '#1a9641' });
    expect(compareStyle('lostService', null)).toEqual({ fill: null, ring: '#d7191c' });
  });

  it('draws no service in either as no service is drawn', () => {
    expect(compareStyle('bothNone', null)).toEqual({ fill: '#7f7f7f', ring: '#ffffff' });
  });
});
