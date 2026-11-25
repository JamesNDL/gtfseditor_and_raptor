// The limits on an access analysis (NFR-3) and the plain-English reason an analysis is refused.

/** The most and least an analysis may ask for. Corners are those of a zone's outline. */
export const ANALYSIS_LIMITS = {
  maxSamplePoints: 10_000,
  maxPois: 10,
  minSpacingM: 50,
  maxSpacingM: 2_000,
  minCorners: 3,
  maxCorners: 200,
} as const;

/** What an analysis would ask for: its sample points, points of interest and (if known) spacing. */
export interface AnalysisCounts {
  samplePoints: number;
  pois: number;
  spacingM?: number;
}

const n = (value: number): string => value.toLocaleString('en-AU');

/** The spacing's problem, or null when it is in range. */
function spacingProblem(spacingM: number): string | null {
  const { minSpacingM, maxSpacingM } = ANALYSIS_LIMITS;
  if (!Number.isFinite(spacingM)) {
    return `The spacing must be a number of metres between ${n(minSpacingM)} and ${n(maxSpacingM)}.`;
  }
  if (spacingM < minSpacingM) {
    return `A spacing of ${n(spacingM)} m is too close; the least is ${n(minSpacingM)} m.`;
  }
  if (spacingM > maxSpacingM) {
    return `A spacing of ${n(spacingM)} m is too wide; the most is ${n(maxSpacingM)} m.`;
  }
  return null;
}

/**
 * Why an analysis cannot start, or null when it is within the limits. The spacing is checked
 * first, as a wrong spacing is usually why the sample point count is off.
 */
export function analysisProblem(counts: AnalysisCounts): string | null {
  const { samplePoints, pois, spacingM } = counts;
  const { maxSamplePoints, maxPois } = ANALYSIS_LIMITS;
  if (spacingM !== undefined) {
    const problem = spacingProblem(spacingM);
    if (problem) return problem;
  }
  if (samplePoints > maxSamplePoints) {
    return `This makes ${n(samplePoints)} sample points; the most is ${n(maxSamplePoints)}. Use a wider spacing or a smaller zone.`;
  }
  // BRD edge cases: a spacing that gives no sample points inside the zone is refused with the count.
  if (samplePoints < 1) {
    return `This makes ${n(samplePoints)} sample points. Use a closer spacing or a bigger zone.`;
  }
  if (pois > maxPois) {
    return `This has ${n(pois)} points of interest; the most is ${n(maxPois)}. Remove some points of interest.`;
  }
  return null;
}
