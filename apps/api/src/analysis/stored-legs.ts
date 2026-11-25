// A journey's legs as an analysis run stores them (D30, D39; docs/architecture/access-analysis.md
// §4.4): walks and transfers with their time and metres; rides with their line, mode, trip, and
// the stops they board and alight at (GTFS id, name, place, time), without the stops passed. The
// trip and stop ids let the picked sample point draw the ride along its vehicle's path.
import { localFrame, type StoredLeg, type StoredStop } from '@gtfs-editor/core';
import type { BulkJourney, RideStop } from './journeys-client.ts';

/** Straight-line metres between two places, with the flat-earth factors of the grid (D26). */
function straightMetres(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const frame = localFrame((a.lon + b.lon) / 2, (a.lat + b.lat) / 2);
  const [ax, ay] = frame.toMetres([a.lon, a.lat]);
  const [bx, by] = frame.toMetres([b.lon, b.lat]);
  return Math.hypot(bx - ax, by - ay);
}

/** The parts of a stop kept (the router's answer has more, such as its place in the trip). */
const stopOf = ({ stop, name, lat, lon, time }: RideStop): StoredStop => ({
  ...(stop === undefined ? {} : { stop }),
  name,
  lat,
  lon,
  time,
});

/**
 * A journey's legs as stored. A ride's metres are the straight line from where it boards to where
 * it alights; its trip id is kept when the router gives one.
 */
export function storedLegs(journey: BulkJourney): StoredLeg[] {
  const legs: StoredLeg[] = [];
  for (const leg of journey.legs) {
    if (leg.type === 'ride') {
      legs.push({
        type: 'ride',
        ...(leg.trip === undefined ? {} : { trip: leg.trip }),
        route: leg.route,
        mode: leg.mode,
        board: stopOf(leg.board),
        alight: stopOf(leg.alight),
        secs: leg.alight.time - leg.board.time,
        metres: Math.round(straightMetres(leg.board, leg.alight)),
      });
    } else if (leg.type !== 'warning') {
      const secs = (leg.arrive ?? 0) - (leg.depart ?? 0);
      legs.push({ type: leg.type, secs, metres: Math.round(leg.metres ?? 0) });
    }
  }
  return legs;
}
