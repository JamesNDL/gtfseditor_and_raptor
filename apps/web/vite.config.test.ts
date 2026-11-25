// AA-17: the dev server's port and the API it passes /api to can be set for private test stacks.
import { afterEach, describe, expect, it, vi } from 'vitest';

interface DevServer {
  port: number;
  proxy: Record<string, string>;
}

/** Loads the config afresh, so that it reads the environment as it is now. */
async function devServer(): Promise<DevServer> {
  vi.resetModules();
  const config = (await import('./vite.config.ts')).default as { server: DevServer };
  return config.server;
}

describe('vite.config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves on 5173 and passes /api to the API on 3001 by default', async () => {
    vi.stubEnv('WEB_PORT', undefined);
    vi.stubEnv('API_TARGET', undefined);
    const server = await devServer();
    expect(server.port).toBe(5173);
    expect(server.proxy['/api']).toBe('http://127.0.0.1:3001');
  });

  it('takes the port from WEB_PORT and the API from API_TARGET', async () => {
    vi.stubEnv('WEB_PORT', '5191');
    vi.stubEnv('API_TARGET', 'http://127.0.0.1:3121');
    const server = await devServer();
    expect(server.port).toBe(5191);
    expect(server.proxy['/api']).toBe('http://127.0.0.1:3121');
  });
});
