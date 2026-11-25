// Deleting a station, a stop or single platforms: one edit kind, `deleteStop`.
//
// The rule, which is the cautious one:
//   - One platform of a station that has others: every call there moves to another platform of the
//     same station, one the line already uses and that is free at that time, otherwise the least bad.
//   - A stop, a whole station, or a station's last platform: trips that call there in the middle of
//     their run no longer do, timed the way "skip a stop" times it; a trip that starts or ends there
//     is cut short to its next or previous stop and keeps its times at the stops it keeps; a trip
//     left with fewer than two stops is removed.
// Nothing is re-routed: every trip keeps its path and its vehicle. The deleted stops are rows in
// `scenario_removed_stops`; the trips are changed in the same edit, so nothing in the scenario
// still calls at a deleted stop. What needs no database is in packages/core/src/edits/delete-stop.ts.
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { scenarioOf, type Scenario } from '../engine.ts';
import { RAIL_MODES } from './delete-stop/assumptions.ts';
import { tidy } from './delete-stop/describe.ts';
import { planDeleteStop } from './delete-stop/plan.ts';
import type { DeleteStopBody, DeleteStopDeps } from './delete-stop/types.ts';

export type { DeleteStopBody } from './delete-stop/types.ts';

/** Deletes a station, a stop or platforms, and changes every trip that called there. One undoable edit. */
export async function editDeleteStop(
  tx: Sql,
  sc: Scenario,
  seq: number,
  body: DeleteStopBody,
  deps: DeleteStopDeps,
) {
  const plan = await planDeleteStop(tx, sc, body, deps);
  const clashesBefore = await deps.clashes(tx, sc);
  await tx`
    insert into scenario_removed_stops (scenario_id, stop_id, edit_seq)
    select ${sc.id}, u.id, ${seq} from unnest(${plan.removedStopIds}::bigint[]) as u(id)
    on conflict (scenario_id, stop_id) do update set edit_seq = excluded.edit_seq`;

  await deps.removeTrips(
    tx,
    sc,
    seq,
    plan.trips.filter((t) => t.removed).map((t) => t.id),
  );
  const changed = plan.trips.filter((t) => !t.removed);
  const changedIds = new Set(changed.map((t) => t.id));
  // Trips that only leave a stay-aboard group are copied too, so that the group can be renamed on them.
  const relinked = [...plan.blocks.keys()].filter((id) => !changedIds.has(id));
  const idMap = await deps.cloneTrips(tx, sc, seq, [...changedIds, ...relinked], 0, {
    replace: true,
    keepVehicle: true,
  });

  // Stop times: rows at the deleted stop go, and the rows whose time or platform changed are rewritten.
  const drops = changed.flatMap((t) => t.dropSeqs.map((s) => ({ trip: idMap[t.id], seq: s })));
  for (let i = 0; i < drops.length; i += 20_000) {
    const chunk = drops.slice(i, i + 20_000);
    await tx`
      delete from stop_times st using unnest(${chunk.map((d) => d.trip)}::bigint[], ${chunk.map((d) => d.seq)}::int[]) as u(trip_id, seq)
      where st.trip_id = u.trip_id and st.seq = u.seq`;
  }
  const rows = changed.flatMap((t) => t.changes.map((c) => ({ trip: idMap[t.id], ...c })));
  for (let i = 0; i < rows.length; i += 20_000) {
    const chunk = rows.slice(i, i + 20_000);
    await tx`
      update stop_times st set arr = u.arr, dep = u.dep, stop_id = u.stop_id
      from unnest(${chunk.map((r) => r.trip)}::bigint[], ${chunk.map((r) => r.seq)}::int[], ${chunk.map((r) => r.arr)}::int[],
                  ${chunk.map((r) => r.dep)}::int[], ${chunk.map((r) => r.stopId)}::bigint[]) as u(trip_id, seq, arr, dep, stop_id)
      where st.trip_id = u.trip_id and st.seq = u.seq`;
  }
  const newIds = changed.map((t) => idMap[t.id]);
  if (newIds.length) {
    await tx`
      update trips t set start_secs = f.dep, end_secs = l.arr, first_stop_id = f.stop_id, last_stop_id = l.stop_id
      from unnest(${newIds}::bigint[]) as u(id)
      join lateral (select st.dep, st.stop_id from stop_times st where st.trip_id = u.id order by st.seq limit 1) f on true
      join lateral (select st.arr, st.stop_id from stop_times st where st.trip_id = u.id order by st.seq desc limit 1) l on true
      where t.id = u.id`;
  }

  // Each changed trip gets a stop pattern without the deleted stop, shared by the trips that now
  // call at the same stops. A trip that ends somewhere new is signed for where it now ends.
  const groups = new Map<
    string,
    { patternId: number; stopIds: number[]; cutEnd: boolean; trips: number[] }
  >();
  for (const t of changed) {
    if (t.patternId === null) continue;
    const key = `${t.patternId}|${t.stopIds.join(',')}`;
    let g = groups.get(key);
    if (!g)
      groups.set(
        key,
        (g = { patternId: t.patternId, stopIds: t.stopIds, cutEnd: t.cutEnd, trips: [] }),
      );
    g.trips.push(idMap[t.id]);
  }
  const lastStops = [
    ...new Set(changed.filter((t) => t.cutEnd).map((t) => t.stopIds[t.stopIds.length - 1])),
  ];
  const names = new Map(
    (lastStops.length ? await tx`select id, name from stops where id = any(${lastStops})` : []).map(
      (s) => [s.id as number, tidy(String(s.name))],
    ),
  );
  let n = 0;
  for (const g of groups.values()) {
    const headsign = g.cutEnd ? (names.get(g.stopIds[g.stopIds.length - 1]) ?? null) : null;
    const [pattern] = await tx`
      insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
      select p.baseline_id, p.route_id, p.direction_id, p.shape_id, coalesce(${headsign}, p.headsign), ${g.stopIds}::bigint[], ${g.trips.length},
             ${`delstop-${sc.id}-${seq}-${++n}`}, ${sc.id}, ${seq}
      from patterns p where p.id = ${g.patternId}
      returning id`;
    if (!pattern) continue;
    await tx`update trips set pattern_id = ${pattern.id}, headsign = coalesce(${headsign}, headsign) where id = any(${g.trips})`;
  }
  // Trips with no stop pattern of their own still need the new headsign.
  for (const t of changed.filter((c) => c.cutEnd && c.patternId === null)) {
    const headsign = names.get(t.stopIds[t.stopIds.length - 1]);
    if (headsign) await tx`update trips set headsign = ${headsign} where id = ${idMap[t.id]}`;
  }

  // Stay-aboard groups split where the trips no longer meet.
  const renamed = new Map<string, number[]>();
  for (const [id, to] of plan.blocks) {
    if (idMap[id] === undefined) continue;
    const key = to.part === null ? '' : `${to.block}~${sc.id}.${seq}.${to.part}`;
    let list = renamed.get(key);
    if (!list) renamed.set(key, (list = []));
    list.push(idMap[id]);
  }
  for (const [block, ids] of renamed)
    await tx`update trips set feed_block_id = ${block === '' ? null : block} where id = any(${ids})`;

  // Trips that move can land on top of others, here or further along the line. The list of clashes
  // shows each one; the summary says how many there are now, so that none arrives unannounced.
  const clashesAfter = await deps.clashes(tx, { ...sc, head: seq });
  const many = (n: number) => (n >= 200 ? `${n} or more` : String(n));
  const clashNote =
    clashesAfter === clashesBefore
      ? ` The scenario has ${clashesAfter === 0 ? 'no clashes' : `${many(clashesAfter)} clash${clashesAfter === 1 ? '' : 'es'}, as before`}.`
      : ` Clashes in the scenario: ${many(clashesBefore)} before, ${many(clashesAfter)} now.`;
  return { summary: `${plan.summary}.${clashNote}`, idMap };
}

