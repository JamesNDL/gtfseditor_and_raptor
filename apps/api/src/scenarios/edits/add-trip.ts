// addTrip edits: a new trip on a line, copied from the trip nearest in time.
import { formatSecs } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { platformNote, settlePlatforms } from '../platforms.ts';
import { describe } from '../describe.ts';
import { stopDeleted } from '../stops-visible.ts';
import { assignVehicles } from '../vehicles.ts';
import { fleetNote } from '../wording.ts';
import { cloneTrips, visible, type Scenario } from '../engine.ts';
import { fail } from '../../http.ts';

export interface AddTripBody {
  routeId: number;
  direction?: number;
  startSecs: number;
  patternId?: number;
}

/** Adds a trip to a line at a given time: a copy of the trip nearest in time in that direction. */
export async function editAddTrip(tx: Sql, sc: Scenario, seq: number, body: AddTripBody) {
  const routeId = Number(body.routeId);
  const start = Math.round(Number(body.startSecs));
  if (!Number.isFinite(start) || start < 0 || start > 36 * 3600)
    throw fail(400, 'Bad departure time');
  const direction = Number(body.direction ?? 0);
  // The stop pattern asked for, otherwise the most-used one in that direction. A line whose trips have
  // all been deleted falls back to the published ones, so a trip can be made from nothing.
  const mostUsed = async (vis: unknown) => {
    const [row] = await tx`
      select t.pattern_id from trips t
      where t.route_id = ${routeId} and t.baseline_id = ${sc.baselineId} and coalesce(t.direction_id, 0) = ${direction}
        and t.pattern_id is not null and ${vis as never}
      group by t.pattern_id order by count(*) desc limit 1`;
    return row?.pattern_id as number | undefined;
  };
  const published = tx`t.scenario_id is null`;
  const pattern = body.patternId
    ? Number(body.patternId)
    : ((await mostUsed(visible(tx, 't', sc))) ?? (await mostUsed(published)));
  if (!pattern) throw fail(400, 'This line has no trip in that direction to model the new one on');
  const nearest = async (vis: unknown) => {
    const [row] = await tx`
      select t.id, t.start_secs from trips t
      where t.pattern_id = ${pattern} and t.route_id = ${routeId} and ${vis as never}
      order by abs(t.start_secs - ${start}), t.id limit 1`;
    return row;
  };
  const template = (await nearest(visible(tx, 't', sc))) ?? (await nearest(published));
  if (!template) throw fail(400, 'This line has no trip in that direction to model the new one on');
  const t = await describe(tx, template.id);
  const idMap = await cloneTrips(tx, sc, seq, [template.id], start - template.start_secs, {
    pinnedIds: [template.id],
    replace: false,
    keepVehicle: false,
  });
  const newId = idMap[template.id];
  // A line whose trips were all deleted is copied from the published ones, which may still call at
  // a stop this scenario has deleted. Such a trip is not made: nothing may call at a deleted stop.
  const [atDeleted] = await tx`
    select s.name from stop_times st join stops s on s.id = st.stop_id
    where st.trip_id = ${newId} and ${stopDeleted(tx, 's', sc)} limit 1`;
  if (atDeleted)
    throw fail(
      400,
      `The trip this would be copied from calls at ${atDeleted.name}, which this scenario has deleted`,
    );
  const fleet = await assignVehicles(tx, sc, seq, [newId]);
  const moved = await settlePlatforms(tx, sc, seq, [newId]);
  return {
    summary: `Added a ${t.line} trip departing ${formatSecs(start)}, timed like the ${formatSecs(template.start_secs)}${fleetNote(fleet)}${platformNote(moved)}`,
    idMap: {},
    focusTripId: newId,
  };
}
