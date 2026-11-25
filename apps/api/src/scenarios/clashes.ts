// The clash rules: what is wrong with a scenario's timetable, and the fix suggested for each
// clash. The database reads are in clashes-read.ts and clashes-reality.ts.
import { formatSecs } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { readTripClashes } from './clashes-read.ts';
import { readRealityChecks } from './clashes-reality.ts';
import { bestFree, platformChoices } from './platforms.ts';
import type { Scenario } from './engine.ts';
import { minutes } from './wording.ts';

// -------------------------------------------------------------------------
// Conflicts caused by the scenario's own trips
// -------------------------------------------------------------------------
export const findConflicts = (sql: Sql, sc: Scenario) => conflictsIn(sql, sc);
/**
 * The same, read through any connection: an edit asks from inside its own transaction, to say how
 * many clashes it caused. With `withFixes` false the suggested platform for each clash is not looked up.
 */
export async function conflictsIn(sql: Sql, sc: Scenario, withFixes = true) {
  const { platform, vehicle, waiting, unassigned } = await readTripClashes(sql, sc);
  const { speedRows, placeRows, closureRows } = await readRealityChecks(sql, sc);

  // A free platform at the same station is the gentler fix where there is one. Looked up for the
  // first clashes only, which are the ones shown.
  type Fix = { label: string; edit: Record<string, unknown> };
  const platformFix = async (
    tripId: number,
    seq: number,
  ): Promise<{ fix: Fix; usual: boolean } | null> => {
    const best = bestFree(await platformChoices(sql, sc, tripId, seq));
    if (!best) return null;
    return {
      fix: {
        label: `Use platform ${best.platformCode ?? best.name} instead${best.uses ? '' : ' (not one this line normally uses)'}`,
        edit: { kind: 'setPlatform', tripId, stopSeq: seq, stopId: best.id },
      },
      usual: best.uses > 0,
    };
  };
  const withPlatform = async (
    fixes: Fix[],
    tripId: number,
    seq: number,
    index: number,
  ): Promise<Fix[]> => {
    if (index >= 30 || !withFixes) return fixes;
    const found = await platformFix(tripId, seq);
    if (!found) return fixes;
    return found.usual ? [found.fix, ...fixes] : [...fixes, found.fix];
  };

  const round30 = (secs: number) => Math.ceil(secs / 30) * 30;
  const platformConflicts = await Promise.all(
    platform.map(async (c, i) => {
      const delta = round30(c.otherDep - c.arr + 60);
      return {
        kind: 'platform' as const,
        tripId: c.tripId,
        otherTripId: c.otherTripId,
        stopId: c.stopId,
        atSecs: c.fromSecs,
        title: `${String(c.stopName).replace(/ Station/, '')}: two trips at once`,
        detail: `${c.line ?? 'Trip'} ${formatSecs(c.startSecs)} and ${c.otherLine ?? 'trip'} ${formatSecs(c.otherStart)} overlap at ${formatSecs(c.fromSecs)}`,
        fixes: await withPlatform(
          [
            {
              label: `Move the ${formatSecs(c.startSecs)} trip ${minutes(delta)} later`,
              edit: { kind: 'shift', tripIds: [c.tripId], delta, ripple: 'none' },
            },
          ],
          c.tripId,
          c.seq,
          i,
        ),
      };
    }),
  );
  const seenWaits = new Set<string>();
  const waitingConflicts = await Promise.all(
    waiting
      .filter((c) => {
        const key = `${c.waitTripId}|${c.tripId}`;
        if (
          seenWaits.has(key) ||
          platform.some(
            (p) =>
              (p.tripId === c.tripId && p.otherTripId === c.waitTripId) ||
              (p.tripId === c.waitTripId && p.otherTripId === c.tripId),
          )
        )
          return false;
        seenWaits.add(key);
        return true;
      })
      .map(async (c, i) => {
        const delta = round30(c.to - c.arr + 60);
        return {
          kind: 'platform' as const,
          tripId: c.tripId,
          otherTripId: c.waitTripId,
          stopId: c.stopId,
          atSecs: Math.max(c.arr, c.from),
          title: `${String(c.stopName).replace(/ Station/, '')}: a waiting vehicle is in the way`,
          detail: `${c.otherLine ?? 'Trip'} ${formatSecs(c.startSecs)} calls at ${formatSecs(c.arr)}, while ${c.vehicle} waits there from ${formatSecs(c.from)} to ${formatSecs(c.to)} for its next ${c.line ?? ''} trip`,
          fixes: await withPlatform(
            [
              {
                label: `Move the ${formatSecs(c.startSecs)} trip ${minutes(delta)} later`,
                edit: { kind: 'shift', tripIds: [c.tripId], delta, ripple: 'none' },
              },
            ],
            c.tripId,
            c.seq,
            i,
          ),
        };
      }),
  );
  const km = (metres: number) =>
    metres >= 950 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;
  const tidyStop = (name: string) =>
    String(name)
      .replace(/ Station/, '')
      .replace(/, Platform.*$/, '');
  // One row for each stretch of each line, however many trips run it.
  const speedGroups = new Map<string, { first: (typeof speedRows)[number]; trips: number }>();
  for (const row of speedRows) {
    const key = `${row.routeId}|${row.fromId}|${row.toId}|${row.backwards}`;
    const known = speedGroups.get(key);
    if (known) known.trips++;
    else speedGroups.set(key, { first: row, trips: 1 });
  }
  const speedConflicts = [...speedGroups.values()].slice(0, 60).map(({ first: c, trips }) => {
    const others =
      trips > 1 ? `, and ${trips - 1} more trip${trips === 2 ? '' : 's'} on the same stretch` : '';
    const kmh = c.secs > 0 ? Math.round((c.metres / c.secs) * 3.6) : null;
    return {
      kind: 'speed' as const,
      tripId: c.tripId as number,
      otherTripId: c.tripId as number,
      atSecs: c.atSecs as number,
      title: c.backwards
        ? `${c.line}: arrives before it left`
        : `${c.line}: faster than a ${String(c.mode).toLowerCase()} can go`,
      detail: c.backwards
        ? `${c.line} ${formatSecs(c.startSecs)}: the times at ${tidyStop(c.to)} run backwards${others}`
        : `${c.line} ${formatSecs(c.startSecs)}: ${tidyStop(c.from)} to ${tidyStop(c.to)} is ${km(c.metres)} in a straight line and is timed at ${c.secs} s${kmh === null ? '' : ` (${kmh} km/h; the most allowed for is ${c.kmh})`}${others}`,
      fixes: [] as Fix[],
    };
  });
  const placeConflicts = placeRows.map((c) => ({
    kind: 'place' as const,
    tripId: c.nextTripId as number,
    otherTripId: c.tripId as number,
    atSecs: c.nextStart as number,
    title: `${c.vehicle}: cannot get to its next trip`,
    detail: `${c.line} ${formatSecs(c.startSecs)} ends at ${tidyStop(c.from)} at ${formatSecs(c.endSecs)}; the vehicle's next trip leaves ${tidyStop(c.to)}, ${km(c.metres)} away, at ${formatSecs(c.nextStart)}`,
    fixes: [
      {
        label: 'Put the later trip on another vehicle',
        edit: { kind: 'setVehicle', tripId: c.nextTripId, mode: 'auto' },
      },
    ] as Fix[],
  }));
  const closureConflicts = closureRows.map((c) => ({
    kind: 'closure' as const,
    tripId: c.tripId as number,
    otherTripId: c.tripId as number,
    atSecs: c.startSecs as number,
    title: `${c.line}: runs through a closure`,
    detail: `${c.trips} trip${c.trips === 1 ? '' : 's'} on a path made after "${c.label}" run through it`,
    fixes: [] as Fix[],
  }));
  // The lists above each stop at a limit. Reaching one means there are more clashes than are counted.
  const capped =
    platform.length >= 200 ||
    vehicle.length >= 200 ||
    waiting.length >= 60 ||
    speedRows.length >= 2000 ||
    placeRows.length >= 200;
  const conflicts = [
    ...speedConflicts,
    ...closureConflicts,
    ...placeConflicts,
    ...platformConflicts,
    ...waitingConflicts,
    ...vehicle.map((c) => {
      const delta = round30(c.endSecs - c.otherStart + 60);
      return {
        kind: 'vehicle' as const,
        tripId: c.tripId,
        otherTripId: c.otherTripId,
        atSecs: c.otherStart,
        title: `${c.vehicle}: next trip leaves before it arrives`,
        detail: `${c.line ?? 'Trip'} ${formatSecs(c.startSecs)} arrives ${formatSecs(c.endSecs)}, but the vehicle's next trip leaves ${formatSecs(c.otherStart)}`,
        fixes: [
          {
            label: `Push the vehicle's later trips back ${minutes(delta)}`,
            edit: { kind: 'shift', tripIds: [c.otherTripId], delta, ripple: 'vehicle' },
          },
        ],
      };
    }),
  ];
  return { conflicts, unassigned, capped };
}
