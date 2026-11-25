// The journey router service: the call to it, and the words for when it is not running.
// Moved out of sim.ts unchanged (AA-13).
import { fail } from '../http.ts';

/** The journey router service. ROUTER_URL is already the road-routing server and keeps that meaning. */
export const ROUTER = (process.env.ROUTER_SERVICE_URL ?? 'http://localhost:3002').replace(
  /\/+$/,
  '',
);

export const ROUTER_DOWN =
  'The journey router is not running. Start it with `npm run router:dev`, then try again.';

/** Calls the router. A router that cannot be reached is a 503 with words for the panel. */
export async function router(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(ROUTER + pathname, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw fail(503, ROUTER_DOWN);
  }
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}
