// Deleting a stop from the network: what happens to one trip that called there, and which other
// platform a call moves to when only one platform of a station goes. No database here, so that the
// rules can be tested on their own; apps/api/src/scenarios/edits/delete-stop.ts reads the trips and writes the result.

/** One call of a trip, in calling order. */
export interface RemovalCall {
  seq: number;
  arr: number;
  dep: number;
  /** The trip runs through without stopping (it neither picks up nor sets down). */
  passing: boolean;
  /** The stop is being deleted and the call has no other platform to move to. */
  gone: boolean;
}

export interface CallRemoval {
  /**
   * The calls the trip keeps, with their new times, or null when fewer than two stops are left and
   * the trip has to be removed.
   */
  kept: { seq: number; arr: number; dep: number }[] | null;
  /** The trip started at the deleted stop and now starts at its next stop. */
  cutStart: boolean;
  /** The trip ended at the deleted stop and now ends at its previous stop. */
  cutEnd: boolean;
  /** Calls in the middle of the run that the trip no longer makes. */
  skipped: number;
  /** Seconds the trip saves between the stops either side of those calls. */
  savingSecs: number;
  /** At least one saving came from the stop time and an allowance, not from published non-stop trips. */
  estimated: boolean;
}

/**
 * Takes the deleted stop out of one trip.
 *
 * In the middle of the run the trip no longer calls there, and the time between the stops either
 * side becomes what `learned` says published trips take without stopping, or otherwise the old time
 * less the stop time and `penaltySecs` for slowing and starting. It is never longer than before and
 * never less than half of before, the same limits as skipping a stop. Stops after it are earlier
 * by the time saved; stops before it do not move. `floorSecs`, when given, is the least time the
 * stretch between two stops may take; it holds an estimate back, so that a guess never has the
 * vehicle running faster than it is known to. A time learned from published trips is what real
 * vehicles do and is not held back.
 *
 * A trip that started or ended there starts or ends at the next stop it keeps, at the time it
 * already called there: nothing on the part it keeps is retimed.
 */
export function removeCalls(
  calls: RemovalCall[],
  learned: (fromSeq: number, toSeq: number, currentSecs: number) => number | null,
  penaltySecs: number,
  floorSecs?: (fromSeq: number, toSeq: number) => number,
): CallRemoval {
  const none: CallRemoval = {
    kept: null,
    cutStart: false,
    cutEnd: false,
    skipped: 0,
    savingSecs: 0,
    estimated: false,
  };
  // A trip cannot begin or end by running through somewhere, so pass-throughs left at either end go too.
  let first = 0;
  let last = calls.length - 1;
  while (first <= last && (calls[first].gone || calls[first].passing)) first++;
  while (last >= first && (calls[last].gone || calls[last].passing)) last--;
  const real = calls.slice(first, last + 1).filter((c) => !c.gone && !c.passing);
  if (real.length < 2) return none;

  const cutStart = calls.slice(0, first).some((c) => c.gone && !c.passing);
  const cutEnd = calls.slice(last + 1).some((c) => c.gone && !c.passing);
  const kept: { seq: number; arr: number; dep: number }[] = [];
  let earlier = 0; // seconds saved so far: every later time moves this much earlier
  let skipped = 0;
  let estimated = false;
  let a = calls[first];
  kept.push({ seq: a.seq, arr: a.arr, dep: a.dep });
  let between: RemovalCall[] = [];
  for (let i = first + 1; i <= last; i++) {
    const c = calls[i];
    if (c.gone || c.passing) {
      between.push(c);
      continue;
    }
    const lost = between.filter((b) => b.gone && !b.passing);
    const current = c.arr - a.dep;
    let target = current;
    if (lost.length) {
      const seen = learned(a.seq, c.seq, current);
      if (seen !== null && seen < current) target = Math.round(seen);
      else {
        target =
          current - lost.reduce((sum, b) => sum + (b.dep - b.arr), 0) - penaltySecs * lost.length;
        if (floorSecs) target = Math.max(target, Math.ceil(floorSecs(a.seq, c.seq)));
        estimated = true;
      }
      target = Math.max(Math.round(current * 0.5), Math.min(current, target));
      skipped += lost.length;
    }
    // Pass-throughs the trip keeps are re-spaced in proportion, so they stay in order.
    const ratio = current > 0 ? target / current : 1;
    for (const b of between) {
      if (b.gone) continue;
      const at = a.dep - earlier + Math.round((b.arr - a.dep) * ratio);
      kept.push({ seq: b.seq, arr: at, dep: at });
    }
    earlier += current - target;
    kept.push({ seq: c.seq, arr: c.arr - earlier, dep: c.dep - earlier });
    a = c;
    between = [];
  }
  // The first stop has no arrival of its own and the last no departure, as in the published timetable.
  if (cutStart) kept[0].arr = kept[0].dep;
  if (cutEnd) kept[kept.length - 1].dep = kept[kept.length - 1].arr;
  return { kept, cutStart, cutEnd, skipped, savingSecs: earlier, estimated };
}

/** A platform a call could move to, with the times it is already taken. */
export interface PlatformOption {
  id: number;
  /** How many of the line's stop patterns already use it. */
  uses: number;
  /** Calls and waiting vehicles there. `trips` are the trips involved, so a trip never clashes with itself. */
  busy: { from: number; to: number; trips: number[] }[];
}

export interface PlatformPick {
  id: number;
  /** Nothing else is there while the trip would be, a minute either side. */
  free: boolean;
  /** The line already uses it. */
  usual: boolean;
}

/**
 * The platform a call moves to when its own is deleted: one the line already uses and that is free
 * for the time the trip is there, a minute either side. Failing that the least bad: the one with
 * the fewest other trips there at that time, and among equals the one the line uses most.
 * Options are given in platform order, which settles what is left. Null when there is no other platform.
 */
export function choosePlatform(
  options: PlatformOption[],
  call: { arr: number; dep: number; tripId: number },
  marginSecs = 60,
): PlatformPick | null {
  const from = call.arr - marginSecs;
  const to = call.dep + marginSecs;
  let best: { option: PlatformOption; clashes: number } | null = null;
  for (const option of options) {
    const clashes = option.busy.filter(
      (b) => b.from < to && b.to > from && !b.trips.includes(call.tripId),
    ).length;
    const better =
      !best ||
      // Free and already used by the line beats everything; otherwise fewest clashes, then most used.
      Number(clashes === 0 && option.uses > 0) >
        Number(best.clashes === 0 && best.option.uses > 0) ||
      (Number(clashes === 0 && option.uses > 0) ===
        Number(best.clashes === 0 && best.option.uses > 0) &&
        (clashes < best.clashes || (clashes === best.clashes && option.uses > best.option.uses)));
    if (better) best = { option, clashes };
  }
  if (!best) return null;
  return { id: best.option.id, free: best.clashes === 0, usual: best.option.uses > 0 };
}
