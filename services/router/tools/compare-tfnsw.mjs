// Compares the router's journeys with the TfNSW trip planner's for the same test journeys.
//
//   node services/router/tools/compare-tfnsw.mjs <journeys.jsonl> [--date 20261117] [--report <file>]
//        [--water <file>] [--offline]
//
// <journeys.jsonl> comes from `RouteCli --random <n> --dump <file>`. Each test journey is asked of
// the TfNSW Trip Planner API (key from API_KEY in .env) between the same two positions at the same
// time. The ends are the positions of stops, not the stops: asked for a stop, TfNSW boards only
// there. Answers are kept in a folder beside the input, so a second run asks nothing again; with
// --offline nothing is asked at all, and a test journey with no kept answer is left out.
// Only stop positions, a date and a time are sent.
//
// What is compared. The two planners do not start from the same place: ours starts on the platform
// or wharf itself, TfNSW at the nearest street address, and walks from there. So the headline is
// not the arrival at the destination but the part both planners can be held to: from the first
// boarding to the last alighting. "Ours gets off the last vehicle sooner" is then looked at for
// every reason it might not be a real journey, and the reasons are counted one by one, not by the
// first that fits: a journey can have several.
//
// --water <file> is the water file the timetable was loaded with (see the service's README). With
// it, a walk of ours whose straight line is over water is marked. Without it nothing is marked,
// and the report says so.
//
// The two planners are not expected to agree everywhere: TfNSW has its own walking and interchange
// rules. The report sorts the differences so that each kind can be read and judged. It does not
// judge them: a journey listed under "none of these" has been checked against nothing but the
// timetable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
let input = null;
let date = '20261117';
let reportFile = null;
let waterFile = null;
let offline = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--date') date = args[++i];
  else if (args[i] === '--report') reportFile = args[++i];
  else if (args[i] === '--water') waterFile = args[++i];
  else if (args[i] === '--offline') offline = true;
  else input = args[i];
}
if (!input) {
  console.error('Usage: node compare-tfnsw.mjs <journeys.jsonl> [--date 20261117] [--report <file>] [--water <file>] [--offline]');
  process.exit(2);
}

let apiKey = '';
if (!offline) {
  apiKey = (readFileSync('.env', 'utf8').match(/^API_KEY=(.*)$/m)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!apiKey) {
    console.error('No API_KEY in .env');
    process.exit(1);
  }
}

const cases = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const ourTrips = new Set(readFileSync(input + '.trips', 'utf8').split(/\r?\n/).filter(Boolean));
const cacheDir = join(dirname(input), 'tfnsw-' + date);
mkdirSync(cacheDir, { recursive: true });
reportFile ??= input.replace(/\.jsonl$/, '') + '.report.txt';

/** Our rule for a change of vehicle: never less than this between getting off and the next leaving. */
const CHANGE_SECS = 120;
/** A change with less than this to spare once the walk is done is called tight. */
const TIGHT_SECS = 60;

