// For the --fixture run of the access check (run-access-check.mjs): tells the fake router
// (apps/api/test/fake-router.mjs) to ride a real bus of the test feed, the first 333 towards Bondi after
// 08:00 from its second stop (Elizabeth St near Hunter St) to its sixth (Taylor Square), so that the
// picked sample point's ride is drawn along the bus's own path (D39) in 07-point-detail.png rather
// than along a made-up straight line. Not a test itself.
import postgres from 'postgres';

/** Reads the trip from `databaseUrl` and sets it as the fake router's ride at `fakeUrl`. */
export async function rideRealBus(databaseUrl, fakeUrl) {
  const db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [trip] = await db`
      select t.id, t.gtfs_id from trips t join routes r on r.id = t.route_id
      where r.short_name = '333' and t.direction_id = 0 and t.shape_id is not null
        and t.start_secs >= ${8 * 3600}
      order by t.start_secs limit 1`;
    if (!trip) throw new Error('the test feed has no 333 bus after 08:00');
    const calls = await db`
      select st.arr, st.dep, s.gtfs_id as stop, s.name, st_x(s.geom) as lon, st_y(s.geom) as lat
      from stop_times st join stops s on s.id = st.stop_id
      where st.trip_id = ${trip.id} order by st.seq`;
    const end = (c, time, position) => ({ ...c, time, position });
    const { arr: _a1, dep: _d1, ...board } = calls[1];
    const { arr: _a5, dep: _d5, ...alight } = calls[5];
    const ride = {
      trip: trip.gtfs_id,
      route: '333',
      routeId: 'X333',
      mode: 'bus',
      board: end(board, calls[1].dep, 1),
      alight: end(alight, calls[5].arr, 5),
    };
    const res = await fetch(`${fakeUrl}/fake/control`, {
      method: 'POST',
      body: JSON.stringify({ ride }),
    });
    if (!res.ok) throw new Error(`the fake router refused the ride: ${res.status}`);
    return `${ride.route} from ${board.name} to ${alight.name}`;
  } finally {
    await db.end();
  }
}
