// Zones and points of interest for access analysis (FR-4, FR-5; docs/architecture/
// access-analysis.md §4.4). Both are global: they belong to no day and are reused on any (D25).
// A zone is stored as a PostGIS polygon and a point of interest as a point, both in SRID 4326.
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  openRing,
  ringProblem,
  type GeoJsonPosition,
  type PointOfInterest,
  type PoiBody,
  type Zone,
  type ZoneBody,
} from '@gtfs-editor/core';
import { fail, int, notFound } from '../http.ts';

/** The longest name kept, as for the simulation's areas and the vehicle types. */
const MAX_NAME = 80;

/** A zone as read from `analysis_zones`, with its outline as GeoJSON coordinates (closed). */
interface ZoneRow {
  id: number;
  name: string;
  rings: GeoJsonPosition[][];
  createdAt: Date;
}

/** A point of interest as read from `points_of_interest`. */
type PoiRow = PointOfInterest;

/** A request body: an object of unknown fields, or nothing. */
type Fields = Partial<Record<string, unknown>>;

const fieldsOf = (body: unknown): Fields =>
  typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body } : {};

/** A trimmed, non-empty name, or a 400 asking for one. */
function nameOf(value: unknown, what: string): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : '';
  if (!name) throw fail(400, `Give the ${what} a name`);
  return name;
}

const isLon = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
const isLat = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;

const RANGE = 'a longitude from -180 to 180 and a latitude from -90 to 90';

/** An outline checked: corners as [longitude, latitude] that `ringProblem` accepts, stored open. */
function ringOf(given: unknown): GeoJsonPosition[] {
  if (!Array.isArray(given)) {
    throw fail(400, 'A zone needs an outline: a list of corners, each [longitude, latitude]');
  }
  const ring = given.map((corner: unknown): GeoJsonPosition => {
    if (!Array.isArray(corner) || corner.length !== 2 || !isLon(corner[0]) || !isLat(corner[1])) {
      throw fail(400, `Each corner of a zone's outline needs ${RANGE}, as [longitude, latitude]`);
    }
    return [corner[0], corner[1]];
  });
  const problem = ringProblem(ring);
  if (problem) throw fail(400, problem);
  return openRing(ring).map(([lon, lat]) => [lon, lat]);
}

/** A zone body checked: a name and an outline. */
function zoneBodyOf(body: unknown): ZoneBody {
  const fields = fieldsOf(body);
  const name = nameOf(fields.name, 'zone');
  return { name, ring: ringOf(fields.ring) };
}

/** The changes a PATCH to a zone asks for: a new name, a new outline (D37), or both. */
function zoneChangesOf(body: unknown): { name?: string; ring?: GeoJsonPosition[] } {
  const fields = fieldsOf(body);
  if (fields.name === undefined && fields.ring === undefined) {
    throw fail(400, 'Give a new name, or a new outline, for the zone');
  }
  return {
    ...(fields.name !== undefined && { name: nameOf(fields.name, 'zone') }),
    ...(fields.ring !== undefined && { ring: ringOf(fields.ring) }),
  };
}

/** A longitude and latitude given together, or a 400 saying what is wrong. */
function positionOf(fields: Fields): { lon: number; lat: number } {
  const { lon, lat } = fields;
  if (!isLon(lon)) throw fail(400, `A point of interest needs ${RANGE}; the longitude is wrong`);
  if (!isLat(lat)) throw fail(400, `A point of interest needs ${RANGE}; the latitude is wrong`);
  return { lon, lat };
}

/** A point of interest body checked: a name, a position and perhaps a kind. */
function poiBodyOf(body: unknown): PoiBody {
  const fields = fieldsOf(body);
  const name = nameOf(fields.name, 'point of interest');
  const { lon, lat } = positionOf(fields);
  if (fields.kind === undefined) return { name, lon, lat };
  if (typeof fields.kind !== 'string' || !fields.kind.trim()) {
    throw fail(400, "A point of interest's kind must be a word, such as place");
  }
  return { name, lon, lat, kind: fields.kind.trim().slice(0, MAX_NAME) };
}

/** The changes a PATCH to a point of interest asks for: a new name, a new position, or both. */
function poiChangesOf(body: unknown): { name?: string; lon?: number; lat?: number } {
  const fields = fieldsOf(body);
  const moving = fields.lon !== undefined || fields.lat !== undefined;
  if (fields.name === undefined && !moving) {
    throw fail(400, 'Give a new name, or a new longitude and latitude, for the point of interest');
  }
  return {
    ...(fields.name !== undefined && { name: nameOf(fields.name, 'point of interest') }),
    ...(moving && positionOf(fields)),
  };
}

