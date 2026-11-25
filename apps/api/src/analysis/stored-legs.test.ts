// A journey's legs as an analysis run stores them (D30, D39): walks and transfers with their time
// and metres; rides with their line, mode, trip and the ids of the stops they board and alight at,
// so the picked sample point can draw the ride along its vehicle's path.
import { describe, expect, it } from 'vitest';
import type { BulkJourney } from './journeys-client.ts';
import { storedLegs } from './stored-legs.ts';

const JOURNEY: BulkJourney = {
  depart: 29000,
  arrive: 30500,
  walkSecs: 300,
  rides: 1,
  legs: [
    { type: 'walk', depart: 29000, arrive: 29150, metres: 154.6 },
    {
      type: 'ride',
      trip: '333.1001',
      route: '333',
      mode: 'bus',
      depart: 29200,
      arrive: 30350,
      board: { stop: 'XQAY1', name: 'Circular Quay', lat: -33.861, lon: 151.211, time: 29200 },
      alight: { stop: 'XBON1', name: 'Bondi Beach', lat: -33.891, lon: 151.274, time: 30350 },
    },
    { type: 'warning' },
    { type: 'walk', depart: 30350, arrive: 30500, metres: 150 },
  ],
};

describe('storedLegs', () => {
  it('keeps the trip and the stop ids of a ride, and the rest as before', () => {
    expect(storedLegs(JOURNEY)).toEqual([
      { type: 'walk', secs: 150, metres: 155 },
      {
        type: 'ride',
        trip: '333.1001',
        route: '333',
        mode: 'bus',
        board: { stop: 'XQAY1', name: 'Circular Quay', lat: -33.861, lon: 151.211, time: 29200 },
        alight: { stop: 'XBON1', name: 'Bondi Beach', lat: -33.891, lon: 151.274, time: 30350 },
        secs: 1150,
        metres: 6701,
      },
      { type: 'walk', secs: 150, metres: 150 },
    ]);
  });

  it('leaves the ids out when the router gives none', () => {
    const ride = JOURNEY.legs[1];
    if (ride.type !== 'ride' || !('board' in ride)) throw new Error('the test journey changed');
    const { trip: _trip, ...noTrip } = ride;
    const { stop: _b, ...board } = ride.board;
    const { stop: _a, ...alight } = ride.alight;
    const [stored] = storedLegs({ ...JOURNEY, legs: [{ ...noTrip, board, alight }] });
    expect(stored).not.toHaveProperty('trip');
    expect(stored).toMatchObject({ board: { name: 'Circular Quay' } });
    expect(stored.type === 'ride' && 'stop' in stored.board).toBe(false);
  });
});
