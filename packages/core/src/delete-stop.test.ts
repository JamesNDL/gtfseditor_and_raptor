import { describe, expect, it } from 'vitest';
import { choosePlatform, removeCalls, type PlatformOption, type RemovalCall } from './delete-stop.ts';

const call = (seq: number, arr: number, dep = arr, flags: { gone?: boolean; passing?: boolean } = {}): RemovalCall => ({
  seq,
  arr,
  dep,
  gone: flags.gone === true,
  passing: flags.passing === true,
});
const nothingLearned = () => null;

/** Times never run backwards, within a call or from one call to the next. */
const inOrder = (kept: { arr: number; dep: number }[]) =>
  kept.every((c, i) => c.dep >= c.arr && (i === 0 || c.arr >= kept[i - 1].dep));

describe('removeCalls', () => {
  // A to E, ten minutes apart, half a minute at each stop in between.
  const trip = (gone: number[]) => [
    call(1, 0, 0, { gone: gone.includes(1) }),
    call(2, 600, 630, { gone: gone.includes(2) }),
    call(3, 1230, 1260, { gone: gone.includes(3) }),
    call(4, 1860, 1890, { gone: gone.includes(4) }),
    call(5, 2490, 2490, { gone: gone.includes(5) }),
  ];

  it('drops a stop in the middle and saves the stop time plus the allowance', () => {
    const out = removeCalls(trip([3]), nothingLearned, 45);
    expect(out.kept!.map((c) => c.seq)).toEqual([1, 2, 4, 5]);
    expect(out.savingSecs).toBe(75);
    expect(out.estimated).toBe(true);
    expect(out.skipped).toBe(1);
    // Stops before it do not move; stops after it are earlier by the saving.
    expect(out.kept![1]).toEqual({ seq: 2, arr: 600, dep: 630 });
    expect(out.kept![2]).toEqual({ seq: 4, arr: 1860 - 75, dep: 1890 - 75 });
    expect(out.kept![3]).toEqual({ seq: 5, arr: 2490 - 75, dep: 2490 - 75 });
    expect(out.cutStart || out.cutEnd).toBe(false);
  });

  it('uses the time published non-stop trips take when there is one', () => {
    const out = removeCalls(trip([3]), (from, to, current) => {
      expect([from, to, current]).toEqual([2, 4, 1230]);
      return 1100;
    }, 45);
    expect(out.savingSecs).toBe(130);
    expect(out.estimated).toBe(false);
  });

  it('is never quicker than half the old time, and never slower than before', () => {
    const quick = removeCalls(trip([3]), () => 10, 45);
    expect(quick.savingSecs).toBe(615); // 1230 seconds between the neighbours, held to half
    const slow = removeCalls(trip([3]), () => 5000, 45);
    // A learned time longer than today's is not believed; the estimate is used and still saves time.
    expect(slow.savingSecs).toBe(75);
    expect(slow.estimated).toBe(true);
    expect(inOrder(quick.kept!) && inOrder(slow.kept!)).toBe(true);
  });

  it('holds an estimate back to the least time the stretch may take, but not a learned time', () => {
    // 1230 seconds between the neighbours today; the estimate alone would make it 1155.
    expect(removeCalls(trip([3]), nothingLearned, 45, () => 1200).savingSecs).toBe(30);
    // A floor above today's time means no saving at all, never a longer trip.
    const none = removeCalls(trip([3]), nothingLearned, 45, () => 2000);
    expect(none.savingSecs).toBe(0);
    expect(none.kept![2]).toEqual({ seq: 4, arr: 1860, dep: 1890 });
    expect(removeCalls(trip([3]), () => 1100, 45, () => 1200).savingSecs).toBe(130);
  });

  it('cuts a trip short at its first stop and keeps the other times', () => {
    const out = removeCalls(trip([1]), nothingLearned, 45);
    expect(out.cutStart).toBe(true);
    expect(out.cutEnd).toBe(false);
    expect(out.savingSecs).toBe(0);
    // It now starts at the second stop when it used to leave it.
    expect(out.kept![0]).toEqual({ seq: 2, arr: 630, dep: 630 });
    expect(out.kept!.slice(1)).toEqual([{ seq: 3, arr: 1230, dep: 1260 }, { seq: 4, arr: 1860, dep: 1890 }, { seq: 5, arr: 2490, dep: 2490 }]);
  });

  it('cuts a trip short at its last stop', () => {
    const out = removeCalls(trip([5]), nothingLearned, 45);
    expect(out.cutEnd).toBe(true);
    expect(out.kept![out.kept!.length - 1]).toEqual({ seq: 4, arr: 1860, dep: 1860 });
    expect(out.kept![0]).toEqual({ seq: 1, arr: 0, dep: 0 });
  });

  it('handles a loop that starts and ends at the deleted stop', () => {
    const out = removeCalls(trip([1, 5]), nothingLearned, 45);
    expect(out.cutStart && out.cutEnd).toBe(true);
    expect(out.kept!.map((c) => c.seq)).toEqual([2, 3, 4]);
    expect(inOrder(out.kept!)).toBe(true);
  });

  it('removes a trip left with fewer than two stops', () => {
    expect(removeCalls([call(1, 0, 0, { gone: true }), call(2, 600)], nothingLearned, 45).kept).toBeNull();
    expect(removeCalls(trip([1, 2, 3, 4]), nothingLearned, 45).kept).toBeNull();
  });

  it('just drops a stop the trip already ran through, without changing a time', () => {
    const calls = trip([]);
    calls[2] = call(3, 1200, 1200, { gone: true, passing: true });
    const out = removeCalls(calls, () => 1, 45);
    expect(out.savingSecs).toBe(0);
    expect(out.skipped).toBe(0);
    expect(out.kept!.map((c) => [c.seq, c.arr, c.dep])).toEqual([[1, 0, 0], [2, 600, 630], [4, 1860, 1890], [5, 2490, 2490]]);
  });

  it('keeps other pass-throughs in order between the neighbours', () => {
    const calls = [call(1, 0), call(2, 300, 300, { passing: true }), call(3, 600, 660, { gone: true }), call(4, 900, 900, { passing: true }), call(5, 1200)];
    const out = removeCalls(calls, nothingLearned, 45);
    expect(out.kept!.map((c) => c.seq)).toEqual([1, 2, 4, 5]);
    expect(out.savingSecs).toBe(105);
    expect(inOrder(out.kept!)).toBe(true);
    expect(out.kept![3].arr).toBe(1200 - 105);
  });

  it('does not leave a trip starting with a pass-through', () => {
    const calls = [call(1, 0, 0, { gone: true }), call(2, 300, 300, { passing: true }), call(3, 600, 630), call(4, 1200)];
    const out = removeCalls(calls, nothingLearned, 45);
    expect(out.kept!.map((c) => c.seq)).toEqual([3, 4]);
    expect(out.kept![0]).toEqual({ seq: 3, arr: 630, dep: 630 });
  });

  it('never makes any trip of many shapes run out of order or longer', () => {
    // Every way of deleting stops from a seven-stop trip.
    for (let mask = 1; mask < 1 << 7; mask++) {
      const calls = Array.from({ length: 7 }, (_, i) => call(i + 1, i * 400, i * 400 + (i === 0 || i === 6 ? 0 : 20), { gone: (mask & (1 << i)) !== 0 }));
      const out = removeCalls(calls, (_f, _t, current) => (mask % 3 === 0 ? current - 37 : null), 20);
      if (!out.kept) continue;
      expect(inOrder(out.kept)).toBe(true);
      for (const k of out.kept) {
        const before = calls.find((c) => c.seq === k.seq)!;
        expect(k.arr).toBeLessThanOrEqual(before.dep);
        expect(k.dep).toBeLessThanOrEqual(before.dep);
      }
      // Between any two stops it keeps, the trip takes at least half as long as before.
      for (let i = 1; i < out.kept.length; i++) {
        const was = calls.find((c) => c.seq === out.kept![i].seq)!.arr - calls.find((c) => c.seq === out.kept![i - 1].seq)!.dep;
        expect(out.kept[i].arr - out.kept[i - 1].dep).toBeGreaterThanOrEqual(Math.round(was * 0.5));
      }
    }
  });
});

