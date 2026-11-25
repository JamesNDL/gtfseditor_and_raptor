// The setup screen's pure parts (FR-6, FR-8, FR-9, FR-21, NFR-3): the time as text and the name of
// its box, the label of each traffic factor box and the note above them, the live count line, why
// Run is refused and the body Run posts.
// See docs/architecture/access-analysis.md §5.2.
import {
  ANALYSIS_LIMITS,
  analysisProblem,
  formatSecs,
  gridCount,
  localFrame,
  openRing,
  settingsProblem,
  type AnalysisCreateBody,
  type Ring,
  type TimeMode,
} from '@gtfs-editor/core';
import type { AnalysisSetupChoices } from '../analysis-state.ts';

/** The departure as HH:MM; hours can pass 23. */
export const clockText = (secs: number): string => formatSecs(secs);

/** Reads "H:MM" or "HH:MM" (hours can pass 23) into seconds, or null when it is not a time. */
export function clockSecs(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[2]);
  return minutes < 60 ? Number(match[1]) * 3600 + minutes * 60 : null;
}

/** The name of the time box, which follows the Depart at / Arrive by switch. */
export const timeBoxLabel = (mode: TimeMode): string =>
  mode === 'arriveBy' ? 'Arrive-by time' : 'Departure time';

/**
 * The note above the traffic factors: the drive is multiplied by the factor of the part of the day
 * the departure, or the arrive-by time, falls in (FR-9), naming that part when the time is set.
 */
export function factorNote(mode: TimeMode, bandLabel: string | null): string {
  const time = mode === 'arriveBy' ? 'the arrive-by time' : 'the departure';
  return (
    'Traffic factors: the drive time with no traffic is multiplied by the factor for the part ' +
    `of the day ${time} falls in${bandLabel ? ` (the ${bandLabel}).` : '.'}`
  );
}

/** A part of the day in DAY_BANDS: its name and when it starts and ends, in seconds. */
interface DayBand {
  label: string;
  from: number;
  to: number;
}

/** A part of the day with its times, such as "Morning peak, 06:30 to 09:30". */
export function bandText(band: DayBand): string {
  const name = band.label.charAt(0).toUpperCase() + band.label.slice(1);
  const from = formatSecs(band.from);
  return Number.isFinite(band.to)
    ? `${name}, ${from} to ${formatSecs(band.to)}`
    : `${name}, from ${from}`;
}

/** The sample points a zone and spacing give, or null with no zone or a spacing out of range. */
export interface SetupCount {
  samplePoints: number | null;
  /** True when worked out from the zone's area, as laying the grid would take too long. */
  approximate: boolean;
}

/** Above this many grid cells over the zone's box, the count is first worked out from the area. */
const MAX_CELLS_COUNTED = 250_000;

/** The grid cells over the zone's box and the zone's area in square metres, in local metres. */
function boxCellsAndArea(ring: Ring, spacingM: number): { cells: number; areaM2: number } {
  const corners = openRing(ring);
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const frame = localFrame(
    (Math.min(...lons) + Math.max(...lons)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  );
  const metres = corners.map((corner) => frame.toMetres(corner));
  const xs = metres.map(([x]) => x);
  const ys = metres.map(([, y]) => y);
  const cells =
    Math.ceil((Math.max(...xs) - Math.min(...xs)) / spacingM) *
    Math.ceil((Math.max(...ys) - Math.min(...ys)) / spacingM);
  // The shoelace formula.
  let twice = 0;
  metres.forEach(([x, y], k) => {
    const [nx, ny] = metres[(k + 1) % metres.length];
    twice += x * ny - nx * y;
  });
  return { cells, areaM2: Math.abs(twice) / 2 };
}

/**
 * How many sample points the zone gives at this spacing, as the API lays them (`gridCount`). A
 * zone whose box holds a great many cells is counted from its area instead when that is plainly
 * over the limit, so that typing a close spacing over a big zone never holds up the screen.
 */
export function setupCount(ring: Ring | null, spacingM: number): SetupCount {
  const { minSpacingM, maxSpacingM, maxSamplePoints } = ANALYSIS_LIMITS;
  const inRange = Number.isFinite(spacingM) && spacingM >= minSpacingM && spacingM <= maxSpacingM;
  if (ring === null || ring.length < 3 || !inRange)
    return { samplePoints: null, approximate: false };
  const { cells, areaM2 } = boxCellsAndArea(ring, spacingM);
  const estimate = Math.round(areaM2 / (spacingM * spacingM));
  if (cells > MAX_CELLS_COUNTED && estimate > 1.2 * maxSamplePoints) {
    return { samplePoints: estimate, approximate: true };
  }
  return { samplePoints: gridCount(ring, spacingM), approximate: false };
}

const n = (value: number): string => value.toLocaleString('en-AU');

/** "1 drive" or "2 drives". */
const counted = (value: number, one: string, many: string): string =>
  `${n(value)} ${value === 1 ? one : many}`;

/**
 * The live count line, such as "312 sample points, 2 points of interest: 624 public transport
 * journeys and 624 drives" (AC-FR-6.1), or null with no count.
 */
export function countLine(count: SetupCount, pois: number): string | null {
  const points = count.samplePoints;
  if (points === null) return null;
  const pairs = points * pois;
  const line =
    `${counted(points, 'sample point', 'sample points')}, ` +
    `${counted(pois, 'point of interest', 'points of interest')}: ` +
    `${counted(pairs, 'public transport journey', 'public transport journeys')} and ` +
    counted(pairs, 'drive', 'drives');
  return count.approximate ? `About ${line}` : line;
}

/**
 * Why Run is disabled, in plain English, or null when the analysis can run: no zone, no point of
 * interest, the limits (NFR-3, from `analysisProblem`), a setting out of range, or no mode.
 */
export function setupProblem(setup: AnalysisSetupChoices, count: SetupCount): string | null {
  if (setup.zoneId === null) return 'Choose a zone.';
  if (setup.poiIds.length === 0) return 'Choose at least one point of interest.';
  const limits = analysisProblem({
    samplePoints: count.samplePoints ?? 0,
    pois: setup.poiIds.length,
    spacingM: setup.settings.spacingM,
  });
  if (limits) return limits;
  const settings = settingsProblem(setup.settings);
  if (settings) return settings;
  return setup.settings.modes.length === 0 ? 'Allow at least one mode.' : null;
}

/** The body Run posts, or null with no zone. A blank name is left out, so the API makes one. */
export function createBody(
  setup: AnalysisSetupChoices,
  baselineId: number,
): AnalysisCreateBody | null {
  if (setup.zoneId === null) return null;
  const name = setup.name.trim();
  return {
    ...(name && { name }),
    baselineId,
    scenarioId: setup.scenarioId,
    zoneId: setup.zoneId,
    poiIds: setup.poiIds,
    settings: setup.settings,
  };
}
