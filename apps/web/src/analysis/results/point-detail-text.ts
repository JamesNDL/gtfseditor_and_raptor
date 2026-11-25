// What one sample point's detail says (FR-15, NFR-6): its journey leg by leg, the walk/wait/ride
// split of the public transport time, the car time and how it is made up, and why a time or the
// car path is missing. Walk distances are the router's straight line taken 1.3 times as long
// (services/router/README.md 'Walks'), so they are given as 'about'.
import type { PointDetail, PtSplit, StoredLeg } from '@gtfs-editor/core';
import type { ModeLook } from '../point-journey.ts';

/** Whole minutes; a time that rounds to none is 'under 1 min'. */
export function minutesText(secs: number): string {
  const mins = Math.round(secs / 60);
  return mins < 1 ? 'under 1 min' : `${mins} min`;
}

/** A walk's length: to 10 m under a kilometre, to 0.1 km over. */
export function distanceText(metres: number): string {
  if (metres < 995) return `about ${Math.round(metres / 10) * 10} m`;
  return `about ${(metres / 1000).toLocaleString('en-AU', { maximumFractionDigits: 1 })} km`;
}

/** One line of the journey list. */
export interface LegRow {
  kind: 'walk' | 'wait' | 'ride' | 'change';
  text: string;
  /** A ride's mode colour; null for the others. */
  colour: string | null;
}

/** A wait shorter than this is not listed. */
const SHORTEST_WAIT_SECS = 30;

/**
 * The journey leg by leg (AC-FR-15.1). The stored legs have no waits, so they are found by
 * walking the clock from the asked departure: a ride boarded later than the clock shows a wait
 * before it. Waiting at home for the first vehicle (D23) shows as the wait before the first ride.
 */
export function legRows(
  legs: readonly StoredLeg[],
  departSecs: number,
  look: (modeId: string) => ModeLook,
): LegRow[] {
  const rows: LegRow[] = [];
  let clock = departSecs;
  let lastStop: string | null = null;
  for (const leg of legs) {
    if (leg.type === 'ride') {
      const wait = leg.board.time - clock;
      if (wait >= SHORTEST_WAIT_SECS) {
        rows.push({ kind: 'wait', text: `Wait ${minutesText(wait)}`, colour: null });
      }
      const mode = look(leg.mode);
      const text = `${mode.name} ${leg.route} from ${leg.board.name} to ${leg.alight.name}, ${minutesText(leg.secs)}`;
      rows.push({ kind: 'ride', text, colour: mode.colour });
      clock = leg.alight.time;
      lastStop = leg.alight.name;
      continue;
    }
    clock += leg.secs;
    const walked = leg.secs > 0 || leg.metres > 0;
    const onFoot = `${minutesText(leg.secs)} (${distanceText(leg.metres)})`;
    if (leg.type === 'transfer') {
      const text = walked ? `Change: walk ${onFoot}` : `Change at ${lastStop ?? 'the stop'}`;
      rows.push({ kind: 'change', text, colour: null });
    } else if (walked) {
      rows.push({ kind: 'walk', text: `Walk ${onFoot}`, colour: null });
    }
  }
  return rows;
}

/** One part of the walk/wait/ride bar. */
export interface SplitPart {
  kind: 'walk' | 'wait' | 'ride';
  label: string;
  /** Its share of the public transport time, from 0 to 1. */
  share: number;
}

/** The public transport time split into walking, waiting and riding (FR-15). */
export function splitParts(pt: PtSplit): SplitPart[] {
  const part = (kind: SplitPart['kind'], word: string, secs: number): SplitPart => ({
    kind,
    label: `${word} ${minutesText(secs)}`,
    share: pt.ptSecs > 0 ? Math.max(0, secs) / pt.ptSecs : 0,
  });
  return [
    part('walk', 'Walk', pt.walkSecs),
    part('wait', 'Wait', pt.waitSecs),
    part('ride', 'Ride', pt.rideSecs),
  ];
}

const n = (value: number): string => value.toLocaleString('en-AU');

/** The public transport time, or why there is none. */
export function journeyText(detail: PointDetail, maxJourneyMins: number): string {
  if (detail.pt === null) return 'No journey found within the limits';
  const time = minutesText(detail.pt.ptSecs);
  if (detail.pt.ptSecs > maxJourneyMins * 60) {
    return `${time}: longer than the longest journey (${n(maxJourneyMins)} min)`;
  }
  return time;
}

/** The car time and how it is made up: the drive, the traffic factor and the parking allowance. */
export function carText(detail: PointDetail): string {
  if (detail.carSecs === null || detail.driveSecs === null) return 'No drive found';
  const drive = `drive ${minutesText(detail.driveSecs)} × ${n(detail.trafficFactor)} traffic`;
  return `${minutesText(detail.carSecs)} (${drive} + ${minutesText(detail.parkingSecs)} parking)`;
}

/** Why no car path is drawn (AC 3), or null when it is. */
export function carPathText(detail: PointDetail): string | null {
  if (detail.carPath !== null) return null;
  if (detail.status === 'noRoad') return 'There is no car path: no drive was found from here.';
  // The router's own words go in brackets, without their full stop.
  const words = detail.carPathMessage?.replace(/\.\s*$/, '') ?? '';
  const why = words ? ` (${words})` : '';
  return `The car path could not be fetched${why}.`;
}
