// A fake journey router for the access analysis e2e checks (D32, docs/architecture/
// access-analysis.md §8): one Node HTTP server that answers the health, timetable, bulk journey and
// road requests an analysis makes, with made-up but repeatable answers, so the fixture run needs
// no Java. Both ROUTER_SERVICE_URL and ROUTER_URL point at it.
//
// The answers, for a straight distance d metres between the two ends:
//   journeys  depart = asked + 240 s; walk 150 s, ride d / 6 s on line 'F1', walk 150 s.
//             noJourney when round(lat * 1e4) of the from point is a multiple of 7.
//   road      seconds = d * 1.3 / 12, metres = d * 1.3. A table row is null when round(lon * 1e4)
//             of its source is a multiple of 11 (that source has no road). A route is two points.
//   timetables 404 until a PUT, then ready with the version asked for.
//
// A test steers it with POST /fake/control {down?, road?, hold?, bulkAnswers?, tableAnswers?,
// bulkError?, ride?, resetCounts?}:
//   down  true: every other request has its connection dropped, as if the router were stopped.
//   road  false: health says the road side is not available.
//   hold  true: timetables stay loading until it is set false again.
//   bulkAnswers, tableAnswers  a number: answer that many more bulk journey (or road table)
//         requests, then hold the next ones until it is raised or set to null (no limit).
//   bulkError  words: bulk journey requests are refused with 400 and these words; null to stop.
//   ride  a ride leg as the real router gives it (trip, route, routeId, mode, board and alight
//         with stop id, name, lat, lon, time and position): every journey found rides it instead
//         of the made-up ride, walking 150 s to it and from it; null to go back to the made-up one.
//   resetCounts  true: the counts below start again from 0.
// GET /fake/state gives {lastBulk, counts}: the last bulk journey request as sent, and how many
// requests, journey queries and drive sources have been answered (a request held and then given
// up by the caller is not counted).
// Usage: import { startFakeRouter } from './fake-router.mjs', or `node fake-router.mjs [port]`.
import { createServer } from 'node:http';
import path from 'node:path';

const json = (res, status, body) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

/** Straight distance in metres, with the flat-earth factors of roads.ts and the sample grid (D26). */
function metresBetween(a, b) {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * 111_320 * Math.cos(midLat);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}

const tenths = (value) => Math.round(value * 10) / 10;
const multipleOf = (value, n) => Math.round(value * 1e4) % n === 0;

/** The made-up ride from `from` to `to` for a journey leaving at `depart` (see the top). */
function madeUpRide(from, to, depart) {
  const boardAt = depart + 240 + 150;
  const alightAt = boardAt + Math.round(metresBetween(from, to) / 6);
  const place = (p, time) => ({ stop: 'F', name: 'Fake stop', lat: p.lat, lon: p.lon, time });
  return {
    trip: 'F1-1',
    route: 'F1',
    routeId: 'F1',
    mode: 'bus',
    board: { ...place(from, boardAt), position: 0 },
    alight: { ...place(to, alightAt), position: 1 },
  };
}

/** One line of a bulk answer for one query, riding `fixedRide` when it is given. */
function journeyLine(query, fixedRide) {
  const { id, from, to, depart } = query;
  if (multipleOf(from.lat, 7)) return { id, status: 'noJourney', reason: 'No journey was found' };
  const ride = fixedRide ?? madeUpRide(from, to, depart);
  const boardAt = ride.board.time;
  const alightAt = ride.alight.time;
  const start = boardAt - 150;
  const arrive = alightAt + 150;
  const legs = [
    { type: 'walk', from, to: ride.board, depart: start, arrive: boardAt, metres: 155 },
    {
      type: 'ride',
      headsign: 'Fake',
      ...ride,
      depart: boardAt,
      arrive: alightAt,
      stayAboard: false,
    },
    { type: 'walk', from: ride.alight, to, depart: alightAt, arrive, metres: 155 },
  ];
  const journey = {
    label: 'fastest',
    depart: start,
    arrive,
    durationSecs: arrive - start,
    rides: 1,
    changes: 0,
    walkSecs: 300,
    waitSecs: 0,
    legs,
  };
  return { id, status: 'ok', journey };
}

function bulk(res, body, counts, ride) {
  const queries = body.queries ?? [];
  counts.bulkRequests++;
  counts.journeys += queries.length;
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  let ok = 0;
  for (const query of queries) {
    const line = journeyLine(query, ride);
    if (line.status === 'ok') ok++;
    res.write(`${JSON.stringify(line)}\n`);
  }
  const summary = {
    queries: queries.length,
    ok,
    noJourney: queries.length - ok,
    stranded: 0,
    errors: 0,
    elapsedSecs: 0,
    perSecond: 0,
  };
  res.end(`${JSON.stringify({ summary })}\n`);
}

