// The road router on ROUTER_URL, typed (docs/architecture/access-analysis.md §3.3, §4.4): its
// health, many drives at once (/v1/road/table) and one drive with its path (/v1/road/route).
// ROUTER_URL is the road router; ROUTER_SERVICE_URL is the journey router (sim/router-client.ts).
// Both are often the same Java service, but either may be pointed elsewhere.
import { fail } from '../http.ts';

/** The words for a road router that cannot be reached, naming the setting that points at it. */
export const ROAD_DOWN =
  'The road router is not running, or ROUTER_URL does not point at it. Start the journey router with road data (npm run router:dev) and set ROUTER_URL=http://localhost:3002.';

/** A place as the road router takes it. */
export interface RoadPoint {
  lat: number;
  lon: number;
}

/** Whether the road router can plan drives. */
export interface RoadHealth {
  available: boolean;
}

/** Drives for every pair: rows are sources, columns destinations; null where there is no way. */
export interface RoadTableAnswer {
  durationsSecs: (number | null)[][];
  metres: (number | null)[][];
  /** How far each end is from its road; null when it has none within the router's limit. */
  sourceSnapMetres: (number | null)[];
  destinationSnapMetres: (number | null)[];
}

/** One drive: ok, no way by road, or an end with no road near it (`reason` says which). */
export interface RoadRouteAnswer {
  status: 'ok' | 'noRoute' | 'noRoad';
  metres: number | null;
  durationSecs: number | null;
  /** The path as [lon, lat] pairs. */
  geometry: [number, number][];
  reason: string | null;
}

/** How long each request may take: a table of 1,000 drives takes a second or two (D22). */
const TABLE_TIMEOUT_MS = 120_000;
const OTHER_TIMEOUT_MS = 10_000;

/** An answer that is a JSON object, with its fields still to be checked. */
type Fields = Partial<Record<string, unknown>>;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));
const isRow = (value: unknown): value is (number | null)[] =>
  Array.isArray(value) && value.every(isNumberOrNull);
const isGrid = (value: unknown): value is (number | null)[][] =>
  Array.isArray(value) && value.every(isRow);
const isPosition = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number');

const unreadable = (): Error => new Error('The road router gave an answer that could not be read');

/**
 * Calls the road router and reads the answer as a JSON object. Unset, unreachable or too slow is
 * a 503 with ROAD_DOWN; a refusal keeps the router's own words.
 */
async function call(
  method: 'GET' | 'POST',
  pathname: string,
  timeoutMs: number,
  body?: unknown,
): Promise<{ status: number; fields: Fields }> {
  const base = process.env.ROUTER_URL?.replace(/\/+$/, '');
  if (!base) throw fail(503, ROAD_DOWN);
  let res: Response;
  let text: string;
  try {
    res = await fetch(base + pathname, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch {
    throw fail(503, ROAD_DOWN);
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text.slice(0, 300) };
  }
  return { status: res.status, fields: isObject(parsed) ? parsed : {} };
}

/** A refusal from the road router, in its own words. */
function refused(status: number, fields: Fields): Error {
  const words = typeof fields.error === 'string' ? fields.error : `status ${status}`;
  return new Error(`The road router refused the request: ${words}`);
}

/** Whether the road router answers and has road data. Not answering at all is a 503 (ROAD_DOWN). */
export async function roadHealth(): Promise<RoadHealth> {
  const { status, fields } = await call('GET', '/v1/health', OTHER_TIMEOUT_MS);
  if (status !== 200) throw fail(503, ROAD_DOWN);
  const road = fields.road;
  return { available: isObject(road) && road.available === true };
}

/** Free-flow drives from every source to every destination (FR-2). */
export async function roadTable(
  sources: RoadPoint[],
  destinations: RoadPoint[],
): Promise<RoadTableAnswer> {
  const body = { sources, destinations, profile: 'car' };
  const { status, fields } = await call('POST', '/v1/road/table', TABLE_TIMEOUT_MS, body);
  if (status !== 200) throw refused(status, fields);
  const { durationsSecs, metres, sourceSnapMetres, destinationSnapMetres } = fields;
  if (
    !isGrid(durationsSecs) ||
    !isGrid(metres) ||
    !isRow(sourceSnapMetres) ||
    !isRow(destinationSnapMetres)
  ) {
    throw unreadable();
  }
  return { durationsSecs, metres, sourceSnapMetres, destinationSnapMetres };
}

const ROUTE_STATUSES: readonly RoadRouteAnswer['status'][] = ['ok', 'noRoute', 'noRoad'];
const isRouteStatus = (value: unknown): value is RoadRouteAnswer['status'] =>
  ROUTE_STATUSES.some((status) => status === value);

/** One free-flow drive and its path (FR-1). */
export async function roadRoute(from: RoadPoint, to: RoadPoint): Promise<RoadRouteAnswer> {
  const body = { from, to, profile: 'car' };
  const { status, fields } = await call('POST', '/v1/road/route', OTHER_TIMEOUT_MS, body);
  if (status !== 200) throw refused(status, fields);
  const { metres, durationSecs, geometry, reason } = fields;
  if (
    !isRouteStatus(fields.status) ||
    !isNumberOrNull(metres) ||
    !isNumberOrNull(durationSecs) ||
    !Array.isArray(geometry) ||
    !geometry.every(isPosition)
  ) {
    throw unreadable();
  }
  return {
    status: fields.status,
    metres,
    durationSecs,
    geometry,
    reason: typeof reason === 'string' ? reason : null,
  };
}
