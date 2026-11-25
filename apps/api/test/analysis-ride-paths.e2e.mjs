// End-to-end check that a picked sample point's rides follow their vehicles' paths (D35,
// docs/architecture/access-analysis.md §12): the fake router (fake-router.mjs) is told to ride a
// real bus trip of the test feed, the run stores the trip and stop ids, and the point's detail gives
// the ride a path cut from the trip's shape between the two stops. A leg stored the old way (no trip
// or stop ids) finds its trip by line, place and time; one that fits no trip is the straight line,
// marked so. Run by analysis.e2e.mjs. Needs FAKE_ROUTER and DATABASE_URL.
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  FAKE_ROUTER,
  create,
  fake,
  get,
  placesFor,
  send,
  step,
  until,
} from './analysis-e2e-client.mjs';

if (!FAKE_ROUTER || !process.env.DATABASE_URL) {
  console.log('skipped: the ride path checks need FAKE_ROUTER and DATABASE_URL');
  process.exit(0);
}
const db = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

/** Straight metres between two [lon, lat] places. */
function metresApart([lon1, lat1], [lon2, lat2]) {
  const kx = 111_320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110_540);
}

// The first 333 bus after 08:00, boarded at its second stop and left at its sixth.
const [trip] = await db`
  select t.id, t.gtfs_id from trips t join routes r on r.id = t.route_id
  where r.short_name = '333' and t.scenario_id is null and t.shape_id is not null
    and t.start_secs >= ${8 * 3600}
  order by t.start_secs limit 1`;
assert.ok(trip, 'the test feed has a 333 bus after 08:00');
const calls = await db`
  select st.seq, st.arr, st.dep, s.gtfs_id as stop, s.name, st_x(s.geom) as lon, st_y(s.geom) as lat
  from stop_times st join stops s on s.id = st.stop_id
  where st.trip_id = ${trip.id} order by st.seq`;
const end = (c, time, position) => ({
  stop: c.stop,
  name: c.name,
  lat: c.lat,
  lon: c.lon,
  time,
  position,
});
const ride = {
  trip: trip.gtfs_id,
  route: '333',
  routeId: 'X333',
  mode: 'bus',
  board: end(calls[1], calls[1].dep, 1),
  alight: end(calls[5], calls[5].arr, 5),
};

const places = await placesFor(151.2, -33.95, {});
const made = [];
try {
  await fake({ ride });
  const id = await create({ ...places.body, poiIds: places.body.poiIds.slice(0, 1) });
  made.push(id);
  const detail = await until(id, (d) => ['done', 'failed'].includes(d.state), 'the run ends');
  assert.equal(detail.state, 'done', detail.error);
  await fake({ ride: null });

  const [pair] = await db`
    select point_seq as seq, legs from analysis_results
    where analysis_id = ${id} and poi_seq = 0 and legs is not null
    order by point_seq limit 1`;
  assert.ok(pair, 'some pair has a journey');
  const stored = pair.legs.find((l) => l.type === 'ride');
  assert.equal(stored.trip, trip.gtfs_id, 'the trip id is stored');
  assert.equal(stored.board.stop, calls[1].stop, 'the boarding stop id is stored');
  assert.equal(stored.alight.stop, calls[5].stop, 'the alighting stop id is stored');
  step('D35 a run stores each ride with its trip and the ids of its two stops');

  const rideOf = async () => {
    const point = await get(`/api/analyses/${id}/points/${pair.seq}?poi=0`);
    return point.legs.find((l) => l.type === 'ride');
  };
  const board = [calls[1].lon, calls[1].lat];
  const alight = [calls[5].lon, calls[5].lat];
  const shown = await rideOf();
  assert.equal(shown.pathFrom, 'shape');
  assert.ok(shown.path.length > 2, `the ride has ${shown.path.length} points`);
  assert.ok(metresApart(shown.path[0], board) < 30, 'the path starts at the boarding stop');
  assert.ok(metresApart(shown.path.at(-1), alight) < 30, 'the path ends at the alighting stop');
  step(`D35 a picked point's ride follows the trip's shape (${shown.path.length} points)`);

  // A leg stored before trip and stop ids were kept: only the line, names, places and times.
  const oldStyle = (change) =>
    pair.legs.map((leg) => {
      if (leg.type !== 'ride') return leg;
      const { trip: _trip, ...rest } = leg;
      const plain = ({ stop: _stop, ...stop }) => stop;
      return change({ ...rest, board: plain(leg.board), alight: plain(leg.alight) });
    });
  const storeLegs = (legs) => db`
    update analysis_results set legs = ${db.json(legs)}
    where analysis_id = ${id} and poi_seq = 0 and point_seq = ${pair.seq}`;
  await storeLegs(oldStyle((leg) => leg));
  const found = await rideOf();
  assert.equal(found.pathFrom, 'shape');
  assert.deepEqual(found.path, shown.path, 'the old-style leg finds the same trip');
  step('D35 a ride stored without ids finds its trip by line, place and time');

  await storeLegs(
    oldStyle((leg) => ({ ...leg, board: { ...leg.board, time: leg.board.time + 7 } })),
  );
  const straight = await rideOf();
  assert.equal(straight.pathFrom, 'straight');
  assert.deepEqual(straight.path, [board, alight]);
  step('D35 a ride that fits no trip is the straight line, marked so');
} finally {
  await fake({ ride: null });
  for (const id of made) await send('DELETE', `/api/analyses/${id}`);
  await places.remove();
  await db.end();
}
console.log('all ride path checks passed');
