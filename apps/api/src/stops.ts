// Stops a scenario adds: a bus stop (optionally with its partner across the road), or a station
// with platforms. They belong to the scenario, like the lines it draws, and can then be used by
// "Draw a new line" and "Change route" in the same way as published stops.
import { distanceM } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { nearestRoad } from './roads.ts';
import type { Scenario } from './scenarios.ts';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

const ROAD_MODES = new Set(['bus', 'coach', 'school_bus']);

/** SQL condition: this scenario has deleted the stop aliased `alias` (apps/api/src/delete-stop.ts). */
export function stopDeleted(sql: Sql, alias: string, sc: Scenario | null) {
  const s = sql(alias);
  if (!sc) return sql`false`;
  return sql`exists (
    select 1 from scenario_removed_stops gone
    where gone.scenario_id = ${sc.id} and gone.stop_id = ${s}.id and gone.edit_seq <= ${sc.head})`;
}

/**
 * SQL condition: the stop aliased `alias` is published, or was added by this scenario and not undone,
 * and the scenario has not deleted it.
 */
export function stopVisible(sql: Sql, alias: string, sc: Scenario | null) {
  const s = sql(alias);
  if (!sc) return sql`${s}.scenario_id is null`;
  return sql`((${s}.scenario_id is null or (${s}.scenario_id = ${sc.id} and ${s}.created_edit <= ${sc.head}))
    and not ${stopDeleted(sql, alias, sc)})`;
}

// What a station and its platforms are called in each mode, following the feed's own naming.
const STATION_NAMES: Record<string, { suffix: string; platform: string; what: string }> = {
  train: { suffix: ' Station', platform: 'Platform', what: 'train station' },
  metro: { suffix: ' Station', platform: 'Platform', what: 'metro station' },
  light_rail: { suffix: ' Light Rail', platform: 'Platform', what: 'light rail stop' },
  ferry: { suffix: ' Wharf', platform: 'Side', what: 'ferry wharf' },
};

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
/** A point moved by so many metres east and north. */
const offset = (lon: number, lat: number, east: number, north: number): [number, number] => [lon + east / mPerDegLon(lat), lat + north / M_PER_DEG_LAT];

// How far from the middle of the road a stop is placed when the click landed on the road itself.
const KERB_M = 6;

/**
 * Where the stop across the road goes. With the click to one side of the road, the partner is the
 * same distance on the other side. With the click on the road itself, the road's direction is found
 * by asking where two nearby points snap to, and the pair is placed either side of it.
 * Returns null when there is no routing server or no road nearby.
 */
async function acrossRoadPair(lon: number, lat: number): Promise<{ here: [number, number]; there: [number, number] } | null> {
  const road = await nearestRoad(lon, lat);
  if (!road) return null;
  const off = distanceM(lon, lat, road[0], road[1]);
  if (off > 60) return null;
  if (off >= 3) return { here: [lon, lat], there: [2 * road[0] - lon, 2 * road[1] - lat] };
  let along: [number, number] | null = null;
  for (const [east, north] of [[20, 0], [0, 20]]) {
    const probe = await nearestRoad(...offset(road[0], road[1], east, north));
    if (!probe) continue;
    const dx = (probe[0] - road[0]) * mPerDegLon(lat);
    const dy = (probe[1] - road[1]) * M_PER_DEG_LAT;
    if (Math.hypot(dx, dy) > (along ? Math.hypot(...along) : 5)) along = [dx, dy];
  }
  if (!along) return null;
  const length = Math.hypot(...along);
  const side: [number, number] = [(-along[1] / length) * KERB_M, (along[0] / length) * KERB_M];
  return { here: offset(road[0], road[1], side[0], side[1]), there: offset(road[0], road[1], -side[0], -side[1]) };
}

export interface AddStopBody {
  name: string;
  lon: number;
  lat: number;
  modeId: string;
  /** Road vehicles: also add the stop across the road, for the way back. */
  pair?: boolean;
  /** Rail and ferry: how many platforms the new station has. */
  platforms?: number;
}

export interface AddedStop {
  id: number;
  name: string;
  lon: number;
  lat: number;
  parentId: number | null;
  isStation: boolean;
}

