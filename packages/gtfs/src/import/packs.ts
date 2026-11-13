// Writes one animation pack per mode for a baseline (see @gtfs-editor/core pack.ts for the format).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { COORD_SCALE, encodePack, simplifyIndices, type PackArrays } from '@gtfs-editor/core';
import type { Sql } from '../db.ts';

/** Shape detail kept for animation. Vehicles are dots, so a few metres of error is invisible. */
const SIMPLIFY_TOLERANCE_M = 8;

export function packsDir(baselineId: number, root = 'data/packs'): string {
  return path.resolve(root, String(baselineId));
}

interface SimpleShape {
  lon: Int32Array;
  lat: Int32Array;
  dist: Float32Array;
}

export async function buildPacks(sql: Sql, baselineId: number, log: (m: string) => void): Promise<void> {
  const dir = packsDir(baselineId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  // One pass over the raw shape points for every shape this baseline uses.
  const started = Date.now();
  const shapes = new Map<number, SimpleShape>();
  let rawPoints = 0;
  let keptPoints = 0;
  const shapeCursor = sql`
    select sh.id,
           array_agg(s.shape_pt_lon::float8 order by s.shape_pt_sequence::int) as lon,
           array_agg(s.shape_pt_lat::float8 order by s.shape_pt_sequence::int) as lat,
           array_agg(s.shape_dist_traveled::float8 order by s.shape_pt_sequence::int) as dist
    from staging.shapes s join shapes sh on sh.gtfs_id = s.shape_id and sh.baseline_id = ${baselineId}
    group by sh.id`.cursor(200);
  for await (const rows of shapeCursor) {
    for (const row of rows) {
      const lon = row.lon as number[];
      const lat = row.lat as number[];
      const dist = row.dist as number[];
      const keep = simplifyIndices(lon, lat, SIMPLIFY_TOLERANCE_M);
      rawPoints += lon.length;
      keptPoints += keep.length;
      shapes.set(row.id, {
        lon: Int32Array.from(keep, (i) => Math.round(lon[i] * COORD_SCALE)),
        lat: Int32Array.from(keep, (i) => Math.round(lat[i] * COORD_SCALE)),
        dist: Float32Array.from(keep, (i) => dist[i]),
      });
    }
  }
  log(
    `  shapes simplified: ${shapes.size.toLocaleString()} shapes, ${rawPoints.toLocaleString()} points down to ` +
      `${keptPoints.toLocaleString()} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  const modes = await sql`
    select r.mode_id, count(*)::int trips from trips t join routes r on r.id = t.route_id
    where t.baseline_id = ${baselineId} and t.shape_id is not null group by 1`;

  for (const { mode_id: modeId, trips: tripCount } of modes) {
    const modeStarted = Date.now();
    const trips = await sql`
      select t.id, t.route_id, t.start_secs, t.end_secs, t.shape_id
      from trips t join routes r on r.id = t.route_id
      where t.baseline_id = ${baselineId} and r.mode_id = ${modeId} and t.shape_id is not null
      order by t.start_secs, t.id`;

    const shapeIndex = new Map<number, number>();
    const usedShapes: SimpleShape[] = [];
    const tripIndex = new Map<number, number>();
    const tripId = new Int32Array(tripCount);
    const tripRoute = new Int32Array(tripCount);
    const tripStart = new Int32Array(tripCount);
    const tripEnd = new Int32Array(tripCount);
    const tripShape = new Int32Array(tripCount);
    const stCounts = new Uint32Array(tripCount);
    trips.forEach((t, i) => {
      tripIndex.set(t.id, i);
      tripId[i] = t.id;
      tripRoute[i] = t.route_id;
      tripStart[i] = t.start_secs;
      tripEnd[i] = t.end_secs;
      let si = shapeIndex.get(t.shape_id);
      if (si === undefined) {
        si = usedShapes.length;
        shapeIndex.set(t.shape_id, si);
        usedShapes.push(shapes.get(t.shape_id)!);
      }
      tripShape[i] = si;
    });

    const [{ n: stCount }] = await sql`
      select count(*)::int n from stop_times st join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
      where t.baseline_id = ${baselineId} and r.mode_id = ${modeId} and t.shape_id is not null`;
    const stTrip = new Int32Array(stCount);
    const stSeq = new Int32Array(stCount);
    const rawArr = new Int32Array(stCount);
    const rawDep = new Int32Array(stCount);
    const rawDist = new Float32Array(stCount);
    let n = 0;
    const stCursor = sql`
      select st.trip_id, st.seq, st.arr, st.dep, coalesce(st.dist, 0)::float4 as dist
      from stop_times st join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
      where t.baseline_id = ${baselineId} and r.mode_id = ${modeId} and t.shape_id is not null`.cursor(20000);
    for await (const rows of stCursor) {
      for (const row of rows) {
        const ti = tripIndex.get(row.trip_id)!;
        stTrip[n] = ti;
        stSeq[n] = row.seq;
        rawArr[n] = row.arr;
        rawDep[n] = row.dep;
        rawDist[n] = row.dist;
        stCounts[ti]++;
        n++;
      }
    }

    // Place each stop time in its trip's slot, ordered by sequence.
    const tripStOffset = new Uint32Array(tripCount + 1);
    for (let i = 0; i < tripCount; i++) tripStOffset[i + 1] = tripStOffset[i] + stCounts[i];
    const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => stTrip[a] - stTrip[b] || stSeq[a] - stSeq[b]);
    const stArr = new Int32Array(n);
    const stDep = new Int32Array(n);
    const stDist = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      stArr[k] = rawArr[order[k]];
      stDep[k] = rawDep[order[k]];
      stDist[k] = rawDist[order[k]];
    }

    const shapePtOffset = new Uint32Array(usedShapes.length + 1);
    usedShapes.forEach((s, i) => (shapePtOffset[i + 1] = shapePtOffset[i] + s.lon.length));
    const pointCount = shapePtOffset[usedShapes.length];
    const ptLon = new Int32Array(pointCount);
    const ptLat = new Int32Array(pointCount);
    const ptDist = new Float32Array(pointCount);
    usedShapes.forEach((s, i) => {
      ptLon.set(s.lon, shapePtOffset[i]);
      ptLat.set(s.lat, shapePtOffset[i]);
      ptDist.set(s.dist, shapePtOffset[i]);
    });

    const arrays: PackArrays = {
      tripId, tripRoute, tripStart, tripEnd, tripShape, tripStOffset,
      stArr, stDep, stDist, shapePtOffset, ptLon, ptLat, ptDist,
    };
    const bytes = encodePack(
      { version: 1, modeId, tripCount, stopTimeCount: n, shapeCount: usedShapes.length, pointCount },
      arrays,
    );
    await writeFile(path.join(dir, `${modeId}.bin`), bytes);
    log(
      `  pack ${modeId}: ${tripCount.toLocaleString()} trips, ${(bytes.length / 1e6).toFixed(1)} MB ` +
        `in ${((Date.now() - modeStarted) / 1000).toFixed(1)}s`,
    );
  }
}
