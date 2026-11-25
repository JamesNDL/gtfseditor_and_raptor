// Stops a scenario has added, for the map. The addStop edit that makes them is in edits/add-stop.ts.
import type { Sql } from '@gtfs-editor/gtfs/db';
import type { Scenario } from './engine.ts';
import { stopDeleted } from './stops-visible.ts';

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