// ---- water: the same test as the router's (a straight line within 20 m of a piece of ferry path) ----
const WATER_MARGIN = 20;
const water = [];
if (waterFile) {
  for (const line of readFileSync(waterFile, 'utf8').split(/\r?\n/).slice(1)) {
    const [kind, lat1, lon1, lat2, lon2] = line.split(',');
    if (kind === 'water') water.push([+lat1, +lon1, +lat2, +lon2]);
  }
}
const M = 111_000;
function fromPoint(px, py, ax, ay, bx, by) {
  const lx = bx - ax;
  const ly = by - ay;
  const length = lx * lx + ly * ly;
  const along = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * lx + (py - ay) * ly) / length));
  return Math.hypot(px - (ax + along * lx), py - (ay + along * ly));
}
const side = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
function overWater(lat1, lon1, lat2, lon2) {
  if (!water.length) return false;
  const east = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const bx = (lon2 - lon1) * east * M;
  const by = (lat2 - lat1) * M;
  const reach = Math.hypot(bx, by) + WATER_MARGIN + 500;
  for (const [a1, o1, a2, o2] of water) {
    const cx = (o1 - lon1) * east * M;
    const cy = (a1 - lat1) * M;
    if (Math.abs(cx) > reach || Math.abs(cy) > reach) continue;
    const dx = (o2 - lon1) * east * M;
    const dy = (a2 - lat1) * M;
    const d1 = side(cx, cy, dx, dy, 0, 0);
    const d2 = side(cx, cy, dx, dy, bx, by);
    const d3 = side(0, 0, bx, by, cx, cy);
    const d4 = side(0, 0, bx, by, dx, dy);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    if (Math.min(fromPoint(0, 0, cx, cy, dx, dy), fromPoint(bx, by, cx, cy, dx, dy), fromPoint(cx, cy, 0, 0, bx, by), fromPoint(dx, dy, 0, 0, bx, by)) <= WATER_MARGIN) return true;
  }
  return false;
}
/** The walks of one of our journeys that are over water, as text; empty if none or no water file. */
function waterWalks(c, j) {
  const found = [];
  for (const leg of j.legs) {
    if (leg.kind === 'RIDE') continue;
    const a = leg.from ?? c.from;
    const b = leg.to ?? c.to;
    if (overWater(a.lat, a.lon, b.lat, b.lon)) found.push(`${leg.metres} m ${leg.from ? `from ${leg.from.name}` : 'from the start'} ${leg.to ? `to ${leg.to.name}` : 'to the end'}`);
  }
  return found;
}

