// What the comparison's counts and key say (FR-17, AC-FR-17.1, NFR-6): each kind of change in
// plain words, with its count and the colour or ring it has on the map (analysis-colours.ts).
import { timeText, type AnalysisListItem, type CompareKind } from '@gtfs-editor/core';
import {
  COMPARE_BETTER,
  COMPARE_FULL_AT,
  COMPARE_LIGHT_AT,
  COMPARE_WORSE,
  compareStyle,
} from '../analysis-colours.ts';

/** One row of the comparison's counts, drawn as on the map. */
export interface CompareRow {
  kind: CompareKind;
  label: string;
  /** What the row means, for its tooltip. */
  title: string;
  count: number;
  /** The swatch's CSS background, or null for a ring with no fill. */
  background: string | null;
  ring: string | null;
}

const gradient = ([light, full]: readonly [string, string]): string =>
  `linear-gradient(90deg, ${light}, ${full})`;

const SHADES = `lighter at a change of ${COMPARE_LIGHT_AT} or less, full at ${COMPARE_FULL_AT} or more`;

/** The kinds in the order they are listed, with their words. */
const KINDS: { kind: CompareKind; label: string; title: string }[] = [
  {
    kind: 'better',
    label: 'Better',
    title: `The access ratio fell: public transport got closer to the car (${SHADES})`,
  },
  {
    kind: 'worse',
    label: 'Worse',
    title: `The access ratio rose: public transport fell further behind the car (${SHADES})`,
  },
  { kind: 'same', label: 'About the same', title: 'The access ratio changed by 0.05 or less' },
  {
    kind: 'gainedService',
    label: 'Gained service',
    title: 'No public transport journey before, one now',
  },
  {
    kind: 'lostService',
    label: 'Lost service',
    title: 'A public transport journey before, none now',
  },
  {
    kind: 'bothNone',
    label: 'No service in either',
    title: 'No public transport journey, or no road, in either analysis',
  },
];

/** The comparison's counts as rows: better and worse first, every kind shown even with none. */
export function compareRows(counts: Record<CompareKind, number>): CompareRow[] {
  return KINDS.map(({ kind, label, title }) => {
    const { fill, ring } = compareStyle(kind, null);
    const background =
      kind === 'better'
        ? gradient(COMPARE_BETTER)
        : kind === 'worse'
          ? gradient(COMPARE_WORSE)
          : fill;
    return { kind, label, title, count: counts[kind], background, ring };
  });
}

/** Every sample point compared. */
export const compareTotal = (counts: Record<CompareKind, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

/** How an analysis uses its time, as the list gives it. */
type TimeOf = Pick<AnalysisListItem, 'timeMode' | 'timeSecs'>;

/** "arrive by 08:00" or "depart 08:00", for the middle of a sentence. */
const lowerTimeText = (a: TimeOf): string => {
  const text = timeText({ timeMode: a.timeMode, departSecs: a.timeSecs });
  return text.charAt(0).toLowerCase() + text.slice(1);
};

/**
 * When the open analysis and the other one use time differently, says so plainly (AC-FR-21.3):
 * "One is arrive by 08:00, the other depart 08:00." Null when both depart or both arrive by.
 */
export function timeModeNote(open: TimeOf, other: TimeOf): string | null {
  if (open.timeMode === other.timeMode) return null;
  return `One is ${lowerTimeText(open)}, the other ${lowerTimeText(other)}.`;
}
