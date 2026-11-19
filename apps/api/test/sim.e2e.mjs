// End-to-end check of the simulator through the editor's API (docs/simulator-plan.md, phase S3).
// Usage: npm run test:sim
// Needs the API on :3001 (`npm run dev`), the journey router on :3002 (`npm run router:dev`), the
// database, and an imported day. It makes its own journeys, runs, scenario, folder and area, and
// removes them again. It takes a minute or two: the router has to load two timetables.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

const API = process.env.API ?? 'http://localhost:3001';
const call = async (method, path, body, headers) => {
  const res = await fetch(API + path, {
    method,
    headers: headers ?? (body ? { 'content-type': 'application/json' } : {}),
    body: body === undefined ? undefined : headers ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: a file
  }
  return { status: res.status, body: parsed };
};
const get = async (path) => {
  const res = await call('GET', path);
  assert.equal(res.status, 200, `${path} responded ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
};
const ok = async (method, path, body, headers) => {
  const res = await call(method, path, body, headers);
  assert.equal(res.status, 200, `${method} ${path} responded ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
};
const step = (name) => console.log(`ok  ${name}`);
const ended = async (id, minutes = 6) => {
  for (let i = 0; i < minutes * 60; i++) {
    const run = await get(`/api/sim-runs/${id}`);
    if (!['queued', 'preparing', 'running', 'importing'].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`run ${id} had not ended after ${minutes} minutes`);
};
const done = async (id) => {
  const run = await ended(id);
  assert.equal(run.state, 'done', `run ${id}: ${run.error}`);
  return run;
};

const status = await get('/api/sim/status');
assert.equal(status.router, true, status.message);
const [baseline] = await get('/api/baselines');
const B = baseline.id;
const made = { runs: [], demand: [], folders: [], areas: [], scenarios: [] };

try {
  // ---- areas and folders ----------------------------------------------------
  const areas = await get('/api/sim-areas');
  const newcastle = areas.find((a) => a.name.startsWith('Newcastle'));
  assert.ok(newcastle && areas.filter((a) => a.provided).length === 4, 'the four areas the editor comes with');
  assert.equal((await call('DELETE', `/api/sim-areas/${newcastle.id}`)).status, 400, 'a provided area cannot be removed');
  const area = await ok('POST', '/api/sim-areas', { name: `e2e box ${Date.now()}`, south: -33.0, west: 151.6, north: -32.85, east: 151.82 });
  made.areas.push(area.id);
  assert.equal((await call('POST', '/api/sim-areas', { name: 'bad', south: 1, west: 1, north: 0, east: 2 })).status, 400);
  const folder = await ok('POST', '/api/sim-folders', { name: 'e2e Newcastle' });
  const inner = await ok('POST', '/api/sim-folders', { name: 'e2e inner', parentId: folder.id });
  made.folders.push(inner.id, folder.id);
  assert.equal((await call('PATCH', `/api/sim-folders/${folder.id}`, { parentId: inner.id })).status, 400, 'a folder cannot go inside itself');
  assert.equal((await call('DELETE', `/api/sim-folders/${folder.id}`)).status, 409, 'only an empty folder can be removed');
  step('areas and folders');

  // ---- demand: made up by the router, and uploaded --------------------------
  const madeUp = await ok('POST', '/api/demand/generate', { name: 'e2e made up', baselineId: B, journeys: 3000, seed: 7, areaId: newcastle.id, madeBy: 'e2e' });
  made.demand.push(madeUp.id);
  assert.equal(madeUp.state, 'generating');
  let demand;
  for (let i = 0; i < 600; i++) {
    demand = await get(`/api/demand/${madeUp.id}?baseline=${B}`);
    if (demand.state !== 'generating') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(demand.state, 'ready', demand.error);
  assert.equal(demand.rows, 3000);
  assert.equal(demand.madeUp, true);
  assert.equal(demand.unknownStops.stops, 0, 'made-up journeys use stops the published timetable has');
  assert.ok(demand.report.busiestHourPeople > 0 && demand.users > 1000);
  // Made-up journeys carry positions of their own, and those are what an area is checked against.
  const box = (a) => `south=${a.south}&west=${a.west}&north=${a.north}&east=${a.east}`;
  const inside = await get(`/api/demand/${madeUp.id}/coverage?baseline=${B}&${box(newcastle)}`);
  assert.equal(inside.journeyEnds, 6000);
  assert.equal(inside.endsInside, 6000, 'journeys made up for an area lie inside it');
  const elsewhere = await get(`/api/demand/${madeUp.id}/coverage?baseline=${B}&${box(areas.find((a) => a.name === 'Sydney'))}`);
  assert.equal(elsewhere.endsInside, 0, 'and outside an area somewhere else');
  step(`made-up demand: ${demand.rows} journeys by ${demand.users} users (the router loaded the published timetable)`);

  // Upload: the made-up set again with a row that cannot be read, a stop that does not exist, and
  // one row standing for 40 people.
  const original = await (await fetch(`${API}/api/demand/${madeUp.id}/download/x.csv.gz`)).arrayBuffer();
  const { gunzipSync } = await import('node:zlib');
  const lines = gunzipSync(Buffer.from(original)).toString('utf8').trimEnd().split('\n');
  const first = lines[1].split(',');
  const csv = [lines[0], ...lines.slice(1, 1501),
    'e2e-bad,not a time,A,B,,,,,,',
    `e2e-unknown,08:00:00,NO-SUCH-STOP,${first[3]},,,,,,`,
    `e2e-crowd,08:00:00,${first[2]},${first[3]},,,,,e2e-crowd,40`].join('\n') + '\n';
  const uploaded = await ok('POST', `/api/demand?name=${encodeURIComponent('e2e uploaded')}&madeBy=e2e`, gzipSync(csv), { 'content-type': 'application/gzip' });
  made.demand.push(uploaded.id);
  assert.equal(uploaded.state, 'ready');
  assert.equal(uploaded.report.rowsRead, 1503);
  assert.equal(uploaded.report.rowsRefused, 1);
  assert.equal(uploaded.rows, 1502);
  assert.equal(uploaded.people, 1541);
  const checked = await get(`/api/demand/${uploaded.id}?baseline=${B}`);
  assert.deepEqual(checked.unknownStops, { stops: 1, journeyEnds: 1, examples: ['NO-SUCH-STOP'] });
  assert.equal((await call('POST', '/api/demand?name=x', 'user_id,start_time\nu,08:00\n', { 'content-type': 'text/csv' })).status, 400,
    'a file without the needed columns is refused');
  assert.equal((await get('/api/demand')).filter((d) => d.name === 'x').length, 0, 'and nothing of it is kept');
  step('uploaded demand is checked: one row refused, one stop id the timetable does not have');

  // ---- a BAU run, bounded to Newcastle ---------------------------------------
  assert.equal((await call('POST', '/api/sim-runs', { baselineId: B, demandSetId: uploaded.id, settings: { giveUpSecs: 600 } })).status, 400,
    'a BAU run cannot be given a scenario setting');
  let bau = await ok('POST', '/api/sim-runs', { baselineId: B, demandSetId: uploaded.id, areaId: newcastle.id, folderId: folder.id, madeBy: 'e2e' });
  made.runs.push(bau.id);
  assert.equal(bau.kind, 'bau');
  assert.equal(bau.name, 'BAU bounded Newcastle and the Hunter');
  assert.ok(['queued', 'preparing', 'running'].includes(bau.state));
  bau = await done(bau.id);
  assert.equal(bau.outOfDate, false);
  assert.equal(bau.madeBy, 'e2e');
  assert.equal(bau.area.name, 'Newcastle and the Hunter');
  assert.equal(bau.summary.demand.rowsRefused, 2, 'the row that cannot be read and the row with the unknown stop');
  assert.equal(bau.summary.demand.rows, 1501);
  assert.equal(bau.summary.people.ok + bau.summary.people.noJourney, 1540);
  assert.equal(bau.summary.stops.changedAtOrigin, 0, 'on the published timetable nobody changes stop');
  assert.ok(bau.timetableId.startsWith(`b${B}-a`), 'the router holds the timetable cut to the area under its own id');
  assert.ok(bau.resultRows > 3000);
  step(`BAU run: ${bau.summary.people.ok} of ${bau.summary.demand.people} travel; ${bau.resultRows} rows copied in`);

  // The counts in the database are the counts in the summary.
  const crowd = await get(`/api/sim-runs/${bau.id}/journeys?user=e2e-crowd`);
  assert.equal(crowd.length, 1);
  assert.equal(crowd[0].people, 40);
  const someone = await get(`/api/sim-runs/${bau.id}/journeys?user=${first[0]}`);
  assert.ok(someone.length >= 1);
  const travelled = [...crowd, ...someone].find((j) => j.status === 'ok');
  if (travelled) {
    const ride = travelled.legs.find((l) => l.kind === 'ride');
    assert.ok(ride.tripId && ride.fromStop && ride.routeName !== undefined, 'legs carry the editor\'s own trips and stops');
    const loads = await get(`/api/sim-runs/${bau.id}/trips/${ride.tripId}`);
    assert.ok(loads.length >= 2 && loads.some((l) => l.load >= travelled.people));
    assert.ok(loads.every((l) => l.stop), 'every stop of the trip is one the editor knows');
    const activity = await get(`/api/sim-runs/${bau.id}/stops/${ride.fromStopId}`);
    assert.ok(activity.reduce((sum, q) => sum + q.boardings, 0) >= travelled.people);
    // The trip belongs to the published day, so the editor's own trip page opens it.
    assert.equal((await get(`/api/trips/${ride.tripId}`)).id, ride.tripId);
  }
  const file = await fetch(`${API}/api/sim-runs/${bau.id}/files/journeys.csv.gz`);
  assert.equal(file.status, 200);
  assert.ok((await file.arrayBuffer()).byteLength > 1000);
  step('one person looked up; a trip\'s loads and a stop\'s activity read from the database');

  // ---- a scenario run against it ---------------------------------------------
  const scenario = await ok('POST', '/api/scenarios', { baselineId: B, name: 'e2e simulator' });
  made.scenarios.push(scenario.id);
  assert.equal((await call('POST', `/api/sim-runs?s=${scenario.id}`, {})).status, 400, 'a scenario run needs its BAU run named');
  assert.equal((await call('POST', `/api/sim-runs?s=${scenario.id}`, { bauRunId: bau.id, settings: { walkMetres: 900 } })).status, 400,
    'a scenario run cannot choose what its BAU run decides');
  let same = await ok('POST', `/api/sim-runs?s=${scenario.id}`, { bauRunId: bau.id, madeBy: 'e2e' });
  made.runs.push(same.id);
  same = await done(same.id);
  assert.equal(same.kind, 'scenario');
  assert.equal(same.bauRunId, bau.id);
  assert.equal(same.demandSetId, uploaded.id, 'the same people as the BAU run');
  assert.deepEqual(same.area, bau.area, 'and the same area');
  assert.equal(same.folderId, folder.id, 'filed with its BAU run');
  assert.equal(same.summary.againstBau.compared, bau.summary.people.ok);
  assert.equal(same.summary.againstBau.later + same.summary.againstBau.sooner, 0, 'an unedited scenario changes nobody\'s arrival');
  assert.equal(same.summary.stops.changedAtOrigin, 0);
  step('scenario run on an unedited scenario: the same people, nobody moved');

  // Edit the scenario: the run made on it is now out of date, and the BAU run is not.
  const routes = await get(`/api/baselines/${B}/routes`);
  const line = routes.filter((r) => r.modeId === 'train').sort((a, b) => b.tripCount - a.tripCount)[0];
  const trips = await get(`/api/routes/${line.id}/trips`);
  const edit = await call('POST', `/api/scenarios/${scenario.id}/edits`, { kind: 'shift', tripIds: [trips[0].id], delta: 300, ripple: 'none' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal((await get(`/api/sim-runs/${same.id}`)).outOfDate, true);
  assert.equal((await get(`/api/sim-runs/${bau.id}`)).outOfDate, false);
  assert.equal((await call('POST', '/api/sim-runs', { fromRunId: same.id })).status, 409, 'capacity cannot be added to an out-of-date run');
  let edited = await ok('POST', `/api/sim-runs?s=${scenario.id}`, { bauRunId: bau.id, name: 'e2e after the edit', settings: { giveUpSecs: null } });
  made.runs.push(edited.id);
  edited = await done(edited.id);
  assert.equal(edited.outOfDate, false);
  assert.notEqual(edited.timetableVersion, same.timetableVersion);
  await ok('POST', `/api/scenarios/${scenario.id}/undo`);
  assert.equal((await get(`/api/sim-runs/${edited.id}`)).outOfDate, true, 'undoing the edit puts the run out of date too');
  await ok('POST', `/api/scenarios/${scenario.id}/redo`);
  assert.equal((await get(`/api/sim-runs/${edited.id}`)).outOfDate, false, 'and redoing it brings the run back');
  step('editing the scenario marks its earlier run out of date; a new run is of the edited timetable');

  // ---- capacity from the BAU run's kept plans --------------------------------
  let crowded = await ok('POST', '/api/sim-runs', { fromRunId: bau.id, settings: { fullAt: 0.5 } });
  made.runs.push(crowded.id);
  crowded = await done(crowded.id);
  assert.equal(crowded.capacity, true);
  assert.equal(crowded.plansRunId, bau.id);
  assert.equal(crowded.kind, 'bau');
  assert.equal(crowded.summary.capacity, true);
  assert.equal(crowded.summary.people.ok + crowded.summary.people.stranded + crowded.summary.people.noJourney, 1540);
  step(`capacity from kept plans: ${crowded.summary.capacityResults.timesLeftBehind} times left behind at half capacity`);

  // ---- the results view (docs/simulator-plan.md, section 18) --------------------
  const overview = await get(`/api/sim-runs/${same.id}/results/overview`);
  assert.equal(overview.vs.id, bau.id, 'a scenario run is set against its BAU run');
  assert.equal(overview.compared, bau.summary.people.ok, 'everyone who travels in both is compared');
  assert.equal(overview.groups.reduce((x, y) => x + y, 0), overview.compared, 'and is in one group of change');
  assert.equal(overview.groups[4], overview.compared, 'an unedited scenario leaves everyone arriving when they did');
  assert.equal(overview.lost.people + overview.gained, 0);
  assert.equal(overview.times.a.people, same.summary.people.ok);
  assert.equal(overview.byHour.reduce((x, h) => x + h.groups[4], 0), overview.compared, 'the hours add up to the day');
  const morning = await get(`/api/sim-runs/${same.id}/results/overview?from=23400&to=34200`);
  assert.ok(morning.compared > 0 && morning.compared < overview.compared, 'a part of the day has part of the people');
  const lineRows = (await get(`/api/sim-runs/${same.id}/results/lines`)).lines;
  assert.ok(lineRows.length > 0 && lineRows.every((l) => l.a === l.b), 'every line carries what it did');
  const lineDetail = await get(`/api/sim-runs/${same.id}/results/lines/${lineRows[0].id}`);
  assert.ok(lineDetail.hourly.length > 0 && lineDetail.stops.length > 0);
  assert.equal(lineDetail.went.riders, lineDetail.cameFrom.riders);
  assert.equal(lineDetail.went.people + lineDetail.cameFrom.people, 0, 'and the same people ride it');
  const flows = await get(`/api/sim-runs/${same.id}/results/flows`);
  assert.ok(flows.links.length > 0 && flows.links.every((l) => l[2] === l[3]), 'every stretch carries what it did');
  assert.ok(flows.links.every((l) => flows.stops.some((s) => s[0] === l[0])), 'and each has somewhere to be drawn');
  for (const by of ['stop', '1000']) {
    const places = await get(`/api/sim-runs/${same.id}/results/places?by=${by}`);
    assert.ok(places.places.length > 0 && places.places.every((p) => p[5] + p[6] + p[7] + p[8] === 0), `nobody is affected anywhere (by ${by})`);
    // Someone who walks the whole way boards nowhere, so has no stop to be placed by.
    const placed = places.places.reduce((x, p) => x + p[3], 0);
    assert.ok(placed > 0 && placed <= overview.compared, `and nobody is counted twice (by ${by})`);
  }
  // Capacity is set against the run whose plans it replays: whoever is stranded travelled before.
  const crowdedView = await get(`/api/sim-runs/${crowded.id}/results/overview`);
  assert.equal(crowdedView.vs.id, bau.id);
  assert.equal(crowdedView.lost.people, crowded.summary.people.stranded);
  assert.equal(crowdedView.lost.stranded, crowded.summary.people.stranded);
  // A BAU run has nothing to be set against, and says which runs it could be.
  const alone = await get(`/api/sim-runs/${bau.id}/results/overview`);
  assert.equal(alone.vs, null);
  assert.equal(alone.compared, undefined);
  assert.deepEqual(alone.others.map((o) => o.id).sort(), [same.id, edited.id, crowded.id].sort());
  assert.equal((await call('GET', `/api/sim-runs/${bau.id}/results/places`)).status, 400, 'who is affected needs two runs');
  assert.equal((await get(`/api/sim-runs/${bau.id}/results/overview?vs=${same.id}`)).vs.id, same.id, 'but it can be asked for');
  // Travel patterns: the same boardings by mode and vehicles a journey, and nobody at another stop.
  const patterns = await get(`/api/sim-runs/${same.id}/results/patterns`);
  assert.ok(patterns.byMode.length > 0 && patterns.byMode.every((m) => m.a === m.b), 'every mode carries what it did');
  assert.equal(patterns.byMode.reduce((x, m) => x + m.a, 0), lineRows.reduce((x, l) => x + l.a, 0), 'the modes add up to the lines');
  assert.deepEqual(patterns.vehicles.a, patterns.vehicles.b);
  assert.equal(patterns.vehicles.a.reduce((x, y) => x + y, 0), same.summary.people.ok, 'everyone who travels boards some number of vehicles');
  assert.equal(patterns.stopChange.origin + patterns.stopChange.destination, 0, 'nobody uses another stop');
  assert.ok(patterns.stations.length > 0 && patterns.stations.every((s) => s.aOn === s.bOn && s.aOff === s.bOff));
  // People: nobody's journey changed, everyone can be listed, and one of them read both ways.
  assert.equal((await get(`/api/sim-runs/${same.id}/results/people`)).journeys, 0, 'nobody is listed as changed');
  const everyone = await get(`/api/sim-runs/${same.id}/results/people?who=all&limit=5`);
  assert.equal(everyone.people, bau.summary.demand.people);
  assert.equal(everyone.rows.length, 5);
  const traveller = (await get(`/api/sim-runs/${same.id}/results/people?who=group:4&limit=1`)).rows[0];
  assert.ok(traveller.aStatus === 'ok' && traveller.bStatus === 'ok' && Math.abs(traveller.later) < 60);
  assert.equal((await get(`/api/sim-runs/${same.id}/results/people?who=user:${encodeURIComponent(traveller.user)}`)).rows.some((r) => r.journeyId === traveller.journeyId), true);
  const bothWays = await get(`/api/sim-runs/${same.id}/results/people/${encodeURIComponent(traveller.journeyId)}`);
  assert.equal(bothWays.a[0].arrive, bothWays.b[0].arrive, 'the same journey in both runs');
  assert.ok(bothWays.a[0].legs.length > 0);
  assert.equal((await call('GET', `/api/sim-runs/${bau.id}/results/people?who=later`)).status, 400, 'nobody is later in a run on its own');
  // Through here: the riders of the busiest stretch, of a line and of a stop, followed on the map.
  const busiest = [...flows.links].sort((x, y) => y[2] - x[2])[0];
  const through = await get(`/api/sim-runs/${same.id}/results/trace?who=link:${busiest[0]}-${busiest[1]}:b`);
  assert.ok(through.people > 0 && through.people <= busiest[2], 'the people on a stretch are no more than its passengers');
  const itself = through.links.find((l) => l[0] === busiest[0] && l[1] === busiest[1]);
  assert.ok(itself && itself[2] === itself[3] && itself[2] >= through.people, 'they ride that stretch in both runs');
  assert.ok(through.links.every((l) => l[2] === l[3]), 'and every other stretch as before');
  assert.ok(through.origins.length > 0 && through.origins.reduce((x, o) => x + o[3], 0) <= through.people);
  const riders = await get(`/api/sim-runs/${same.id}/results/trace?who=line:${lineRows[0].id}:a`);
  assert.equal(riders.people, lineDetail.went.riders, 'a line\'s riders are the people its card counts');
  const atStop = await get(`/api/sim-runs/${same.id}/results/trace?who=stop:${patterns.stations[0].id}:a`);
  assert.ok(atStop.people > 0 && atStop.links.length > 0);
  assert.equal((await get(`/api/sim-runs/${bau.id}/results/trace?who=line:${lineRows[0].id}:a`)).people, riders.people, 'a run on its own can be followed too');
  // How full each vehicle is through the day.
  const loads = await get(`/api/sim-runs/${same.id}/results/vehicle-loads`);
  assert.ok(loads.trips.length > 0 && loads.trips.every((t) => t.length >= 5 && t.length % 2 === 1 && t[2] > 0), 'every trip answered carries someone');
  assert.ok(loads.trips.every((t) => t[t.length - 1] === 0), 'and ends empty');
  step(`results: ${overview.compared} people compared, ${lineRows.length} lines, ${flows.links.length} stretches on the map; ${through.people} people followed through the busiest stretch`);

  // ---- the library -----------------------------------------------------------
  const inFolder = await get(`/api/sim-runs?folder=${folder.id}`);
  assert.deepEqual(inFolder.map((r) => r.id).sort(), [bau.id, same.id, edited.id, crowded.id].sort());
  assert.ok(inFolder.every((r) => r.summary === undefined && r.people), 'the list carries the headline figures only');
  assert.deepEqual((await get(`/api/sim-runs?q=${encodeURIComponent('after the edit')}`)).map((r) => r.id), [edited.id]);
  assert.equal((await get(`/api/sim-runs?kind=bau&baseline=${B}&madeBy=e2e`)).some((r) => r.id === bau.id), true);
  const listed = (await get(`/api/sim-runs?baseline=${B}`)).find((r) => r.id === bau.id);
  assert.equal(listed.scenarioRuns, 2);
  assert.equal(listed.capacityRuns, 1);
  const moved = await ok('PATCH', `/api/sim-runs/${edited.id}`, { name: 'e2e renamed', folderId: inner.id });
  assert.equal(moved.name, 'e2e renamed');
  assert.equal(moved.folderId, inner.id);
  assert.equal((await ok('PATCH', `/api/sim-runs/${edited.id}`, { folderId: null })).folderId, null);
  step('runs are filed, found by folder, name, kind and maker, renamed and moved');

  // Archive and restore.
  const archived = await ok('POST', `/api/sim-runs/${bau.id}/archive`);
  assert.equal(archived.archived, true);
  assert.ok(archived.resultRows < bau.resultRows && archived.resultRows > 0);
  assert.equal((await call('GET', `/api/sim-runs/${bau.id}/journeys?user=e2e-crowd`)).status, 409, 'an archived run has no journeys to look up');
  assert.ok((await get(`/api/sim-runs/${bau.id}`)).summary.people.ok > 0, 'but it still opens');
  assert.equal((await call('GET', `/api/sim-runs/${same.id}/results/overview`)).status, 409, 'results about people need the journeys of both runs');
  assert.ok((await get(`/api/sim-runs/${same.id}/results/lines`)).lines.length > 0, 'results about lines do not');
  assert.ok((await get(`/api/sim-runs/${same.id}/results/flows`)).links.length > 0, 'nor do the flows on the map');
  const restored = await ok('POST', `/api/sim-runs/${bau.id}/restore`);
  assert.equal(restored.archived, false);
  assert.equal(restored.resultRows, bau.resultRows);
  assert.equal((await get(`/api/sim-runs/${bau.id}/journeys?user=e2e-crowd`)).length, 1);
  step('archive takes the journeys out of the database; restore brings them back whole');

  // Stopping a run that is going.
  let stopped = await ok('POST', '/api/sim-runs', { baselineId: B, demandSetId: madeUp.id, areaId: area.id, name: 'e2e to be stopped' });
  made.runs.push(stopped.id);
  assert.equal((await ok('DELETE', `/api/sim-runs/${stopped.id}`)).stopping, true);
  stopped = await ended(stopped.id);
  assert.equal(stopped.state, 'stopped');
  step('a run that is going can be stopped');

  // Removing: a BAU run others were made from asks first.
  const refused = await call('DELETE', `/api/sim-runs/${bau.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /3 other runs/);
  assert.equal((await call('DELETE', `/api/demand/${uploaded.id}`)).status, 409, 'journeys that runs were made from ask first too');
  await ok('DELETE', `/api/sim-runs/${same.id}`);
  assert.equal((await call('GET', `/api/sim-runs/${same.id}`)).status, 404);
  await ok('DELETE', `/api/sim-runs/${bau.id}?force=true`);
  const orphan = await get(`/api/sim-runs/${edited.id}`);
  assert.equal(orphan.bauRunId, null, 'its scenario run stays, without what it was compared with');
  assert.ok(orphan.summary.againstBau, 'and keeps its figures');
  step('removing asks first when other runs depend on it');
} finally {
  for (const id of made.runs) {
    await call('DELETE', `/api/sim-runs/${id}?force=true`);
    await ended(id, 1).catch(() => {});
    await call('DELETE', `/api/sim-runs/${id}?force=true`);
  }
  for (const id of made.scenarios) await call('DELETE', `/api/scenarios/${id}`);
  for (const id of made.demand) await call('DELETE', `/api/demand/${id}?force=true`);
  for (const id of made.folders) await call('DELETE', `/api/sim-folders/${id}`);
  for (const id of made.areas) await call('DELETE', `/api/sim-areas/${id}`);
}
console.log('\nSimulator end-to-end checks passed.');
