// skipStop edits: a trip, or every trip of its stop pattern, runs through a stop without stopping.
import { SKIP_PENALTY } from './assumptions.ts';
import { describe } from '../describe.ts';
import { minutes } from '../wording.ts';
import { cloneTrips, visible, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

/** How many seconds a trip saves by running through a stop, learned from the timetable where possible. */
async function skipSaving(
  tx: Tx,
  baselineId: number,
  tripId: number,
  stopSeq: number,
  ruleSet: string,
) {
  const stops = await tx`
    select st.seq, st.arr, st.dep, coalesce(s.parent_id, s.id) as station,
           (st.pickup_type = 1 and st.drop_off_type = 1) as passing
    from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${tripId} order by st.seq`;
  const i = stops.findIndex((s) => s.seq === stopSeq);
  if (i <= 0 || i >= stops.length - 1)
    throw fail(400, 'The first and last stops cannot be skipped');
  if (stops[i].passing) throw fail(400, 'This trip already runs through that stop');
  // Nearest real stops either side.
  let a = i - 1;
  while (a > 0 && stops[a].passing) a--;
  let c = i + 1;
  while (c < stops.length - 1 && stops[c].passing) c++;
  const current = stops[c].arr - stops[a].dep;
  // Trips in the baseline that already run between those two stations without stopping.
  const [observed] = await tx`
    with runs as (
      select st.trip_id, st.dep, coalesce(s.parent_id, s.id) as station,
             lead(coalesce(s.parent_id, s.id)) over w as next_station, lead(st.arr) over w as next_arr
      from stop_times st join stops s on s.id = st.stop_id
      where st.trip_id in (
          select st2.trip_id from stop_times st2 join stops s2 on s2.id = st2.stop_id
          join trips t2 on t2.id = st2.trip_id
          where coalesce(s2.parent_id, s2.id) = ${stops[a].station} and t2.scenario_id is null and t2.baseline_id = ${baselineId})
        and not (st.pickup_type = 1 and st.drop_off_type = 1)
      window w as (partition by st.trip_id order by st.seq))
    select count(*)::int as n, percentile_cont(0.5) within group (order by next_arr - dep) as median
    from runs where station = ${stops[a].station} and next_station = ${stops[c].station}`;
  const fallback = current - (stops[i].dep - stops[i].arr) - (SKIP_PENALTY[ruleSet] ?? 20);
  let target =
    observed.n >= 3 && observed.median < current ? Math.round(observed.median) : fallback;
  target = Math.max(Math.round(current * 0.5), Math.min(current, target));
  return {
    saving: current - target,
    learned: observed.n >= 3 && observed.median < current,
    a: stops[a].seq,
    c: stops[c].seq,
  };
}

export async function editSkipStop(
  tx: Tx,
  sc: Scenario,
  seq: number,
  body: { tripId: number; stopSeq: number; scope?: 'trip' | 'pattern' },
) {
  const tripId = Number(body.tripId);
  const stopSeq = Number(body.stopSeq);
  const t = await describe(tx, tripId);
  const { saving, learned, a, c } = await skipSaving(
    tx,
    sc.baselineId,
    tripId,
    stopSeq,
    t.rule_set,
  );
  const [stop] =
    await tx`select s.name from stop_times st join stops s on s.id = st.stop_id where st.trip_id = ${tripId} and st.seq = ${stopSeq}`;
  let ids = [tripId];
  if (body.scope === 'pattern' && t.pattern_id) {
    const rows = await tx`
      select t.id from trips t where t.pattern_id = ${t.pattern_id} and ${visible(tx, 't', sc)}
        and exists (select 1 from stop_times st where st.trip_id = t.id and st.seq = ${stopSeq}
                    and not (st.pickup_type = 1 and st.drop_off_type = 1))`;
    ids = rows.map((r) => r.id);
  }
  const idMap = await cloneTrips(tx, sc, seq, ids, 0, {
    pinnedIds: body.scope === 'pattern' ? [] : [tripId],
    replace: true,
    keepVehicle: true,
  });
  const newIds = Object.values(idMap);
  // The stop stays in the trip as a pass-through, so the vehicle still follows the same path.
  // Times between the stops either side are re-spaced in proportion; everything after is earlier.
  // Each trip saves the same share of its own time between those two stops, never the clicked
  // trip's seconds: a trip that is quicker there than the clicked one would otherwise be given
  // more saving than it has time, and arrive before it left.
  const [clicked] = await tx`
    select y.arr - x.dep as gap from stop_times x join stop_times y on y.trip_id = x.trip_id and y.seq = ${c}
    where x.trip_id = ${tripId} and x.seq = ${a}`;
  const keep = clicked.gap > 0 ? Math.max(0.5, (clicked.gap - saving) / clicked.gap) : 1;
  await tx`
    update stop_times st set
      arr = case when st.seq >= ${c} then st.arr - b.saving
                 else b.a_dep + round((st.arr - b.a_dep) * b.ratio)::int end,
      dep = case when st.seq >= ${c} then st.dep - b.saving
                 when st.seq = ${stopSeq} then b.a_dep + round((st.arr - b.a_dep) * b.ratio)::int
                 else b.a_dep + round((st.dep - b.a_dep) * b.ratio)::int end,
      pickup_type = case when st.seq = ${stopSeq} then 1 else st.pickup_type end,
      drop_off_type = case when st.seq = ${stopSeq} then 1 else st.drop_off_type end
    from (
      select g.trip_id, g.a_dep, g.gap - g.target as saving, g.target::float8 / greatest(1, g.gap) as ratio
      from (
        select x.trip_id, x.dep as a_dep, greatest(0, y.arr - x.dep) as gap,
               greatest(0, round((y.arr - x.dep) * ${keep}::float8))::int as target
        from stop_times x join stop_times y on y.trip_id = x.trip_id and y.seq = ${c}
        where x.seq = ${a} and x.trip_id = any(${newIds})) g) b
    where st.trip_id = b.trip_id and st.seq > ${a}`;
  await tx`
    update trips t set end_secs = e.arr
    from (select st.trip_id, max(st.arr) as arr from stop_times st where st.trip_id = any(${newIds}) group by 1) e
    where t.id = e.trip_id`;
  const [{ backwards }] = await tx`
    select count(*)::int as backwards from (
      select st.arr, st.dep, lag(st.dep) over (partition by st.trip_id order by st.seq) as prev
      from stop_times st where st.trip_id = any(${newIds})) q
    where q.dep < q.arr or q.arr < q.prev`;
  if (backwards)
    throw fail(409, 'That would make a trip arrive before it left, so nothing was done');
  const name = String(stop.name).replace(/, Platform.*$/, '');
  return {
    summary: `${ids.length === 1 ? t.label : `${ids.length} ${t.line} trips`} now skip${ids.length === 1 ? 's' : ''} ${name}, saving ${ids.length === 1 ? '' : 'about '}${minutes(saving)}${ids.length === 1 ? '' : ' each'}${learned ? '' : ' (estimated)'}`,
    idMap,
    focusTripId: idMap[tripId],
  };
}
