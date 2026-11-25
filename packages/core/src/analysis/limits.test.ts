// The NFR-3 limits on an analysis (AC-NFR-3.1, logic) and the spacing range.
import { describe, expect, it } from 'vitest';
import { ANALYSIS_LIMITS, analysisProblem } from './limits.ts';

describe('ANALYSIS_LIMITS', () => {
  it('holds the agreed limits', () => {
    expect(ANALYSIS_LIMITS).toEqual({
      maxSamplePoints: 10_000,
      maxPois: 10,
      minSpacingM: 50,
      maxSpacingM: 2_000,
      minCorners: 3,
      maxCorners: 200,
    });
  });
});

describe('analysisProblem', () => {
  it('AC-NFR-3.1: refuses 10,001 sample points with the reason', () => {
    expect(analysisProblem({ samplePoints: 10_001, pois: 1 })).toBe(
      'This makes 10,001 sample points; the most is 10,000. Use a wider spacing or a smaller zone.',
    );
  });

  it('passes exactly 10,000 sample points and 10 points of interest', () => {
    expect(analysisProblem({ samplePoints: 10_000, pois: 10, spacingM: 250 })).toBeNull();
  });

  it('refuses 11 points of interest with the reason', () => {
    expect(analysisProblem({ samplePoints: 16, pois: 11 })).toBe(
      'This has 11 points of interest; the most is 10. Remove some points of interest.',
    );
  });

  it('refuses a zone that gets no sample points, with the count', () => {
    expect(analysisProblem({ samplePoints: 0, pois: 1 })).toBe(
      'This makes 0 sample points. Use a closer spacing or a bigger zone.',
    );
  });

  it('refuses a spacing under 50 m', () => {
    expect(analysisProblem({ samplePoints: 16, pois: 1, spacingM: 49 })).toBe(
      'A spacing of 49 m is too close; the least is 50 m.',
    );
  });

  it('refuses a spacing over 2,000 m', () => {
    expect(analysisProblem({ samplePoints: 16, pois: 1, spacingM: 2_500 })).toBe(
      'A spacing of 2,500 m is too wide; the most is 2,000 m.',
    );
  });

  it('passes the spacing at both ends of the range', () => {
    expect(analysisProblem({ samplePoints: 16, pois: 1, spacingM: 50 })).toBeNull();
    expect(analysisProblem({ samplePoints: 16, pois: 1, spacingM: 2_000 })).toBeNull();
  });

  it('refuses a spacing that is not a number', () => {
    expect(analysisProblem({ samplePoints: 16, pois: 1, spacingM: Number.NaN })).toBe(
      'The spacing must be a number of metres between 50 and 2,000.',
    );
  });
});
