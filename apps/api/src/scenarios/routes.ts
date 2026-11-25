// Scenarios: edits layered over a baseline, with undo and redo. How an edit is applied, and what a
// scenario can see, is in engine.ts; each edit kind is in edits/.
import { COORD_SCALE, encodePack, simplifyIndices, type PackArrays } from '@gtfs-editor/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import {
  describeChange,
  describeNewStretches,
  describeStops,
  planOtherWay,
  planReshape,
  reshapeDeps,
  reshapeOptions,
  typicalChange,
  type ReshapeBody,
} from './edits/reshape.ts';
import { closureRoutes } from './edits/closure/routes.ts';
import { deleteStopRoutes } from './edits/delete-stop.ts';
import { scheduleRoutes } from './edits/schedule.ts';
import { closureDeps, deleteStopDeps } from './edits/deps.ts';
import { isEditKind, runEdit, type EditRequest } from './edits/registry.ts';
import { describeMethod, linePath } from '../routing/roads.ts';
import { findConflicts } from './clashes.ts';
import { scenarioStopsGeoJson } from './stops.ts';
import { applyEdit, dayFigures, scenarioOf, visible, type Scenario } from './engine.ts';
import { fail } from '../http.ts';

/** One stop time as the playback pack reads it. */
interface PackStopRow {
  trip_id: number;
  arr: number;
  dep: number;
  dist: number;
}

const loadScenario = async (sql: Sql, id: number): Promise<Scenario> => {
  const [row] =
    await sql`select id, baseline_id as "baselineId", head from scenarios where id = ${id}`;
  if (!row) throw fail(404, 'Scenario not found');
  return row as unknown as Scenario;
};
const idParam = (req: FastifyRequest) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id)) throw fail(400, 'Bad scenario id');
  return id;
};

