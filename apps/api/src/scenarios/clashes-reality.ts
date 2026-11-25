// The clash rules, part two: the reality checks, read from the database. The clashes are worded
// in clashes.ts.
import { DEAD_RUN_KMH, MODE_MAX_KMH, SAME_PLACE_M } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { visible, type Scenario } from './engine.ts';

/** Stretches no vehicle can run, vehicles that cannot reach their next trip, and new paths through a closure. */
export async function readRealityChecks(sql: Sql, sc: Scenario) {
  const visT = visible(sql, 't', sc);
  const mine = sql`t.scenario_id = ${sc.id} and ${visT}`;

  // ---------------------------------------------------------------------
  // Reality checks: what no vehicle can do. Each compares with the published timetable, because
  // the feed itself has oddities (hundreds of bus hops timed at over 150 km/h), and those are
  // not the scenario's doing.
  // ---------------------------------------------------------------------
  // 1. A stretch between two consecutive stops that the scenario's trip runs backwards in time, or
  //    faster than its mode can go in a straight line, unless a published trip runs that same
  //    stretch as fast.
  const limitModes = Object.keys(MODE_MAX_KMH);
  const speedRows = await sql`
    with calls as (
      select t.id, t.route_id, t.start_secs, st.seq, st.stop_id, st.arr, st.dep,
             lag(st.stop_id) over w as prev_stop, lag(st.dep) over w as prev_dep
      from trips t join stop_times st on st.trip_id = t.id
      where ${mine}
      window w as (partition by t.id order by st.seq)),
    hops as (
      select c.id, c.route_id, c.start_secs, c.seq, c.prev_stop, c.stop_id, c.prev_dep, c.arr - c.prev_dep as secs,
             (c.arr < c.prev_dep or c.dep < c.arr) as backwards,
             ST_DistanceSphere(a.geom, b.geom) as metres, a.name as from_name, b.name as to_name
      from calls c join stops a on a.id = c.prev_stop join stops b on b.id = c.stop_id
      where c.prev_stop is not null)
    select h.id as "tripId", h.seq, h.start_secs as "startSecs", h.prev_dep as "atSecs", h.secs, h.metres, h.backwards,
           h.from_name as "from", h.to_name as "to", h.prev_stop as "fromId", h.stop_id as "toId",
           coalesce(r.short_name, r.long_name, 'Trip') as line, r.id as "routeId", m.name as mode, lim.kmh
    from hops h
    join routes r on r.id = h.route_id
    join modes m on m.id = r.mode_id
    join unnest(${limitModes}::text[], ${limitModes.map((k) => MODE_MAX_KMH[k])}::float8[]) as lim(mode_id, kmh) on lim.mode_id = r.mode_id
    where h.backwards
       or (h.metres > 300 and h.secs * lim.kmh / 3.6 < h.metres
           and not exists (
             select 1 from stop_times x
             join stop_times y on y.trip_id = x.trip_id and y.seq = x.seq + 1
             join trips p on p.id = x.trip_id
             where x.stop_id = h.prev_stop and y.stop_id = h.stop_id and p.scenario_id is null and y.arr - x.dep <= h.secs))
    order by h.backwards desc, h.metres / greatest(h.secs, 1) desc
    limit 2000`;

  // 2. A vehicle whose next trip starts somewhere it cannot have reached. Looked for on every
  //    vehicle the scenario has touched: one that runs a trip the scenario made, or that lost one.
  //    Two published trips with nothing removed between them are the feed's own business.
  const placeRows = await sql`
    with days as (
      select t.vehicle_day_id as vd from trips t where ${mine} and t.vehicle_day_id is not null
      union
      select t.vehicle_day_id from scenario_removed x join trips t on t.id = x.trip_id
      where x.scenario_id = ${sc.id} and x.edit_seq <= ${sc.head} and t.vehicle_day_id is not null),
    run as (
      select t.id, t.vehicle_day_id, t.route_id, t.scenario_id, t.start_secs, t.end_secs, t.last_stop_id,
             lead(t.id) over w as next_id, lead(t.start_secs) over w as next_start, lead(t.first_stop_id) over w as next_first,
             lead(t.scenario_id) over w as next_scenario
      from trips t join days d on d.vd = t.vehicle_day_id
      where ${visT}
      window w as (partition by t.vehicle_day_id order by t.start_secs, t.id))
    select q.* from (
      select s.id as "tripId", s.next_id as "nextTripId", s.end_secs as "endSecs", s.next_start as "nextStart", s.start_secs as "startSecs",
             coalesce(r.short_name, r.long_name, 'Trip') as line, vd.label as vehicle, m.rule_set as "ruleSet",
             coalesce(lp.name, l.name) as "from", coalesce(fp.name, f.name) as "to",
             ST_DistanceSphere(coalesce(lp.geom, l.geom), coalesce(fp.geom, f.geom)) as metres
      from run s
      join routes r on r.id = s.route_id
      join modes m on m.id = r.mode_id
      join vehicle_days vd on vd.id = s.vehicle_day_id
      join stops l on l.id = s.last_stop_id
      join stops f on f.id = s.next_first
      left join stops lp on lp.id = l.parent_id and m.rule_set <> 'road'
      left join stops fp on fp.id = f.parent_id and m.rule_set <> 'road'
      where s.next_id is not null and s.next_start >= s.end_secs
        and (s.scenario_id is not null or s.next_scenario is not null or exists (
          select 1 from scenario_removed x join trips g on g.id = x.trip_id
          where x.scenario_id = ${sc.id} and x.edit_seq <= ${sc.head} and g.vehicle_day_id = s.vehicle_day_id
            and g.start_secs >= s.start_secs and g.start_secs <= s.next_start))) q
    where q.metres > case q."ruleSet" when 'rail' then ${SAME_PLACE_M.rail} when 'ferry' then ${SAME_PLACE_M.ferry} else ${SAME_PLACE_M.road} end::float8
      and (q."nextStart" - q."endSecs")
          * case q."ruleSet" when 'rail' then ${DEAD_RUN_KMH.rail} when 'ferry' then ${DEAD_RUN_KMH.ferry} else ${DEAD_RUN_KMH.road} end::float8 / 3.6 < q.metres
    order by q.metres / greatest(1, q."nextStart" - q."endSecs") desc
    limit 200`;

  // 3. A path the scenario made after a closure that runs through it. (Trips that were already
  //    running through, by choice or because no way round was found, are in the closure's own summary.)
  const closureRows = await sql`
    select c.label, r.id as "routeId", coalesce(r.short_name, r.long_name, 'Line') as line, count(*)::int as trips,
           min(t.id) as "tripId", min(t.start_secs) as "startSecs"
    from scenario_closures c
    join shapes sh on sh.scenario_id = ${sc.id} and sh.created_edit > c.created_edit and sh.created_edit <= ${sc.head} and ST_Intersects(sh.geom, c.geom)
    join trips t on t.shape_id = sh.id
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    where c.scenario_id = ${sc.id} and c.created_edit <= ${sc.head} and ${visT}
      and (c.kind = 'cut' or (c.kind = 'road' and m.rule_set = 'road') or c.kind = r.mode_id)
      and (c.from_secs is null or (t.start_secs < c.to_secs and t.end_secs > c.from_secs))
    group by c.id, c.label, r.id
    order by trips desc
    limit 60`;
  return { speedRows, placeRows, closureRows };
}
