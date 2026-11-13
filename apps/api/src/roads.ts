// Works out the path a vehicle takes through a list of stops.
//
// Road vehicles, best method first:
//   1. A road routing service (any server that speaks the OSRM route API), if ROUTER_URL is set.
//   2. Existing bus paths: where a published bus pattern already runs from one stop to the next,
//      that stretch of its path is reused.
//   3. A straight line.
// Trains, trams and ferries follow the network of published services (see tracks.ts).
import { distanceToPathM, pathDistances, slicePath } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { trackPath } from './tracks.ts';

export interface PathStop {
  id: number;
  lon: number;
  lat: number;
  /** The station a platform belongs to, where there is one. */
  stationId?: number | null;
}

export type PathMethod = 'roads' | 'bus_paths' | 'track' | 'track_partly' | 'water' | 'water_partly' | 'straight';

/** A circle that a path must stay out of: a closed road. */
export interface Avoid {
  lon: number;
  lat: number;
  radiusM: number;
}

export interface RoadPath {
  coords: [number, number][];
  method: PathMethod;
  /** Which point of the path each stop sits at, when the method knows. */
  at?: number[];
  /** True when the path had to stay out of a closed area and no way round was found. */
  blocked?: boolean;
}

export const ROAD_MODES = new Set(['bus', 'coach', 'school_bus']);

interface Routed {
  coords: [number, number][];
  metres: number;
  /** The length of each leg between consecutive waypoints, in metres. */
  legs: number[];
}

// Answers from the routing server, kept for a while: a preview and the edit that follows it ask the
// same questions, and so do the many stop patterns that share a stretch of road.
const routerCache = new Map<string, RouterAnswer>();
const ROUTER_CACHE_MAX = 800;

interface RouterAnswer {
  code?: string;
  routes?: { distance: number; legs?: { distance: number }[]; geometry: { coordinates: [number, number][] } }[];
  distances?: (number | null)[][];
}

// A shared routing server turns away callers that ask too fast, so requests take turns, two at a
// time, and one that is turned away is asked once more after a pause.
const waiting: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
let lane = 0;
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const mine = lane++ % waiting.length;
  const run = waiting[mine].then(job, job);
  waiting[mine] = run.catch(() => {});
  return run;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One question to the routing server. Null without a server, or when it cannot be reached. */
async function ask(question: string): Promise<RouterAnswer | null> {
  const base = process.env.ROUTER_URL;
  if (!base) return null;
  const url = `${base.replace(/\/$/, '')}/${question}`;
  const known = routerCache.get(url);
  if (known) return known;
  try {
    let res = await inTurn(() => fetch(url, { signal: AbortSignal.timeout(10_000) }));
    if (res.status === 429 || res.status >= 500) {
      await pause(1500);
      res = await inTurn(() => fetch(url, { signal: AbortSignal.timeout(10_000) }));
    }
    // "No route" is an answer (and comes with status 400); anything else unexpected is not.
    if (!res.ok && res.status !== 400) return null;
    const json = (await res.json()) as RouterAnswer;
    if (routerCache.size >= ROUTER_CACHE_MAX) routerCache.delete(routerCache.keys().next().value!);
    routerCache.set(url, json);
    return json;
  } catch {
    return null; // unreachable or too slow: fall back to the next method, and ask again next time
  }
}

const listOf = (points: [number, number][]) => points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');

async function askRouter(points: [number, number][], alternatives: boolean): Promise<Routed[] | null> {
  const json = await ask(`route/v1/driving/${listOf(points)}?overview=full&geometries=geojson&steps=false${alternatives ? '&alternatives=3' : ''}`);
  if (!json || json.code !== 'Ok' || !json.routes?.length) return null;
  const found = json.routes
    .filter((r) => r.geometry.coordinates.length >= 2)
    .map((r) => ({ coords: r.geometry.coordinates, metres: r.distance, legs: (r.legs ?? []).map((l) => l.distance) }));
  return found.length ? found : null;
}

/** The distance by road between every pair of points, in metres; null where there is no way. */
async function askTable(points: [number, number][]): Promise<(number | null)[][] | null> {
  const json = await ask(`table/v1/driving/${listOf(points)}?annotations=distance`);
  return json?.code === 'Ok' && Array.isArray(json.distances) ? json.distances : null;
}

async function routed(stops: PathStop[]): Promise<[number, number][] | null> {
  const found = await askRouter(stops.map((s) => [s.lon, s.lat]), false);
  return found?.[0]?.coords ?? null;
}

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

const clearOf = (coords: [number, number][], avoid: Avoid) => distanceToPathM(coords, avoid.lon, avoid.lat) > avoid.radiusM;

