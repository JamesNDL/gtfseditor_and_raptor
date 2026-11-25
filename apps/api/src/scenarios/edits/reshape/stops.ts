// Finding the stops a reshaped line calls at: loading them, the stop across the road, published
// run times between two stops, and which platform to use at a station.
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Scenario } from '../../engine.ts';
import { stopVisible } from '../../stops-visible.ts';
import type { StopRow } from './types.ts';

export async function loadStops(
  tx: Sql,
  sc: Scenario | null,
  baselineId: number,
  ids: number[],
): Promise<Map<number, StopRow>> {
  const rows = await tx`
    select s.id, s.name, s.location_type as "locationType", s.parent_id as "parentId", ST_X(s.geom) as lon, ST_Y(s.geom) as lat
    from stops s where s.id = any(${ids}) and s.baseline_id = ${baselineId} and ${stopVisible(tx, 's', sc)}`;
  return new Map(rows.map((r) => [r.id, r as unknown as StopRow]));
}

/**
 * The stop across the road: among the lines that call at a stop, the stop within 150 m that their
 * opposite direction calls at most often. Null for termini, one-way streets and loops.
 * A stop added by a scenario names its partner itself.
 */
export async function acrossTheRoad(tx: Sql, stopId: number) {
  const [named] = await tx`
    select o.id, o.name, o.location_type, ST_X(o.geom) as lon, ST_Y(o.geom) as lat, '{}'::bigint[] as platforms
    from stops s join stops o on o.id = s.partner_id where s.id = ${stopId}`;
  if (named) return named;
  const [partner] = await tx`
    select o.id, o.name, o.location_type, ST_X(o.geom) as lon, ST_Y(o.geom) as lat, '{}'::bigint[] as platforms,
           count(*) as uses, min(ST_Distance(o.geom::geography, s.geom::geography)) as metres
    from stops s
    join patterns p on p.baseline_id = s.baseline_id and p.scenario_id is null and p.stop_ids @> array[s.id]
    join patterns q on q.route_id = p.route_id and q.scenario_id is null and q.direction_id is distinct from p.direction_id
    join stops o on o.id = any(q.stop_ids) and o.id <> s.id and not (o.id = any(p.stop_ids))
      and ST_DWithin(o.geom::geography, s.geom::geography, 150)
    where s.id = ${stopId}
    group by o.id order by uses desc, metres limit 1`;
  return partner ?? null;
}

/** How long published trips take from one stop to a later one: how many do, and their median time. */
export async function publishedRunSecs(
  tx: Sql,
  fromStopId: number,
  toStopId: number,
): Promise<{ n: number; median: number }> {
  const [seen] = await tx`
    select count(*)::int as n, percentile_cont(0.5) within group (order by b.arr - a.dep) as median
    from stop_times a
    join stop_times b on b.trip_id = a.trip_id and b.seq > a.seq and b.stop_id = ${toStopId}
    join trips t on t.id = a.trip_id
    where a.stop_id = ${fromStopId} and t.scenario_id is null`;
  return { n: seen.n, median: Number(seen.median ?? 0) };
}

/**
 * The platform a line should use at a station: the one its trips in this direction already use
 * most, otherwise the first or second in platform order depending on direction.
 */
export async function pickPlatform(
  tx: Sql,
  sc: Scenario | null,
  stationId: number,
  routeId: number,
  direction: number | null,
  index: number,
  avoid = -1,
): Promise<number | null> {
  const rows = await tx`
    select c.id,
           (select count(*)::int from patterns p
            where p.route_id = ${routeId} and p.direction_id is not distinct from ${direction}::int and p.stop_ids @> array[c.id]) as uses
    from stops c where c.parent_id = ${stationId} and c.location_type = 0
      -- Not a platform of another scenario, or one this scenario has deleted.
      and ${stopVisible(tx, 'c', sc)}
    order by (cardinality(c.mode_ids) = 0), length(c.platform_code), c.platform_code, c.id`;
  if (!rows.length) return null;
  const used = [...rows].sort((a, b) => b.uses - a.uses)[0];
  if (used.uses > 0) return used.id;
  const others = rows.filter((r) => r.id !== avoid);
  const list = others.length ? others : rows;
  return list[Math.min(index, list.length - 1)].id;
}
