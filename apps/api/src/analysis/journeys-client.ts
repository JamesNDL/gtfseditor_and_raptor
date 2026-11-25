// Many journeys at once from the journey router (ROUTER_SERVICE_URL), typed (D21, docs/architecture/
// access-analysis.md §4.4; services/router/README.md "Many journeys"). The answer is NDJSON: one
// line per query, then a summary line, which ends it. The body is read as it arrives, line by line.
import type { RouterJourney, RouterOtherLeg, RouterRideLeg } from '@gtfs-editor/core';
import { fail } from '../http.ts';
import { ROUTER, ROUTER_DOWN } from '../sim/router-client.ts';

/** A place as the journey router takes it. */
export interface JourneyPoint {
  lat: number;
  lon: number;
}

/** One journey to plan: `id` comes back on its answer line. */
export interface JourneyQuery {
  id: string;
  from: JourneyPoint;
  to: JourneyPoint;
  depart: number;
}

/** The settings given once for every query in a bulk request. */
export interface BulkSettings {
  timetable: string;
  maxWalkMetres: number;
  maxRides: number;
  avoid: string[];
  capacity: { mode: 'off' };
  detail: 'summary';
}

/** A stop a ride boards or alights at; the router gives its GTFS id as `stop`. */
export interface RideStop {
  stop?: string;
  name: string;
  lat: number;
  lon: number;
  time: number;
}

/** A ride leg as the bulk answer gives it, as far as the analysis keeps it (D30, D39). */
export interface BulkRideLeg extends RouterRideLeg {
  /** The trip's GTFS id. */
  trip?: string;
  route: string;
  mode: string;
  board: RideStop;
  alight: RideStop;
}

/** A walk, transfer or warning leg; walks and transfers have their straight-line metres. */
export interface BulkOtherLeg extends RouterOtherLeg {
  metres?: number;
}

/** A journey from a bulk answer line. */
export interface BulkJourney extends RouterJourney {
  legs: (BulkRideLeg | BulkOtherLeg)[];
}

/** One query's answer: its journey, or why there is none (`noJourney`, `stranded` or `error`). */
export type JourneyLine =
  | { id: string; status: 'ok'; journey: BulkJourney }
  | { id: string; status: 'noJourney' | 'stranded' | 'error'; reason: string };

/** The router's kinds of vehicle, the words `avoid` takes and an analysis's modes are chosen from. */
export const ROUTER_MODES: readonly string[] = [
  'train',
  'metro',
  'light_rail',
  'ferry',
  'bus',
  'coach',
  'school_bus',
  'other',
];

/** The kinds of vehicle to leave out: every one the analysis does not allow. */
export const avoidedModes = (allowed: readonly string[]): string[] =>
  ROUTER_MODES.filter((mode) => !allowed.includes(mode));

/** 500 journeys take about a second (D21); allow for a slow, busy router. */
const BULK_TIMEOUT_MS = 300_000;

type Fields = Partial<Record<string, unknown>>;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const unreadable = (): Error =>
  new Error('The journey router gave an answer that could not be read');

/** A field that may be left out, or is text. */
const maybeText = (value: unknown): boolean => value === undefined || typeof value === 'string';

const isStop = (value: unknown): value is RideStop =>
  isObject(value) &&
  maybeText(value.stop) &&
  typeof value.name === 'string' &&
  isNumber(value.lat) &&
  isNumber(value.lon) &&
  isNumber(value.time);

/** A ride or other leg, checked as far as the analysis reads it. */
function isLeg(value: unknown): value is BulkRideLeg | BulkOtherLeg {
  if (!isObject(value)) return false;
  if (value.type === 'ride') {
    return (
      maybeText(value.trip) &&
      typeof value.route === 'string' &&
      typeof value.mode === 'string' &&
      isNumber(value.depart) &&
      isNumber(value.arrive) &&
      isStop(value.board) &&
      isStop(value.alight)
    );
  }
  if (value.type === 'warning') return true;
  return (
    (value.type === 'walk' || value.type === 'transfer') &&
    isNumber(value.depart) &&
    isNumber(value.arrive) &&
    isNumber(value.metres)
  );
}

function isJourney(value: unknown): value is BulkJourney {
  return (
    isObject(value) &&
    isNumber(value.depart) &&
    isNumber(value.arrive) &&
    isNumber(value.walkSecs) &&
    isNumber(value.rides) &&
    Array.isArray(value.legs) &&
    value.legs.every(isLeg)
  );
}

/** One NDJSON line as a JourneyLine, or null for the summary line. */
function lineOf(text: string): JourneyLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  if (!isObject(parsed)) throw unreadable();
  if ('summary' in parsed) return null;
  const { id, status } = parsed;
  if (typeof id !== 'string') throw unreadable();
  if (status === 'ok') {
    if (!isJourney(parsed.journey)) throw unreadable();
    return { id, status, journey: parsed.journey };
  }
  if (status === 'noJourney' || status === 'stranded' || status === 'error') {
    const reason = typeof parsed.reason === 'string' ? parsed.reason : status;
    return { id, status, reason };
  }
  throw unreadable();
}

/** A refusal from the journey router, in its own words. */
async function refused(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  let words = `status ${res.status}`;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && typeof parsed.error === 'string') words = parsed.error;
  } catch {
    if (text) words = text.slice(0, 300);
  }
  return new Error(`The journey router refused the request: ${words}`);
}

/**
 * Plans every query on the journey router and yields each answer line as it arrives, ending at the
 * summary line. Not reachable is a 503 with ROUTER_DOWN; a refusal keeps the router's words.
 */
export async function* bulkJourneys(
  settings: BulkSettings,
  queries: JourneyQuery[],
): AsyncGenerator<JourneyLine> {
  let res: Response;
  try {
    res = await fetch(`${ROUTER}/v1/journeys/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...settings, queries }),
      signal: AbortSignal.timeout(BULK_TIMEOUT_MS),
    });
  } catch {
    throw fail(503, ROUTER_DOWN);
  }
  if (res.status !== 200) throw await refused(res);
  if (!res.body) throw unreadable();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for await (const chunk of res.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let end = buffered.indexOf('\n');
      while (end >= 0) {
        const text = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf('\n');
        if (!text) continue;
        const line = lineOf(text);
        if (line === null) return;
        yield line;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('The journey router')) throw err;
    throw fail(503, ROUTER_DOWN);
  }
  const last = (buffered + decoder.decode()).trim();
  if (last && lineOf(last) === null) return;
  throw new Error('The journey router stopped before it had answered every journey');
}
