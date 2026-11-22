import { describe, expect, it } from 'vitest';
import { buildVehicleDays, type ChainTrip } from './vehicle-days.ts';

const A: [number, number] = [151.0, -33.8];
const B: [number, number] = [151.1, -33.8]; // about 9 km east of A

let nextId = 1;
function trip(
  from: [number, number],
  to: [number, number],
  start: number,
  end: number,
  extra: Partial<ChainTrip> = {},
): ChainTrip {
  return {
    id: nextId++,
    startSecs: start,
    endSecs: end,
    firstLon: from[0],
    firstLat: from[1],
    lastLon: to[0],
    lastLat: to[1],
    ruleSet: 'road',
    partition: 'bus|op1|',
    ...extra,
  };
}

describe('buildVehicleDays', () => {
  it('chains a trip onto the next one leaving from where it ended', () => {
    const out = trip(A, B, 0, 1000);
    const back = trip(B, A, 1300, 2300);
    const days = buildVehicleDays([back, out]);
    expect(days).toHaveLength(1);
    expect(days[0].tripIds).toEqual([out.id, back.id]);
    expect(days[0].source).toBe('inferred');
    expect(days[0].gapCount).toBe(0);
  });

  it('does not chain when the layover is too short, too long, or somewhere else', () => {
    expect(buildVehicleDays([trip(A, B, 0, 1000), trip(B, A, 1010, 2000)])).toHaveLength(2); // 10 s turnaround
    expect(buildVehicleDays([trip(A, B, 0, 1000), trip(B, A, 1000 + 2 * 3600, 9000)])).toHaveLength(
      2,
    ); // 2 h wait
    expect(buildVehicleDays([trip(A, B, 0, 1000), trip(A, B, 1300, 2300)])).toHaveLength(2); // starts at A, bus is at B
  });

  it('never chains across partitions', () => {
    const days = buildVehicleDays([
      trip(A, B, 0, 1000),
      trip(B, A, 1300, 2300, { partition: 'bus|op2|' }),
    ]);
    expect(days).toHaveLength(2);
  });

  it('gives the longest-waiting vehicle the next departure', () => {
    const first = trip(A, B, 0, 1000);
    const second = trip(A, B, 100, 1100);
    const next = trip(B, A, 1500, 2500);
    const days = buildVehicleDays([first, second, next]);
    expect(days.find((d) => d.tripIds.includes(next.id))!.tripIds).toEqual([first.id, next.id]);
  });

  it('keeps block-linked trips on one vehicle even with no layover', () => {
    const a = trip(A, B, 0, 1000, { blockId: 'blk' });
    const b = trip(B, A, 1000, 2000, { blockId: 'blk' });
    expect(buildVehicleDays([a, b])).toHaveLength(1);
  });

  it('uses run numbers as given and counts station jumps as gaps', () => {
    const rail = { ruleSet: 'rail' as const, partition: 'train|st|', runKey: '1--' };
    const days = buildVehicleDays([
      trip(A, B, 0, 1000, rail),
      trip(A, B, 5000, 6000, rail),
      trip(B, A, 6100, 7000, rail),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0].source).toBe('run_number');
    expect(days[0].tripIds).toHaveLength(3);
    expect(days[0].gapCount).toBe(1);
  });
});
