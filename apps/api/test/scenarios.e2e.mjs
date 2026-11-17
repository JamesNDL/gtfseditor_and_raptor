// End-to-end check of the scenario engine against a running API and an imported baseline.
// Usage: node apps/api/test/scenarios.e2e.mjs   (needs `npm run dev` or the API running on :3001)
import assert from 'node:assert/strict';

const API = process.env.API ?? 'http://localhost:3001';
const get = async (path) => {
  const res = await fetch(API + path);
  assert.equal(res.status, 200, `${path} responded ${res.status}: ${await res.clone().text()}`);
  return res.json();
};
const send = async (method, path, body) => {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const step = (name) => console.log(`ok  ${name}`);

const [baseline] = await get('/api/baselines');
const routes = await get(`/api/baselines/${baseline.id}/routes`);
const t1 = routes.filter((r) => r.shortName === 'T1').sort((a, b) => b.tripCount - a.tripCount)[0];
const before = await get(`/api/routes/${t1.id}`);
const baseTrips = await get(`/api/routes/${t1.id}/trips`);

const created = await send('POST', '/api/scenarios', { baselineId: baseline.id, name: 'e2e test' });
assert.equal(created.status, 200);
const S = created.body.id;
const q = `?s=${S}`;
try {
  // A fresh scenario looks exactly like the baseline.
  assert.equal((await get(`/api/routes/${t1.id}${q}`)).tripCount, before.tripCount);
  step('new scenario matches the baseline');

  // Retime: a trip with a tight follow-on is moved later, which must break its vehicle's next trip.
  const tight = await (async () => {
    for (const t of baseTrips.filter((x) => x.vehicleDayId)) {
      const day = await get(`/api/vehicle-days/${t.vehicleDayId}`);
      const i = day.trips.findIndex((x) => x.id === t.id);
      const next = day.trips[i + 1];
      if (next && next.startSecs - t.endSecs <= 120 && next.startSecs > t.endSecs) return { trip: t, next };
    }
    throw new Error('no tightly linked trip found');
  })();
  const shift = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'shift', tripIds: [tight.trip.id], delta: 300, ripple: 'none' });
  assert.equal(shift.status, 200, JSON.stringify(shift.body));
  const movedId = shift.body.focusTripId;
  assert.ok(movedId && movedId !== tight.trip.id);
  const moved = await get(`/api/trips/${movedId}${q}`);
  assert.equal(moved.startSecs, tight.trip.startSecs + 300);
  assert.equal(moved.stopTimes[0].dep, tight.trip.startSecs + 300);
  assert.equal(moved.edited, true);
  assert.equal(moved.vehicleDayId, tight.trip.vehicleDayId);
  const after = await get(`/api/routes/${t1.id}/trips${q}`);
  assert.equal(after.length, baseTrips.length, 'retiming must not change the trip count');
  assert.ok(!after.some((t) => t.id === tight.trip.id), 'the original trip is hidden in the scenario');
  assert.ok((await get(`/api/routes/${t1.id}/trips`)).some((t) => t.id === tight.trip.id), 'the baseline is untouched');
  step('retime replaces the trip in the scenario only');

  let info = await get(`/api/scenarios/${S}`);
  const vehicleConflict = info.conflicts.find((c) => c.kind === 'vehicle' && c.tripId === movedId);
  assert.ok(vehicleConflict, 'moving the trip later must flag its vehicle');
  step(`conflict found: ${vehicleConflict.title}`);

  // One-click fix: push the vehicle's later trips back.
  const fix = await send('POST', `/api/scenarios/${S}/edits`, vehicleConflict.fixes[0].edit);
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  info = await get(`/api/scenarios/${S}`);
  assert.ok(!info.conflicts.some((c) => c.kind === 'vehicle'), 'the fix clears the vehicle conflict');
  assert.equal(info.head, 2);
  step('one-click fix clears it');

  // Undo twice returns to the baseline; redo brings the edits back.
  await send('POST', `/api/scenarios/${S}/undo`);
  await send('POST', `/api/scenarios/${S}/undo`);
  const undone = await get(`/api/routes/${t1.id}/trips${q}`);
  assert.deepEqual(undone.map((t) => t.id), baseTrips.map((t) => t.id));
  assert.equal((await send('POST', `/api/scenarios/${S}/undo`)).status, 400);
  await send('POST', `/api/scenarios/${S}/redo`);
  assert.ok((await get(`/api/routes/${t1.id}/trips${q}`)).some((t) => t.id === movedId));
  await send('POST', `/api/scenarios/${S}/undo`);
  step('undo and redo');

  // Skip a stop: the trip gets shorter and the stop becomes a pass-through.
  const victim = baseTrips.find((t) => t.stopCount >= 10);
  const detail = await get(`/api/trips/${victim.id}`);
  const real = detail.stopTimes.filter((s) => !(s.pickupType === 1 && s.dropOffType === 1));
  const target = real[Math.floor(real.length / 2)];
  const skip = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'skipStop', tripId: victim.id, stopSeq: target.seq, scope: 'trip' });
  assert.equal(skip.status, 200, JSON.stringify(skip.body));
  const skipped = await get(`/api/trips/${skip.body.focusTripId}${q}`);
  const passing = skipped.stopTimes.find((s) => s.seq === target.seq);
  assert.equal(passing.pickupType, 1);
  assert.equal(passing.dropOffType, 1);
  assert.ok(skipped.endSecs < detail.endSecs, 'skipping a stop must make the trip faster');
  assert.equal(skipped.startSecs, detail.startSecs);
  for (let i = 1; i < skipped.stopTimes.length; i++) {
    assert.ok(skipped.stopTimes[i].arr >= skipped.stopTimes[i - 1].dep, 'times must stay in order');
  }
  step(`skip stop: ${skip.body.summary}`);
  // A new edit after an undo discards the undone edit.
  assert.equal((await send('POST', `/api/scenarios/${S}/redo`)).status, 400);
  step('editing after undo discards the redo history');

  // Duplicate and delete.
  const dup = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'duplicate', tripId: victim.id, startSecs: victim.startSecs + 420 });
  assert.equal(dup.status, 200, JSON.stringify(dup.body));
  assert.equal((await get(`/api/routes/${t1.id}${q}`)).tripCount, before.tripCount + 1);
  const copy = await get(`/api/trips/${dup.body.focusTripId}${q}`);
  assert.ok(copy.vehicleDayId, 'a new trip is given a vehicle');
  assert.equal((await get(`/api/scenarios/${S}`)).stats.unassigned, 0);
  const copyDay = await get(`/api/vehicle-days/${copy.vehicleDayId}${q}`);
  assert.ok(copyDay.trips.some((t) => t.id === copy.id));
  for (let i = 1; i < copyDay.trips.length; i++) {
    assert.ok(copyDay.trips[i].startSecs >= copyDay.trips[i - 1].endSecs, 'a vehicle cannot run two trips at once');
  }
  step(`new trip got a vehicle: ${copyDay.label}${copyDay.isNew ? ' (added)' : ' (had spare time)'}`);

  // Force it onto its own new vehicle.
  const own = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'setVehicle', tripId: copy.id, mode: 'new' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const ownDay = await get(`/api/vehicle-days/${(await get(`/api/trips/${own.body.focusTripId}${q}`)).vehicleDayId}${q}`);
  assert.equal(ownDay.isNew, true);
  assert.equal(ownDay.tripCount, 1);
  step('a trip can be put on its own new vehicle');
  dup.body.focusTripId = own.body.focusTripId;
  const del = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'delete', tripIds: [dup.body.focusTripId] });
  assert.equal(del.status, 200);
  assert.equal((await get(`/api/routes/${t1.id}${q}`)).tripCount, before.tripCount);
  step('duplicate and delete');

  // Headway: a two-hour band at 10 minutes yields 12 trips of that pattern in the band.
  const pattern = [...before.patterns].sort((a, b) => b.tripCount - a.tripCount)[0];
  const from = 10 * 3600;
  const to = 12 * 3600;
  const hw = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'headway', patternId: pattern.id, fromSecs: from, toSecs: to, headwaySecs: 600 });
  assert.equal(hw.status, 200, JSON.stringify(hw.body));
  const inBand = (await get(`/api/routes/${t1.id}/trips${q}`)).filter((t) => t.patternId === pattern.id && t.startSecs >= from && t.startSecs < to);
  assert.equal(inBand.length, 12);
  assert.deepEqual(inBand.map((t) => t.startSecs), Array.from({ length: 12 }, (_, i) => from + i * 600));
  step(`headway: ${hw.body.summary}`);
  assert.ok(inBand.every((t) => t.vehicleDayId), 'every new trip has a vehicle');

  // Before-and-after data for the views.
  info = await get(`/api/scenarios/${S}`);
  const line = info.impact.find((i) => i.routeId === t1.id);
  assert.ok(line, 'the edited line is listed in the impact summary');
  assert.equal(line.tripsBefore, before.tripCount);
  assert.equal(line.tripsAfter, (await get(`/api/routes/${t1.id}${q}`)).tripCount);
  assert.ok(line.vehiclesAfter >= line.vehiclesBefore);
  const withBefore = await get(`/api/routes/${t1.id}${q}`);
  assert.equal(withBefore.before.tripCount, before.tripCount);
  assert.equal((await get(`/api/routes/${t1.id}`)).before, null);
  const sl = await get(`/api/patterns/${pattern.id}/stringline${q}&others=0`);
  assert.ok(sl.trips.some((t) => t.edited), 'changed trips are flagged on the stringline');
  step(`impact: ${line.tripsBefore} to ${line.tripsAfter} trips, ${line.vehiclesBefore} to ${line.vehiclesAfter} vehicles`);

  // Undoing everything removes the added vehicles from the picture.
  for (let i = 0; i < info.head; i++) await send('POST', `/api/scenarios/${S}/undo`);
  const clean = await get(`/api/scenarios/${S}`);
  assert.equal(clean.stats.trips, clean.stats.baselineTrips);
  assert.equal(clean.stats.vehicles, clean.stats.baselineVehicles);
  assert.equal(clean.impact.length, 0);
  for (let i = 0; i < info.head; i++) await send('POST', `/api/scenarios/${S}/redo`);
  step('undoing everything returns trips and vehicles to the published numbers');

  // Whole-line frequency: both directions in one go, and trips out and back share vehicles.
  const beforeLine = await get(`/api/scenarios/${S}`);
  const lf = await send('POST', `/api/scenarios/${S}/edits`, {
    kind: 'lineFrequency',
    routeId: t1.id,
    bands: [{ fromSecs: 13 * 3600, toSecs: 15 * 3600, headwaySecs: 900 }],
  });
  assert.equal(lf.status, 200, JSON.stringify(lf.body));
  const lineTrips = (await get(`/api/routes/${t1.id}/trips${q}`)).filter((t) => t.edited && t.startSecs >= 13 * 3600 && t.startSecs < 15 * 3600);
  assert.ok(new Set(lineTrips.map((t) => t.direction)).size >= 2, 'both directions get new trips');
  assert.ok(lineTrips.every((t) => t.vehicleDayId));
  const afterLine = await get(`/api/scenarios/${S}`);
  const addedVehicles = afterLine.stats.vehicles - beforeLine.stats.vehicles;
  step(`whole-line frequency: ${lf.body.summary}`);
  assert.ok(addedVehicles < lineTrips.length, 'out-and-back trips share vehicles rather than taking one each');

  // A brand-new line through existing stops.
  const someBus = routes.find((r) => r.modeId === 'bus' && r.tripCount > 40);
  const busTrip = (await get(`/api/routes/${someBus.id}/trips`))[0];
  const busStops = (await get(`/api/trips/${busTrip.id}`)).stopTimes.map((s) => s.stopId);
  const picked = [busStops[0], busStops[Math.floor(busStops.length / 2)], busStops[busStops.length - 1]];
  const made = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'createLine', name: 'X99', modeId: 'bus', color: 'FF00AA', stopIds: picked, headwaySecs: 1200 });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const newRoute = await get(`/api/routes/${made.body.routeId}${q}`);
  assert.equal(newRoute.shortName, 'X99');
  assert.equal(newRoute.tripCount, 96, 'every 20 minutes from 06:00 to 22:00, both ways');
  assert.equal(newRoute.directions.length, 2);
  const newTrips = await get(`/api/routes/${made.body.routeId}/trips${q}`);
  assert.ok(newTrips.every((t) => t.vehicleDayId && t.stopCount === 3));
  const oneNew = await get(`/api/trips/${newTrips[0].id}${q}`);
  // Buses are published with no stop time of their own, and a new bus line follows suit.
  assert.ok(oneNew.stopTimes[2].arr > oneNew.stopTimes[1].dep && oneNew.stopTimes[1].dep >= oneNew.stopTimes[1].arr);
  assert.match(made.body.summary, /run times: \d+ sections? from/);
  // Run times follow the time of day: every trip that sets out in the same part of the day takes the same time,
  // and no part of the day is wildly different from another.
  const durations = (from, to) => [...new Set(newTrips.filter((t) => t.direction === 0 && t.startSecs >= from && t.startSecs < to).map((t) => t.endSecs - t.startSecs))];
  const peak = durations(6.5 * 3600, 9.5 * 3600);
  const midday = durations(9.5 * 3600, 15 * 3600);
  assert.equal(peak.length, 1, 'one run time through the morning peak');
  assert.equal(midday.length, 1, 'one run time through the middle of the day');
  assert.ok(peak[0] > midday[0] * 0.6 && peak[0] < midday[0] * 1.8, `peak ${peak[0]}s against midday ${midday[0]}s`);
  step(`run times by time of day: ${Math.round(peak[0] / 60)} min in the morning peak, ${Math.round(midday[0] / 60)} min in the middle of the day`);
  assert.ok((await get(`/api/baselines/${baseline.id}/routes${q}`)).some((r) => r.id === made.body.routeId && r.isNew));
  assert.ok(!(await get(`/api/baselines/${baseline.id}/routes`)).some((r) => r.id === made.body.routeId), 'not in the published list');
  const drawn = (await get(`/api/scenarios/${S}/lines`)).features;
  assert.equal(drawn.length, 2, 'both directions are drawn');
  // These stops are served in this order by a published bus route, so the path should follow it, both ways.
  for (const d of drawn) assert.ok(d.geometry.coordinates.length > picked.length, 'each direction follows the road rather than cutting straight between stops');
  // Run times come from the published trips between these stops, so they should match that trip's.
  const src = (await get(`/api/trips/${busTrip.id}`)).stopTimes;
  const published = src[src.length - 1].arr - src[0].dep;
  const outbound = newTrips.find((t) => t.direction === 0);
  const ours = outbound.endSecs - outbound.startSecs;
  assert.ok(Math.abs(ours - published) < published * 0.35 + 120, `run time ${ours}s should be close to the published ${published}s`);
  assert.ok(oneNew.stopTimes[2].dist > oneNew.stopTimes[1].dist && oneNew.stopTimes[1].dist > 0, 'stops sit in order along the path');
  await get(`/api/patterns/${newRoute.patterns[0].id}/stringline${q}&others=0`);
  // The way back should use the stops across the road, not the same ones.
  const backTrip = await get(`/api/trips/${newTrips.find((t) => t.direction === 1).id}${q}`);
  const outStops = new Set(oneNew.stopTimes.map((s) => s.stopId));
  const acrossTheRoad = backTrip.stopTimes.filter((s) => !outStops.has(s.stopId)).length;
  step(`the way back uses ${acrossTheRoad} of ${backTrip.stopTimes.length} stops from the other side of the road`);
  assert.ok(made.body.summary.includes('across the road') === acrossTheRoad > 0);

  // The moving dots must stay on the drawn path, in both directions, for the whole trip.
  const { decodePack, tripPosition } = await import('../../../packages/core/src/pack.ts');
  const packBuffer = await (await fetch(`${API}/api/scenarios/${S}/pack`)).arrayBuffer();
  const mapPack = decodePack(packBuffer);
  const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);
  const toSegment = (p, a, b) => {
    const ax = (a[0] - p[0]) * 111320 * Math.cos((p[1] * Math.PI) / 180), ay = (a[1] - p[1]) * 110540;
    const bx = (b[0] - p[0]) * 111320 * Math.cos((p[1] * Math.PI) / 180), by = (b[1] - p[1]) * 110540;
    const dx = bx - ax, dy = by - ay;
    const f = dx * dx + dy * dy > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(ax + f * dx, ay + f * dy);
  };
  let worst = 0;
  let sampled = 0;
  const directionsSeen = new Set();
  for (let i = 0; i < mapPack.meta.tripCount; i++) {
    if (mapPack.tripRoute[i] !== made.body.routeId) continue;
    const info = newTrips.find((t) => t.id === mapPack.tripId[i]);
    if (!info || directionsSeen.has(info.direction)) continue;
    directionsSeen.add(info.direction);
    const out = new Float64Array(2);
    for (let k = 0; k <= 40; k++) {
      const secs = mapPack.tripStart[i] + ((mapPack.tripEnd[i] - mapPack.tripStart[i]) * k) / 40;
      assert.ok(tripPosition(mapPack, i, secs, out, 0));
      const here = [out[0], out[1]];
      const off = Math.min(...drawn.map((d) => Math.min(...d.geometry.coordinates.slice(1).map((c, n) => toSegment(here, d.geometry.coordinates[n], c)))));
      worst = Math.max(worst, off);
      sampled++;
    }
  }
  assert.equal(directionsSeen.size, 2, 'checked a trip in each direction');
  assert.ok(metres([0, 0], [0, 0]) === 0 && worst < 25, `a vehicle strayed ${worst.toFixed(0)} m from the drawn path`);
  step(`vehicles stay on the drawn path both ways (${sampled} positions checked, furthest ${worst.toFixed(0)} m off)`);

  const fleetNow = (await get(`/api/scenarios/${S}`)).impact.find((i) => i.routeId === made.body.routeId);
  assert.ok(fleetNow.vehiclesAfter < 96 / 2, 'buses run out and back rather than one per trip');
  step(`new line: ${made.body.summary}`);
  await send('POST', `/api/scenarios/${S}/undo`);
  assert.equal((await get(`/api/scenarios/${S}/lines`)).features.length, 0, 'undo removes the drawn line');
  assert.ok(!(await get(`/api/baselines/${baseline.id}/routes${q}`)).some((r) => r.id === made.body.routeId));
  await send('POST', `/api/scenarios/${S}/redo`);
  step('undo removes the new line and redo brings it back');

  // Reshape an existing line: cut it short, extend it again, add a stop, and undo.
  {
    const preview = (body) => send('POST', `/api/reshape-preview${q}`, body);
    const reshape = (body) => send('POST', `/api/scenarios/${S}/edits`, { kind: 'reshape', ...body });
    const inOrder = (trip) => {
      for (let i = 1; i < trip.stopTimes.length; i++) {
        assert.ok(trip.stopTimes[i].arr >= trip.stopTimes[i - 1].dep, 'times must stay in order');
        assert.ok(trip.stopTimes[i].dist >= trip.stopTimes[i - 1].dist, 'stops must stay in order along the path');
      }
      assert.equal(trip.stopTimes[0].dep, trip.startSecs);
      assert.equal(trip.stopTimes[trip.stopTimes.length - 1].arr, trip.endSecs);
    };
    // A two-way bus line whose main stop pattern is long enough to cut.
    let line = null;
    for (const r of routes.filter((x) => x.modeId === 'bus' && x.tripCount > 40).slice(0, 40)) {
      const d = await get(`/api/routes/${r.id}${q}`);
      if (d.directions.length === 2 && d.patterns[0].stopCount >= 10) {
        line = d;
        break;
      }
    }
    assert.ok(line, 'found a two-way bus line to reshape');
    const main = line.patterns[0];
    const published = (await get(`/api/patterns/${main.id}/stops`)).stops;
    const ids = published.map((s) => s.id);
    const tripsWere = (await get(`/api/routes/${line.id}/trips${q}`)).filter((t) => t.patternId === main.id);
    const sampleWas = await get(`/api/trips/${tripsWere[0].id}${q}`);
    const headBefore = (await get(`/api/scenarios/${S}`)).head;

    assert.equal((await preview({ patternId: main.id, stopIds: ids })).status, 400, 'an unchanged line is refused');
    assert.equal((await preview({ patternId: main.id, stopIds: ids.slice(0, 1) })).status, 400, 'a line needs two stops');

    // Cut the last two stops off, both directions.
    const cutPreview = await preview({ patternId: main.id, stopIds: ids.slice(0, -2) });
    assert.equal(cutPreview.status, 200, JSON.stringify(cutPreview.body));
    assert.equal(cutPreview.body.removed, 2);
    assert.equal(cutPreview.body.trips, tripsWere.length);
    assert.equal((await get(`/api/routes/${line.id}/trips${q}`)).filter((t) => t.edited && t.patternId === main.id).length, tripsWere.filter((t) => t.edited).length, 'a preview changes nothing');
    const cut = await reshape({ patternId: main.id, stopIds: ids.slice(0, -2) });
    assert.equal(cut.status, 200, JSON.stringify(cut.body));
    const afterCut = await get(`/api/routes/${line.id}${q}`);
    assert.equal(afterCut.tripCount, line.tripCount, 'reshaping keeps every trip');
    assert.ok(!afterCut.patterns.some((p) => p.id === main.id), 'the replaced stop pattern is no longer listed');
    const tripsCut = (await get(`/api/routes/${line.id}/trips${q}`)).filter((t) => t.edited && t.stopCount === ids.length - 2 && t.direction === tripsWere[0].direction);
    assert.equal(tripsCut.length, tripsWere.length);
    assert.deepEqual(tripsCut.map((t) => t.startSecs), tripsWere.map((t) => t.startSecs), 'cutting the end leaves every departure where it was');
    assert.ok(tripsCut.every((t, i) => t.endSecs <= tripsWere[i].endSecs && t.vehicleDayId === tripsWere[i].vehicleDayId), 'trips end sooner and keep their vehicles');
    const sampleCut = await get(`/api/trips/${cut.body.idMap[sampleWas.id]}${q}`);
    inOrder(sampleCut);
    assert.deepEqual(sampleCut.stopTimes.map((s) => [s.stopId, s.arr, s.dep]), sampleWas.stopTimes.slice(0, -2).map((s) => [s.stopId, s.arr, s.dep]), 'the stops that remain keep their times');
    const cutPattern = sampleCut.patternId;
    const otherWayCut = cutPreview.body.otherWay && cutPreview.body.otherWay.coords ? cutPreview.body.otherWay.trips : 0;
    assert.equal(Object.keys(cut.body.idMap).length, tripsWere.length + otherWayCut, 'the other direction changes with it');
    assert.ok((await get(`/api/scenarios/${S}/lines`)).features.some((f) => f.properties.route_id === line.id), 'the new path is drawn on the map');
    step(`cut short: ${cut.body.summary}`);

    // Put the two stops back on the end: run times come from published trips, so the trip is as long as it was.
    const extended = await reshape({ patternId: cutPattern, stopIds: ids, bothWays: false });
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.ok(extended.body.summary.includes('2 stops added'));
    const sampleBack = await get(`/api/trips/${extended.body.idMap[sampleCut.id]}${q}`);
    inOrder(sampleBack);
    assert.equal(sampleBack.stopTimes.length, ids.length);
    assert.equal(sampleBack.startSecs, sampleWas.startSecs);
    const was = sampleWas.endSecs - sampleWas.startSecs;
    const now = sampleBack.endSecs - sampleBack.startSecs;
    assert.ok(Math.abs(now - was) <= was * 0.2 + 120, `an extended trip takes ${now}s, close to the published ${was}s`);
    assert.equal(sampleBack.stopTimes[ids.length - 3].pickupType, 0, 'the old last stop takes passengers again');
    step(`extended: ${extended.body.summary}`);

    // The moving dot follows the reshaped path.
    {
      const { decodePack, tripPosition } = await import('../../../packages/core/src/pack.ts');
      const mapPack = decodePack(await (await fetch(`${API}/api/scenarios/${S}/pack`)).arrayBuffer());
      const paths = (await get(`/api/scenarios/${S}/lines`)).features.filter((f) => f.properties.route_id === line.id).map((f) => f.geometry.coordinates);
      const off = (p, a, b) => {
        const k = 111320 * Math.cos((p[1] * Math.PI) / 180);
        const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * 110540, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * 110540;
        const dx = bx - ax, dy = by - ay;
        const f = dx * dx + dy * dy > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
        return Math.hypot(ax + f * dx, ay + f * dy);
      };
      const i = mapPack.tripId.indexOf(sampleBack.id);
      assert.ok(i >= 0, 'the reshaped trip is in the map data');
      let worst = 0;
      const out = new Float64Array(2);
      for (let k = 0; k <= 40; k++) {
        assert.ok(tripPosition(mapPack, i, mapPack.tripStart[i] + ((mapPack.tripEnd[i] - mapPack.tripStart[i]) * k) / 40, out, 0));
        worst = Math.max(worst, Math.min(...paths.map((c) => Math.min(...c.slice(1).map((pt, n) => off([out[0], out[1]], c[n], pt))))));
      }
      assert.ok(worst < 25, `a vehicle strayed ${worst.toFixed(0)} m from the reshaped path`);
      step(`vehicles follow the reshaped path (furthest ${worst.toFixed(0)} m off)`);
    }

    // Add a stop in the middle: one from the other direction, which is just across the road.
    const backPattern = (await get(`/api/routes/${line.id}${q}`)).patterns.find((p) => p.direction !== main.direction);
    const backStops = (await get(`/api/patterns/${backPattern.id}/stops`)).stops.filter((s) => !ids.includes(s.id));
    const mid = published[Math.floor(ids.length / 2)];
    const near = backStops.sort((a, b) => Math.hypot(a.lon - mid.lon, a.lat - mid.lat) - Math.hypot(b.lon - mid.lon, b.lat - mid.lat))[0];
    if (near) {
      const at = Math.floor(ids.length / 2) + 1;
      const withStop = [...ids.slice(0, at), near.id, ...ids.slice(at)];
      const added = await reshape({ patternId: sampleBack.patternId, stopIds: withStop, bothWays: false });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const sampleAdded = await get(`/api/trips/${added.body.idMap[sampleBack.id]}${q}`);
      inOrder(sampleAdded);
      assert.deepEqual(sampleAdded.stopTimes.map((s) => s.stopId), withStop);
      assert.deepEqual(sampleAdded.stopTimes.slice(0, at).map((s) => s.dep), sampleBack.stopTimes.slice(0, at).map((s) => s.dep), 'stops before the new one keep their times');
      assert.ok(sampleAdded.stopTimes[at].dep >= sampleAdded.stopTimes[at].arr && sampleAdded.stopTimes[at].arr > sampleAdded.stopTimes[at - 1].dep, 'the new stop has its own time');
      step(`stop added: ${added.body.summary}`);
    }

    // Undo it all: the published stop patterns and trips come back.
    const headNow = (await get(`/api/scenarios/${S}`)).head;
    for (let i = headBefore; i < headNow; i++) await send('POST', `/api/scenarios/${S}/undo`);
    const restored = await get(`/api/routes/${line.id}${q}`);
    assert.deepEqual(restored.patterns.map((p) => [p.id, p.tripCount]), line.patterns.map((p) => [p.id, p.tripCount]));
    assert.ok(!(await get(`/api/scenarios/${S}/lines`)).features.some((f) => f.properties.route_id === line.id), 'undo removes the reshaped path');
    for (let i = headBefore; i < headNow; i++) await send('POST', `/api/scenarios/${S}/redo`);
    assert.ok(!(await get(`/api/routes/${line.id}${q}`)).patterns.some((p) => p.id === main.id));
    step('undo restores the published line and redo reshapes it again');
  }

  // New stops: a bus stop with its partner across the road, used to extend a line; and a new station.
  {
    const edit = (body) => send('POST', `/api/scenarios/${S}/edits`, body);
    const newStops = async () => (await get(`/api/scenarios/${S}/stops`)).features;
    const metresApart = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);
    let line = null;
    for (const r of routes.filter((x) => x.modeId === 'bus' && x.tripCount > 40).slice(0, 40)) {
      const d = await get(`/api/routes/${r.id}${q}`);
      if (d.directions.length === 2 && d.patterns[0].stopCount >= 10) {
        line = d;
        break;
      }
    }
    const main = line.patterns[0];
    const stops = (await get(`/api/patterns/${main.id}/stops`)).stops;
    const end = stops[stops.length - 1];
    const before = stops[stops.length - 2];
    // A point a little beyond the last stop, carrying on the way the line was heading, so still by the road.
    const scale = 30 / Math.max(1, metresApart([before.lon, before.lat], [end.lon, end.lat]));
    const spot = { lon: end.lon + (end.lon - before.lon) * scale, lat: end.lat + (end.lat - before.lat) * scale };

    assert.equal((await edit({ kind: 'addStop', name: '  ', modeId: 'bus', ...spot })).status, 400, 'a stop needs a name');
    assert.equal((await edit({ kind: 'addStop', name: 'Nowhere', modeId: 'bus', lon: 0, lat: 0 })).status, 400, 'a stop must be in NSW');
    const added = await edit({ kind: 'addStop', name: 'E2E Road', modeId: 'bus', ...spot });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const stop = added.body.stops[0];
    assert.ok(stop.id && !stop.isStation && stop.name === 'E2E Road');
    let features = await newStops();
    const paired = features.length === 2;
    assert.ok(features.length === 1 || paired);
    assert.equal(added.body.summary.includes('across the road'), paired || added.body.summary.includes('no stop across the road'));
    const partner = features.find((f) => f.properties.stop_id !== stop.id);
    if (paired) {
      const gap = metresApart(partner.geometry.coordinates, [stop.lon, stop.lat]);
      assert.ok(gap > 4 && gap < 130, `the stop across the road is ${gap.toFixed(0)} m away`);
    }
    assert.equal((await get(`/api/scenarios?baseline=${baseline.id}`)).length > 0, true);
    step(`new stop: ${added.body.summary}`);

    // Extend the line to it. The way back starts from the stop across the road.
    const extended = await edit({ kind: 'reshape', patternId: main.id, stopIds: [...stops.map((s) => s.id), stop.id] });
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    const after = await get(`/api/routes/${line.id}${q}`);
    const out = after.patterns.find((p) => p.direction === main.direction && p.stopCount === stops.length + 1);
    assert.ok(out, 'the line now has one more stop');
    const outStops = (await get(`/api/patterns/${out.id}/stops`)).stops;
    assert.equal(outStops[outStops.length - 1].id, stop.id);
    if (extended.body.summary.includes('changed to match')) {
      const firstStops = await Promise.all(after.patterns.filter((p) => p.direction !== main.direction).map(async (p) => (await get(`/api/patterns/${p.id}/stops`)).stops[0].id));
      assert.ok(firstStops.includes(paired ? partner.properties.stop_id : stop.id), 'the way back starts from the new stop, across the road where there is one');
    }
    const trip = (await get(`/api/routes/${line.id}/trips${q}`)).find((t) => t.patternId === out.id);
    const calls = (await get(`/api/trips/${trip.id}${q}`)).stopTimes;
    assert.equal(calls[calls.length - 1].stopId, stop.id);
    assert.ok(calls[calls.length - 1].arr > calls[calls.length - 2].dep && calls[calls.length - 1].dist > calls[calls.length - 2].dist);
    step(`line extended to the new stop: ${extended.body.summary}`);

    // Undo both: the stop disappears; redo brings it back. The published timetable never sees it.
    await send('POST', `/api/scenarios/${S}/undo`);
    await send('POST', `/api/scenarios/${S}/undo`);
    assert.equal((await newStops()).length, 0, 'undo removes the new stop');
    await send('POST', `/api/scenarios/${S}/redo`);
    await send('POST', `/api/scenarios/${S}/redo`);
    assert.equal((await newStops()).length, features.length);
    assert.equal((await send('POST', '/api/reshape-preview', { patternId: main.id, stopIds: [...stops.map((s) => s.id), stop.id] })).status, 400, 'the published timetable cannot use a scenario\'s stop');
    step('undo removes the new stop and redo brings it back');

    // A new station with two platforms, and a new train line that runs to it.
    const t1Trip = await get(`/api/trips/${baseTrips[0].id}`);
    const from = t1Trip.stopTimes[0];
    const station = await edit({ kind: 'addStop', name: 'E2E Junction', modeId: 'train', lon: from.lon + 0.02, lat: from.lat + 0.01, platforms: 2 });
    assert.equal(station.status, 200, JSON.stringify(station.body));
    assert.equal(station.body.stops[0].name, 'E2E Junction Station');
    assert.equal(station.body.stops[0].isStation, true);
    features = await newStops();
    const platforms = features.filter((f) => f.properties.platform).map((f) => f.properties.stop_id);
    assert.equal(platforms.length, 2);
    assert.equal((await get(`/api/stations/${station.body.stops[0].id}/platforms${q}`)).platforms.length, 2);
    const shuttle = await edit({ kind: 'createLine', name: 'E2E', modeId: 'train', stopIds: [from.stopId, station.body.stops[0].id], headwaySecs: 1800 });
    assert.equal(shuttle.status, 200, JSON.stringify(shuttle.body));
    const shuttleTrips = await get(`/api/routes/${shuttle.body.routeId}/trips${q}`);
    const ends = new Set();
    for (const direction of [0, 1]) {
      const t = await get(`/api/trips/${shuttleTrips.find((x) => x.direction === direction).id}${q}`);
      ends.add(direction === 0 ? t.stopTimes[t.stopTimes.length - 1].stopId : t.stopTimes[0].stopId);
    }
    assert.ok([...ends].every((id) => platforms.includes(id)), 'trains call at the new station\'s platforms');
    assert.equal(ends.size, 2, 'a different platform each way');
    step(`new station: ${station.body.summary}; ${shuttleTrips.length} trips run to it`);
  }

  // One-way loops, paths that follow track and water, and closures.
  {
    const edit = (body) => send('POST', `/api/scenarios/${S}/edits`, body);
    const headOf = async () => (await get(`/api/scenarios/${S}`)).head;
    const undoTo = async (head) => {
      for (let h = await headOf(); h > head; h--) await send('POST', `/api/scenarios/${S}/undo`);
    };
    const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110540);
    const lengthOf = (coords) => coords.slice(1).reduce((sum, c, i) => sum + metres(coords[i], c), 0);
    const toPath = (p, coords) => {
      const k = 111320 * Math.cos((p[1] * Math.PI) / 180);
      let best = Infinity;
      for (let i = 1; i < coords.length; i++) {
        const ax = (coords[i - 1][0] - p[0]) * k, ay = (coords[i - 1][1] - p[1]) * 110540;
        const dx = (coords[i][0] - p[0]) * k - ax, dy = (coords[i][1] - p[1]) * 110540 - ay;
        const f = dx * dx + dy * dy > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
        best = Math.min(best, Math.hypot(ax + f * dx, ay + f * dy));
      }
      return best;
    };
    const busLine = await (async () => {
      for (const r of routes.filter((x) => x.modeId === 'bus' && x.tripCount > 40).slice(0, 40)) {
        const d = await get(`/api/routes/${r.id}${q}`);
        if (d.directions.length === 2 && d.patterns[0].stopCount >= 14) return d;
      }
      throw new Error('no bus line long enough');
    })();
    const busStops = (await get(`/api/patterns/${busLine.patterns[0].id}/stops`)).stops;

    // A one-way loop: one direction only, ending where it began.
    const third = Math.floor(busStops.length / 3);
    const ring = [busStops[0].id, busStops[third].id, busStops[2 * third].id];
    assert.equal((await edit({ kind: 'createLine', name: 'LP', modeId: 'bus', stopIds: ring.slice(0, 2), headwaySecs: 1200, loop: true })).status, 400, 'a loop needs three stops');
    const loop = await edit({ kind: 'createLine', name: 'LP', modeId: 'bus', stopIds: ring, headwaySecs: 1200, loop: true });
    assert.equal(loop.status, 200, JSON.stringify(loop.body));
    const loopRoute = await get(`/api/routes/${loop.body.routeId}${q}`);
    assert.equal(loopRoute.directions.length, 1, 'a loop runs one way only');
    assert.equal(loopRoute.tripCount, 48, 'every 20 minutes from 06:00 to 22:00, one way');
    const loopTrips = await get(`/api/routes/${loop.body.routeId}/trips${q}`);
    const loopTrip = await get(`/api/trips/${loopTrips[0].id}${q}`);
    assert.deepEqual(loopTrip.stopTimes.map((s) => s.stopId), [...ring, ring[0]], 'it comes back to its first stop');
    for (let i = 1; i < loopTrip.stopTimes.length; i++) {
      assert.ok(loopTrip.stopTimes[i].arr > loopTrip.stopTimes[i - 1].dep && loopTrip.stopTimes[i].dist > loopTrip.stopTimes[i - 1].dist, 'times and distances run forwards round the loop');
    }
    assert.equal((await get(`/api/scenarios/${S}/lines`)).features.filter((f) => f.properties.route_id === loop.body.routeId).length, 1);
    assert.ok(loopRoute.vehicleDays < 48 / 2, 'a bus that finishes a lap starts the next one');
    step(`loop: ${loop.body.summary}`);

    // A new train line between two stations a long way apart follows the track between them.
    const t1Stops = (await get(`/api/patterns/${[...before.patterns].sort((a, b) => b.stopCount - a.stopCount)[0].id}/stops`)).stops;
    const far = [t1Stops[1], t1Stops[t1Stops.length - 2]];
    const crow = metres([far[0].lon, far[0].lat], [far[1].lon, far[1].lat]);
    const rail = await edit({ kind: 'createLine', name: 'TRK', modeId: 'train', stopIds: far.map((s) => s.parentId ?? s.id), headwaySecs: 1800 });
    assert.equal(rail.status, 200, JSON.stringify(rail.body));
    assert.ok(rail.body.summary.includes('following existing track'), rail.body.summary);
    const railPaths = (await get(`/api/scenarios/${S}/lines`)).features.filter((f) => f.properties.route_id === rail.body.routeId).map((f) => f.geometry.coordinates);
    assert.equal(railPaths.length, 2);
    for (const path of railPaths) {
      assert.ok(path.length > 50 && lengthOf(path) >= crow * 0.98, 'the path has the shape of the track, not a straight line');
      for (const s of t1Stops.slice(2, -2).filter((_, i) => i % 4 === 0)) {
        assert.ok(toPath([s.lon, s.lat], path) < 400, `the path passes ${s.name}, which is on the track between the two ends`);
      }
    }
    const railTrip = await get(`/api/trips/${(await get(`/api/routes/${rail.body.routeId}/trips${q}`))[0].id}${q}`);
    assert.ok(Math.abs(railTrip.stopTimes[1].dist - lengthOf(railPaths[0])) < lengthOf(railPaths[0]) * 0.05, 'the last stop is at the end of the path');
    const straightLine = await send('POST', '/api/road-path', { baselineId: baseline.id, modeId: 'train', stopIds: far.map((s) => s.parentId ?? s.id) });
    assert.equal(straightLine.body.method, 'track');
    const ferry = routes.filter((r) => r.modeId === 'ferry').sort((a, b) => b.tripCount - a.tripCount)[0];
    if (ferry) {
      const wharves = (await get(`/api/patterns/${(await get(`/api/routes/${ferry.id}`)).patterns[0].id}/stops`)).stops;
      const water = await send('POST', '/api/road-path', { baselineId: baseline.id, modeId: 'ferry', stopIds: [wharves[0], wharves[wharves.length - 1]].map((s) => s.parentId ?? s.id) });
      assert.equal(water.status, 200);
      assert.equal(water.body.method, 'water');
      assert.ok(water.body.coords.length > 10, 'a ferry line follows the published ferry routes');
    }
    step(`track: ${rail.body.summary}`);

    // Cut a train line between two neighbouring stations: nothing runs across the gap any more.
    const headBeforeCut = await headOf();
    const statsBefore = (await get(`/api/scenarios/${S}`)).stats;
    const mid = Math.floor(t1Stops.length / 2);
    const [sideA, sideB] = [t1Stops[mid], t1Stops[mid + 1]];
    const cutBody = { what: 'train', fromStopId: sideA.id, toStopId: sideB.id };
    assert.equal((await send('POST', `/api/close-preview${q}`, { what: 'train', fromStopId: sideA.id, toStopId: sideA.id })).status, 400, 'a closure needs two different stations');
    const cutPreview = await send('POST', `/api/close-preview${q}`, cutBody);
    assert.equal(cutPreview.status, 200, JSON.stringify(cutPreview.body));
    assert.ok(cutPreview.body.lines.some((l) => l.routeId === t1.id), 'the line through the closure is listed');
    assert.ok(cutPreview.body.trips.split > 0);
    assert.equal(await headOf(), headBeforeCut, 'a preview changes nothing');
    const cut = await edit({ kind: 'close', ...cutBody });
    assert.equal(cut.status, 200, JSON.stringify(cut.body));
    const stationsOf = (stops) => new Set(stops.map((s) => s.parentId ?? s.id));
    const [stationA, stationB] = [sideA.parentId ?? sideA.id, sideB.parentId ?? sideB.id];
    const afterCut = await get(`/api/routes/${t1.id}${q}`);
    for (const p of afterCut.patterns) {
      const stations = stationsOf((await get(`/api/patterns/${p.id}/stops`)).stops);
      assert.ok(!(stations.has(stationA) && stations.has(stationB)), `no stop pattern of ${t1.shortName} crosses the closure`);
    }
    const t1Preview = cutPreview.body.lines.find((l) => l.routeId === t1.id);
    assert.ok(afterCut.tripCount > withBefore.tripCount - t1Preview.trips, 'trips either side of the closure still run');
    const cutInfo = await get(`/api/scenarios/${S}`);
    assert.equal(cutInfo.stats.unassigned, 0, 'every part of a split trip has a vehicle');
    assert.equal((await get(`/api/scenarios/${S}/closures`)).features.length, 1, 'the closure is drawn on the map');
    const parts = await get(`/api/routes/${t1.id}/trips${q}`);
    const day = await get(`/api/vehicle-days/${parts.find((t) => t.edited && t.vehicleDayId).vehicleDayId}${q}`);
    for (let i = 1; i < day.trips.length; i++) assert.ok(day.trips[i].startSecs >= day.trips[i - 1].endSecs, 'a vehicle cannot run two trips at once');
    step(`line cut: ${cut.body.summary}`);
    await undoTo(headBeforeCut);
    assert.equal((await get(`/api/scenarios/${S}/closures`)).features.length, 0, 'undo reopens the line');
    assert.equal((await get(`/api/scenarios/${S}`)).stats.trips, statsBefore.trips);
    step('undo reopens the line');

    // The same cut for part of the day: only trips in the closed stretch between 10:00 and 14:00 change.
    const partBody = { ...cutBody, fromSecs: 10 * 3600, toSecs: 14 * 3600 };
    assert.equal((await send('POST', `/api/close-preview${q}`, { ...cutBody, fromSecs: 14 * 3600, toSecs: 10 * 3600 })).status, 400, 'a closure must end after it starts');
    const partPreview = await send('POST', `/api/close-preview${q}`, partBody);
    assert.equal(partPreview.status, 200, JSON.stringify(partPreview.body));
    assert.match(partPreview.body.label, /10:00 to 14:00$/);
    assert.ok(partPreview.body.trips.split > 0 && partPreview.body.trips.split < cutPreview.body.trips.split, 'fewer trips are caught than by an all-day closure');
    const t1Before = await get(`/api/routes/${t1.id}${q}`);
    const partCut = await edit({ kind: 'close', ...partBody });
    assert.equal(partCut.status, 200, JSON.stringify(partCut.body));
    const t1Part = await get(`/api/routes/${t1.id}${q}`);
    const t1Caught = partPreview.body.lines.find((l) => l.routeId === t1.id);
    assert.ok(t1Part.tripCount > t1Before.tripCount && t1Part.tripCount <= t1Before.tripCount + t1Caught.trips, 'each caught trip now runs in two parts');
    // Trips that cross the closed stretch still run, but none of them is in it while it is closed.
    let crossing = 0;
    const sides = new Map();
    for (const trip of await get(`/api/routes/${t1.id}/trips${q}`)) {
      if (trip.startSecs > 15 * 3600 || trip.endSecs < 9 * 3600) continue;
      if (!sides.has(trip.patternId)) {
        const stations = (await get(`/api/patterns/${trip.patternId}/stops`)).stops.map((s) => s.parentId ?? s.id);
        sides.set(trip.patternId, [stations.indexOf(stationA), stations.indexOf(stationB)]);
      }
      const [a, b] = sides.get(trip.patternId);
      if (a < 0 || b < 0) continue;
      const calls = (await get(`/api/trips/${trip.id}${q}`)).stopTimes;
      crossing++;
      const [first, second] = a < b ? [calls[a], calls[b]] : [calls[b], calls[a]];
      assert.ok(first.dep >= 14 * 3600 || second.arr <= 10 * 3600, `trip ${trip.id} is in the closed stretch while it is closed`);
    }
    assert.ok(crossing > 0, 'trips outside the closed hours still cross');
    const [drawn] = (await get(`/api/scenarios/${S}/closures`)).features;
    assert.equal(drawn.properties.fromSecs, 10 * 3600);
    assert.equal((await get(`/api/scenarios/${S}`)).stats.unassigned, 0, 'every part of a split trip has a vehicle');
    step(`line cut for part of the day: ${partCut.body.summary}`);
    await undoTo(headBeforeCut);
    assert.equal((await get(`/api/scenarios/${S}`)).stats.trips, statsBefore.trips);

    // Close a road in the middle of a bus line: buses go round and miss the stops inside.
    const headBeforeRoad = await headOf();
    const shut = busStops[Math.floor(busStops.length / 2)];
    const roadBody = { what: 'road', lon: shut.lon, lat: shut.lat, radiusM: 50 };
    assert.equal((await send('POST', `/api/close-preview${q}`, { what: 'road', lon: 0, lat: 0 })).status, 400);
    const roadPreview = await send('POST', `/api/close-preview${q}`, roadBody);
    assert.equal(roadPreview.status, 200, JSON.stringify(roadPreview.body));
    assert.ok(roadPreview.body.lines.some((l) => l.routeId === busLine.id), 'the bus line through the closure is listed');
    if (roadPreview.body.trips.detour === 0) {
      step('road closure: no routing server answered, so no way round could be found (skipped)');
    } else {
      assert.ok(roadPreview.body.paths.length > 0);
      const road = await edit({ kind: 'close', ...roadBody });
      assert.equal(road.status, 200, JSON.stringify(road.body));
      const afterRoad = await get(`/api/routes/${busLine.id}${q}`);
      assert.equal(afterRoad.tripCount, busLine.tripCount, 'a detour keeps every trip');
      // A stop pattern is left alone, and reported, when the routing server finds no way round for it.
      const allRound = !road.body.summary.includes('no way round was found');
      let stillCalling = 0;
      for (const p of afterRoad.patterns) {
        const stops = (await get(`/api/patterns/${p.id}/stops`)).stops;
        if (stops.some((s) => s.id === shut.id)) stillCalling++;
      }
      if (allRound) assert.equal(stillCalling, 0, `no stop pattern calls at the closed stop: ${road.body.summary}`);
      else assert.ok(stillCalling < afterRoad.patterns.length, road.body.summary);
      const newPaths = (await get(`/api/scenarios/${S}/lines`)).features.filter((f) => f.properties.route_id === busLine.id).map((f) => f.geometry.coordinates);
      assert.ok(newPaths.length > 0);
      const inside = newPaths.filter((path) => toPath([shut.lon, shut.lat], path) <= 49).length;
      if (allRound) assert.equal(inside, 0, `every new path stays out of the closed stretch: ${road.body.summary}`);
      else assert.ok(inside < newPaths.length, road.body.summary);
      const moved = (await get(`/api/routes/${busLine.id}/trips${q}`)).find((t) => t.edited);
      const movedTrip = await get(`/api/trips/${moved.id}${q}`);
      for (let i = 1; i < movedTrip.stopTimes.length; i++) {
        assert.ok(movedTrip.stopTimes[i].arr >= movedTrip.stopTimes[i - 1].dep && movedTrip.stopTimes[i].dist >= movedTrip.stopTimes[i - 1].dist, 'times and distances stay in order');
      }
      assert.ok(moved.vehicleDayId, 'a detoured trip keeps its vehicle');
      step(`road closed: ${road.body.summary}`);
      await undoTo(headBeforeRoad);
      assert.deepEqual((await get(`/api/routes/${busLine.id}${q}`)).patterns.map((p) => p.id), busLine.patterns.map((p) => p.id), 'undo reopens the road');
    }
  }

  // Schedule edits: a trip added to a line, vehicles worked out again, a stop added to one trip, platforms.
  {
    const edit = (body) => send('POST', `/api/scenarios/${S}/edits`, body);
    const line = routes.find((r) => r.modeId === 'bus' && r.tripCount > 60 && r.id !== someBus.id);
    const lineBefore = await get(`/api/routes/${line.id}${q}`);
    const addedTrip = await edit({ kind: 'addTrip', routeId: line.id, direction: 0, startSecs: 12 * 3600 + 420 });
    assert.equal(addedTrip.status, 200, JSON.stringify(addedTrip.body));
    const fresh = await get(`/api/trips/${addedTrip.body.focusTripId}${q}`);
    assert.equal(fresh.startSecs, 12 * 3600 + 420);
    assert.ok(fresh.vehicleDayId, 'the added trip has a vehicle');
    assert.equal((await get(`/api/routes/${line.id}${q}`)).tripCount, lineBefore.tripCount + 1);
    step(`trip added: ${addedTrip.body.summary}`);

    // Doubling the frequency adds vehicles one trip at a time; working them out again should need no more.
    const freq = await edit({ kind: 'lineFrequency', routeId: line.id, bands: [{ fromSecs: 9 * 3600, toSecs: 12 * 3600, headwaySecs: 600 }] });
    assert.equal(freq.status, 200, JSON.stringify(freq.body));
    const piecemeal = (await get(`/api/routes/${line.id}${q}`)).vehicleDays;
    const replanned = await edit({ kind: 'replan', routeId: line.id });
    assert.equal(replanned.status, 200, JSON.stringify(replanned.body));
    const planned = await get(`/api/routes/${line.id}${q}`);
    const plannedTrips = await get(`/api/routes/${line.id}/trips${q}`);
    assert.ok(plannedTrips.every((t) => t.vehicleDayId), 'every trip has a vehicle after re-planning');
    assert.ok(planned.vehicleDays <= piecemeal, `re-planning should not need more vehicles (${planned.vehicleDays} against ${piecemeal})`);
    assert.ok(!(await get(`/api/scenarios/${S}`)).conflicts.some((c) => c.kind === 'vehicle' && plannedTrips.some((t) => t.id === c.tripId)), 'no vehicle is in two places');
    step(`vehicles re-planned: ${replanned.body.summary}`);

    // Move a trip onto another vehicle of the line.
    const mover = plannedTrips[0];
    const target = plannedTrips.find((t) => t.vehicleDayId !== mover.vehicleDayId);
    const movedTrip = await edit({ kind: 'moveToVehicle', tripId: mover.id, vehicleDayId: target.vehicleDayId });
    assert.equal(movedTrip.status, 200, JSON.stringify(movedTrip.body));
    assert.equal((await get(`/api/trips/${movedTrip.body.focusTripId}${q}`)).vehicleDayId, target.vehicleDayId);
    step(`trip moved between vehicles: ${movedTrip.body.summary}`);

    // A stop the trip runs through can be put back, and a stop beside the path can be added.
    const subject = plannedTrips[Math.floor(plannedTrips.length / 2)];
    const subjectStops = (await get(`/api/trips/${subject.id}${q}`)).stopTimes;
    const mid = subjectStops[Math.floor(subjectStops.length / 2)];
    const skipped = await edit({ kind: 'skipStop', tripId: subject.id, stopSeq: mid.seq, scope: 'trip' });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    const skippedId = skipped.body.focusTripId;
    const options = await get(`/api/trips/${skippedId}/addable-stops${q}`);
    assert.ok(options.some((o) => o.stopId === mid.stopId && o.restore), 'the skipped stop is offered again');
    const restored = await edit({ kind: 'addCall', tripId: skippedId, stopId: mid.stopId });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const back = await get(`/api/trips/${restored.body.focusTripId}${q}`);
    const again = back.stopTimes.find((x) => x.stopId === mid.stopId);
    assert.ok(again.pickupType === 0 && again.dropOffType === 0, 'the trip stops there again');
    assert.equal(back.stopTimes.length, subjectStops.length);
    step(`stop restored: ${restored.body.summary}`);

    // Take a stop out of the whole pattern by reshaping is another tool; here find a trip with a stop beside its path.
    let inserted = null;
    for (const r of routes.filter((x) => x.modeId === 'bus' && x.tripCount > 20).slice(0, 25)) {
      const trip = (await get(`/api/routes/${r.id}/trips${q}`))[0];
      if (!trip) continue;
      const extra = (await get(`/api/trips/${trip.id}/addable-stops${q}`)).find((o) => !o.restore);
      if (!extra) continue;
      const beforeStops = (await get(`/api/trips/${trip.id}${q}`)).stopTimes;
      const done = await edit({ kind: 'addCall', tripId: trip.id, stopId: extra.stopId });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const now = await get(`/api/trips/${done.body.focusTripId}${q}`);
      assert.equal(now.stopTimes.length, beforeStops.length + 1);
      for (let i = 1; i < now.stopTimes.length; i++) {
        assert.ok(now.stopTimes[i].arr >= now.stopTimes[i - 1].dep, 'times run forwards through the new stop');
        assert.ok(now.stopTimes[i].dist >= now.stopTimes[i - 1].dist, 'stops stay in order along the path');
      }
      assert.ok(now.endSecs >= beforeStops[beforeStops.length - 1].arr, 'the trip is no shorter');
      assert.notEqual(now.patternId, trip.patternId ?? -1, 'the trip has a stop pattern of its own');
      inserted = done.body.summary;
      break;
    }
    step(inserted ? `stop added to one trip: ${inserted}` : 'no bus trip with a spare stop beside its path was found (skipped)');

    // Whole-line frequency on a line with several stop patterns: the new departures are shared between them.
    {
      let branching = null;
      for (const r of routes.filter((x) => x.modeId === 'bus' && x.tripCount > 80 && x.id !== line.id && x.id !== someBus.id).slice(0, 60)) {
        const trips = await get(`/api/routes/${r.id}/trips${q}`);
        if (trips.some((t) => t.edited)) continue;
        const inBand = trips.filter((t) => t.direction === 0 && t.startSecs >= 9 * 3600 && t.startSecs < 15 * 3600);
        if (new Set(inBand.map((t) => t.patternId)).size >= 2) {
          branching = { route: r, patterns: new Set(inBand.map((t) => t.patternId)).size };
          break;
        }
      }
      if (!branching) step('no branching bus line found for the shared frequency check (skipped)');
      else {
        const shared = await edit({ kind: 'lineFrequency', routeId: branching.route.id, allPatterns: true, bands: [{ fromSecs: 9 * 3600, toSecs: 15 * 3600, headwaySecs: 900 }] });
        assert.equal(shared.status, 200, JSON.stringify(shared.body));
        const now = (await get(`/api/routes/${branching.route.id}/trips${q}`)).filter((t) => t.direction === 0 && t.startSecs >= 9 * 3600 && t.startSecs < 15 * 3600);
        assert.equal(now.length, 24, 'every 15 minutes for six hours, whatever the pattern');
        assert.ok(new Set(now.map((t) => t.patternId)).size >= 2, 'more than one stop pattern still runs');
        const starts = now.map((t) => t.startSecs).sort((a, b) => a - b);
        assert.ok(starts.every((x, i) => i === 0 || x - starts[i - 1] === 900), 'departures are evenly spaced across the patterns: ' + starts.map((x) => x / 60).join(' ') + ' | ' + shared.body.summary);
        step(`shared frequency: ${shared.body.summary}`);
      }
    }

    // Platforms: a trip can be moved to another platform at the same station.
    const train = (await get(`/api/routes/${t1.id}/trips${q}`)).find((t) => !t.edited);
    const trainStops = (await get(`/api/trips/${train.id}${q}`)).stopTimes;
    let platformDone = false;
    for (const call of trainStops) {
      const choices = await get(`/api/trips/${train.id}/platforms${q}&seq=${call.seq}`);
      assert.ok(choices.length === 0 || choices.some((c) => c.current), 'the platform in use is among the choices');
      const freeOne = choices.find((c) => c.free && !c.current);
      if (!freeOne) continue;
      const moved = await edit({ kind: 'setPlatform', tripId: train.id, stopSeq: call.seq, stopId: freeOne.id });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      const now = await get(`/api/trips/${moved.body.focusTripId}${q}`);
      assert.equal(now.stopTimes.find((x) => x.seq === call.seq).stopId, freeOne.id);
      assert.equal(now.startSecs, train.startSecs, 'changing platform does not move the trip');
      step(`platform changed: ${moved.body.summary}`);
      platformDone = true;
      break;
    }
    assert.ok(platformDone, 'some station on T1 has a free platform');

    // A copy one minute behind a train lands on its platforms; where the line has another free one it is used,
    // and what is left is reported with a free platform offered as a fix.
    const crowd = await edit({ kind: 'duplicate', tripId: train.id, startSecs: train.startSecs + 60 });
    assert.equal(crowd.status, 200, JSON.stringify(crowd.body));
    const clashes = (await get(`/api/scenarios/${S}`)).conflicts.filter((c) => c.kind === 'platform');
    const offered = clashes.filter((c) => c.fixes.some((x) => x.edit.kind === 'setPlatform')).length;
    step(`copy one minute behind: ${crowd.body.summary}; ${clashes.length} platform clashes left, ${offered} with a free platform offered`);
    await send('POST', `/api/scenarios/${S}/undo`);
  }

  // Vehicle types: put one trip on a bigger train, then set a fleet size the scenario exceeds.
  const types = await get(`/api/vehicle-types?baseline=${baseline.id}&s=${S}`);
  const tripNow = (await get(`/api/routes/${t1.id}/trips${q}`)).find((t) => !t.edited);
  const detailNow = await get(`/api/trips/${tripNow.id}${q}`);
  const other = types.find((t) => t.modeId === 'train' && t.id !== detailNow.vehicleTypeId && t.seated + t.standing !== detailNow.seated + detailNow.standing);
  const retyped = await send('POST', `/api/scenarios/${S}/edits`, { kind: 'setVehicleType', scope: 'trip', id: tripNow.id, vehicleTypeId: other.id });
  assert.equal(retyped.status, 200, JSON.stringify(retyped.body));
  const after2 = await get(`/api/trips/${retyped.body.focusTripId}${q}`);
  assert.equal(after2.vehicleTypeId, other.id);
  assert.equal(after2.seated + after2.standing, other.seated + other.standing);
  assert.equal(after2.startSecs, detailNow.startSecs, 'changing the vehicle type does not move the trip');
  const lineNow = (await get(`/api/scenarios/${S}`)).impact.find((i) => i.routeId === t1.id);
  assert.notEqual(lineNow.placesAfter, lineNow.placesBefore);
  step(`vehicle type: ${retyped.body.summary}`);

  const busy = types.filter((t) => t.vehicles > 1).sort((a, b) => a.vehicles - b.vehicles)[0];
  const original = busy.fleetSize;
  try {
    assert.equal((await send('PATCH', `/api/vehicle-types/${busy.id}`, { fleetSize: busy.vehicles - 1 })).status, 200);
    const short = (await get(`/api/scenarios/${S}`)).fleet.find((f) => f.id === busy.id);
    assert.ok(short && short.inUse > short.fleetSize, 'a fleet smaller than the vehicles in use is flagged');
    step(`fleet limit: ${busy.name} needs ${short.inUse}, fleet has ${short.fleetSize}`);
  } finally {
    await send('PATCH', `/api/vehicle-types/${busy.id}`, { fleetSize: original });
  }
  assert.ok(!(await get(`/api/scenarios/${S}`)).fleet.some((f) => f.id === busy.id));

  // The map's data for the scenario.
  const removed = await get(`/api/scenarios/${S}/removed`);
  assert.ok(removed.includes(victim.id));
  const pack = await fetch(`${API}/api/scenarios/${S}/pack`);
  assert.equal(pack.status, 200);
  assert.ok((await pack.arrayBuffer()).byteLength > 1000);
  step('map data for the scenario');

  // The timeline views accept the scenario.
  await get(`/api/patterns/${pattern.id}/stringline${q}&others=0`);
  await get(`/api/routes/${t1.id}/vehicles${q}`);
  step('timeline queries');
} finally {
  await send('DELETE', `/api/scenarios/${S}`);
}
const leftovers = (await get(`/api/scenarios?baseline=${baseline.id}`)).filter((s) => s.name === 'e2e test');
assert.equal(leftovers.length, 0);
assert.equal((await get(`/api/routes/${t1.id}`)).tripCount, before.tripCount, 'the baseline is unchanged after the test');
console.log('all scenario checks passed');
