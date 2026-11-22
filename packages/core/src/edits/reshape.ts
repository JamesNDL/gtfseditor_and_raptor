// Reshaping a line (extend, cut short, re-route, add or remove a stop): the parts that need no
// database, shared by the server's edit and its preview.
import { bandOf } from '../time.ts';
import { distanceM } from '../vehicle-days.ts';

export type Coord = [number, number];

/**
 * For each stop of the new sequence, its position in the old sequence if it is kept, else -1.
 * Kept stops are the longest run of stops the two sequences share in the same order, so a stop that
 * moves to a different place in the line counts as removed and added again.
 */
export function keptIndexes(previous: number[], next: number[]): number[] {
  const n = previous.length;
  const m = next.length;
  // lcs[i][j]: length of the longest common subsequence of previous[i..] and next[j..].
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        previous[i] === next[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const kept = new Array<number>(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (previous[i] === next[j]) kept[j++] = i++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return kept;
}

/** Distance along a path at each of its points, in metres. */
export function pathDistances(coords: Coord[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++)
    out.push(
      out[i - 1] + distanceM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]),
    );
  return out;
}

/** The stretch of a path between two distances along it, with the cut ends interpolated. */
export function slicePath(
  coords: Coord[],
  dists: ArrayLike<number>,
  from: number,
  to: number,
): Coord[] {
  const at = (d: number, k: number): Coord => {
    // k is the first point at or beyond d.
    if (k <= 0) return coords[0];
    if (k >= coords.length) return coords[coords.length - 1];
    const span = dists[k] - dists[k - 1];
    const f = span > 0 ? (d - dists[k - 1]) / span : 0;
    return [
      coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * f,
      coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * f,
    ];
  };
  let a = 0;
  while (a < coords.length && dists[a] < from) a++;
  let b = a;
  while (b < coords.length && dists[b] < to) b++;
  const out: Coord[] = [at(from, a)];
  for (let k = a; k < b; k++) if (dists[k] > from) out.push(coords[k]);
  out.push(at(to, b));
  return out;
}

/**
 * Which point of a path each stop sits at, at or after the previous stop's.
 * The first and last stops take the path's two ends.
 *
 * A path can pass the same place twice (a divided road, a turn-round, a loop). The stop belongs to
 * the first pass that comes about as close as any pass does: taking the nearest point of the whole
 * remaining path could jump to the second pass, and every stop after it would then be squeezed
 * into what is left of the path.
 */
export function locateStops(coords: Coord[], stops: Coord[]): number[] {
  const out: number[] = [];
  let at = 0;
  stops.forEach((s, i) => {
    if (i === stops.length - 1) at = coords.length - 1;
    else if (i > 0) {
      const d = (k: number) => distanceM(s[0], s[1], coords[k][0], coords[k][1]);
      let bestD = Infinity;
      for (let k = at; k < coords.length; k++) bestD = Math.min(bestD, d(k));
      // The first point that is nearly as close as the closest, then on to the closest point of that pass.
      const near = bestD + Math.max(25, bestD * 0.5);
      let k = at;
      while (k < coords.length - 1 && d(k) > near) k++;
      while (k < coords.length - 1 && d(k + 1) <= d(k)) k++;
      at = k;
    }
    out.push(at);
  });
  return out;
}

/** How close a path comes to a point, in metres. */
export function distanceToPathM(coords: Coord[], lon: number, lat: number): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const bx = (coords[i][0] - lon) * kx;
    const by = (coords[i][1] - lat) * ky;
    if (i === 0) {
      best = Math.hypot(bx, by);
      continue;
    }
    const ax = (coords[i - 1][0] - lon) * kx;
    const ay = (coords[i - 1][1] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy;
    const f = span > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / span)) : 0;
    best = Math.min(best, Math.hypot(ax + f * dx, ay + f * dy));
  }
  return best;
}

