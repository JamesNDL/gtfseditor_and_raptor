// Platforms a call could use: the choices at a station, the best free one, and moving the calls of
// new trips off platforms another train is already using. The clash list and several edit kinds
// share these.
import type { Sql } from '@gtfs-editor/gtfs/db';
import { visible, type Scenario } from './engine.ts';
import { stopVisible } from './stops-visible.ts';
import { fail } from '../http.ts';

export interface PlatformChoice {
  id: number;
  name: string;
  platformCode: string | null;
  /** Nothing else calls or waits there while this trip would. */
  free: boolean;
  /** How many of this line's stop patterns already use it. */
  uses: number;
  current: boolean;
}

/**
 * The platforms a trip could use for one of its calls: the others at the same station, with whether
 * each is free for the time the trip is there (a minute either side) and whether the line already uses it.
 */
export async function platformChoices(
  tx: Sql,
  sc: Scenario | null,
  tripId: number,
  stopSeq: number,
): Promise<PlatformChoice[]> {
  const [call] = await tx`
    select st.stop_id, st.arr, st.dep, s.parent_id, t.route_id, t.vehicle_day_id, r.mode_id
    from stop_times st join stops s on s.id = st.stop_id join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
    where st.trip_id = ${tripId} and st.seq = ${stopSeq}`;
  if (!call) throw fail(404, 'That stop is not on this trip');
  if (call.parent_id === null) return [];
  const from = call.arr - 60;
  const to = call.dep + 60;
  const rows = await tx`
    select c.id, c.name, c.platform_code as "platformCode", (c.id = ${call.stop_id}) as current,
           (select count(*)::int from patterns p where p.route_id = ${call.route_id} and p.stop_ids @> array[c.id]) as uses,
           not exists (
             select 1 from stop_times so join trips t on t.id = so.trip_id
             where so.stop_id = c.id and so.trip_id <> ${tripId} and so.arr < ${to} and so.dep > ${from}
               and so.arr > ${from - 7200} and not (so.pickup_type = 1 and so.drop_off_type = 1) and ${visible(tx, 't', sc)})
           and not exists (
             -- A vehicle that ended a trip here and leaves from here again holds the platform in between.
             select 1 from trips a join trips b on b.vehicle_day_id = a.vehicle_day_id and b.first_stop_id = c.id
               and b.start_secs >= a.end_secs and b.start_secs <= a.end_secs + 3600 and b.id <> a.id
             where a.last_stop_id = c.id and a.end_secs < ${to} and b.start_secs > ${from} and a.end_secs > ${from - 3600}
               and a.id <> ${tripId} and b.id <> ${tripId}
               and ${visible(tx, 'a', sc)} and ${visible(tx, 'b', sc)}) as free
    from stops c
    where c.parent_id = ${call.parent_id} and c.location_type = 0 and (${call.mode_id} = any(c.mode_ids) or c.scenario_id is not null)
      and ${stopVisible(tx, 'c', sc)}
    order by length(c.platform_code), c.platform_code, c.id`;
  return rows as unknown as PlatformChoice[];
}

/** The best free platform for a call, preferring ones the line already uses, or null. */
export const bestFree = (choices: PlatformChoice[]): PlatformChoice | null =>
  choices.filter((c) => c.free && !c.current).sort((a, b) => b.uses - a.uses)[0] ?? null;

export async function movePlatform(tx: Sql, tripId: number, stopSeq: number, stopId: number) {
  await tx`update stop_times set stop_id = ${stopId} where trip_id = ${tripId} and seq = ${stopSeq}`;
  await tx`
    update trips t set
      first_stop_id = (select stop_id from stop_times where trip_id = t.id order by seq limit 1),
      last_stop_id = (select stop_id from stop_times where trip_id = t.id order by seq desc limit 1)
    where t.id = ${tripId}`;
}

/**
 * New trips copy the platforms of the trip they were made from, so they often land on top of
 * another train. Each such call is moved to a free platform at the same station that the line
 * already uses, where there is one. Returns how many calls were moved.
 */
export async function settlePlatforms(
  tx: Sql,
  sc: Scenario,
  seq: number,
  tripIds: number[],
): Promise<number> {
  if (!tripIds.length) return 0;
  const now = { ...sc, head: seq };
  const clashes = await tx`
    select distinct st.trip_id, st.seq, st.arr
    from stop_times st
    join trips t on t.id = st.trip_id
    join routes r on r.id = t.route_id
    join modes m on m.id = r.mode_id
    join stops s on s.id = st.stop_id
    join stop_times so on so.stop_id = st.stop_id and so.trip_id <> st.trip_id
      and so.arr < st.dep and st.arr < so.dep and not (so.pickup_type = 1 and so.drop_off_type = 1)
    join trips o on o.id = so.trip_id
    where st.trip_id = any(${tripIds}) and m.rule_set in ('rail', 'ferry') and s.parent_id is not null
      and not (st.pickup_type = 1 and st.drop_off_type = 1) and ${visible(tx, 'o', now)}
      and (t.vehicle_day_id is null or o.vehicle_day_id is distinct from t.vehicle_day_id)
    order by st.arr limit 400`;
  let moved = 0;
  for (const c of clashes) {
    const best = bestFree(await platformChoices(tx, now, c.trip_id, c.seq));
    if (!best || best.uses === 0) continue;
    await movePlatform(tx, c.trip_id, c.seq, best.id);
    moved++;
  }
  return moved;
}

export const platformNote = (moved: number) =>
  moved ? `; ${moved} call${moved === 1 ? '' : 's'} moved to a free platform` : '';
