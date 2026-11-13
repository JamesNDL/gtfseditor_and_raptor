// Works out the path a road vehicle takes through a list of stops.
//
// Three methods, best first:
//   1. A road routing service (any server that speaks the OSRM route API), if ROUTER_URL is set.
//   2. Existing bus paths: where a published bus pattern already runs from one stop to the next,
//      that stretch of its path is reused.
//   3. A straight line.
import type { Sql } from '@gtfs-editor/gtfs/db';

export interface PathStop {
  id: number;
  lon: number;
  lat: number;
}

export type PathMethod = 'roads' | 'bus_paths' | 'straight';

export interface RoadPath {
  coords: [number, number][];
  method: PathMethod;
}

async function routed(stops: PathStop[]): Promise<[number, number][] | null> {
  const base = process.env.ROUTER_URL;
  if (!base) return null;
  const points = stops.map((s) => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`).join(';');
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/route/v1/driving/${points}?overview=full&geometries=geojson&steps=false`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: string; routes?: { geometry: { coordinates: [number, number][] } }[] };
    const coords = json.routes?.[0]?.geometry.coordinates;
    return json.code === 'Ok' && coords && coords.length >= 2 ? coords : null;
  } catch {
    return null; // unreachable or too slow: fall back to the next method
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

export async function roadPath(sql: Sql, baselineId: number, stops: PathStop[]): Promise<RoadPath> {
  const viaRouter = await routed(stops);
  if (viaRouter) return { coords: viaRouter, method: 'roads' };
  const viaBuses = await alongBusPaths(sql, baselineId, stops);
  if (viaBuses.found > 0) return { coords: viaBuses.coords, method: 'bus_paths' };
  return { coords: stops.map((s) => [s.lon, s.lat]), method: 'straight' };
}

export const describeMethod = (method: PathMethod) =>
  method === 'roads' ? 'following roads' : method === 'bus_paths' ? 'following existing bus routes where they run' : 'drawn straight between stops';