function table(res, body, counts) {
  const { sources = [], destinations = [] } = body;
  counts.tableRequests++;
  counts.drives += sources.length * destinations.length;
  const noRoad = sources.map((s) => multipleOf(s.lon, 11));
  const grid = (perMetre) =>
    sources.map((s, i) =>
      destinations.map((d) => (noRoad[i] ? null : tenths(metresBetween(s, d) * perMetre))),
    );
  json(res, 200, {
    profile: 'car',
    freeFlow: true,
    durationsSecs: grid(1.3 / 12),
    metres: grid(1.3),
    sourceSnapMetres: noRoad.map((none) => (none ? null : 0)),
    destinationSnapMetres: destinations.map(() => 0),
    computeMicros: 0,
  });
}

function route(res, body) {
  const d = metresBetween(body.from, body.to) * 1.3;
  json(res, 200, {
    status: 'ok',
    profile: 'car',
    freeFlow: true,
    metres: tenths(d),
    durationSecs: tenths(d / 12),
    geometry: [
      [body.from.lon, body.from.lat],
      [body.to.lon, body.to.lat],
    ],
    snapMetres: { from: 0, to: 0 },
    computeMicros: 0,
  });
}

/** Starts the fake router. Resolves with its address and a function that stops it. */
export async function startFakeRouter(port = 0) {
  const control = {
    down: false,
    road: true,
    hold: false,
    bulkAnswers: null,
    tableAnswers: null,
    bulkError: null,
    ride: null,
  };
  const zeroCounts = () => ({ bulkRequests: 0, journeys: 0, tableRequests: 0, drives: 0 });
  let counts = zeroCounts();
  let lastBulk = null;
  /** Timetable id to the version last asked for. */
  const timetables = new Map();

  /**
   * Waits while `control[key]` is 0, then takes one from it if it is a number. False when the
   * caller went away meanwhile, so the request is not answered and not counted.
   */
  async function allowed(key, res) {
    const gone = () => res.destroyed || !res.socket || res.socket.destroyed;
    while (control[key] === 0) {
      if (gone()) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (gone()) return false;
    if (typeof control[key] === 'number') control[key]--;
    return true;
  }

  async function answer(req, res, text) {
    const body = text ? JSON.parse(text) : {};
    const { pathname } = new URL(req.url, 'http://fake');
    const timetable = /^\/v1\/timetables\/([^/]+)$/.exec(pathname);
    if (req.method === 'POST' && pathname === '/fake/control') {
      for (const key of ['down', 'road', 'hold'])
        if (key in body) control[key] = Boolean(body[key]);
      for (const key of ['bulkAnswers', 'tableAnswers', 'bulkError', 'ride'])
        if (key in body) control[key] = body[key];
      if (body.resetCounts) counts = zeroCounts();
      return json(res, 200, control);
    }
    if (req.method === 'GET' && pathname === '/fake/state') {
      return json(res, 200, { lastBulk, counts });
    }
    if (control.down) return req.socket.destroy();
    if (req.method === 'GET' && pathname === '/v1/health') {
      return json(res, 200, { status: 'up', timetables: [], road: { available: control.road } });
    }
    if (timetable && req.method === 'PUT') {
      timetables.set(timetable[1], body.version);
      return json(res, 202, { id: timetable[1], status: 'loading' });
    }
    if (timetable && req.method === 'GET') {
      const version = timetables.get(timetable[1]);
      if (version === undefined) return json(res, 404, { error: 'no such timetable' });
      if (control.hold) return json(res, 200, { id: timetable[1], building: { version } });
      return json(res, 200, { id: timetable[1], status: 'ready', version });
    }
    if (req.method === 'POST' && pathname === '/v1/journeys/bulk') {
      lastBulk = body;
      if (control.bulkError !== null) return json(res, 400, { error: control.bulkError });
      if (await allowed('bulkAnswers', res)) bulk(res, body, counts, control.ride);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/road/table') {
      if (await allowed('tableAnswers', res)) table(res, body, counts);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/road/route') return route(res, body);
    // Anything else, such as the OSRM-shaped road requests, is not known: roads.ts falls back.
    return json(res, 404, { error: `the fake router does not answer ${req.method} ${pathname}` });
  }

  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      answer(req, res, text).catch((err) => json(res, 400, { error: String(err?.message ?? err) }));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { url, stop };
}

// Run as a script: start it and keep it going until stopped.
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const { url } = await startFakeRouter(Number(process.argv[2] ?? 0));
  console.log(`fake router listening on ${url}`);
}