export function registerScenarioRoutes(app: FastifyInstance, sql: Sql) {
  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  app.get('/api/scenarios', async (req) => {
    const baseline = Number((req.query as Record<string, string>).baseline);
    return sql`
      select id, name, head, baseline_id as "baselineId", created_at as "createdAt",
             (select count(*)::int from scenario_edits e where e.scenario_id = s.id) as "editCount",
             (select count(*)::int from sim_runs r where r.scenario_id = s.id) as "simRuns"
      from scenarios s where ${Number.isInteger(baseline) ? sql`baseline_id = ${baseline}` : sql`true`}
      order by created_at`;
  });

  app.post('/api/scenarios', async (req) => {
    const body = req.body as { baselineId: number; name?: string };
    const [b] = await sql`select id from baselines where id = ${Number(body.baselineId)} and ready`;
    if (!b) throw fail(400, 'Unknown day');
    const [{ n }] = await sql`select count(*)::int as n from scenarios where baseline_id = ${b.id}`;
    const name = (body.name ?? '').trim().slice(0, 80) || `Scenario ${n + 1}`;
    const [row] =
      await sql`insert into scenarios (baseline_id, name) values (${b.id}, ${name}) returning id, name, head, baseline_id as "baselineId"`;
    return { ...row, editCount: 0 };
  });

  /** Rename a scenario. */
  app.patch('/api/scenarios/:id', async (req) => {
    const name = String((req.body as { name?: unknown })?.name ?? '')
      .trim()
      .slice(0, 80);
    if (!name) throw fail(400, 'Give the scenario a name');
    const [row] =
      await sql`update scenarios set name = ${name} where id = ${idParam(req)} returning id, name, head, baseline_id as "baselineId"`;
    if (!row) throw fail(404, 'Scenario not found');
    return row;
  });

  app.delete('/api/scenarios/:id', async (req) => {
    await sql`delete from scenarios where id = ${idParam(req)}`;
    return { ok: true };
  });

  app.get('/api/scenarios/:id', async (req) => {
    const sc = await loadScenario(sql, idParam(req));
    const [info] =
      await sql`select id, name, head, baseline_id as "baselineId" from scenarios where id = ${sc.id}`;
    const edits =
      await sql`select seq, kind, summary, (seq <= ${sc.head}) as applied from scenario_edits where scenario_id = ${sc.id} order by seq`;
    const vis = visible(sql, 't', sc);
    const [stats] = await sql`
      select
        (select count(*)::int from trips t where t.baseline_id = ${sc.baselineId} and t.scenario_id is null) as "baselineTrips",
        (select count(*)::int from trips t where t.baseline_id = ${sc.baselineId} and ${vis}) as trips,
        (select count(*)::int from trips t where t.scenario_id = ${sc.id} and ${vis}) as "editedTrips",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.baseline_id = ${sc.baselineId} and ${vis}) as vehicles,
        (select count(distinct t.vehicle_day_id)::int from trips t where t.baseline_id = ${sc.baselineId} and t.scenario_id is null) as "baselineVehicles"`;
    const { conflicts, unassigned, capped } = await findConflicts(sql, sc);
    const day = await dayFigures(sql, sc.baselineId, sc);
    const publishedDay = await dayFigures(sql, sc.baselineId, null);
    // Every line the scenario has touched, before and after.
    const impact = await sql`
      with touched as (
        select t.route_id from trips t where t.scenario_id = ${sc.id} and ${vis}
        union
        select t.route_id from scenario_removed x join trips t on t.id = x.trip_id
        where x.scenario_id = ${sc.id} and x.edit_seq <= ${sc.head})
      select r.id as "routeId", coalesce(r.short_name, r.long_name) as name, coalesce(r.color, m.color) as color,
        (select count(*)::int from trips t where t.route_id = r.id and t.scenario_id is null) as "tripsBefore",
        (select count(*)::int from trips t where t.route_id = r.id and ${vis}) as "tripsAfter",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.route_id = r.id and t.scenario_id is null) as "vehiclesBefore",
        (select count(distinct t.vehicle_day_id)::int from trips t where t.route_id = r.id and ${vis}) as "vehiclesAfter",
        (select count(*)::int from trips t where t.route_id = r.id and t.scenario_id = ${sc.id} and ${vis}) as "changedTrips",
        (select coalesce(sum(v.seated + v.standing), 0)::int from trips t join trip_vehicle tv on tv.trip_id = t.id
           join vehicle_types v on v.id = tv.vehicle_type_id where t.route_id = r.id and t.scenario_id is null) as "placesBefore",
        (select coalesce(sum(v.seated + v.standing), 0)::int from trips t join trip_vehicle tv on tv.trip_id = t.id
           join vehicle_types v on v.id = tv.vehicle_type_id where t.route_id = r.id and ${vis}) as "placesAfter"
      from touched join routes r on r.id = touched.route_id join modes m on m.id = r.mode_id
      order by m.sort, r.short_name`;
    const fleet = await sql`
      select v.id, v.name, v.fleet_size as "fleetSize", count(distinct t.vehicle_day_id)::int as "inUse"
      from trips t join trip_vehicle tv on tv.trip_id = t.id join vehicle_types v on v.id = tv.vehicle_type_id
      where t.baseline_id = ${sc.baselineId} and ${vis} and v.fleet_size is not null
      group by v.id having count(distinct t.vehicle_day_id) > v.fleet_size
      order by v.name`;
    const [{ limits }] =
      await sql`select count(*) filter (where fleet_size is not null)::int as limits from vehicle_types`;
    return {
      ...info,
      edits,
      // peak: the most trips running at any one moment, a firmer measure of vehicles needed than the count of chains.
      stats: { ...stats, unassigned, peak: day.peak, baselinePeak: publishedDay.peak },
      conflicts,
      conflictsCapped: capped,
      impact,
      fleet,
      fleetLimitsSet: limits,
    };
  });

  app.post('/api/scenarios/:id/undo', async (req) => {
    const [row] =
      await sql`update scenarios set head = head - 1 where id = ${idParam(req)} and head > 0 returning head`;
    if (!row) throw fail(400, 'Nothing to undo');
    return row;
  });

  app.post('/api/scenarios/:id/redo', async (req) => {
    const id = idParam(req);
    const [row] = await sql`
      update scenarios set head = head + 1 where id = ${id}
        and head < (select coalesce(max(seq), 0) from scenario_edits where scenario_id = ${id}) returning head`;
    if (!row) throw fail(400, 'Nothing to redo');
    return row;
  });

  app.post('/api/scenarios/:id/edits', async (req) => {
    // The body is not checked yet (refactor stage 4), so the kind may be one there is no function for.
    const body = req.body as EditRequest;
    if (!isEditKind(body.kind)) throw fail(400, `Unknown edit "${body.kind}"`);
    // The editor sends `confirm: false` first: an edit that would add many vehicles then comes back
    // described, not applied, and is sent again with `confirm: true` once the user has seen the figure.
    return applyEdit(
      sql,
      idParam(req),
      body.kind,
      (tx, sc, seq) => runEdit(body.kind, tx, sc, seq, body),
      body.confirm !== false,
    );
  });

  /** The path a new line would take through these stops, for the preview while drawing. */
  app.post('/api/road-path', async (req) => {
    const body = req.body as {
      baselineId: number;
      stopIds: number[];
      modeId?: string;
      loop?: boolean;
    };
    const ids = (body.stopIds ?? []).map(Number).slice(0, 150);
    if (ids.length < 2) throw fail(400, 'Pick at least two stops');
    if (body.loop && ids[ids.length - 1] !== ids[0]) ids.push(ids[0]);
    const rows = await sql`
      select id, location_type, parent_id, ST_X(geom) as lon, ST_Y(geom) as lat from stops
      where id = any(${ids}) and baseline_id = ${Number(body.baselineId)}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (ids.some((id) => !byId.has(id))) throw fail(400, 'Unknown stop');
    const found = await linePath(
      sql,
      Number(body.baselineId),
      String(body.modeId ?? 'bus'),
      ids.map((id) => {
        const s = byId.get(id)!;
        return { id, lon: s.lon, lat: s.lat, stationId: s.location_type === 1 ? id : s.parent_id };
      }),
      { follow: true },
    );
    return {
      coords: found.coords,
      method: found.method,
      description: describeMethod(found.method),
    };
  });

  closureRoutes(app, sql, { loadScenario, idParam, deps: closureDeps });
  deleteStopRoutes(app, sql, { loadScenario, idParam: idParam as never, deps: deleteStopDeps });
  scheduleRoutes(app, sql);

  /** The stops of one stop pattern, in calling order, for the reshaping tool. */
  app.get('/api/patterns/:id/stops', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw fail(400, 'Bad pattern id');
    const [pattern] = await sql`
      select p.id, p.route_id as "routeId", coalesce(p.direction_id, 0) as direction, p.headsign from patterns p where p.id = ${id}`;
    if (!pattern) throw fail(404, 'Stop pattern not found');
    const stops = await sql`
      select s.id, s.name, s.parent_id as "parentId", ST_X(s.geom) as lon, ST_Y(s.geom) as lat
      from patterns p cross join unnest(p.stop_ids) with ordinality as o(stop_id, n)
      join stops s on s.id = o.stop_id where p.id = ${id} order by o.n`;
    return { ...pattern, stops };
  });

  /** What a reshape would do, for the preview while the stops are being changed. Changes nothing. */
  app.post('/api/reshape-preview', async (req) => {
    const body = req.body as ReshapeBody;
    const sc = await scenarioOf(req, sql);
    const options = reshapeOptions(body);
    const plan = await planReshape(
      sql,
      sc,
      Number(body.patternId),
      body.stopIds ?? [],
      options,
      reshapeDeps,
    );
    const other =
      body.bothWays === false ? null : await planOtherWay(sql, sc, plan, options, reshapeDeps);
    const side = async (p: typeof plan) => ({
      coords: p.coords,
      added: p.added,
      removed: p.removed,
      trips: p.tripIds.length,
      change: describeChange(await typicalChange(sql, p)),
      what: describeStops(p),
    });
    return {
      ...(await side(plan)),
      stretches: describeNewStretches(plan),
      stops: plan.stops.map((s) => ({
        id: s.id,
        name: s.name,
        lon: s.lon,
        lat: s.lat,
        parentId: s.parentId,
      })),
      otherWay: !other
        ? null
        : 'plan' in other
          ? await side(other.plan)
          : 'reason' in other
            ? { reason: other.reason }
            : { same: true },
    };
  });

  /** Stops this scenario added, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/stops', async (req) =>
    scenarioStopsGeoJson(sql, await loadScenario(sql, idParam(req))),
  );

  /** Lines this scenario created or reshaped, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/lines', async (req) => {
    const sc = await loadScenario(sql, idParam(req));
    const rows = await sql`
      select r.id, coalesce(r.short_name, '') as name, r.mode_id, coalesce(r.color, m.color) as color, ST_AsGeoJSON(s.geom) as geometry
      from routes r join modes m on m.id = r.mode_id
      join patterns p on p.route_id = r.id
      join shapes s on s.id = p.shape_id
      where p.scenario_id = ${sc.id} and p.created_edit <= ${sc.head}
        -- A pattern that has since been reshaped again, or cut by a closure, has no trips left and is not drawn.
        and exists (select 1 from trips t where t.pattern_id = p.id and ${visible(sql, 't', sc)})`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geometry),
        properties: { route_id: r.id, name: r.name, mode: r.mode_id, color: `#${r.color}` },
      })),
    };
  });

  /** Baseline trips this scenario has removed or replaced, so the map can stop drawing them. */
  app.get('/api/scenarios/:id/removed', async (req) => {
    const sc = await loadScenario(sql, idParam(req));
    const rows =
      await sql`select trip_id from scenario_removed where scenario_id = ${sc.id} and edit_seq <= ${sc.head}`;
    return rows.map((r) => r.trip_id);
  });

  /** The scenario's own trips as an animation pack, in the same format as the per-mode packs. */
  app.get('/api/scenarios/:id/pack', async (req, reply) => {
    const sc = await loadScenario(sql, idParam(req));
    const trips = await sql`
      select t.id, t.route_id, t.start_secs, t.end_secs, t.shape_id from trips t
      where t.scenario_id = ${sc.id} and ${visible(sql, 't', sc)} and t.shape_id is not null
      order by t.start_secs, t.id`;
    const shapeIds = [...new Set(trips.map((t) => t.shape_id))];
    const shapeRows = shapeIds.length
      ? await sql`
          select s.id, s.length_m, s.dists,
                 array(select ST_X((dp).geom) from ST_DumpPoints(s.geom) dp order by (dp).path[1]) as lon,
                 array(select ST_Y((dp).geom) from ST_DumpPoints(s.geom) dp order by (dp).path[1]) as lat
          from shapes s where s.id = any(${shapeIds})`
      : [];
    const shapeIndex = new Map<number, number>();
    const shapes = shapeRows.map((row, i) => {
      shapeIndex.set(row.id, i);
      const lon = row.lon as number[];
      const lat = row.lat as number[];
      // Distance along the line, scaled to the feed's own total so it lines up with the stop times.
      const dist = new Float64Array(lon.length);
      for (let k = 1; k < lon.length; k++) {
        const dx = (lon[k] - lon[k - 1]) * 111_320 * Math.cos((lat[k] * Math.PI) / 180);
        const dy = (lat[k] - lat[k - 1]) * 110_540;
        dist[k] = dist[k - 1] + Math.hypot(dx, dy);
      }
      const scale =
        dist[lon.length - 1] > 0 && row.length_m ? row.length_m / dist[lon.length - 1] : 1;
      const stored = row.dists as number[] | null;
      const keep = simplifyIndices(lon, lat, 8);
      return {
        lon: Int32Array.from(keep, (k) => Math.round(lon[k] * COORD_SCALE)),
        lat: Int32Array.from(keep, (k) => Math.round(lat[k] * COORD_SCALE)),
        dist: Float32Array.from(keep, (k) =>
          stored && stored.length === lon.length ? stored[k] : dist[k] * scale,
        ),
      };
    });

    const n = trips.length;
    const stops = n
      ? await sql<PackStopRow[]>`
          select st.trip_id, st.arr, st.dep, coalesce(st.dist, 0)::float4 as dist from stop_times st
          where st.trip_id = any(${trips.map((t) => t.id)}) order by st.trip_id, st.seq`
      : [];
    const byTrip = new Map<number, PackStopRow[]>();
    for (const s of stops) {
      let list = byTrip.get(s.trip_id);
      if (!list) byTrip.set(s.trip_id, (list = []));
      list.push(s);
    }
    const tripStOffset = new Uint32Array(n + 1);
    trips.forEach(
      (t, i) => (tripStOffset[i + 1] = tripStOffset[i] + (byTrip.get(t.id)?.length ?? 0)),
    );
    const total = tripStOffset[n];
    const shapePtOffset = new Uint32Array(shapes.length + 1);
    shapes.forEach((s, i) => (shapePtOffset[i + 1] = shapePtOffset[i] + s.lon.length));
    const points = shapePtOffset[shapes.length];
    const arrays: PackArrays = {
      tripId: Int32Array.from(trips, (t) => t.id),
      tripRoute: Int32Array.from(trips, (t) => t.route_id),
      tripStart: Int32Array.from(trips, (t) => t.start_secs),
      tripEnd: Int32Array.from(trips, (t) => t.end_secs),
      tripShape: Int32Array.from(trips, (t) => shapeIndex.get(t.shape_id)!),
      tripStOffset,
      stArr: new Int32Array(total),
      stDep: new Int32Array(total),
      stDist: new Float32Array(total),
      shapePtOffset,
      ptLon: new Int32Array(points),
      ptLat: new Int32Array(points),
      ptDist: new Float32Array(points),
    };
    trips.forEach((t, i) =>
      (byTrip.get(t.id) ?? []).forEach((s, k) => {
        arrays.stArr[tripStOffset[i] + k] = s.arr;
        arrays.stDep[tripStOffset[i] + k] = s.dep;
        arrays.stDist[tripStOffset[i] + k] = s.dist;
      }),
    );
    shapes.forEach((s, i) => {
      arrays.ptLon.set(s.lon, shapePtOffset[i]);
      arrays.ptLat.set(s.lat, shapePtOffset[i]);
      arrays.ptDist.set(s.dist, shapePtOffset[i]);
    });
    const bytes = encodePack(
      {
        version: 1,
        modeId: 'scenario',
        tripCount: n,
        stopTimeCount: total,
        shapeCount: shapes.length,
        pointCount: points,
      },
      arrays,
    );
    reply.header('content-type', 'application/octet-stream');
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}