// Every extra waypoint risks a small side trip to reach it, so a chain with fewer is preferred.
const HOP_PENALTY_M = 150;

/** The shortest chain of hops from point 0 to point 1 using only the hops still allowed, or null. */
function shortestChain(table: (number | null)[][], allowed: boolean[][]): number[] | null {
  const n = table.length;
  const dist = new Array<number>(n).fill(Infinity);
  const via = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let here = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (here < 0 || dist[i] < dist[here])) here = i;
    if (here < 0) return null;
    if (here === 1) break;
    done[here] = true;
    for (let j = 0; j < n; j++) {
      const hop = table[here][j];
      if (done[j] || !allowed[here][j] || hop === null) continue;
      const d = dist[here] + hop + HOP_PENALTY_M;
      if (d < dist[j]) {
        dist[j] = d;
        via[j] = here;
      }
    }
  }
  const chain = [1];
  while (chain[0] !== 0) chain.unshift(via[chain[0]]);
  return chain;
}

/**
 * A road path through the stops that stays out of a closed area, or null if none was found.
 *
 * The routing server cannot be told that a road is closed, so the way round is searched for. If
 * neither its own route nor its alternatives stay clear, waypoints are placed on rings round the
 * closure and the shortest chain of hops through them is looked for. One table of road distances
 * between all of them says which hops go through the closure: those where going by way of the
 * closed spot is no further than going direct. A chain is then checked against its real path, and
 * any hop that still enters the closure is struck out and the search repeated.
 */
async function routedAround(stops: PathStop[], avoid: Avoid): Promise<[number, number][] | null> {
  const points = stops.map((s) => [s.lon, s.lat] as [number, number]);
  const direct = await askRouter(points, points.length === 2);
  if (!direct) return null;
  const clear = direct.filter((r) => clearOf(r.coords, avoid)).sort((a, b) => a.metres - b.metres);
  if (clear.length) return clear[0].coords;

  // Which leg of the journey runs into the closure: the one whose straight line passes closest to it.
  let leg = 1;
  let nearest = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = distanceToPathM([points[i - 1], points[i]], avoid.lon, avoid.lat);
    if (d < nearest) {
      nearest = d;
      leg = i;
    }
  }
  const at = (east: number, north: number): [number, number] => [avoid.lon + east / mPerDegLon(avoid.lat), avoid.lat + north / M_PER_DEG_LAT];
  const nodes: [number, number][] = [points[leg - 1], points[leg]];
  for (const ring of [avoid.radiusM + 120, avoid.radiusM * 2 + 350, avoid.radiusM * 4 + 1000]) {
    for (let k = 0; k < 8; k++) nodes.push(at(Math.cos((k * Math.PI) / 4) * ring, Math.sin((k * Math.PI) / 4) * ring));
  }
  const travel = nodes.length;
  // Spots inside the closure: its middle, and a little way towards each side.
  const inside = avoid.radiusM * 0.6;
  nodes.push(at(0, 0), at(inside, 0), at(-inside, 0), at(0, inside), at(0, -inside));
  const table = await askTable(nodes);
  if (!table) return null;
  const through = (i: number, j: number) => {
    const directly = table[i][j];
    if (directly === null) return true;
    for (let k = travel; k < nodes.length; k++) {
      const first = table[i][k];
      const second = table[k][j];
      if (first !== null && second !== null && first + second <= directly + Math.max(25, directly * 0.02)) return true;
    }
    return false;
  };
  const allowed = nodes.map((_, i) => nodes.map((__, j) => i !== j && i < travel && j < travel && !through(i, j)));
  allowed[0][1] = false; // already known to run through it

  for (let attempt = 0; attempt < 12; attempt++) {
    const chain = shortestChain(table, allowed);
    if (!chain) return null;
    const waypoints = [...points.slice(0, leg - 1), ...chain.map((i) => nodes[i]), ...points.slice(leg + 1)];
    const route = (await askRouter(waypoints, false))?.[0];
    if (!route) return null;
    if (clearOf(route.coords, avoid)) return route.coords;
    // Strike out each hop of the chain whose road route enters the closure.
    const along = pathDistances(route.coords);
    const total = route.legs.reduce((sum, m) => sum + m, 0);
    const scale = total > 0 ? along[along.length - 1] / total : 1;
    let struck = false;
    let from = 0;
    route.legs.forEach((metres, n) => {
      const piece = slicePath(route.coords, along, from * scale, (from + metres) * scale);
      from += metres;
      const hop = n - (leg - 1);
      if (hop >= 0 && hop < chain.length - 1 && !clearOf(piece, avoid)) {
        allowed[chain[hop]][chain[hop + 1]] = false;
        struck = true;
      }
    });
    if (!struck) return null;
  }
  return null;
}

