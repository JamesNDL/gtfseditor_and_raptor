// AA-13: the timetable key, the water file and timetable loading have their own file, out of
// sim.ts, and work as before.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type Timetables = typeof import('./timetables.ts');

/** One call the fake router received. */
interface Call {
  method: string | undefined;
  url: string | undefined;
  body: string;
}

/** What the fake router says about the timetable: answered in turn, the last one repeated. */
let states: { status: number; body: unknown }[] = [];
let calls: Call[] = [];
let server: Server;
let timetables: Timetables;

function answer(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body });
    if (req.method === 'PUT') {
      res.writeHead(202).end('{}');
      return;
    }
    const state = (states.length > 1 ? states.shift() : undefined) ?? states[0];
    res.writeHead(state.status).end(JSON.stringify(state.body));
  });
}

const key = {
  id: 'b1-s2',
  planVersion: 'feed@1/r2',
  version: 'feed@1/r2|fleet-abc',
  exportUrl: 'http://api/export',
  waterUrl: 'http://api/water',
};

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.ROUTER_SERVICE_URL = `http://127.0.0.1:${port}`;
  timetables = await import('./timetables.ts');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
});

describe('timetables', () => {
  it('keeps the rules number, the gaps and the box text as they were', () => {
    expect(timetables.ROUTER_RULES).toBe(2);
    expect(timetables.WHARF_GAP).toBe(100);
    expect(timetables.BRIDGE_GAP).toBe(150);
    expect(timetables.FOOT_BRIDGES.map((b) => b.name)).toEqual([
      'John Whitton Bridge, Meadowbank to Rhodes',
    ]);
    const box = { name: null, south: -34, west: 150.5, north: -33.5, east: 151.3 };
    expect(timetables.boxText(box)).toBe('-34,150.5,-33.5,151.3');
  });

  it('does nothing more when the router already holds this version', async () => {
    states = [{ status: 200, body: { status: 'ready', version: key.version } }];
    await timetables.ensureTimetable(key, async () => {});
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/timetables/b1-s2']);
  });

  it('asks the router to load the timetable and waits until it is ready', async () => {
    states = [
      { status: 404, body: { error: 'not found' } },
      { status: 200, body: { status: 'ready', version: key.version } },
    ];
    await timetables.ensureTimetable(key, async () => {});
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/timetables/b1-s2',
      'PUT /v1/timetables/b1-s2',
      'GET /v1/timetables/b1-s2',
    ]);
    expect(JSON.parse(calls[1].body)).toEqual({
      source: { url: key.exportUrl },
      water: { url: key.waterUrl },
      version: key.version,
    });
  });

  it('says why when the router could not load the timetable', async () => {
    states = [
      { status: 404, body: {} },
      { status: 200, body: { status: 'failed', lastFailure: { message: 'bad zip' } } },
    ];
    await expect(timetables.ensureTimetable(key, async () => {})).rejects.toThrow(
      'The router could not load the timetable: bad zip',
    );
  });

  it('imports nothing from sim.ts (no import circle)', async () => {
    const text = await readFile(path.join(import.meta.dirname, 'timetables.ts'), 'utf8');
    expect(text).not.toMatch(/from '\.\/sim\.ts'/);
  });
});
