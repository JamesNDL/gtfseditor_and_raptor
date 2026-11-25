// AA-14: the typed client for the road router on ROUTER_URL (health, table, route), and the words
// for when it is not running, which name ROUTER_URL.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROAD_DOWN, roadHealth, roadRoute, roadTable } from './road-client.ts';

/** What the fake road router answers next, by path. */
const answers = new Map<string, { status: number; body: string }>();
/** The last body each path received. */
const received = new Map<string, string>();

let server: Server;
let url: string;
const saved = process.env.ROUTER_URL;

function answer(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    const path = `${req.method} ${req.url}`;
    received.set(path, body);
    const next = answers.get(path) ?? { status: 404, body: '{"error":"not here"}' };
    res.writeHead(next.status, { 'content-type': 'application/json' }).end(next.body);
  });
}

const setAnswer = (path: string, status: number, body: unknown): void => {
  answers.set(path, { status, body: JSON.stringify(body) });
};

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  answers.clear();
  received.clear();
  process.env.ROUTER_URL = `${url}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (saved === undefined) delete process.env.ROUTER_URL;
  else process.env.ROUTER_URL = saved;
});

describe('the road router words', () => {
  it('name ROUTER_URL and how to start it', () => {
    expect(ROAD_DOWN).toBe(
      'The road router is not running, or ROUTER_URL does not point at it. Start the journey router with road data (npm run router:dev) and set ROUTER_URL=http://localhost:3002.',
    );
  });
});

describe('roadHealth', () => {
  it('reads whether the road side is available', async () => {
    process.env.ROUTER_URL = `${url}/`;
    setAnswer('GET /v1/health', 200, { status: 'up', road: { available: true, mode: 'on' } });
    expect(await roadHealth()).toEqual({ available: true });
    setAnswer('GET /v1/health', 200, { status: 'up', road: { available: false } });
    expect(await roadHealth()).toEqual({ available: false });
  });

  it('counts a router with no road part as not available', async () => {
    process.env.ROUTER_URL = url;
    setAnswer('GET /v1/health', 200, { status: 'up' });
    expect(await roadHealth()).toEqual({ available: false });
  });

  it('is a 503 naming ROUTER_URL when it is unset or cannot be reached', async () => {
    delete process.env.ROUTER_URL;
    await expect(roadHealth()).rejects.toMatchObject({ statusCode: 503, message: ROAD_DOWN });
    process.env.ROUTER_URL = 'http://127.0.0.1:1';
    await expect(roadHealth()).rejects.toMatchObject({ statusCode: 503, message: ROAD_DOWN });
  });

  it('is a 503 when the health answer is not a router health', async () => {
    process.env.ROUTER_URL = url;
    setAnswer('GET /v1/health', 500, { error: 'broken' });
    await expect(roadHealth()).rejects.toMatchObject({ statusCode: 503, message: ROAD_DOWN });
  });
});

describe('roadTable', () => {
  const sources = [
    { lat: -32.89, lon: 151.73 },
    { lat: -32.9, lon: 151.74 },
  ];
  const destinations = [{ lat: -32.927, lon: 151.772 }];

  it('sends the sources and destinations and reads the drives, nulls kept', async () => {
    process.env.ROUTER_URL = url;
    setAnswer('POST /v1/road/table', 200, {
      profile: 'car',
      freeFlow: true,
      durationsSecs: [[512.3], [null]],
      metres: [[5230], [null]],
      sourceSnapMetres: [12.4, null],
      destinationSnapMetres: [3.1],
      computeMicros: 41000,
    });
    expect(await roadTable(sources, destinations)).toEqual({
      durationsSecs: [[512.3], [null]],
      metres: [[5230], [null]],
      sourceSnapMetres: [12.4, null],
      destinationSnapMetres: [3.1],
    });
    expect(JSON.parse(received.get('POST /v1/road/table') ?? '')).toEqual({
      sources,
      destinations,
      profile: 'car',
    });
  });

  it("keeps the router's words when it refuses", async () => {
    process.env.ROUTER_URL = url;
    setAnswer('POST /v1/road/table', 400, { error: 'a road table may hold at most 10 pairs' });
    await expect(roadTable(sources, destinations)).rejects.toThrow(
      'a road table may hold at most 10 pairs',
    );
  });

  it('refuses an answer of the wrong shape', async () => {
    process.env.ROUTER_URL = url;
    setAnswer('POST /v1/road/table', 200, { durationsSecs: [[1]], metres: 'lots' });
    await expect(roadTable(sources, destinations)).rejects.toThrow('could not be read');
  });

  it('is a 503 naming ROUTER_URL when the router cannot be reached', async () => {
    process.env.ROUTER_URL = 'http://127.0.0.1:1';
    await expect(roadTable(sources, destinations)).rejects.toMatchObject({
      statusCode: 503,
      message: ROAD_DOWN,
    });
  });
});

describe('roadRoute', () => {
  const from = { lat: -32.897, lon: 151.736 };
  const to = { lat: -32.927, lon: 151.772 };

  it('sends the two ends and reads the drive and its path', async () => {
    process.env.ROUTER_URL = url;
    setAnswer('POST /v1/road/route', 200, {
      status: 'ok',
      profile: 'car',
      freeFlow: true,
      metres: 5230,
      durationSecs: 512,
      geometry: [
        [151.7361, -32.8969],
        [151.7365, -32.8975],
      ],
      snapMetres: { from: 12.4, to: 3.1 },
      computeMicros: 2100,
    });
    expect(await roadRoute(from, to)).toEqual({
      status: 'ok',
      metres: 5230,
      durationSecs: 512,
      geometry: [
        [151.7361, -32.8969],
        [151.7365, -32.8975],
      ],
      reason: null,
    });
    expect(JSON.parse(received.get('POST /v1/road/route') ?? '')).toEqual({
      from,
      to,
      profile: 'car',
    });
  });

  it('reads a drive with no road, and its reason', async () => {
    process.env.ROUTER_URL = url;
    setAnswer('POST /v1/road/route', 200, {
      status: 'noRoad',
      metres: null,
      durationSecs: null,
      geometry: [],
      reason: 'from is more than 500 m from a road',
    });
    expect(await roadRoute(from, to)).toEqual({
      status: 'noRoad',
      metres: null,
      durationSecs: null,
      geometry: [],
      reason: 'from is more than 500 m from a road',
    });
  });
});
