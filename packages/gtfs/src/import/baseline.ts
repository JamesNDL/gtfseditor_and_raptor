// Builds a baseline (one service day) from the staged raw feed.
import type { FeedVersion } from '../feed/feed-cache.ts';
import type { Sql } from '../db.ts';
import { guardReplace, isoDate } from './replace-guard.ts';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Sydney Trains / NSW TrainLink set letters. Names are for display only.
const SET_NAMES: Record<string, string> = {
  A: 'Waratah',
  B: 'Waratah Series 2',
  T: 'Tangara',
  M: 'Millennium',
  H: 'OSCAR',
  D: 'Mariyung',
  N: 'Endeavour',
  J: 'Hunter',
  X: 'XPT',
  P: 'Xplorer',
};

export interface ImportedBaseline {
  id: number;
  label: string;
}

export interface ImportBaselineOptions {
  /** Allow re-importing a day that has scenarios. Re-importing deletes them (on delete cascade). */
  replace?: boolean;
}

export async function importBaseline(
  sql: Sql,
  feed: FeedVersion,
  date: string,
  log: (m: string) => void,
  options: ImportBaselineOptions = {},
): Promise<ImportedBaseline> {
  const iso = isoDate(date);
  await guardReplace(sql, feed.id, date, options.replace ?? false, log);
  const jsDate = new Date(`${iso}T00:00:00Z`);
  const weekday = WEEKDAYS[jsDate.getUTCDay()];
  const dayType = weekday === 'saturday' || weekday === 'sunday' ? weekday : 'weekday';
  const label = jsDate.toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const [unmapped] = await sql`
    select string_agg(distinct route_type, ', ') types from staging.routes
    where route_type::int not in (select route_type from route_type_modes)`;
  if (unmapped.types) {
    throw new Error(
      `Feed has route types with no mode mapping: ${unmapped.types}. Add them to route_type_modes.`,
    );
  }

  await sql`delete from baselines where feed_id = ${feed.id} and service_date = ${iso}`;
  const [{ id: b }] = await sql`
    insert into baselines (feed_id, service_date, day_type, label)
    values (${feed.id}, ${iso}, ${dayType}, ${label}) returning id`;

  const step = async (name: string, statement: string) => {
    const started = Date.now();
    const result = await sql.unsafe(statement);
    // Keep planner statistics current: a freshly inserted baseline is invisible to the planner
    // until analysed, and it then picks nested loops over hundreds of thousands of rows.
    const inserted = /^\s*(?:with[\s\S]*?\)\s*)?insert into (\w+)/i.exec(statement);
    if (inserted) await sql.unsafe(`analyze ${inserted[1]}`);
    log(
      `  ${name}: ${(result.count ?? 0).toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  };

  // `b`, `date` and `weekday` are validated above, so they are safe to inline.
  await sql.unsafe(`drop table if exists staging.day_trips`);
  await step(
    'trips running on the day',
    `create unlogged table staging.day_trips as
     select t.* from staging.trips t
     where t.service_id in (
       select service_id from staging.calendar
       where ${weekday} = '1' and start_date <= '${date}' and end_date >= '${date}'
         and service_id not in (select service_id from staging.calendar_dates where date = '${date}' and exception_type = '2')
       union
       select service_id from staging.calendar_dates where date = '${date}' and exception_type = '1')`,
  );

  await step(
    'routes',
    `insert into routes (baseline_id, gtfs_id, agency_gtfs_id, agency_name, short_name, long_name, description,
                         route_type, mode_id, color, text_color, extra)
     select ${b}, r.route_id, r.agency_id, a.agency_name, nullif(r.route_short_name, ''), nullif(r.route_long_name, ''),
            nullif(r.route_desc, ''), r.route_type::int, m.mode_id, nullif(r.route_color, ''), nullif(r.route_text_color, ''),
            jsonb_build_object('exact_times', r.exact_times)
     from staging.routes r
     join route_type_modes m on m.route_type = r.route_type::int
     left join staging.agency a on a.agency_id = r.agency_id`,
  );

  await step(
    'stops',
    `insert into stops (baseline_id, gtfs_id, code, name, location_type, parent_gtfs_id, platform_code, wheelchair, level_id, geom)
     select ${b}, stop_id, nullif(stop_code, ''), stop_name, coalesce(nullif(location_type, '')::int, 0),
            nullif(parent_station, ''), nullif(platform_code, ''), nullif(wheelchair_boarding, '')::int, nullif(level_id, ''),
            ST_SetSRID(ST_MakePoint(stop_lon::float8, stop_lat::float8), 4326)
     from staging.stops`,
  );
  await step(
    'stop parents',
    `update stops s set parent_id = p.id from stops p
     where s.baseline_id = ${b} and p.baseline_id = ${b} and p.gtfs_id = s.parent_gtfs_id`,
  );

  await step(
    'shapes',
    `insert into shapes (baseline_id, gtfs_id, geom, length_m, dists)
     select ${b}, shape_id,
            ST_SetSRID(ST_MakeLine(ST_MakePoint(shape_pt_lon::float8, shape_pt_lat::float8) order by shape_pt_sequence::int), 4326),
            max(shape_dist_traveled::float8),
            array_agg(shape_dist_traveled::float8 order by shape_pt_sequence::int)
     from staging.shapes
     where shape_id in (select distinct shape_id from staging.day_trips)
     group by shape_id having count(*) >= 2`,
  );

  await step(
    'trips',
    `with p as (
       select t.*, r.id as route_pk, r.mode_id, r.route_type, r.short_name, string_to_array(t.trip_id, '.') as parts
       from staging.day_trips t join routes r on r.baseline_id = ${b} and r.gtfs_id = t.route_id),
     q as (
       select p.*,
         case when mode_id = 'train' and array_length(parts, 1) = 7 and parts[5] ~ '^[A-Za-z]$' then 5
              when mode_id = 'train' and array_length(parts, 1) = 6 and parts[4] ~ '^[A-Za-z]$' then 4 end as set_at
       from p)
     insert into trips (baseline_id, gtfs_id, route_id, shape_id, service_gtfs_id, headsign, direction_id, feed_block_id,
                        trip_name, run_key, set_type, cars, extra)
     select ${b}, q.trip_id, q.route_pk, sh.id, q.service_id, nullif(q.trip_headsign, ''), nullif(q.direction_id, '')::int,
            nullif(q.block_id, ''),
            case when q.mode_id = 'train' then q.parts[1] end,
            case when q.route_type = 2 and q.short_name ~ '^T[0-9]$' and array_length(q.parts, 1) = 7 then left(q.parts[1], 3) end,
            upper(q.parts[q.set_at]),
            case when q.parts[q.set_at + 1] ~ '^[0-9]+$' then q.parts[q.set_at + 1]::int end,
            jsonb_strip_nulls(jsonb_build_object(
              'wheelchair_accessible', nullif(q.wheelchair_accessible, ''), 'route_direction', nullif(q.route_direction, ''),
              'trip_note', nullif(q.trip_note, ''), 'bikes_allowed', nullif(q.bikes_allowed, '')))
     from q left join shapes sh on sh.baseline_id = ${b} and sh.gtfs_id = q.shape_id`,
  );

  await step(
    'stop times',
    `insert into stop_times (trip_id, seq, stop_id, arr, dep, dist, pickup_type, drop_off_type, timepoint, headsign, note)
     select t.id, st.stop_sequence::int, s.id, gtfs_secs(st.arrival_time), gtfs_secs(st.departure_time),
            nullif(st.shape_dist_traveled, '')::real, coalesce(nullif(st.pickup_type, '')::smallint, 0),
            coalesce(nullif(st.drop_off_type, '')::smallint, 0), nullif(st.timepoint, '')::smallint,
            nullif(st.stop_headsign, ''), nullif(st.stop_note, '')
     from staging.stop_times st
     join trips t on t.baseline_id = ${b} and t.gtfs_id = st.trip_id
     join stops s on s.baseline_id = ${b} and s.gtfs_id = st.stop_id`,
  );
  await sql.unsafe(
    `analyze trips; analyze stop_times; analyze stops; analyze shapes; analyze routes`,
  );

  await sql.unsafe(`drop table if exists staging.day_seq`);
  await step(
    'trip stop sequences',
    `create unlogged table staging.day_seq as
     select st.trip_id, array_agg(st.stop_id order by st.seq) as stop_ids,
            min(st.dep) as start_secs, max(st.arr) as end_secs
     from stop_times st join trips t on t.id = st.trip_id
     where t.baseline_id = ${b} group by st.trip_id`,
  );
  await step(
    'trip start, end and terminals',
    `update trips t set start_secs = q.start_secs, end_secs = q.end_secs,
            first_stop_id = q.stop_ids[1], last_stop_id = q.stop_ids[array_length(q.stop_ids, 1)]
     from staging.day_seq q where q.trip_id = t.id`,
  );
  await step(
    'trips with no stop times removed',
    `delete from trips where baseline_id = ${b} and start_secs is null`,
  );

  await step(
    'patterns',
    `insert into patterns (baseline_id, route_id, direction_id, shape_id, headsign, stop_ids, trip_count, key)
     select ${b}, t.route_id, t.direction_id, t.shape_id, mode() within group (order by t.headsign), q.stop_ids, count(*),
            md5(t.route_id || '|' || coalesce(t.direction_id, -1) || '|' || coalesce(t.shape_id, -1) || '|' || q.stop_ids::text)
     from trips t join staging.day_seq q on q.trip_id = t.id
     where t.baseline_id = ${b}
     group by t.route_id, t.direction_id, t.shape_id, q.stop_ids`,
  );
  await step(
    'trip patterns',
    `update trips t set pattern_id = p.id
     from staging.day_seq q, patterns p
     where q.trip_id = t.id and t.baseline_id = ${b} and p.baseline_id = ${b}
       and p.key = md5(t.route_id || '|' || coalesce(t.direction_id, -1) || '|' || coalesce(t.shape_id, -1) || '|' || q.stop_ids::text)`,
  );
  await sql.unsafe(`drop table staging.day_seq; drop table staging.day_trips`);

  await step(
    'map lines',
    `insert into map_lines (baseline_id, route_id, shape_id, mode_id, color, name, trips, geom_lo, geom_mid, geom_hi)
     select ${b}, r.id, s.id, r.mode_id, '#' || coalesce(r.color, m.color), coalesce(r.short_name, ''), sum(p.trip_count),
            ST_Simplify(g.merc, 250), ST_Simplify(g.merc, 30), ST_Simplify(g.merc, 3)
     from patterns p
     join shapes s on s.id = p.shape_id
     join routes r on r.id = p.route_id
     join modes m on m.id = r.mode_id
     cross join lateral (select ST_Transform(s.geom, 3857) as merc) g
     where p.baseline_id = ${b}
     group by r.id, s.id, m.id, g.merc`,
  );

  await step(
    'route trip counts',
    `update routes r set trip_count = c.n
     from (select route_id, count(*) n from trips where baseline_id = ${b} group by 1) c where c.route_id = r.id`,
  );
  await step(
    'modes calling at each stop',
    `update stops s set mode_ids = c.modes
     from (select st.stop_id, array_agg(distinct r.mode_id) modes
           from stop_times st join trips t on t.id = st.trip_id join routes r on r.id = t.route_id
           where t.baseline_id = ${b} group by 1) c
     where c.stop_id = s.id`,
  );

  await step(
    'modes calling at each station',
    `update stops p set mode_ids = c.modes
     from (select s.parent_id, array_agg(distinct m) modes
           from stops s, unnest(s.mode_ids) m
           where s.baseline_id = ${b} and s.parent_id is not null group by 1) c
     where c.parent_id = p.id`,
  );

  // Vehicle types found in train trip IDs. Capacities are placeholders until sourced.
  const names = Object.entries(SET_NAMES)
    .map(([k, v]) => `('${k}', '${v}')`)
    .join(', ');
  await step(
    'vehicle types seen in the feed',
    `insert into vehicle_types (code, name, mode_id, cars, seated, standing)
     select distinct 'TRAIN-' || t.set_type || '-' || t.cars,
            coalesce(n.name, 'Set type ' || t.set_type) || ' (' || t.set_type || ' set), ' || t.cars || ' cars',
            'train', t.cars, t.cars * 100, t.cars * 50
     from trips t left join (values ${names}) as n(letter, name) on n.letter = t.set_type
     where t.baseline_id = ${b} and t.set_type is not null and t.cars is not null
     on conflict (code) do nothing`,
  );
  await step(
    'trip vehicle types from the feed',
    `update trips t set vehicle_type_id = v.id from vehicle_types v
     where t.baseline_id = ${b} and t.set_type is not null and t.cars is not null
       and v.code = 'TRAIN-' || t.set_type || '-' || t.cars`,
  );

  await step(
    'stay-aboard links',
    `insert into stay_aboard_links (baseline_id, from_trip_id, to_trip_id, feed_block_id)
     select ${b}, id, next_id, feed_block_id from (
       select id, feed_block_id, lead(id) over (partition by feed_block_id order by start_secs, id) next_id
       from trips where baseline_id = ${b} and feed_block_id is not null) x
     where next_id is not null`,
  );

  await step(
    'pathways',
    `insert into pathways (baseline_id, gtfs_id, from_stop_id, to_stop_id, pathway_mode, is_bidirectional, traversal_secs)
     select ${b}, p.pathway_id, f.id, t.id, p.pathway_mode::int, p.is_bidirectional = '1', nullif(p.traversal_time, '')::int
     from staging.pathways p
     join stops f on f.baseline_id = ${b} and f.gtfs_id = p.from_stop_id
     join stops t on t.baseline_id = ${b} and t.gtfs_id = p.to_stop_id`,
  );

  await step(
    'platform and wharf overlaps already in the feed',
    `insert into baseline_conflicts (baseline_id, stop_id, trip_a, trip_b, from_secs, to_secs)
     with calls as (
       select st.stop_id, st.trip_id, st.arr, st.dep
       from stop_times st join trips t on t.id = st.trip_id join routes r on r.id = t.route_id join modes m on m.id = r.mode_id
       where t.baseline_id = ${b} and m.rule_set in ('rail', 'ferry'))
     select ${b}, c1.stop_id, c1.trip_id, c2.trip_id, greatest(c1.arr, c2.arr), least(c1.dep, c2.dep)
     from calls c1 join calls c2
       on c1.stop_id = c2.stop_id and c1.trip_id < c2.trip_id and c1.arr <= c2.dep and c2.arr <= c1.dep`,
  );

  return { id: b, label };
}
