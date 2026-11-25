// Read-only routes for the trip panel: which platforms a call could use, and which stops a trip
// could add.
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { platformChoices } from './platforms.ts';
import { scenarioOf } from './engine.ts';
import { stopVisible } from './stops-visible.ts';
import { fail } from '../http.ts';

/** Read-only helpers for the trip panel: which platforms a call could use, and which stops a trip could add. */
export function scheduleRoutes(app: FastifyInstance, sql: Sql) {
  app.get('/api/trips/:id/platforms', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const seq = Number((req.query as Record<string, string>).seq);
    if (!Number.isInteger(id) || !Number.isInteger(seq)) throw fail(400, 'Bad trip or stop');
    return platformChoices(sql, await scenarioOf(req, sql), id, seq);
  });

  app.get('/api/trips/:id/addable-stops', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw fail(400, 'Bad trip id');
    const sc = await scenarioOf(req, sql);
    const [trip] = await sql`
      select t.id, t.route_id, coalesce(t.direction_id, 0) as direction, t.shape_id, r.mode_id, m.rule_set, t.baseline_id
      from trips t join routes r on r.id = t.route_id join modes m on m.id = r.mode_id where t.id = ${id}`;
    if (!trip) throw fail(404, 'Trip not found');
    const calls = await sql`
      select st.seq, st.stop_id as "stopId", s.name, coalesce(s.parent_id, s.id) as station, coalesce(st.dist, 0)::float8 as dist,
             (st.pickup_type = 1 and st.drop_off_type = 1) as passing
      from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${id} order by st.seq`;
    if (calls.length < 2 || trip.shape_id === null) return [];
    const road = trip.rule_set === 'road';
    const near = await sql`
      select s.id, s.name, s.parent_id as "parentId", s.platform_code as "platformCode",
             ST_LineLocatePoint(sh.geom, s.geom) * sh.length_m as along,
             ST_Distance(sh.geom::geography, s.geom::geography) as off,
             (select count(*)::int from patterns p where p.route_id = ${trip.route_id} and coalesce(p.direction_id, 0) = ${trip.direction} and p.stop_ids @> array[s.id]) as uses,
             exists (select 1 from patterns p where p.route_id = ${trip.route_id} and coalesce(p.direction_id, 0) <> ${trip.direction} and p.stop_ids @> array[s.id]) as "otherWay"
      from shapes sh join stops s on ST_DWithin(s.geom, sh.geom, 0.0015)
      where sh.id = ${trip.shape_id} and s.baseline_id = ${trip.baseline_id} and s.location_type = 0
        and (${trip.mode_id} = any(s.mode_ids) or s.scenario_id is not null) and ${stopVisible(sql, 's', sc)}`;
    const called = new Set(calls.filter((c) => !c.passing).map((c) => c.station));
    const inTrip = new Set(calls.map((c) => c.stopId));
    const first = calls[0].dist;
    const last = calls[calls.length - 1].dist;
    const after = (along: number) =>
      [...calls].reverse().find((c) => !c.passing && c.dist <= along)?.name ?? calls[0].name;
    const out: { stopId: number; name: string; along: number; restore: boolean; after: string }[] =
      calls
        .filter((c) => c.passing)
        .map((c) => ({
          stopId: c.stopId,
          name: c.name,
          along: c.dist,
          restore: true,
          after: after(c.dist - 1),
        }));
    // One platform per station: the one this line already uses that way, otherwise the nearest to the path.
    const best = new Map<number, (typeof near)[number]>();
    for (const s of near) {
      if (inTrip.has(s.id) || called.has(s.parentId ?? s.id)) continue;
      // The stop across the road serves the other direction.
      if (road && s.otherWay && s.uses === 0) continue;
      if (s.off > (road ? 35 : 120) || s.along <= first + 30 || s.along >= last - 30) continue;
      const key = s.parentId ?? s.id;
      const held = best.get(key);
      if (!held || s.uses > held.uses || (s.uses === held.uses && s.off < held.off))
        best.set(key, s);
    }
    for (const s of best.values())
      out.push({
        stopId: s.id,
        name: s.name,
        along: s.along,
        restore: false,
        after: after(s.along),
      });
    return out.sort((a, b) => a.along - b.along).slice(0, 120);
  });
}
