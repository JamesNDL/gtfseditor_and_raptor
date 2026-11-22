// Phase 0 data audit: checks the facts about the TfNSW feed that the editor's design depends on.
// Usage: npm run feed:audit [-- YYYYMMDD]   (defaults to the first Tuesday covered by the feed)
import { ensureFeed } from './feed-cache.ts';
import { openAuditDb } from './audit-db.ts';

const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}

const feed = await ensureFeed({ apiKey, log: console.log });
const { query } = await openAuditDb(feed.dir);

async function section(title: string, sql: string) {
  console.log(`\n## ${title}`);
  console.table(await query(sql));
}

const SECS = (col: string) =>
  `(split_part(${col},':',1)::int*3600 + split_part(${col},':',2)::int*60 + split_part(${col},':',3)::int)`;

let date = process.argv[2];
if (!date) {
  const [row] = await query(`select min(start_date) d from calendar`);
  const d = new Date(
    `${String(row.d).slice(0, 4)}-${String(row.d).slice(4, 6)}-${String(row.d).slice(6, 8)}T00:00:00Z`,
  );
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  date = d.toISOString().slice(0, 10).replaceAll('-', '');
}
if (!/^\d{8}$/.test(date)) throw new Error(`Date must be YYYYMMDD, got ${date}`);
const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
  new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`).getUTCDay()
];
console.log(`\nFeed ${feed.id}, auditing service day ${date} (${weekday})`);

await section(
  'Whole feed: row counts',
  `select (select count(*) from agency) agencies, (select count(*) from routes) routes,
          (select count(*) from trips) trips, (select count(*) from stop_times) stop_times,
          (select count(*) from stops) stops, (select count(distinct shape_id) from shapes) shapes,
          (select count(*) from shapes) shape_points, (select count(*) from calendar) services,
          (select count(*) from pathways) pathways,
          (select min(start_date) || ' to ' || max(end_date) from calendar) date_range,
          (select max(departure_time) from stop_times) latest_departure`,
);

await query(`
  create or replace table day_trips as
  select t.*, r.route_type, r.route_short_name
  from trips t join routes r using (route_id)
  where service_id in (
    select service_id from calendar
    where ${weekday} = '1' and start_date <= '${date}' and end_date >= '${date}'
      and service_id not in (select service_id from calendar_dates where date = '${date}' and exception_type = '2')
    union
    select service_id from calendar_dates where date = '${date}' and exception_type = '1')`);

await section(
  'One day: size and block_id coverage per mode (route_type)',
  `select d.route_type, any_value(r.route_desc) example_network, count(*) trips, count(distinct d.route_id) routes,
          sum((coalesce(d.block_id,'') <> '')::int) trips_with_block, count(distinct nullif(d.block_id,'')) blocks,
          (select count(*) from stop_times st where st.trip_id in
             (select trip_id from day_trips d2 where d2.route_type = d.route_type)) stop_times
   from day_trips d join routes r using (route_id) group by 1 order by 3 desc`,
);

await query(`
  create or replace table train_trips as
  with ends as (
    select trip_id,
           min_by(stop_id, stop_sequence::int) first_stop, max_by(stop_id, stop_sequence::int) last_stop,
           min_by(departure_time, stop_sequence::int) dep, max_by(arrival_time, stop_sequence::int) arr
    from stop_times where trip_id in (select trip_id from day_trips where route_type = '2') group by 1)
  select d.route_short_name, d.trip_id, d.block_id,
         split_part(d.trip_id,'.',1) trip_name, split_part(d.trip_id,'.',5) set_type, split_part(d.trip_id,'.',6) cars,
         e.dep, e.arr, s1.parent_station first_station, s2.parent_station last_station
  from day_trips d join ends e using (trip_id)
  join stops s1 on s1.stop_id = e.first_stop join stops s2 on s2.stop_id = e.last_stop`);

await section(
  'Trains: does the trip ID carry set type and car count? (per line)',
  `select route_short_name line, count(*) trips,
          sum(regexp_matches(set_type,'^[A-Za-z]$')::int) with_set_type, any_value(trip_id) example
   from train_trips group by 1 order by 1`,
);

await section(
  'Trains: set type and car count combinations',
  `select set_type, cars, count(*) trips, string_agg(distinct route_short_name, ' ') lines
   from train_trips where regexp_matches(set_type,'^[A-Za-z]$') group by 1, 2 order by 3 desc`,
);

await section(
  'Trains: trips per block_id',
  `select n trips_in_block, count(*) blocks
   from (select block_id, count(*) n from train_trips where coalesce(block_id,'') <> '' group by 1) group by 1 order by 1`,
);

await section(
  'Suburban trains: do run numbers (first 3 characters of the trip name) chain into a vehicle day?',
  `with c as (
     select *, lead(first_station) over w next_first, lead(dep) over w next_dep
     from train_trips where route_short_name like 'T_'
     window w as (partition by substr(trip_name,1,3) order by dep))
   select count(distinct substr(trip_name,1,3)) runs, count(*) trips, sum((next_first is not null)::int) links,
          sum((next_first = last_station and next_dep >= arr)::int) valid_links,
          sum((next_first is not null and next_first <> last_station)::int) station_jumps,
          sum((next_first is not null and next_dep < arr)::int) time_overlaps
   from c`,
);

await section(
  'Stops used on the day: parent station and platform code coverage per mode',
  `with used as (select distinct st.stop_id, d.route_type from stop_times st join day_trips d using (trip_id))
   select u.route_type, count(*) stops_used,
          sum((coalesce(s.parent_station,'') <> '')::int) with_parent_station,
          sum((coalesce(s.platform_code,'') <> '')::int) with_platform_code, any_value(s.stop_name) example
   from used u join stops s using (stop_id) group by 1 order by 2 desc`,
);

await section(
  'Pathways (walking links inside stations) by pathway_mode',
  `select pathway_mode, count(*) pathways, round(avg(traversal_time::int)) avg_seconds from pathways group by 1 order by 1`,
);

await section(
  'Baseline platform/wharf overlaps: two trips at the same stop at the same time (non-bus modes)',
  `with calls as (
     select st.stop_id, st.trip_id, d.route_type, ${SECS('arrival_time')} a, ${SECS('departure_time')} dp
     from stop_times st join day_trips d using (trip_id) where d.route_type in ('2','401','900','4','106'))
   select c1.route_type, count(*) overlapping_pairs, count(distinct c1.stop_id) stops_affected
   from calls c1 join calls c2
     on c1.stop_id = c2.stop_id and c1.trip_id < c2.trip_id and c1.a <= c2.dp and c2.a <= c1.dp
   group by 1 order by 1`,
);