/** How close two paths come to each other, in metres: nothing where they cross. */
export function distanceBetweenPathsM(a: Coord[], b: Coord[]): number {
  if (!a.length || !b.length) return Infinity;
  const side = (p: Coord, q: Coord, r: Coord) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  // The box round b, so that most of a long path is passed over quickly.
  let west = Infinity,
    east = -Infinity,
    south = Infinity,
    north = -Infinity;
  for (const p of b) {
    west = Math.min(west, p[0]);
    east = Math.max(east, p[0]);
    south = Math.min(south, p[1]);
    north = Math.max(north, p[1]);
  }
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1];
    const q = a[i];
    if (
      Math.max(p[0], q[0]) < west ||
      Math.min(p[0], q[0]) > east ||
      Math.max(p[1], q[1]) < south ||
      Math.min(p[1], q[1]) > north
    )
      continue;
    for (let j = 1; j < b.length; j++) {
      const r = b[j - 1];
      const s = b[j];
      if (side(p, q, r) !== side(p, q, s) && side(r, s, p) !== side(r, s, q)) return 0;
    }
  }
  let best = Infinity;
  for (const p of a) best = Math.min(best, distanceToPathM(b, p[0], p[1]));
  for (const p of b) best = Math.min(best, distanceToPathM(a, p[0], p[1]));
  return best;
}

/** One call of a trip as it is now. */
export interface OldCall {
  arr: number;
  dep: number;
  pickup: number;
  dropOff: number;
}

/**
 * The run between two consecutive stops of the new sequence.
 * - same: both stops are kept and nothing between them changed; each trip keeps its own time.
 * - passing: both are kept, stops between them were removed and the vehicle still drives past them;
 *   each trip keeps its own time less what stopping cost.
 * - new: a stretch the line did not run before, with one run time for every trip, or one for each
 *   part of the day (`byBand`, indexed like DAY_BANDS) chosen by when the trip sets out.
 * - detour: both stops are kept but the vehicle goes a different way between them; each trip keeps
 *   its own time (less any stops it no longer makes), scaled by how much longer the new way is.
 */
export type ReshapeSection =
  | { kind: 'same' }
  | { kind: 'passing' }
  | { kind: 'new'; secs: number; byBand?: number[] }
  | {
      kind: 'detour';
      /** How many times longer the new way is than the published one. */
      factor: number;
      /**
       * The new way's length and how much longer it is than the published one, in metres, with the
       * typical speed of the mode and the fastest it can go, in metres per second. Given these, a
       * detour is never timed faster than the vehicle can go: a published time of nought (bus
       * timetables are in whole minutes) would otherwise stay nought however long the way round.
       */
      lengthM?: number;
      extraM?: number;
      speed?: number;
      maxSpeed?: number;
    };

export interface NewCall {
  arr: number;
  dep: number;
  /** Position in the old trip this call is carried over from, or -1 for a new stop. */
  from: number;
  pickup: number;
  dropOff: number;
  /** True when the old call's other details (timing point, notes) still apply. */
  carried: boolean;
}

const isPassing = (c: OldCall) => c.pickup === 1 && c.dropOff === 1;

/**
 * Works out one trip's times over the new stop sequence.
 *
 * The trip still leaves the first stop it shares with the old sequence at the same time, so
 * passengers at stops that did not change see the same timetable where the path allows it:
 * adding stops at the start makes the trip begin earlier, adding them at the end makes it finish later.
 */
