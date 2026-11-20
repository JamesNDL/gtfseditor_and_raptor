// Run times and stop times for stretches no published trip runs, learned from the timetable and
// varying by time of day.
//
// Best evidence first, for each stretch between two stops:
//   1. published trips that already run from one stop to the other: their median time;
//   2. published trips of the same mode between other stops close by: their median speed;
//   3. the typical end-to-end speed of the mode on that day.
// Each is worked out for five parts of the day where there are enough trips, otherwise for the whole day.
import { DAY_BANDS, minRunSecs } from '@gtfs-editor/core';
import type { Sql } from '@gtfs-editor/gtfs/db';

export interface Place {
  id: number;
  lon: number;
  lat: number;
}

export type TimeSource = 'published' | 'nearby' | 'typical';

export interface SectionTime {
  /** Seconds from leaving one stop to arriving at the next, for each part of the day. */
  byBand: number[];
  source: TimeSource;
}

const BAND_CASE = (column: string) =>
  `case ${DAY_BANDS.slice(0, -1)
    .map((b, k) => `when ${column} < ${b.to} then ${k}`)
    .join(' ')} else ${DAY_BANDS.length - 1} end`;

const round10 = (secs: number) => Math.round(secs / 10) * 10;

interface Banded {
  n: number;
  value: number;
  bands: ({ n: number; value: number } | undefined)[];
}

/** Rows grouped by band, with a null band for the whole day, as one object. */
function banded(rows: { band: number | null; n: number; value: number | null }[]): Banded {
  const all = rows.find((r) => r.band === null);
  const bands = DAY_BANDS.map((_, k) => {
    const r = rows.find((x) => x.band === k);
    return r && r.value !== null ? { n: r.n, value: Number(r.value) } : undefined;
  });
  return { n: all?.n ?? 0, value: Number(all?.value ?? 0), bands };
}

/** The whole-day figure, replaced in each part of the day that has enough trips of its own. */
const perBand = (b: Banded, enough: number): number[] => b.bands.map((x) => (x && x.n >= enough && x.value > 0 ? x.value : b.value));

const cache = new Map<string, unknown>();
async function cached<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (cache.has(key)) return cache.get(key) as T;
  const value = await work();
  if (cache.size > 5000) cache.clear();
  cache.set(key, value);
  return value;
}

/** Typical end-to-end speed of a mode in metres per second, stops included, for each part of the day. */
export function modeSpeeds(tx: Sql, baselineId: number, modeId: string, fallback: number): Promise<number[]> {
  return cached(`speed|${baselineId}|${modeId}`, async () => {
    const rows = await tx.unsafe(
      `select ${BAND_CASE('t.start_secs')} as band, count(*)::int as n,
              percentile_cont(0.5) within group (order by sh.length_m / (t.end_secs - t.start_secs)) as value
       from trips t join routes r on r.id = t.route_id join shapes sh on sh.id = t.shape_id
       where t.baseline_id = $1 and t.scenario_id is null and r.mode_id = $2
         and t.end_secs > t.start_secs + 120 and sh.length_m > 500
       group by grouping sets ((1), ())`,
      [baselineId, modeId] as never[],
    );
    const b = banded(rows as never);
    if (!(b.value > 1 && b.value < 40)) return DAY_BANDS.map(() => fallback);
    return perBand(b, 30);
  });
}

/** How long vehicles of a mode usually stand at a stop, in seconds, from a sample of the timetable. */
function modeDwell(tx: Sql, baselineId: number, modeId: string, fallback: number): Promise<number> {
  return cached(`dwell|${baselineId}|${modeId}`, async () => {
    const [row] = await tx`
      select count(*)::int as n, percentile_cont(0.5) within group (order by st.dep - st.arr) as median
      from stop_times st join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
      where t.baseline_id = ${baselineId} and t.scenario_id is null and r.mode_id = ${modeId} and t.id % 20 = 0
        and st.stop_id <> t.first_stop_id and st.stop_id <> t.last_stop_id`;
    return row && row.n >= 50 ? Math.round(Number(row.median)) : fallback;
  });
}

/**
 * How long a vehicle stands at a stop: what published trips do there, otherwise what the mode
 * usually does, otherwise the fallback. Timetables for buses give no stop time (it is part of the
 * run time), so for them this is zero.
 */
export async function stopDwell(tx: Sql, baselineId: number, modeId: string, stopId: number, fallback: number): Promise<number> {
  return cached(`dwell|${baselineId}|${modeId}|${stopId}`, async () => {
    const [row] = await tx`
      select count(*)::int as n, percentile_cont(0.5) within group (order by st.dep - st.arr) as median
      from stop_times st join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
      where st.stop_id = ${stopId} and t.scenario_id is null and r.mode_id = ${modeId}
        and st.stop_id <> t.first_stop_id and st.stop_id <> t.last_stop_id`;
    if (row && row.n >= 5) return Math.round(Number(row.median));
    return modeDwell(tx, baselineId, modeId, fallback);
  });
}