describe('choosePlatform', () => {
  const option = (id: number, uses: number, busy: [number, number, number][] = []): PlatformOption => ({
    id,
    uses,
    busy: busy.map(([from, to, trip]) => ({ from, to, trips: [trip] })),
  });
  const at = { arr: 1000, dep: 1060, tripId: 7 };

  it('prefers a free platform the line already uses', () => {
    expect(choosePlatform([option(1, 0), option(2, 3), option(3, 5, [[1000, 1100, 9]])], at)).toEqual({ id: 2, free: true, usual: true });
  });
  it('takes a free platform the line does not use before a busy one it does', () => {
    expect(choosePlatform([option(1, 4, [[900, 1010, 9]]), option(2, 0)], at)).toEqual({ id: 2, free: true, usual: false });
  });
  it('takes the least busy when none is free, and says so', () => {
    const pick = choosePlatform([option(1, 2, [[990, 1010, 8], [1050, 1070, 9]]), option(2, 2, [[1000, 1100, 9]])], at);
    expect(pick).toEqual({ id: 2, free: false, usual: true });
  });
  it('counts a minute either side as taken', () => {
    expect(choosePlatform([option(1, 1, [[1100, 1200, 9]])], at)!.free).toBe(false);
    expect(choosePlatform([option(1, 1, [[1121, 1200, 9]])], at)!.free).toBe(true);
  });
  it('does not let a trip clash with itself', () => {
    expect(choosePlatform([option(1, 1, [[1000, 1060, 7]])], at)!.free).toBe(true);
  });
  it('has nothing to offer when there is no other platform', () => {
    expect(choosePlatform([], at)).toBeNull();
  });
});