export function retime(
  old: OldCall[],
  keptAt: number[],
  sections: ReshapeSection[],
  options: { dwellSecs: number; skipPenaltySecs: number },
): NewCall[] {
  const n = keptAt.length;
  const lastOld = old.length - 1;
  const band = bandOf(old[0].dep);
  const run = (i: number): number => {
    const s = sections[i];
    if (s.kind === 'new') return s.byBand?.[band] ?? s.secs;
    const a0 = keptAt[i];
    const a1 = keptAt[i + 1];
    const current = old[a1].arr - old[a0].dep;
    if (s.kind === 'same') return Math.max(0, current);
    let saving = 0;
    for (let a = a0 + 1; a < a1; a++)
      if (!isPassing(old[a])) saving += old[a].dep - old[a].arr + options.skipPenaltySecs;
    const passing = Math.max(0, Math.round(current * 0.5), current - saving);
    if (s.kind !== 'detour') return passing;
    const scaled = Math.round(passing * s.factor);
    if (s.lengthM === undefined || s.maxSpeed === undefined || !(s.maxSpeed > 0)) return scaled;
    const least = Math.ceil(s.lengthM / s.maxSpeed);
    const added =
      s.speed !== undefined && s.speed > 0
        ? Math.round(passing + Math.max(0, s.extraM ?? 0) / s.speed)
        : null;
    // Up to three times the length, the trip's own time is scaled. Beyond that the published time
    // says little about the new way, and where it is nought (or too short to mean anything) it
    // cannot be scaled at all: the extra distance is timed at the mode's typical speed instead.
    const secs = added !== null && (s.factor > 3 || scaled < least) ? added : scaled;
    return Math.max(secs, least);
  };
  const dwell = (i: number): number => {
    if (i === 0 || i === n - 1) return 0;
    const a = keptAt[i];
    // A stop that used to be the end of the line has no stop time of its own to keep.
    return a > 0 && a < lastOld ? Math.max(0, old[a].dep - old[a].arr) : options.dwellSecs;
  };

  const arr = new Array<number>(n).fill(0);
  const dep = new Array<number>(n).fill(0);
  let anchor = keptAt.findIndex((a) => a >= 0);
  if (anchor < 0) {
    anchor = 0;
    dep[0] = old[0].dep;
  } else {
    dep[anchor] = old[keptAt[anchor]].dep;
  }
  arr[anchor] = dep[anchor] - dwell(anchor);
  for (let i = anchor + 1; i < n; i++) {
    arr[i] = dep[i - 1] + run(i - 1);
    dep[i] = arr[i] + dwell(i);
  }
  for (let i = anchor - 1; i >= 0; i--) {
    dep[i] = arr[i + 1] - run(i);
    arr[i] = dep[i] - dwell(i);
  }
  // Nothing can start before the service day does.
  const shift = arr[0] < 0 ? -arr[0] : 0;

  return keptAt.map((a, i) => {
    const first = i === 0;
    const last = i === n - 1;
    const sameRole = a >= 0 && (first ? a === 0 : last ? a === lastOld : a > 0 && a < lastOld);
    return {
      arr: arr[i] + shift,
      dep: dep[i] + shift,
      from: a,
      // The ends of a trip keep the published convention (often "no setting down" at the first
      // stop and "no boarding" at the last); a stop that changes role is opened to passengers.
      pickup: sameRole ? old[a].pickup : last ? old[lastOld].pickup : 0,
      dropOff: sameRole ? old[a].dropOff : first ? old[0].dropOff : 0,
      carried: sameRole,
    };
  });
}

/**
 * Applies the same change to the line's other direction.
 *
 * `matchOld[a]` is where the old stop at position `a` has its counterpart in the opposite sequence
 * (the platform at the same station, or the stop across the road), or null if it has none.
 * `counterpart[i]` is the stop to use going the other way for the new stop at position `i`.
 * Returns the opposite direction's new stops, or null when the change cannot be placed.
 */
export function mirrorStops(args: {
  keptAt: number[];
  matchOld: (number | null)[];
  counterpart: number[];
  opposite: number[];
}): number[] | null {
  const { keptAt, matchOld, counterpart, opposite } = args;
  const kept = new Set(keptAt.filter((a) => a >= 0));
  const protectedAt = new Set<number>();
  for (const a of kept) if (matchOld[a] !== null) protectedAt.add(matchOld[a]!);
  const removeAt = new Set<number>();
  matchOld.forEach((j, a) => {
    if (j !== null && !kept.has(a) && !protectedAt.has(j)) removeAt.add(j);
  });

  const before = new Map<number, number[]>();
  const after = new Map<number, number[]>();
  const n = keptAt.length;
  for (let s = 0; s < n; s++) {
    if (keptAt[s] >= 0) continue;
    let e = s;
    while (e + 1 < n && keptAt[e + 1] < 0) e++;
    // Going the other way the added stops are met in reverse, after the stop that followed them.
    const ids = counterpart.slice(s, e + 1).reverse();
    const following = e + 1 < n ? matchOld[keptAt[e + 1]] : null;
    const preceding = s > 0 ? matchOld[keptAt[s - 1]] : null;
    if (s === 0 && e === n - 1) return ids;
    if (following !== null && following !== undefined)
      after.set(following, [...(after.get(following) ?? []), ...ids]);
    else if (preceding !== null && preceding !== undefined)
      before.set(preceding, [...ids, ...(before.get(preceding) ?? [])]);
    else return null;
    s = e;
  }

  const out: number[] = [];
  const push = (id: number) => {
    if (out[out.length - 1] !== id) out.push(id);
  };
  opposite.forEach((id, j) => {
    for (const x of before.get(j) ?? []) push(x);
    if (!removeAt.has(j)) push(id);
    for (const x of after.get(j) ?? []) push(x);
  });
  return out;
}
