-- GTFS Editor schema. Idempotent: safe to run on every start.
create extension if not exists postgis;
create schema if not exists staging;

create or replace function gtfs_secs(t text) returns int language sql immutable as $$
  select split_part(t, ':', 1)::int * 3600 + split_part(t, ':', 2)::int * 60 + split_part(t, ':', 3)::int
$$;

-- Which raw feed is currently loaded in the staging schema.
create table if not exists staged_feed (
  only_row boolean primary key default true check (only_row),
  feed_id text not null,
  staged_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Reference data (shared by all baselines)
-- ---------------------------------------------------------------------------
create table if not exists modes (
  id text primary key,
  name text not null,
  rule_set text not null check (rule_set in ('rail', 'ferry', 'road')),
  sort int not null,
  color text not null
);

create table if not exists route_type_modes (
  route_type int primary key,
  mode_id text not null references modes
);

create table if not exists vehicle_types (
  id serial primary key,
  code text not null unique,
  name text not null,
  mode_id text not null references modes,
  cars int,
  seated int not null,
  standing int not null,
  -- True until someone replaces the placeholder numbers with sourced ones.
  capacity_is_placeholder boolean not null default true
);

create table if not exists mode_default_vehicle (
  mode_id text primary key references modes,
  vehicle_type_id int not null references vehicle_types
);

-- ---------------------------------------------------------------------------
-- Baselines: one immutable import of one service day from one feed
-- ---------------------------------------------------------------------------
create table if not exists baselines (
  id serial primary key,
  feed_id text not null,
  service_date date not null,
  day_type text not null,
  label text not null,
  imported_at timestamptz not null default now(),
  ready boolean not null default false,
  stats jsonb not null default '{}',
  unique (feed_id, service_date)
);

create table if not exists routes (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  gtfs_id text not null,
  agency_gtfs_id text,
  agency_name text,
  short_name text,
  long_name text,
  description text,
  route_type int not null,
  mode_id text not null references modes,
  color text,
  text_color text,
  vehicle_type_id int references vehicle_types,
  trip_count int not null default 0,
  extra jsonb not null default '{}',
  unique (baseline_id, gtfs_id)
);

create table if not exists stops (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  gtfs_id text not null,
  code text,
  name text not null,
  location_type int not null default 0,
  parent_gtfs_id text,
  parent_id bigint,
  platform_code text,
  wheelchair int,
  level_id text,
  -- Modes that call here on the service day. Stations carry the union of their platforms. Empty if unused.
  mode_ids text[] not null default '{}',
  geom geometry(Point, 4326) not null,
  unique (baseline_id, gtfs_id)
);
create index if not exists stops_geom_idx on stops using gist (geom);
create index if not exists stops_parent_idx on stops (parent_id);

create table if not exists shapes (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  gtfs_id text not null,
  length_m double precision,
  geom geometry(LineString, 4326) not null,
  unique (baseline_id, gtfs_id)
);
create index if not exists shapes_geom_idx on shapes using gist (geom);

create table if not exists patterns (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  route_id bigint not null references routes on delete cascade,
  direction_id int,
  shape_id bigint references shapes,
  headsign text,
  stop_ids bigint[] not null,
  trip_count int not null,
  key text not null,
  unique (baseline_id, key)
);
create index if not exists patterns_route_idx on patterns (route_id);
create index if not exists patterns_shape_idx on patterns (shape_id);

create table if not exists vehicle_days (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  mode_id text not null references modes,
  label text not null,
  -- 'run_number': read from the feed's train run numbers. 'inferred': chained by the importer.
  source text not null check (source in ('run_number', 'inferred')),
  vehicle_type_id int references vehicle_types,
  trip_count int not null,
  start_secs int not null,
  end_secs int not null,
  -- Consecutive trips that do not start where the previous one ended (an empty run is needed).
  gap_count int not null default 0
);
create index if not exists vehicle_days_baseline_idx on vehicle_days (baseline_id);

create table if not exists trips (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  gtfs_id text not null,
  route_id bigint not null references routes on delete cascade,
  pattern_id bigint references patterns,
  shape_id bigint references shapes,
  service_gtfs_id text not null,
  headsign text,
  direction_id int,
  feed_block_id text,
  trip_name text,
  run_key text,
  set_type text,
  cars int,
  vehicle_type_id int references vehicle_types,
  vehicle_day_id bigint references vehicle_days on delete set null,
  vehicle_day_seq int,
  start_secs int,
  end_secs int,
  first_stop_id bigint,
  last_stop_id bigint,
  extra jsonb not null default '{}',
  unique (baseline_id, gtfs_id)
);
create index if not exists trips_route_idx on trips (route_id, start_secs);
create index if not exists trips_vehicle_day_idx on trips (vehicle_day_id, vehicle_day_seq);
create index if not exists trips_pattern_idx on trips (pattern_id);
create index if not exists trips_shape_idx on trips (shape_id);
create index if not exists trips_last_stop_idx on trips (last_stop_id);
create index if not exists trips_baseline_idx on trips (baseline_id, start_secs);

create table if not exists stop_times (
  trip_id bigint not null references trips on delete cascade,
  seq int not null,
  stop_id bigint not null,
  arr int not null,
  dep int not null,
  dist real,
  pickup_type smallint not null default 0,
  drop_off_type smallint not null default 0,
  timepoint smallint,
  headsign text,
  note text,
  primary key (trip_id, seq)
);
create index if not exists stop_times_stop_idx on stop_times (stop_id, arr);

-- Passengers can stay on the vehicle between these two trips (block_id in the TfNSW feed).
create table if not exists stay_aboard_links (
  baseline_id int not null references baselines on delete cascade,
  from_trip_id bigint not null references trips on delete cascade,
  to_trip_id bigint not null references trips on delete cascade,
  feed_block_id text,
  primary key (from_trip_id, to_trip_id)
);
create index if not exists stay_aboard_to_idx on stay_aboard_links (to_trip_id);

create table if not exists pathways (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  gtfs_id text not null,
  from_stop_id bigint not null,
  to_stop_id bigint not null,
  pathway_mode int not null,
  is_bidirectional boolean not null,
  traversal_secs int
);
create index if not exists pathways_from_idx on pathways (from_stop_id);

-- Two trips occupying the same platform or wharf at once in the feed as published.
create table if not exists baseline_conflicts (
  id bigserial primary key,
  baseline_id int not null references baselines on delete cascade,
  stop_id bigint not null,
  trip_a bigint not null references trips on delete cascade,
  trip_b bigint not null references trips on delete cascade,
  from_secs int not null,
  to_secs int not null
);
create index if not exists baseline_conflicts_baseline_idx on baseline_conflicts (baseline_id);

-- Route lines prepared for map tiles: one row per route and shape, in Web Mercator, at three levels of detail.
create table if not exists map_lines (
  baseline_id int not null references baselines on delete cascade,
  route_id bigint not null references routes on delete cascade,
  shape_id bigint not null,
  mode_id text not null,
  color text not null,
  name text not null,
  trips int not null,
  geom_lo geometry(LineString, 3857) not null,
  geom_mid geometry(LineString, 3857) not null,
  geom_hi geometry(LineString, 3857) not null,
  primary key (route_id, shape_id)
);
create index if not exists map_lines_lo_idx on map_lines using gist (geom_lo);
create index if not exists map_lines_mid_idx on map_lines using gist (geom_mid);
create index if not exists map_lines_hi_idx on map_lines using gist (geom_hi);

-- Every trip resolves to exactly one vehicle type: trip, then vehicle day, then route, then mode default.
create or replace view trip_vehicle as
select
  t.id as trip_id,
  coalesce(t.vehicle_type_id, vd.vehicle_type_id, r.vehicle_type_id, mdv.vehicle_type_id) as vehicle_type_id,
  case
    when t.vehicle_type_id is not null then 'trip'
    when vd.vehicle_type_id is not null then 'vehicle_day'
    when r.vehicle_type_id is not null then 'route'
    else 'mode_default'
  end as assigned_at,
  -- "Assumed" means nobody (feed or user) chose it; it fell through to the mode default.
  (t.vehicle_type_id is null and vd.vehicle_type_id is null and r.vehicle_type_id is null) as assumed
from trips t
join routes r on r.id = t.route_id
left join vehicle_days vd on vd.id = t.vehicle_day_id
left join mode_default_vehicle mdv on mdv.mode_id = r.mode_id;

-- ---------------------------------------------------------------------------
-- Seed reference data
-- ---------------------------------------------------------------------------
insert into modes (id, name, rule_set, sort, color) values
  ('train',      'Train',       'rail',  1, 'F6891F'),
  ('metro',      'Metro',       'rail',  2, '168388'),
  ('light_rail', 'Light rail',  'rail',  3, 'EE343F'),
  ('ferry',      'Ferry',       'ferry', 4, '5AB031'),
  ('bus',        'Bus',         'road',  5, '00B5EF'),
  ('coach',      'Coach',       'road',  6, '742282'),
  ('school_bus', 'School bus',  'road',  7, 'FDD835')
on conflict (id) do nothing;

-- TfNSW uses extended route types. Unmapped types make the import fail loudly.
insert into route_type_modes (route_type, mode_id) values
  (2, 'train'), (106, 'train'), (401, 'metro'), (900, 'light_rail'), (4, 'ferry'),
  (700, 'bus'), (714, 'bus'), (712, 'school_bus'), (204, 'coach'), (205, 'coach')
on conflict (route_type) do nothing;

-- Placeholder capacities: round numbers, NOT sourced. Replace before using for analysis.
insert into vehicle_types (code, name, mode_id, cars, seated, standing) values
  ('DEFAULT-TRAIN',      'Train (assumed)',          'train',      8, 800, 400),
  ('DEFAULT-METRO',      'Metro train (assumed)',    'metro',      6, 350, 750),
  ('DEFAULT-LIGHT-RAIL', 'Light rail vehicle (assumed)', 'light_rail', null, 100, 200),
  ('DEFAULT-FERRY',      'Ferry (assumed)',          'ferry',      null, 300, 100),
  ('DEFAULT-BUS',        'Standard bus (assumed)',   'bus',        null, 45, 20),
  ('DEFAULT-COACH',      'Coach (assumed)',          'coach',      null, 50, 0),
  ('DEFAULT-SCHOOL-BUS', 'School bus (assumed)',     'school_bus', null, 55, 15)
on conflict (code) do nothing;

insert into mode_default_vehicle (mode_id, vehicle_type_id)
select m.id, v.id from modes m
join vehicle_types v on v.code = 'DEFAULT-' || upper(replace(m.id, '_', '-'))
on conflict (mode_id) do nothing;

-- ---------------------------------------------------------------------------
-- Scenarios: edits layered over a baseline. Nothing is copied when one is created.
--
-- An edited trip is a new row in `trips` owned by the scenario; the row it replaces is listed in
-- `scenario_removed`. Every row records the edit number that created or removed it, and the
-- scenario's `head` says how many edits are currently applied, so undo and redo only move `head`.
-- ---------------------------------------------------------------------------
create table if not exists scenarios (
  id serial primary key,
  baseline_id int not null references baselines on delete cascade,
  name text not null,
  head int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists scenario_edits (
  scenario_id int not null references scenarios on delete cascade,
  seq int not null,
  kind text not null,
  summary text not null,
  created_at timestamptz not null default now(),
  primary key (scenario_id, seq)
);

alter table trips add column if not exists scenario_id int references scenarios on delete cascade;
-- The baseline trip this one ultimately descends from (null for brand-new trips).
alter table trips add column if not exists origin_trip_id bigint;
-- The row this one was copied from in the edit that made it.
alter table trips add column if not exists cloned_from bigint;
alter table trips add column if not exists created_edit int;
alter table trips add column if not exists removed_edit int;
-- Set by hand-edits; frequency changes leave pinned trips alone.
alter table trips add column if not exists pinned boolean not null default false;
create index if not exists trips_scenario_idx on trips (scenario_id) where scenario_id is not null;

-- Vehicles added by a scenario for its new trips.
alter table vehicle_days add column if not exists scenario_id int references scenarios on delete cascade;
alter table vehicle_days add column if not exists created_edit int;

create table if not exists scenario_removed (
  scenario_id int not null references scenarios on delete cascade,
  trip_id bigint not null references trips on delete cascade,
  edit_seq int not null,
  primary key (scenario_id, trip_id)
);

-- How many vehicles of each type the fleet has. Null means no limit is set.
alter table vehicle_types add column if not exists fleet_size int;

-- The feed's own distance along the shape at each point, in point order. Kept exactly so that an
-- export lines up with the stop times; re-measuring the line gives different numbers.
alter table shapes add column if not exists dists float8[];

-- Lines a scenario has created, with their shapes and stopping patterns.
alter table routes add column if not exists scenario_id int references scenarios on delete cascade;
alter table routes add column if not exists created_edit int;
alter table shapes add column if not exists scenario_id int references scenarios on delete cascade;
alter table shapes add column if not exists created_edit int;
alter table patterns add column if not exists scenario_id int references scenarios on delete cascade;
alter table patterns add column if not exists created_edit int;
