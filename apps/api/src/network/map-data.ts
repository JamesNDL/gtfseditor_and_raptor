// What the map draws: animation packs, waits between trips and vector tiles.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vehicleWaits, type WaitTrip } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { packsDir } from '@gtfs-editor/gtfs/packs';
import { int, notFound } from '../http.ts';
import { scenarioOf } from '../scenarios/scenarios.ts';

// Packs live under <repo>/data/packs regardless of where the server is started from.
const PACKS_ROOT =
  process.env.PACKS_DIR ?? path.resolve(import.meta.dirname, '../../../../data/packs');

// Vector tiles: route lines and stops.
const tileCache = new Map<string, Buffer>();
const TILE_CACHE_MAX = 3000;

// The lowest zoom at which each mode's lines and stops are drawn.
const LINE_MIN_ZOOM: Record<string, number> = {
  train: 0,
  metro: 0,
  light_rail: 0,
  ferry: 0,
  coach: 7,
  bus: 10,
  school_bus: 12,
};

export function registerMapDataRoutes(app: FastifyInstance, sql: Sql) {
  // ---------------------------------------------------------------------------
  // Animation packs (binary, one per mode)
  // ---------------------------------------------------------------------------
  app.get('/api/baselines/:b/packs/:mode', async (req, reply) => {
    const { b, mode } = req.params as { b: string; mode: string };
    if (!/^[a-z_]+$/.test(mode)) throw notFound('Pack');
    const file = path.join(packsDir(int(b), PACKS_ROOT), `${mode}.bin`);
    const info = await stat(file).catch(() => null);
    if (!info) throw notFound('Pack');
    reply.header('content-type', 'application/octet-stream');
    reply.header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(file));
  });

  /**
   * Waits between trips, so the map keeps a vehicle drawn while it stands at its terminus: pairs of
   * [trip id, the second its vehicle's next trip starts] as 32-bit integers. With ?s= the vehicle days
   * are the scenario's, and its own trips are included.
   */
  app.get('/api/baselines/:b/waits', async (req, reply) => {
    const b = int((req.params as any).b);
    const sc = await scenarioOf(req, sql);
    // The published trips and the scenario's own are read separately and put together here: asking the
    // database which of 59,000 trips a scenario can see, one by one, takes several seconds.
    const read = (mine: ReturnType<typeof sql>) => sql<WaitTrip[]>`
      select t.id, t.vehicle_day_id as "vehicleDayId", t.start_secs as "startSecs", t.end_secs as "endSecs",
             t.first_stop_id as "firstStopId", t.last_stop_id as "lastStopId"
      from trips t
      where t.baseline_id = ${b} and ${mine}
        and t.vehicle_day_id is not null and t.start_secs is not null and t.end_secs is not null`;
    let trips: WaitTrip[] = await read(sql`t.scenario_id is null`);
    if (sc) {
      const [removed, own] = await Promise.all([
        sql`select trip_id from scenario_removed where scenario_id = ${sc.id} and edit_seq <= ${sc.head}`,
        read(
          sql`t.scenario_id = ${sc.id} and t.created_edit <= ${sc.head} and (t.removed_edit is null or t.removed_edit > ${sc.head})`,
        ),
      ]);
      const gone = new Set(removed.map((r) => r.trip_id as number));
      trips = [...trips.filter((t) => !gone.has(t.id)), ...own];
    }
    const ends = [
      ...new Set(trips.flatMap((t) => [t.firstStopId, t.lastStopId]).filter((id) => id !== null)),
    ];
    const stopRows = ends.length
      ? await sql`select id, parent_id, ST_X(geom) as lon, ST_Y(geom) as lat from stops where id = any(${ends})`
      : [];
    const stops = new Map(
      stopRows.map((s) => [
        s.id as number,
        { parentId: s.parent_id as number | null, lon: s.lon as number, lat: s.lat as number },
      ]),
    );
    const pairs = vehicleWaits(trips, stops);
    reply.header('content-type', 'application/octet-stream');
    // The published timetable never changes; a scenario does with every edit.
    reply.header('cache-control', sc ? 'no-store' : 'public, max-age=3600');
    return reply.send(Buffer.from(pairs.buffer, pairs.byteOffset, pairs.byteLength));
  });

  app.get('/api/baselines/:b/tiles/:z/:x/:y', async (req, reply) => {
    const p = req.params as Record<string, string>;
    const [b, z, x, y] = [int(p.b), int(p.z), int(p.x), int(p.y.replace('.mvt', ''))];
    if (z > 22 || x >= 2 ** z || y >= 2 ** z) throw notFound('Tile');
    const key = `${b}/${z}/${x}/${y}`;
    let tile = tileCache.get(key);
    if (!tile) {
      const lineModes = Object.keys(LINE_MIN_ZOOM).filter((m) => z >= LINE_MIN_ZOOM[m]);
      const geom = sql(z < 10 ? 'geom_lo' : z < 13 ? 'geom_mid' : 'geom_hi');
      const [row] = await sql`
        with bounds as (
          select ST_TileEnvelope(${z}, ${x}, ${y}) as merc,
                 ST_Transform(ST_TileEnvelope(${z}, ${x}, ${y}, margin => 0.02), 4326) as wgs),
        lines as (
          select ST_AsMVTGeom(l.${geom}, bounds.merc, 4096, 64, true) as geom,
                 l.route_id, l.mode_id as mode, l.color, l.name, l.trips
          from map_lines l, bounds
          where l.baseline_id = ${b} and l.mode_id = any(${lineModes}) and l.${geom} && bounds.merc),
        stations as (
          select ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds.merc, 4096, 64, true) as geom,
                 s.id as stop_id, s.name, s.mode_ids[1] as mode, true as station, true as rail, null::text as platform
          from stops s, bounds
          where s.baseline_id = ${b} and s.scenario_id is null and s.location_type = 1 and ${z} >= 9
            and s.mode_ids && array['train', 'metro', 'light_rail', 'ferry'] and s.geom && bounds.wgs),
        road_stops as (
          select ST_AsMVTGeom(ST_Transform(s.geom, 3857), bounds.merc, 4096, 64, true) as geom,
                 s.id as stop_id, s.name, s.mode_ids[1] as mode, false as station,
                 (s.mode_ids && array['train', 'metro', 'light_rail', 'ferry']) as rail, s.platform_code as platform
          from stops s, bounds
          where s.baseline_id = ${b} and s.scenario_id is null and s.location_type = 0 and ${z} >= 14
            and cardinality(s.mode_ids) > 0 and s.geom && bounds.wgs)
        select coalesce((select ST_AsMVT(l, 'lines') from lines l where l.geom is not null), ''::bytea)
            || coalesce((select ST_AsMVT(q, 'stops') from (select * from stations union all select * from road_stops) q
                         where q.geom is not null), ''::bytea) as tile`;
      tile = row.tile as Buffer;
      if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value!);
      tileCache.set(key, tile);
    }
    reply.header('content-type', 'application/vnd.mapbox-vector-tile');
    // Short browser cache: tile contents change whenever the tile query does.
    reply.header('cache-control', 'public, max-age=60');
    return reply.send(tile);
  });
}
