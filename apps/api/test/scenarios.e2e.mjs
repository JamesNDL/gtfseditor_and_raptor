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
  assert.ok(oneNew.stopTimes[2].arr > oneNew.stopTimes[1].dep && oneNew.stopTimes[1].dep > oneNew.stopTimes[1].arr);
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
