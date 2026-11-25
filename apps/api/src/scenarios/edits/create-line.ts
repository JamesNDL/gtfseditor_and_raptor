// createLine edits: a new line through existing stops.
import { bandOf, DAY_BANDS, distanceM, formatSecs, locateStops } from '@gtfs-editor/core';
import { acrossTheRoad, ROAD_MODES } from './reshape.ts';
import { describeMethod, linePath, type PathMethod } from '../../routing/roads.ts';
import { describeTimes, sectionTime, stopDwell, type SectionTime } from '../../routing/timings.ts';
import { NEW_LINE } from './assumptions.ts';
import { platformNote, settlePlatforms } from './deps.ts';
import { assignVehicles } from '../vehicles.ts';
import { stopVisible } from '../stops-visible.ts';
import { fleetNote, minutes } from '../wording.ts';
import type { Scenario, Tx } from '../engine.ts';
import { fail } from '../../http.ts';

export interface CreateLineBody {
  name: string;
  modeId: string;
  color?: string;
  stopIds: number[];
  headwaySecs?: number;
  fromSecs?: number;
  toSecs?: number;
  followRoads?: boolean;
  /** Runs one way round and back to the first stop, with no return direction. */
  loop?: boolean;
}

/**
 * Creates a new line through existing stops, with a timetable in both directions, or in one
 * direction only for a loop that runs round and back to where it started.
 * The path follows roads, or the track and ferry routes that published services already use.
 */