/** The nearest point on the road network, or null without a routing server or when it does not answer. */
export async function nearestRoad(lon: number, lat: number): Promise<[number, number] | null> {
  const base = process.env.ROUTER_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/nearest/v1/driving/${lon.toFixed(6)},${lat.toFixed(6)}?number=1`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: string; waypoints?: { location: [number, number] }[] };
    return json.code === 'Ok' && json.waypoints?.[0] ? json.waypoints[0].location : null;
  } catch {
    return null;
  }
}

async function alongBusPaths(sql: Sql, baselineId: number, stops: PathStop[]): Promise<{ coords: [number, number][]; found: number }> {
  const coords: [number, number][] = [[stops[0].lon, stops[0].lat]];
  let found = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    // The published pattern that goes from a to b with the fewest stops in between.
    const [row] = await sql`
      select ST_AsGeoJSON(ST_LineSubstring(s.geom, fa.f, fb.f)) as path
      from patterns p
      join shapes s on s.id = p.shape_id
      cross join lateral (select array_position(p.stop_ids, ${a.id}::bigint) as ia, array_position(p.stop_ids, ${b.id}::bigint) as ib) x
      cross join lateral (select ST_LineLocatePoint(s.geom, ST_SetSRID(ST_MakePoint(${a.lon}, ${a.lat}), 4326)) as f) fa
      cross join lateral (select ST_LineLocatePoint(s.geom, ST_SetSRID(ST_MakePoint(${b.lon}, ${b.lat}), 4326)) as f) fb
      where p.baseline_id = ${baselineId} and p.scenario_id is null
        and p.stop_ids @> array[${a.id}, ${b.id}]::bigint[] and x.ia < x.ib and fa.f < fb.f
      order by x.ib - x.ia limit 1`;
    if (row?.path) {
      const piece = (JSON.parse(row.path) as { coordinates: [number, number][] }).coordinates;
      coords.push(...piece.slice(1, -1));
      found++;
    }
    coords.push([b.lon, b.lat]);
  }
  return { coords, found };
}

const straight = (stops: PathStop[]): [number, number][] => stops.map((s) => [s.lon, s.lat]);

export async function roadPath(sql: Sql, baselineId: number, stops: PathStop[], avoid?: Avoid): Promise<RoadPath> {
  if (avoid) {
    const around = await routedAround(stops, avoid);
    if (around) return { coords: around, method: 'roads' };
    return { coords: straight(stops), method: 'straight', blocked: true };
  }
  const viaRouter = await routed(stops);
  if (viaRouter) return { coords: viaRouter, method: 'roads' };
  const viaBuses = await alongBusPaths(sql, baselineId, stops);
  if (viaBuses.found > 0) return { coords: viaBuses.coords, method: 'bus_paths' };
  return { coords: straight(stops), method: 'straight' };
}

/**
 * The path a line of this mode takes through the stops: along roads for road vehicles, along the
 * published network for trains, trams and ferries, or straight from stop to stop when `follow` is off.
 */
export async function linePath(
  sql: Sql,
  baselineId: number,
  modeId: string,
  stops: PathStop[],
  options: { follow: boolean; avoid?: Avoid },
): Promise<RoadPath> {
  if (!options.follow) return { coords: straight(stops), method: 'straight' };
  if (ROAD_MODES.has(modeId)) return roadPath(sql, baselineId, stops, options.avoid);
  const found = await trackPath(sql, baselineId, modeId, stops.map((s) => ({ lon: s.lon, lat: s.lat, stationId: s.stationId ?? s.id })));
  if (found.found === 0) return { coords: straight(stops), method: 'straight' };
  const water = modeId === 'ferry';
  const all = found.found === found.stretches;
  return { coords: found.coords, at: found.at, method: water ? (all ? 'water' : 'water_partly') : all ? 'track' : 'track_partly' };
}

const DESCRIPTIONS: Record<PathMethod, string> = {
  roads: 'following roads',
  bus_paths: 'following existing bus routes where they run',
  track: 'following existing track',
  track_partly: 'following existing track where there is some, straight elsewhere',
  water: 'following existing ferry routes',
  water_partly: 'following existing ferry routes where there are some, straight elsewhere',
  straight: 'drawn straight between stops',
};

export const describeMethod = (method: PathMethod) => DESCRIPTIONS[method];

/** Weakest first: when a path is found by several methods, it is described by the weakest of them. */
export const METHOD_STRENGTH: PathMethod[] = ['straight', 'bus_paths', 'water_partly', 'track_partly', 'water', 'track', 'roads'];