/** The outline as a closed line in WKT, for ST_MakePolygon. Numbers keep their full precision. */
const lineWkt = (ring: GeoJsonPosition[]): string =>
  `LINESTRING(${[...ring, ring[0]].map(([lon, lat]) => `${lon} ${lat}`).join(', ')})`;

/** A zone row as the API's `Zone`: the outline open (the closing corner dropped). */
const zoneOf = (row: ZoneRow): Zone => ({
  id: row.id,
  name: row.name,
  ring: row.rings[0].slice(0, -1),
  createdAt: row.createdAt.toISOString(),
});

export function registerAnalysisPlaceRoutes(app: FastifyInstance, sql: Sql): void {
  // 15 decimal places keeps every digit a double holds, so a ring reads back as it was saved.
  const zoneColumns = sql`
    id, name, (st_asgeojson(geom, 15)::json -> 'coordinates') as rings, created_at as "createdAt"`;
  const poiColumns = sql`id, name, kind, source, st_x(geom) as lon, st_y(geom) as lat`;
  const idOf = (params: unknown): number => int(fieldsOf(params).id);

  async function oneZone(id: number): Promise<Zone> {
    const [row] = await sql<ZoneRow[]>`select ${zoneColumns} from analysis_zones where id = ${id}`;
    if (!row) throw notFound('Zone');
    return zoneOf(row);
  }

  async function onePoi(id: number): Promise<PointOfInterest> {
    const [row] = await sql<
      PoiRow[]
    >`select ${poiColumns} from points_of_interest where id = ${id}`;
    if (!row) throw notFound('Point of interest');
    return row;
  }

  // ---- zones (FR-4) -----------------------------------------------------------------------------
  app.get('/api/analysis/zones', async (): Promise<Zone[]> => {
    const rows = await sql<ZoneRow[]>`
      select ${zoneColumns} from analysis_zones order by name, id`;
    return rows.map(zoneOf);
  });

  app.post('/api/analysis/zones', async (req): Promise<Zone> => {
    const { name, ring } = zoneBodyOf(req.body);
    const [row] = await sql<{ id: number }[]>`
      insert into analysis_zones (name, geom)
      values (${name}, st_makepolygon(st_geomfromtext(${lineWkt(ring)}, 4326)))
      returning id`;
    return oneZone(row.id);
  });

  // A new outline changes no analysis already made: each keeps its own copy (D25).
  app.patch('/api/analysis/zones/:id', async (req): Promise<Zone> => {
    const id = idOf(req.params);
    const { name, ring } = zoneChangesOf(req.body);
    const geom = ring ? sql`st_makepolygon(st_geomfromtext(${lineWkt(ring)}, 4326))` : sql`geom`;
    const updated = await sql`
      update analysis_zones
      set name = coalesce(${name ?? null}, name), geom = ${geom}, updated_at = now()
      where id = ${id} returning id`;
    if (updated.length === 0) throw notFound('Zone');
    return oneZone(id);
  });

  // Analyses keep their own copy of the zone, so deleting it changes none of them (D25).
  app.delete('/api/analysis/zones/:id', async (req): Promise<{ ok: true }> => {
    const deleted =
      await sql`delete from analysis_zones where id = ${idOf(req.params)} returning id`;
    if (deleted.length === 0) throw notFound('Zone');
    return { ok: true };
  });

  // ---- points of interest (FR-5) ----------------------------------------------------------------
  app.get(
    '/api/analysis/pois',
    async (): Promise<PointOfInterest[]> =>
      sql<PoiRow[]>`select ${poiColumns} from points_of_interest order by name, id`,
  );

  app.post('/api/analysis/pois', async (req): Promise<PointOfInterest> => {
    const { name, lon, lat, kind } = poiBodyOf(req.body);
    const [row] = await sql<{ id: number }[]>`
      insert into points_of_interest (name, kind, geom)
      values (${name}, ${kind ?? 'place'}, st_setsrid(st_makepoint(${lon}, ${lat}), 4326))
      returning id`;
    return onePoi(row.id);
  });

  app.patch('/api/analysis/pois/:id', async (req): Promise<PointOfInterest> => {
    const id = idOf(req.params);
    const current = await onePoi(id);
    const { name = current.name, lon = current.lon, lat = current.lat } = poiChangesOf(req.body);
    await sql`
      update points_of_interest
      set name = ${name}, geom = st_setsrid(st_makepoint(${lon}, ${lat}), 4326), updated_at = now()
      where id = ${id}`;
    return onePoi(id);
  });

  app.delete('/api/analysis/pois/:id', async (req): Promise<{ ok: true }> => {
    const deleted =
      await sql`delete from points_of_interest where id = ${idOf(req.params)} returning id`;
    if (deleted.length === 0) throw notFound('Point of interest');
    return { ok: true };
  });
}
