// AA-13: the call to the journey router has its own file, out of sim.ts, and works as before.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as RouterClientModule from './router-client.ts';

type RouterClient = typeof RouterClientModule;

/** What the fake router last received. */
interface Received {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server;
let received: Received | null = null;
let client: RouterClient;

/** A fake router: /json answers with JSON, /text with plain words, /empty with nothing. */
function answer(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    received = {
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'],
      body,
    };
    if (req.url === '/json') res.writeHead(202).end(JSON.stringify({ status: 'ready' }));
    else if (req.url === '/text') res.writeHead(500).end('Something broke');
    else res.writeHead(204).end();
  });
}

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // ROUTER is read once when the module loads, so the address must be set before the import.
  process.env.ROUTER_SERVICE_URL = `http://127.0.0.1:${port}/`;
  client = await import('./router-client.ts');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('router-client', () => {
  it('reads the router address from ROUTER_SERVICE_URL, without the trailing slash', () => {
    const { port } = server.address() as AddressInfo;
    expect(client.ROUTER).toBe(`http://127.0.0.1:${port}`);
  });

  it('sends a JSON body and parses a JSON answer', async () => {
    const got = await client.router('PUT', '/json', { version: 'v1' });
    expect(got).toEqual({ status: 202, body: { status: 'ready' } });
    expect(received).toEqual({
      method: 'PUT',
      url: '/json',
      contentType: 'application/json',
      body: '{"version":"v1"}',
    });
  });

  it('turns an answer that is not JSON into an error field', async () => {
    const got = await client.router('GET', '/text');
    expect(got).toEqual({ status: 500, body: { error: 'Something broke' } });
    expect(received?.contentType).toBeUndefined();
  });

  it('gives a null body for an empty answer', async () => {
    expect(await client.router('DELETE', '/empty')).toEqual({ status: 204, body: null });
  });

  it('is a 503 with the "not running" words when the router cannot be reached', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // router() always calls ROUTER, so load a fresh copy of the module pointed at the closed port.
    process.env.ROUTER_SERVICE_URL = `http://127.0.0.1:${port}`;
    vi.resetModules();
    const down: RouterClient = await import('./router-client.ts');
    await expect(down.router('GET', '/v1/health')).rejects.toMatchObject({
      statusCode: 503,
      message: down.ROUTER_DOWN,
    });
    expect(down.ROUTER_DOWN).toMatch(/journey router is not running/);
  });

  it('imports nothing from sim.ts (no import circle)', async () => {
    const text = await readFile(path.join(import.meta.dirname, 'router-client.ts'), 'utf8');
    expect(text).not.toMatch(/from '\.\/sim\.ts'/);
  });
});