export async function editCreateLine(tx: Tx, sc: Scenario, seq: number, body: CreateLineBody) {
  const follow = body.followRoads !== false;
  const loop = body.loop === true;
  let pathMethod: PathMethod = 'straight';
  const name = (body.name ?? '').trim().slice(0, 40);
  if (!name) throw fail(400, 'Give the line a name');
  const model = NEW_LINE[body.modeId];
  if (!model) throw fail(400, 'Choose a mode');
  const color = /^[0-9A-Fa-f]{6}$/.test(body.color ?? '') ? body.color!.toUpperCase() : null;
  const headway = Math.round(Number(body.headwaySecs ?? 900));
  const from = Math.round(Number(body.fromSecs ?? 6 * 3600));
  const to = Math.round(Number(body.toSecs ?? 22 * 3600));
  if (!(headway >= 60) || headway > 4 * 3600 || !(to > from) || from < 0 || to > 30 * 3600) {
    throw fail(
      400,
      'Give a frequency between 1 minute and 4 hours, and hours between the start of the day and 06:00 the next morning',
    );
  }
  const chosen = (body.stopIds ?? []).map(Number);
  if (chosen.length < 2 || chosen.length > 150) throw fail(400, 'Pick at least two stops');
  // A loop comes back to where it started.
  if (loop && chosen[chosen.length - 1] !== chosen[0]) chosen.push(chosen[0]);
  if (loop && chosen.length < 4)
    throw fail(
      400,
      'A loop needs at least three stops, so that it goes round rather than out and back',
    );
  for (let i = 1; i < chosen.length; i++)
    if (chosen[i] === chosen[i - 1]) throw fail(400, 'The same stop is listed twice in a row');

  const rows = await tx`
    select s.id, s.name, s.location_type, s.parent_id, ST_X(s.geom) as lon, ST_Y(s.geom) as lat,
           array(select c.id from stops c where c.parent_id = s.id and c.location_type = 0 and ${stopVisible(tx, 'c', sc)}
                 order by (cardinality(c.mode_ids) = 0), length(c.platform_code), c.platform_code, c.id) as platforms
    from stops s where s.id = any(${chosen}) and s.baseline_id = ${sc.baselineId} and ${stopVisible(tx, 's', sc)}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (chosen.some((id) => !byId.has(id))) throw fail(400, 'One of those stops is not on this day');
  const stops = chosen.map((id) => byId.get(id)!);
  // A station was clicked: use one of its platforms, a different one each way where there are two.
  const platform = (s: (typeof stops)[number], direction: number): number => {
    if (s.location_type !== 1) return s.id;
    const list = s.platforms as number[];
    if (!list.length) throw fail(400, `${s.name} has no platforms to stop at`);
    return list[Math.min(direction, list.length - 1)];
  };

  const tidy = (stopName: string) => stopName.replace(/,.*$/, '').replace(/ Station$/, '');
  // A loop is named after the stop furthest from where it starts.
  const furthest = stops.reduce((best, s) =>
    distanceM(stops[0].lon, stops[0].lat, s.lon, s.lat) >
    distanceM(stops[0].lon, stops[0].lat, best.lon, best.lat)
      ? s
      : best,
  );
  const longName = loop
    ? `${tidy(stops[0].name)} loop via ${tidy(furthest.name)}`
    : `${stops[0].name.replace(/,.*$/, '')} to ${stops[stops.length - 1].name.replace(/,.*$/, '')}`;
  const [route] = await tx`
    insert into routes (baseline_id, gtfs_id, agency_gtfs_id, agency_name, short_name, long_name, route_type, mode_id, color,
                        scenario_id, created_edit)
    values (${sc.baselineId}, ${`NEW-${sc.id}-${seq}`}, 'NEW', 'New services', ${name},
            ${longName},
            ${model.routeType}, ${body.modeId}, ${color}, ${sc.id}, ${seq})
    returning id`;

  // Road vehicles stop on the left, so the way back uses the stop across the road. A stop's partner
  // is found from the published timetable: among the lines that call at it, the stop within 150 m
  // that their opposite direction calls at most often. Stops with no partner (termini, one-way
  // streets, loops) are used both ways.
  const returnStops = [...stops];
  let swapped = 0;
  if (ROAD_MODES.has(body.modeId) && !loop) {
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (s.location_type !== 0) continue;
      const partner = await acrossTheRoad(tx, s.id);
      if (partner) {
        returnStops[i] = partner as unknown as (typeof stops)[number];
        swapped++;
      }
    }
  }

  const tripIds: number[] = [];
  let outboundLine: [number, number][] | null = null;
  const timed: SectionTime[] = [];
  for (const direction of loop ? [0] : [0, 1]) {
    const order = direction === 0 ? stops : [...returnStops].reverse();
    // The path: along roads, track or ferry routes where it can be found, otherwise straight between stops.
    const found = await linePath(
      tx,
      sc.baselineId,
      body.modeId,
      order.map((s) => ({
        id: s.id,
        lon: s.lon,
        lat: s.lat,
        stationId: s.location_type === 1 ? s.id : s.parent_id,
      })),
      { follow },
    );
    let line: [number, number][] = found.coords;
    let known = found.at;
    if (direction === 0) {
      pathMethod = found.method;
      outboundLine = found.coords;
    } else if (follow && found.method === 'straight' && pathMethod !== 'straight' && outboundLine) {
      // Without a routing server there is rarely a published path for the way back, so the
      // return trip runs back along the outbound path rather than cutting straight across.
      line = [...outboundLine].reverse();
      known = undefined;
    }
    const lineDist: number[] = [0];
    for (let i = 1; i < line.length; i++)
      lineDist.push(
        lineDist[i - 1] + distanceM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]),
      );
    // Where each stop sits along the path: where the path's maker says, otherwise worked out in order.
    const placedAt =
      known ??
      locateStops(
        line,
        order.map((s) => [s.lon, s.lat] as [number, number]),
      );
    const dist = placedAt.map((k) => lineDist[Math.min(k, lineDist.length - 1)]);
    // Arrival and departure at each stop, as seconds after the trip starts, for each part of the day:
    // a trip that starts in the morning peak uses the morning peak's run times throughout.
    const stopIds = order.map((s) => platform(s, direction));
    const runs: SectionTime[] = [];
    const dwells: number[] = [0];
    for (let i = 1; i < order.length; i++) {
      const dwell =
        i === order.length - 1
          ? 0
          : await stopDwell(tx, sc.baselineId, body.modeId, stopIds[i], model.dwell);
      dwells.push(dwell);
      const run = await sectionTime(
        tx,
        sc.baselineId,
        body.modeId,
        { id: stopIds[i - 1], lon: order[i - 1].lon, lat: order[i - 1].lat },
        { id: stopIds[i], lon: order[i].lon, lat: order[i].lat },
        dist[i] - dist[i - 1],
        { speed: model.speed, dwellAtTo: dwell },
      );
      runs.push(run);
      timed.push(run);
    }
    const arrBy: number[][] = [];
    const depBy: number[][] = [];
    DAY_BANDS.forEach((_, k) => {
      const arr = [0];
      const dep = [0];
      for (let i = 1; i < order.length; i++) {
        arr.push(dep[i - 1] + runs[i - 1].byBand[k]);
        dep.push(arr[i] + dwells[i]);
      }
      arrBy.push(arr);
      depBy.push(dep);
    });
    const wkt = `LINESTRING(${line.map((p) => `${p[0]} ${p[1]}`).join(',')})`;
    const [shape] = await tx`
      insert into shapes (baseline_id, gtfs_id, geom, length_m, dists, scenario_id, created_edit)
      values (${sc.baselineId}, ${`NEW-${sc.id}-${seq}-${direction}`}, ST_GeomFromText(${wkt}, 4326), ${lineDist[lineDist.length - 1]},
              ${lineDist}::float8[], ${sc.id}, ${seq})
      returning id`;
    const headsign = loop ? `${tidy(furthest.name)} loop` : tidy(order[order.length - 1].name);
    const [pattern] = await tx`
      insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key, scenario_id, created_edit)
      values (${sc.baselineId}, ${route.id}, ${direction}, ${shape.id}, ${headsign}, ${stopIds}::bigint[], 0,
              ${`new-${sc.id}-${seq}-${direction}`}, ${sc.id}, ${seq})
      returning id`;
    const starts: number[] = [];
    for (let s = from; s < to; s += headway) starts.push(s);
    const lasts = starts.map((s) => arrBy[bandOf(s)][order.length - 1]);
    const created = await tx`
      insert into trips (baseline_id, gtfs_id, route_id, pattern_id, shape_id, service_gtfs_id, headsign, direction_id,
                         start_secs, end_secs, first_stop_id, last_stop_id, scenario_id, created_edit)
      select ${sc.baselineId}, ${`NEW${sc.id}.${seq}.${direction}-`} || row_number() over (order by s.start), ${route.id}, ${pattern.id},
             ${shape.id}, 'NEW', ${headsign}, ${direction}, s.start, s.start + s.last,
             ${stopIds[0]}, ${stopIds[stopIds.length - 1]}, ${sc.id}, ${seq}
      from unnest(${starts}::int[], ${lasts}::int[]) as s(start, last)
      returning id, start_secs`;
    for (let k = 0; k < DAY_BANDS.length; k++) {
      const ids = created.filter((r) => bandOf(r.start_secs) === k).map((r) => r.id);
      if (!ids.length) continue;
      await tx`
        insert into stop_times (trip_id, seq, stop_id, arr, dep, dist)
        select n.id, o.seq, o.stop_id, n.start_secs + o.arr, n.start_secs + o.dep, o.dist
        from trips n
        cross join unnest(${stopIds}::bigint[], ${arrBy[k]}::int[], ${depBy[k]}::int[], ${dist}::float4[]) with ordinality as o(stop_id, arr, dep, dist, seq)
        where n.id = any(${ids})`;
    }
    for (const r of created) tripIds.push(r.id);
  }
  const fleet = await assignVehicles(tx, sc, seq, tripIds);
  const settled = await settlePlatforms(tx, sc, seq, tripIds);
  return {
    summary: `New ${loop ? 'one-way loop' : 'line'} ${name}: ${loop ? stops.length - 1 : stops.length} stops, every ${minutes(headway)} from ${formatSecs(from)} to ${formatSecs(to)} (${tripIds.length} trips), ${describeMethod(pathMethod)}; run times: ${describeTimes(timed, 'end to end', chosen.length - 1)}${swapped ? `; the way back uses the stop across the road at ${swapped} of ${stops.length} stops` : ''}${fleetNote(fleet)}${platformNote(settled)}`,
    idMap: {},
    routeId: route.id,
  };
}
