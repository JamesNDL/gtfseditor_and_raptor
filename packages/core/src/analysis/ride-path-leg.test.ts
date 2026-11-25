// One stored ride's path for the picked sample point (D35): along its trip when the trip and its
// two calls are found, otherwise the straight line from boarding to alighting, marked as such.
import { describe, expect, it } from 'vitest';
import { localFrame } from './local-metres.ts';
import { legPath, type TripCall } from './ride-path.ts';

const FRAME = localFrame(151.2, -33.9);
const at = (x: number, y: number) => FRAME.toLonLat([x, y]);
const call = (stop: string, x: number, y: number, time: number): TripCall => {
  const [lon, lat] = at(x, y);
  return { stop, lon, lat, arr: time, dep: time, dist: null };
};
const CALLS = [call('A', 0, 0, 100), call('B', 400, 300, 200), call('C', 800, 0, 300)];
const end = (stop: string | undefined, x: number, y: number, time: number) => {
  const [lon, lat] = at(x, y);
  return { ...(stop === undefined ? {} : { stop }), name: stop ?? 'Stop', lon, lat, time };
};

describe('legPath', () => {
  it('follows the trip when its two calls are found', () => {
    const leg = { board: end('A', 0, 0, 100), alight: end('C', 800, 0, 300) };
    const { path, from } = legPath(leg, { shape: null, calls: CALLS });
    expect(from).toBe('stops');
    expect(path).toEqual([at(0, 0), at(400, 300), at(800, 0)]);
  });

  it('is the straight line, marked straight, when no trip was found', () => {
    const leg = { board: end('A', 0, 0, 100), alight: end('C', 800, 0, 300) };
    expect(legPath(leg, null)).toEqual({ path: [at(0, 0), at(800, 0)], from: 'straight' });
  });

  it('is the straight line when the trip does not call at the stored stops and times', () => {
    const leg = { board: end('A', 0, 0, 90), alight: end('C', 800, 0, 300) };
    expect(legPath(leg, { shape: null, calls: CALLS }).from).toBe('straight');
  });
});
