// headway edits: how often one stop pattern runs in one time band.
import { formatSecs } from '@gtfs-editor/core';
import { platformNote, settlePlatforms } from './deps.ts';
import { describe } from '../describe.ts';
import { assignVehicles } from '../vehicles.ts';
import { fleetNote, minutes } from '../wording.ts';
import { removeTrips, TRIP_COLUMNS, visible, type Scenario, type Tx } from '../engine.ts';
import { fail } from '../../http.ts';

export interface HeadwayBody {
  patternId: number;
  fromSecs: number;
  toSecs: number;
  headwaySecs: number;
}

export async function editHeadway(tx: Tx, sc: Scenario, seq: number, body: HeadwayBody) {
  const from = Math.round(Number(body.fromSecs));
  const to = Math.round(Number(body.toSecs));
  const headway = Math.round(Number(body.headwaySecs));
  if (!(to > from) || from < 0 || to > 30 * 3600)
    throw fail(
      400,
      'The time band must end after it starts, and no later than 06:00 the next morning',
    );
  if (!(headway >= 60) || headway > 4 * 3600)
    throw fail(400, 'Headway must be between 1 minute and 4 hours');
  const vis = visible(tx, 't', sc);
  const existing = await tx`
    select t.id, t.start_secs, t.pinned from trips t
    where t.pattern_id = ${Number(body.patternId)} and ${vis} order by t.start_secs`;
  if (!existing.length)
    throw fail(400, 'No trips use that stopping pattern, so there is nothing to copy');
  const middle = (from + to) / 2;
  // Copy the trip nearest the middle of the band: its run times are the most representative.
  const template = existing.reduce((best, t) =>
    Math.abs(t.start_secs - middle) < Math.abs(best.start_secs - middle) ? t : best,
  );
  const inBand = existing.filter((t) => t.start_secs >= from && t.start_secs < to);
  const pinned = inBand.filter((t) => t.pinned);
  const replaced = inBand.filter((t) => !t.pinned).map((t) => t.id);
  const starts: number[] = [];
  for (let s = from; s < to; s += headway) {
    // Leave room around hand-placed trips rather than doubling up on them.
    if (!pinned.some((p) => Math.abs(p.start_secs - s) < headway / 2)) starts.push(s);
  }
  const t = await describe(tx, template.id);
  await removeTrips(tx, sc, seq, replaced);
  let fleet = { reused: 0, added: 0 };
  let settled = 0;
  if (starts.length) {
    const created = await tx.unsafe(
      `insert into trips (${TRIP_COLUMNS}, gtfs_id, start_secs, end_secs, scenario_id, cloned_from, created_edit)
       select ${TRIP_COLUMNS},
              split_part(gtfs_id, '~', 1) || '~' || $1::int || '.' || $2::int || '.' || row_number() over (order by s.start),
              s.start, end_secs + (s.start - start_secs), $1::int, id, $2::int
       from trips, unnest($4::int[]) as s(start) where id = $3::bigint
       returning id, start_secs`,
      [sc.id, seq, template.id, starts] as never[],
    );
    await tx`
      insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
      select n.id, st.seq, st.stop_id, st.arr + (n.start_secs - ${template.start_secs}), st.dep + (n.start_secs - ${template.start_secs}),
             st.dist, st.pickup_type, st.drop_off_type, st.timepoint, st.headsign, st.note
      from trips n join stop_times st on st.trip_id = ${template.id}
      where n.id = any(${created.map((r) => r.id)})`;
    fleet = await assignVehicles(
      tx,
      sc,
      seq,
      created.map((r) => r.id),
    );
    settled = await settlePlatforms(
      tx,
      sc,
      seq,
      created.map((r) => r.id),
    );
  }
  return {
    summary: `${t.line}: every ${minutes(headway)} from ${formatSecs(from)} to ${formatSecs(to)} (${starts.length} trips, replacing ${replaced.length}${pinned.length ? `, keeping ${pinned.length} pinned` : ''})${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
  };
}