// Midnight in Sydney at the start of the service day, as a UTC instant.
const dayStart = (() => {
  const utc = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
  const shown = new Date(utc).toLocaleString('sv-SE', { timeZone: 'Australia/Sydney', hour12: false });
  const offsetHours = +shown.slice(11, 13) + (shown.slice(8, 10) === date.slice(6, 8) ? 0 : -24);
  return utc - offsetHours * 3600_000;
})();
const secs = (iso) => Math.round((Date.parse(iso) - dayStart) / 1000);
const clock = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function ask(c) {
  const file = join(cacheDir, `at_${c.from.id}_${c.to.id}_${c.depart}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (offline) return null;
  const query = new URLSearchParams({
    outputFormat: 'rapidJSON', coordOutputFormat: 'EPSG:4326', depArrMacro: 'dep', itdDate: date,
    itdTime: clock(c.depart).replace(':', ''), type_origin: 'coord', name_origin: `${c.from.lon}:${c.from.lat}:EPSG:4326`,
    type_destination: 'coord', name_destination: `${c.to.lon}:${c.to.lat}:EPSG:4326`, calcNumberOfTrips: '6', TfNSWTR: 'true',
    version: '10.2.1.42',
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.transport.nsw.gov.au/v1/tp/trip?' + query, {
      headers: { Authorization: 'apikey ' + apiKey, Accept: 'application/json' },
    });
    if (res.ok) {
      const body = await res.json();
      writeFileSync(file, JSON.stringify(body));
      await sleep(300);
      return body;
    }
    if (attempt === 4 || (res.status !== 429 && res.status < 500)) {
      throw new Error(`TfNSW responded ${res.status} for ${c.from.id} to ${c.to.id}`);
    }
    await sleep(2000 * attempt);
  }
}

const WALK_CLASSES = new Set([99, 100]);

// A TfNSW journey in the same terms as one of ours.
function theirs(journey) {
  const legs = journey.legs.map((leg) => {
    const t = leg.transportation ?? {};
    const walk = WALK_CLASSES.has(t.product?.class);
    return {
      walk,
      from: leg.origin.name,
      fromId: leg.origin.id,
      to: leg.destination.name,
      toId: leg.destination.id,
      depart: secs(leg.origin.departureTimePlanned),
      arrive: secs(leg.destination.arrivalTimePlanned),
      route: walk ? null : (t.disassembledName ?? t.number ?? t.name ?? '?'),
      kind: t.product?.name ?? '',
      trip: walk ? null : (t.properties?.RealtimeTripId ?? null),
      metres: leg.distance ?? null,
    };
  });
  const rides = legs.filter((leg) => !leg.walk);
  return {
    legs,
    depart: legs[0].depart,
    arrive: legs[legs.length - 1].arrive,
    rides: rides.length,
    // The part the two planners can be held to: first boarding to last alighting. Null if it only walks.
    board: rides.length ? rides[0].depart : null,
    alight: rides.length ? rides[rides.length - 1].arrive : null,
    // How long TfNSW takes to reach its first stop from the street address it starts at.
    firstWalkSecs: legs[0].walk ? legs[0].arrive - legs[0].depart : 0,
    walkSecs: legs.filter((leg) => leg.walk).reduce((sum, leg) => sum + leg.arrive - leg.depart, 0),
    trips: rides.map((leg) => leg.trip),
  };
}

/** One of our journeys with the same two times, and what its changes look like. */
function measured(j) {
  const rides = j.legs.filter((leg) => leg.kind === 'RIDE');
  let change = Infinity; // least time between getting off one vehicle and the next leaving
  let spare = Infinity;  // the same, less our own walking time between the two
  for (let i = 1; i < j.legs.length; i++) {
    const leg = j.legs[i];
    if (leg.kind !== 'RIDE' || leg.stayAboard) continue;
    const before = j.legs[i - 1];
    const off = before.kind === 'RIDE' ? before : j.legs[i - 2];
    if (!off || off.kind !== 'RIDE') continue;
    change = Math.min(change, leg.depart - off.arrive);
    spare = Math.min(spare, leg.depart - before.arrive);
  }
  return {
    board: rides.length ? rides[0].depart : null,
    alight: rides.length ? rides[rides.length - 1].arrive : null,
    change,
    spare,
    trips: rides.filter((leg) => !leg.stayAboard).map((leg) => leg.trip).join('|'),
    schoolBus: rides.some((leg) => leg.mode === 'school_bus'),
  };
}

const spareText = (m) => (Number.isFinite(m.change) ? `least time to change ${m.change} s, least spare after the walk ${m.spare} s` : 'no change of vehicle');

function oursText(c, j) {
  const m = measured(j);
  const wet = waterWalks(c, j);
  const lines = [`    ours (${j.label}): leave ${clock(j.depart)}, first boarding ${m.board === null ? '-' : clock(m.board)}, last alighting ${m.alight === null ? '-' : clock(m.alight)}, arrive ${clock(j.arrive)}, ${j.rides} rides, ${Math.round(j.walkSecs / 60)} min walking; ${spareText(m)}${wet.length ? `; WALKS OVER WATER: ${wet.join('; ')}` : ''}`];
  for (const leg of j.legs) {
    lines.push(leg.kind === 'RIDE'
      ? `      ${clock(leg.depart)}-${clock(leg.arrive)} ${leg.mode} ${leg.route}: ${leg.from.name} [${leg.from.id}] to ${leg.to.name} [${leg.to.id}] (trip ${leg.trip})`
      : `      ${clock(leg.depart)}-${clock(leg.arrive)} walk ${leg.metres} m to ${leg.to?.name ?? 'the destination'}`);
  }
  return lines.join('\n');
}

function theirsText(j) {
  const lines = [`    TfNSW: leave ${clock(j.depart)}, first boarding ${j.board === null ? '-' : clock(j.board)}, last alighting ${j.alight === null ? '-' : clock(j.alight)}, arrive ${clock(j.arrive)}, ${j.rides} rides, ${Math.round(j.walkSecs / 60)} min walking`];
  for (const leg of j.legs) {
    lines.push(leg.walk
      ? `      ${clock(leg.depart)}-${clock(leg.arrive)} walk ${leg.metres ?? '?'} m to ${leg.to}`
      : `      ${clock(leg.depart)}-${clock(leg.arrive)} ${leg.kind} ${leg.route}: ${leg.from} [${leg.fromId}] to ${leg.to} [${leg.toId}] (trip ${leg.trip}${leg.trip && !ourTrips.has(leg.trip) ? ', NOT IN OUR TIMETABLE' : ''})`);
  }
  return lines.join('\n');
}

const groups = { same: [], oursEarlier: [], theirsEarlier: [], onlyOurs: [], onlyTheirs: [], neither: [], walkOnly: [] };
const rows = [];
let asked = 0;
let notKept = 0;
for (const c of cases) {
  let body;
  try {
    body = await ask(c);
  } catch (err) {
    console.error(String(err.message));
    continue;
  }
  if (!body) {
    notKept++;
    continue;
  }
  if (++asked % 25 === 0) console.error(`${asked} of ${cases.length}`);
  // TfNSW may list a journey that left before the time asked; those are not answers to the question.
  const tf = (body.journeys ?? []).map(theirs).filter((j) => j.depart >= c.depart);
  const tfBest = tf.reduce((best, j) => (!best || j.arrive < best.arrive ? j : best), null);
  // TfNSW's journey that gets off its last vehicle soonest: the one ours is held against.
  const tfRide = tf.filter((j) => j.alight !== null).reduce((best, j) => (!best || j.alight < best.alight ? j : best), null);
  const ours = c.journeys[0] ?? null;
  const row = { c, tf, tfBest, tfRide, ours, recommended: c.journeys[c.recommended] ?? null };
  rows.push(row);
  if (!ours && !tfBest) groups.neither.push(row);
  else if (!ours) groups.onlyTheirs.push(row);
  else if (!tfBest) groups.onlyOurs.push(row);
  else {
    row.m = measured(ours);
    row.arriveDiff = ours.arrive - tfBest.arrive; // above 0: TfNSW reaches the destination sooner
    row.sameTrips = c.journeys.some((j) => tf.some((t) => t.trips.join('|') === measured(j).trips));
    row.fastestSameTrips = tf.some((t) => t.trips.join('|') === row.m.trips);
    row.missingTrips = (tfRide ?? tfBest).trips.filter((trip) => !trip || !ourTrips.has(trip)).length;
    row.water = waterWalks(c, ours);
    row.theirSchoolBus = (tfRide ?? tfBest).legs.some((leg) => /school/i.test(leg.kind));
    if (row.m.alight === null || !tfRide) {
      groups.walkOnly.push(row); // one of them only walks: there is no boarding or alighting to compare
      continue;
    }
    row.diff = row.m.alight - tfRide.alight; // above 0: TfNSW gets off its last vehicle sooner
    // Ours boards a vehicle that TfNSW, walking from the street address, could not have reached.
    row.headStart = row.m.board < tfRide.board && row.m.board < c.depart + tfRide.firstWalkSecs;
    (Math.abs(row.diff) <= 60 ? groups.same : row.diff < 0 ? groups.oursEarlier : groups.theirsEarlier).push(row);
  }
}

const both = [...groups.same, ...groups.oursEarlier, ...groups.theirsEarlier];
const answered = [...both, ...groups.walkOnly];
const percent = (n, of) => (of ? `${((100 * n) / of).toFixed(1)}%` : '-');
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const count = (list, test) => list.filter(test).length;
const out = [];
out.push(`${rows.length} test journeys from ${input}, service day ${date}${notKept ? ` (${notKept} more left out: no kept answer, and --offline)` : ''}`);
out.push(`  both planners answer         ${answered.length}`);
out.push(`  only ours answers            ${groups.onlyOurs.length}`);
out.push(`  only TfNSW answers           ${groups.onlyTheirs.length}`);
out.push(`  neither answers              ${groups.neither.length}`);
out.push(`  one of the two only walks    ${groups.walkOnly.length} (not compared below)`);
out.push(`From first boarding to last alighting: when our fastest journey gets off its last vehicle, against the soonest of TfNSW's (up to 6)`);
out.push(`  within a minute              ${groups.same.length} (${percent(groups.same.length, both.length)})`);
out.push(`  ours gets off sooner         ${groups.oursEarlier.length} (${percent(groups.oursEarlier.length, both.length)}), median ${Math.round(median(groups.oursEarlier.map((r) => -r.diff)) / 60)} min sooner`);
out.push(`  TfNSW gets off sooner        ${groups.theirsEarlier.length} (${percent(groups.theirsEarlier.length, both.length)}), median ${Math.round(median(groups.theirsEarlier.map((r) => r.diff)) / 60)} min sooner`);
for (const limit of [5, 10, 20]) {
  out.push(`    TfNSW sooner by over ${String(limit).padStart(2)} min ${count(groups.theirsEarlier, (r) => r.diff > limit * 60)}`);
}
{
  // The measure the earlier reports used, kept so that they can be set beside this one.
  const near = count(answered, (r) => Math.abs(r.arriveDiff) <= 60);
  const sooner = answered.filter((r) => r.arriveDiff < -60);
  const later = answered.filter((r) => r.arriveDiff > 60);
  out.push(`For reference, arrival at the destination (it includes each planner's own walk at the ends, which start from different places)`);
  out.push(`  within a minute ${near} (${percent(near, answered.length)}), ours sooner ${sooner.length} (${percent(sooner.length, answered.length)}), TfNSW sooner ${later.length} (${percent(later.length, answered.length)})`);
}
out.push(`  one of ours uses exactly the vehicles of one of TfNSW's   ${count(answered, (r) => r.sameTrips)} (${percent(count(answered, (r) => r.sameTrips), answered.length)})`);
out.push(`  TfNSW's soonest uses a trip our timetable lacks           ${count(answered, (r) => r.missingTrips > 0)}`);
out.push(`  rides, on average            ours fastest ${mean(answered.map((r) => r.ours.rides)).toFixed(2)}, ours recommended ${mean(answered.map((r) => r.recommended.rides)).toFixed(2)}, TfNSW's earliest ${mean(answered.map((r) => r.tfBest.rides)).toFixed(2)}`);
out.push(`  walking, on average          ours fastest ${(mean(answered.map((r) => r.ours.walkSecs)) / 60).toFixed(1)} min, ours recommended ${(mean(answered.map((r) => r.recommended.walkSecs)) / 60).toFixed(1)} min, TfNSW's earliest ${(mean(answered.map((r) => r.tfBest.walkSecs)) / 60).toFixed(1)} min`);
{
  const changing = answered.filter((r) => Number.isFinite(r.m.change));
  out.push(`Our fastest journeys' changes of vehicle (${changing.length} journeys change at least once)`);
  out.push(`  least time between getting off and the next leaving: under ${CHANGE_SECS} s in ${count(changing, (r) => r.m.change < CHANGE_SECS)}; smallest ${changing.length ? Math.min(...changing.map((r) => r.m.change)) : '-'} s; median ${median(changing.map((r) => r.m.change))} s`);
  out.push(`  least spare once the walk is done: under ${TIGHT_SECS} s in ${count(changing, (r) => r.m.spare < TIGHT_SECS)}; smallest ${changing.length ? Math.min(...changing.map((r) => r.m.spare)) : '-'} s; median ${median(changing.map((r) => r.m.spare))} s`);
}
out.push(water.length
  ? `Our fastest journeys with a walk over water (by ${waterFile}): ${count(answered, (r) => r.water.length > 0)} of ${answered.length}`
  : `Walks over water were not looked for: no --water file was given`);

// Why ours gets off sooner. Every reason that fits is counted, so the rows add up to more than the total.
const reasons = [
  ['ours boards a vehicle TfNSW could not reach: it starts from a street address and walks to its first stop', (r) => r.headStart],
  ['the same vehicles as one of TfNSW\'s (so only walking or waiting differs)', (r) => r.fastestSameTrips],
  ['a walk of ours is over water', (r) => r.water.length > 0],
  [`ours makes a change with under ${TIGHT_SECS} s to spare once the walk is done`, (r) => r.m.spare < TIGHT_SECS],
  ['ours changes more often than TfNSW\'s', (r) => r.ours.rides > r.tfRide.rides],
  ['ours rides a school bus', (r) => r.m.schoolBus],
];
const unexplained = (r) => !reasons.some(([, test]) => test(r));
out.push(`Where ours gets off sooner (${groups.oursEarlier.length}): every reason that fits is counted, so a journey may be in several rows`);
for (const [label, test] of reasons) out.push(`  ${String(count(groups.oursEarlier, test)).padStart(4)}  ${label}`);
out.push(`  ${String(count(groups.oursEarlier, unexplained)).padStart(4)}  none of these: a different journey, which nothing here has checked beyond the timetable`);
const over5 = groups.oursEarlier.filter((r) => -r.diff > 300);
out.push(`  ours sooner by over 5 min: ${over5.length}, of which none of the reasons above fits ${count(over5, unexplained)}`);

// How fast TfNSW walks, from its walks of 200 m or more.
const paces = rows.flatMap((r) => r.tf.flatMap((j) => j.legs.filter((leg) => leg.walk && leg.metres >= 200 && leg.arrive > leg.depart).map((leg) => leg.metres / (leg.arrive - leg.depart)))).sort((x, y) => x - y);
if (paces.length) out.push(`TfNSW's walking pace over ${paces.length} walks of 200 m or more: median ${paces[Math.floor(paces.length / 2)].toFixed(2)} m/s along the path (ours: 1.03 m/s along 1.3 times the straight line)`);
{
  // Where both end on the same vehicle at the same stop, the last walk is the same walk measured
  // twice: TfNSW's along its paths, ours as a straight line.
  const ratios = [];
  const times = [];
  for (const r of answered) {
    const mine = r.ours.legs[r.ours.legs.length - 1];
    const lastRide = r.ours.legs.filter((leg) => leg.kind === 'RIDE').pop();
    if (!lastRide || mine.kind === 'RIDE' || mine.metres < 100) continue;
    for (const t of r.tf) {
      const walk = t.legs[t.legs.length - 1];
      const ride = t.legs.filter((leg) => !leg.walk).pop();
      if (!walk.walk || !ride || ride.trip !== lastRide.trip || ride.arrive !== lastRide.arrive || !walk.metres) continue;
      ratios.push(walk.metres / mine.metres);
      times.push((walk.arrive - walk.depart) / Math.max(1, mine.arrive - mine.depart));
      break;
    }
  }
  if (ratios.length) out.push(`The same last walk measured by both (${ratios.length} walks of 100 m or more in a straight line): TfNSW's path is a median ${median(ratios).toFixed(2)} times our straight line (we assume 1.3), and takes a median ${median(times).toFixed(2)} times as long as ours`);
}
console.log(out.join('\n'));

function section(title, list) {
  out.push('', '='.repeat(100), `${title}: ${list.length}`, '='.repeat(100));
  if (list.length && list[0].diff !== undefined) {
    out.push('  min apart at the last alighting | rides ours/TfNSW | walking min ours/TfNSW | our least time to change, s (least spare after the walk) | marks');
    for (const r of list) {
      const marks = [r.headStart ? 'head start' : '', r.fastestSameTrips ? 'same vehicles' : '', r.water.length ? 'WATER' : '', r.m.spare < TIGHT_SECS ? 'tight' : '', r.m.schoolBus ? 'school bus' : '', r.theirSchoolBus ? 'TfNSW school bus' : ''].filter(Boolean).join(', ');
      out.push(`  ${String(Math.round(Math.abs(r.diff) / 60)).padStart(9)} | ${r.ours.rides}/${r.tfRide.rides} | ${Math.round(r.ours.walkSecs / 60)}/${Math.round(r.tfRide.walkSecs / 60)} | ${Number.isFinite(r.m.change) ? `${r.m.change} (${r.m.spare})` : '-'} | ${marks || '-'}   ${r.c.from.id} to ${r.c.to.id} at ${clock(r.c.depart)}`);
    }
  }
  for (const r of list) {
    out.push('', `  ${r.c.from.name} [${r.c.from.id}] to ${r.c.to.name} [${r.c.to.id}] at ${clock(r.c.depart)}` + (r.diff === undefined ? '' : `   (${r.diff > 0 ? 'TfNSW' : 'ours'} gets off the last vehicle sooner by ${Math.round(Math.abs(r.diff) / 60)} min)`));
    for (const j of r.c.journeys) out.push(oursText(r.c, j));
    const shown = r.tfRide ?? r.tfBest;
    if (shown) out.push(theirsText(shown));
  }
}
section('TfNSW gets off sooner', groups.theirsEarlier.sort((a, b) => b.diff - a.diff));
section('Ours gets off sooner', groups.oursEarlier.sort((a, b) => a.diff - b.diff));
section('Only TfNSW answers', groups.onlyTheirs);
section('Only ours answers', groups.onlyOurs);
section('One of the two only walks', groups.walkOnly);
section('Within a minute but different vehicles', groups.same.filter((r) => !r.sameTrips));
writeFileSync(reportFile, out.join('\n') + '\n');
console.log(`Full report: ${reportFile}`);
