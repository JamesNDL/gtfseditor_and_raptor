// What the comparison's counts and key say (FR-17, AC-FR-17.1, NFR-6): each kind of change in
// plain words, with its count and the colour or ring it has on the map (analysis-colours.ts).
import type { CompareKind } from '@gtfs-editor/core';
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