/** Adds a stop for road vehicles, or a station with platforms for everything else. */
export async function editAddStop(tx: Sql, sc: Scenario, seq: number, body: AddStopBody) {
  const name = (body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw fail(400, 'Give the stop a name');
  const lon = Number(body.lon);
  const lat = Number(body.lat);
  if (!(lon > 140 && lon < 160 && lat > -38 && lat < -28)) throw fail(400, 'That place is outside New South Wales');
  const [mode] = await tx`select id, name from modes where id = ${String(body.modeId)}`;
  if (!mode) throw fail(400, 'Choose a mode');

  const insert = async (row: {
    n: number;
    name: string;
    at: [number, number];
    locationType: number;
    parent?: { id: number; gtfsId: string };
    platformCode?: string;
  }): Promise<AddedStop & { gtfsId: string }> => {
    const gtfsId = `NEW-${sc.id}-${seq}-${row.n}`;
    const [made] = await tx`
      insert into stops (baseline_id, gtfs_id, name, location_type, parent_gtfs_id, parent_id, platform_code, mode_ids, geom, scenario_id, created_edit)
      values (${sc.baselineId}, ${gtfsId}, ${row.name}, ${row.locationType}, ${row.parent?.gtfsId ?? null}, ${row.parent?.id ?? null},
              ${row.platformCode ?? null}, ${[mode.id]}::text[], ST_SetSRID(ST_MakePoint(${row.at[0]}, ${row.at[1]}), 4326), ${sc.id}, ${seq})
      returning id`;
    return { id: made.id, name: row.name, lon: row.at[0], lat: row.at[1], parentId: row.parent?.id ?? null, isStation: row.locationType === 1, gtfsId };
  };

  if (ROAD_MODES.has(mode.id)) {
    const pair = body.pair === false ? null : await acrossRoadPair(lon, lat);
    const here = await insert({ n: 1, name, at: pair?.here ?? [lon, lat], locationType: 0 });
    let note = '';
    if (pair) {
      const there = await insert({ n: 2, name: `${name} (opposite)`, at: pair.there, locationType: 0 });
      await tx`update stops set partner_id = ${there.id} where id = ${here.id}`;
      await tx`update stops set partner_id = ${here.id} where id = ${there.id}`;
      note = `, with a stop across the road ${Math.round(distanceM(here.lon, here.lat, there.lon, there.lat))} m away for the way back`;
    } else if (body.pair !== false) {
      note = '; no road was found close by, so there is no stop across the road and lines will use this one both ways';
    }
    return { summary: `New ${String(mode.name).toLowerCase()} stop ${name}${note}`, idMap: {}, stops: [here] };
  }

  const naming = STATION_NAMES[mode.id] ?? STATION_NAMES.train;
  const count = Math.max(1, Math.min(8, Math.round(Number(body.platforms ?? 2)) || 2));
  const stationName = name.toLowerCase().endsWith(naming.suffix.trim().toLowerCase()) ? name : `${name}${naming.suffix}`;
  const station = await insert({ n: 0, name: stationName, at: [lon, lat], locationType: 1 });
  for (let i = 0; i < count; i++) {
    // Platforms sit a few metres apart so that they can be told apart on the map.
    await insert({
      n: i + 1,
      name: `${stationName}, ${naming.platform} ${i + 1}`,
      at: offset(lon, lat, (i - (count - 1) / 2) * 8, 0),
      locationType: 0,
      parent: station,
      platformCode: String(i + 1),
    });
  }
  return {
    summary: `New ${naming.what} ${stationName} with ${count} ${naming.platform.toLowerCase()}${count === 1 ? '' : 's'}`,
    idMap: {},
    stops: [station],
  };
}

/** Stops a scenario has added, as GeoJSON for the map, with the same properties as the stops in the map tiles. */
export async function scenarioStopsGeoJson(sql: Sql, sc: Scenario) {
  const rows = await sql`
    select s.id, s.name, s.mode_ids[1] as mode, s.location_type, s.parent_id, s.platform_code, ST_X(s.geom) as lon, ST_Y(s.geom) as lat
    from stops s where s.scenario_id = ${sc.id} and s.created_edit <= ${sc.head} and not ${stopDeleted(sql, 's', sc)}`;
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
        platform: r.parent_id !== null,
        code: r.platform_code,
      },
    })),
  };
}