/** Speed of published trips of a mode between consecutive stops near a stretch, for each part of the day, or null. */
async function nearbySpeeds(tx: Sql, baselineId: number, modeId: string, from: Place, to: Place): Promise<number[] | null> {
  // About 400 m either side of the stretch; degrees are near enough at these latitudes.
  const near = await tx`
    select s.id from stops s
    where s.baseline_id = ${baselineId} and s.scenario_id is null and s.location_type = 0 and ${modeId} = any(s.mode_ids)
      and ST_DWithin(s.geom, ST_SetSRID(ST_MakeLine(ST_MakePoint(${from.lon}, ${from.lat}), ST_MakePoint(${to.lon}, ${to.lat})), 4326), 0.004)
    order by s.geom <-> ST_SetSRID(ST_MakePoint(${(from.lon + to.lon) / 2}, ${(from.lat + to.lat) / 2}), 4326)
    limit 60`;
  if (near.length < 4) return null;
  const ids = near.map((r) => r.id);
  const rows = await tx.unsafe(
    `select ${BAND_CASE('a.dep')} as band, count(*)::int as n,
            percentile_cont(0.5) within group (order by (b.dist - a.dist) / (b.arr - a.dep)) as value
     from stop_times a
     join stop_times b on b.trip_id = a.trip_id and b.seq = a.seq + 1
     join trips t on t.id = a.trip_id
     join routes r on r.id = t.route_id
     where a.stop_id = any($1::bigint[]) and b.stop_id = any($1::bigint[])
       and t.scenario_id is null and r.mode_id = $2 and b.arr > a.dep and b.dist > a.dist + 50
     group by grouping sets ((1), ())`,
    [ids, modeId] as never[],
  );
  const b = banded(rows as never);
  if (b.n < 30 || !(b.value > 0.5 && b.value < 45)) return null;
  return perBand(b, 8);
}

/** Run time for one stretch between two stops, by part of the day. */
export async function sectionTime(
  tx: Sql,
  baselineId: number,
  modeId: string,
  from: Place,
  to: Place,
  lengthM: number,
  /**
   * Fallback speed in metres per second, and the stop time the caller adds at the far end. The
   * typical speed counts time spent at stops, so that much is taken back out; a caller that adds no
   * stop time (bus timetables have none) gives nought, and nothing is taken out.
   */
  model: { speed: number; dwellAtTo: number },
): Promise<SectionTime> {
  // Whatever the evidence says, the stretch is never timed faster than the vehicle can go.
  const least = minRunSecs(modeId, lengthM);
  const rows = await tx.unsafe(
    `select ${BAND_CASE('a.dep')} as band, count(*)::int as n, percentile_cont(0.5) within group (order by b.arr - a.dep) as value
     from stop_times a
     join stop_times b on b.trip_id = a.trip_id and b.seq > a.seq and b.stop_id = $2
     join trips t on t.id = a.trip_id
     where a.stop_id = $1 and t.scenario_id is null
     group by grouping sets ((1), ())`,
    [from.id, to.id] as never[],
  );
  const seen = banded(rows as never);
  if (seen.n >= 3 && seen.value > 0) {
    return { byBand: perBand(seen, 3).map((s) => Math.max(20, round10(s))), source: 'published' };
  }
  const key = (p: Place) => `${p.lon.toFixed(3)},${p.lat.toFixed(3)}`;
  const near = await cached(`near|${baselineId}|${modeId}|${key(from)}|${key(to)}`, () => nearbySpeeds(tx, baselineId, modeId, from, to));
  if (near) return { byBand: near.map((v) => Math.max(20, least, round10(lengthM / v))), source: 'nearby' };
  const speeds = await modeSpeeds(tx, baselineId, modeId, model.speed);
  // The typical speed already includes time spent at stops, so take the stop time back out.
  return { byBand: speeds.map((v) => Math.max(30, least, round10(lengthM / v - Math.max(0, model.dwellAtTo)))), source: 'typical' };
}

/** "3 sections from published trips, 2 from services nearby, 1 at the typical speed for this mode; ..." */
export function describeTimes(sections: SectionTime[], what: string, first = sections.length): string {
  const count = (source: TimeSource) => sections.filter((s) => s.source === source).length;
  const n = (k: number) => `${k} section${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (count('published')) parts.push(`${n(count('published'))} from published trips`);
  if (count('nearby')) parts.push(`${n(count('nearby'))} from the speed of services nearby`);
  if (count('typical')) parts.push(`${n(count('typical'))} at the typical speed for this mode`);
  // A line timed in both directions is described by its first direction.
  const total = (k: number) => sections.slice(0, first).reduce((sum, s) => sum + s.byBand[k], 0);
  const totals = DAY_BANDS.map((_, k) => total(k));
  const fast = Math.min(...totals);
  const slow = Math.max(...totals);
  const slowest = DAY_BANDS[totals.indexOf(slow)].label;
  const spread =
    slow - fast >= 60
      ? `; ${what} ${Math.round(slow / 60)} min in the ${slowest}, ${Math.round(fast / 60)} min at the quietest time`
      : `; ${what} ${slow < 90 ? `${Math.round(slow)} s` : `${Math.round(slow / 60)} min`} all day`;
  return `${parts.join(', ')}${sections.length ? spread : ''}`;
}