/** The preview request and what the map needs to draw deleted stops. */
export function deleteStopRoutes(
  app: FastifyInstance,
  sql: Sql,
  ctx: {
    loadScenario: (sql: Sql, id: number) => Promise<Scenario>;
    idParam: (req: never) => number;
    deps: DeleteStopDeps;
  },
) {
  /** What deleting a stop would do, with ?s= for a scenario. Changes nothing. */
  app.post('/api/delete-stop-preview', async (req) => {
    const sc = await scenarioOf(req, sql);
    const plan = await planDeleteStop(sql, sc, req.body as DeleteStopBody, ctx.deps);
    return {
      what: plan.what,
      label: plan.label,
      stationId: plan.stationId,
      stopIds: plan.removedStopIds,
      platforms: plan.platforms,
      placeWord: plan.placeWord,
      totals: plan.totals,
      lines: plan.lines.slice(0, 200),
      linesInAll: plan.lines.length,
      movedTo: plan.movedTo,
      vehicles: plan.vehicles,
      linksEnded: plan.linksEnded,
      warnings: plan.warnings,
      summary: plan.summary,
    };
  });

  /**
   * Stops this scenario has deleted, as GeoJSON for the map, with the same properties as the stops
   * in the map tiles. A bus stop's station row is left out, as it is from the tiles.
   */
  app.get('/api/scenarios/:id/deleted-stops', async (req) => {
    const sc = await ctx.loadScenario(sql, ctx.idParam(req as never));
    const rows = await sql`
      select s.id, s.name, s.mode_ids[1] as mode, s.location_type, s.parent_id, s.platform_code,
             (s.mode_ids && ${RAIL_MODES}::text[]) as rail, ST_X(s.geom) as lon, ST_Y(s.geom) as lat, g.edit_seq
      from scenario_removed_stops g join stops s on s.id = g.stop_id
      where g.scenario_id = ${sc.id} and g.edit_seq <= ${sc.head} and s.location_type in (0, 1)
        and (s.location_type = 0 or s.mode_ids && ${RAIL_MODES}::text[])`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: {
          stop_id: r.id,
          name: r.name,
          mode: r.mode,
          station: r.location_type === 1,
          rail: r.rail,
          platform: r.location_type === 0 && r.rail,
          code: r.platform_code,
          edit: r.edit_seq,
        },
      })),
    };
  });
}
