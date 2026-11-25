// The clash rules, part one: reading the clashes between trips from the database. The clashes
// are worded, and fixes suggested, in clashes.ts.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { visible, type Scenario } from './engine.ts';

/** Two trips at one platform at once, a vehicle's trips overlapping, a waiting vehicle in the way, and trips with no vehicle. */
export async function readTripClashes(sql: Sql, sc: Scenario) {
  const visT = visible(sql, 't', sc);
  const visO = visible(sql, 'o', sc);
  const mine = sql`t.scenario_id = ${sc.id} and ${visT}`;

  const platform = await sql`
    select t.id as "tripId", o.id as "otherTripId", st.stop_id as "stopId", st.seq, s.name as "stopName",
           r.short_name as line, ro.short_name as "otherLine",
           greatest(st.arr, so.arr) as "fromSecs", least(st.dep, so.dep) as "toSecs",
           st.arr, so.dep as "otherDep", t.start_secs as "startSecs", o.start_secs as "otherStart"
    from trips t
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    join stop_times st on st.trip_id = t.id and not (st.pickup_type = 1 and st.drop_off_type = 1)
    join stops s on s.id = st.stop_id
    join stop_times so on so.stop_id = st.stop_id and so.trip_id <> st.trip_id
      and so.arr < st.dep and st.arr < so.dep and not (so.pickup_type = 1 and so.drop_off_type = 1)
    join trips o on o.id = so.trip_id
    join routes ro on ro.id = o.route_id
    where ${mine} and m.rule_set in ('rail', 'ferry') and ${visO}
      -- Report each pair once, and not the two halves of a through-running vehicle.
      and (o.scenario_id is null or o.id > t.id)
      and (t.vehicle_day_id is null or o.vehicle_day_id is distinct from t.vehicle_day_id)
    order by "fromSecs" limit 200`;

  const vehicle = await sql`
    select t.id as "tripId", o.id as "otherTripId", r.short_name as line, vd.label as vehicle,
           t.end_secs as "endSecs", o.start_secs as "otherStart", t.start_secs as "startSecs"
    from trips t
    join routes r on r.id = t.route_id
    join vehicle_days vd on vd.id = t.vehicle_day_id
    join trips o on o.vehicle_day_id = t.vehicle_day_id and o.id <> t.id
      and o.start_secs >= t.start_secs and o.start_secs < t.end_secs
    where (t.scenario_id = ${sc.id} or o.scenario_id = ${sc.id}) and ${visT} and ${visO}
      and (o.start_secs > t.start_secs or o.id > t.id)
    order by t.end_secs limit 200`;

  // A vehicle that ends a trip at a platform and starts its next from the same one holds it in between.
  // Reported when a trip the scenario made or retimed is the one waiting, or the one calling there.
  const changed = (alias: string) => {
    const t = sql(alias);
    return sql`(${t}.scenario_id = ${sc.id} and (${t}.origin_trip_id is null or exists (
      select 1 from trips og where og.id = ${t}.origin_trip_id
        and (og.start_secs <> ${t}.start_secs or og.end_secs <> ${t}.end_secs or og.first_stop_id <> ${t}.first_stop_id
             or og.last_stop_id <> ${t}.last_stop_id or og.vehicle_day_id is distinct from ${t}.vehicle_day_id))))`;
  };
  const waitingFor = (start: ReturnType<typeof sql>, where: ReturnType<typeof sql>) => sql`
    select a.id as "waitTripId", b.id as "nextTripId", o.id as "tripId", so.seq, a.last_stop_id as "stopId", s.name as "stopName",
           r.short_name as line, ro.short_name as "otherLine", a.end_secs as "from", b.start_secs as "to",
           so.arr, so.dep, o.start_secs as "startSecs", vd.label as vehicle
    from ${start}
    join routes r on r.id = a.route_id
    join modes m on m.id = r.mode_id
    join stops s on s.id = a.last_stop_id
    join vehicle_days vd on vd.id = a.vehicle_day_id
    join routes ro on ro.id = o.route_id
    where ${where} and m.rule_set in ('rail', 'ferry') and s.parent_id is not null
      and ${visible(sql, 'a', sc)} and ${visible(sql, 'b', sc)} and ${visO}
      and o.vehicle_day_id is distinct from a.vehicle_day_id
      and not exists (select 1 from trips c where c.vehicle_day_id = a.vehicle_day_id and c.id not in (a.id, b.id)
                      and c.start_secs >= a.end_secs and c.start_secs < b.start_secs and ${visible(sql, 'c', sc)})
    order by so.arr limit 60`;
  const waitJoin = sql`
    join trips b on b.vehicle_day_id = a.vehicle_day_id and b.first_stop_id = a.last_stop_id and b.id <> a.id
      and b.start_secs > a.end_secs and b.start_secs <= a.end_secs + 3600`;
  const callJoin = sql`
    join stop_times so on so.stop_id = a.last_stop_id and so.trip_id not in (a.id, b.id) and so.arr < b.start_secs and so.dep > a.end_secs
      and not (so.pickup_type = 1 and so.drop_off_type = 1)
    join trips o on o.id = so.trip_id`;
  const waiting = [
    // The waiting vehicle's trips are the scenario's.
    ...(await waitingFor(
      sql`trips a ${waitJoin} ${callJoin}`,
      sql`a.scenario_id = ${sc.id} and (${changed('a')} or ${changed('b')})`,
    )),
    // The trip calling there is the scenario's.
    ...(await waitingFor(
      sql`trips o
        join stop_times so on so.trip_id = o.id and not (so.pickup_type = 1 and so.drop_off_type = 1)
        join trips a on a.last_stop_id = so.stop_id and a.id <> o.id and a.end_secs < so.dep and a.end_secs > so.arr - 3600
        ${waitJoin} and b.id <> o.id and b.start_secs > so.arr`,
      sql`o.scenario_id = ${sc.id} and ${changed('o')} and not (a.scenario_id is not distinct from ${sc.id} and (${changed('a')} or ${changed('b')}))`,
    )),
  ];

  const [{ n: unassigned }] =
    await sql`select count(*)::int as n from trips t where ${mine} and t.vehicle_day_id is null`;
  return { platform, vehicle, waiting, unassigned };
}
