// Writes the small test feed in ./mini-feed: a made-up weekday timetable in central Sydney, big
// enough for the scenario e2e suite (apps/api/test/scenarios.e2e.mjs) and nothing more.
// Usage: node packages/gtfs/test/fixtures/make-mini-feed.mjs
//
// What it holds (all ids are made up; places and coordinates are real):
//   T1  train, Redfern to Chatswood, 11 stations each with two platforms, every 15 minutes from
//       05:00 until after midnight. Four train runs (run numbers in the trip ids, as TfNSW does)
//       turn round in 2 minutes, so each trip has a tight follow-on. One run is a 4-car set.
//   333 bus, Circular Quay to Bondi Beach along Oxford St and Bondi Rd, every 20 minutes, slower
//       in the peaks. Stops in pairs across the road.
//   373 bus, Museum to Coogee, every 20 minutes.
//   389 bus, Pyrmont to Bondi Junction, sharing 333's stops along Oxford St, with one stop of its
//       own there. Every other trip runs only as far as Taylor Square: two stop patterns each way.
//   F1  ferry, Circular Quay to Manly, every 30 minutes, on two vessels given block ids.
// The file is deterministic: running it again gives the same files.
//
// The code lives in ./mini-feed-gen. The order of the calls below sets the order of the rows in
// each file, so keep it.
import path from 'node:path';
import { addBuses } from './mini-feed-gen/buses.mjs';
import { routes, shapes, stopTimes, stops, trips } from './mini-feed-gen/feed.mjs';
import { addFerry } from './mini-feed-gen/ferry.mjs';
import { addTrain } from './mini-feed-gen/train.mjs';
import { writeFeed } from './mini-feed-gen/write.mjs';

const OUT = path.join(import.meta.dirname, 'mini-feed');

addTrain();
addBuses();
addFerry();
await writeFeed(OUT);
console.log(
  `Wrote ${OUT}: ${routes.length} routes, ${stops.length} stops, ${trips.length} trips, ` +
    `${stopTimes.length} stop times, ${shapes.length} shape points`,
);
