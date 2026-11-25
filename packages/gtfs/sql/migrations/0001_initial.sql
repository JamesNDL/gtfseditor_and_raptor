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

-- Stops a scenario has added. A road stop may name its partner across the road, used on the way back.
alter table stops add column if not exists scenario_id int references scenarios on delete cascade;
alter table stops add column if not exists created_edit int;
alter table stops add column if not exists partner_id bigint;
create index if not exists stops_scenario_idx on stops (scenario_id) where scenario_id is not null;

-- Roads and lines a scenario has closed, kept so that the map can show them. The trips that ran
-- through each one were changed by the same edit.
create table if not exists scenario_closures (
  id bigserial primary key,
  scenario_id int not null references scenarios on delete cascade,
  created_edit int not null,
  -- 'road', or the mode whose line is closed.
  kind text not null,
  label text not null,
  geom geometry(MultiPolygon, 4326) not null
);
create index if not exists scenario_closures_scenario_idx on scenario_closures (scenario_id);
-- A closure for part of the day: when it starts and ends, in seconds since the start of the service
-- day. Both null for a closure that lasts all day.
alter table scenario_closures add column if not exists from_secs int;
alter table scenario_closures add column if not exists to_secs int;

-- Stops a scenario has deleted: published ones, or ones the scenario added itself. A deleted
-- station is listed with every stop under it. The trips that called there were changed by the same
-- edit; like everything else, the row carries the edit that made it, so undo only moves `head`.
create table if not exists scenario_removed_stops (
  scenario_id int not null references scenarios on delete cascade,
  stop_id bigint not null references stops on delete cascade,
  edit_seq int not null,
  primary key (scenario_id, stop_id)
);

-- ---------------------------------------------------------------------------
-- The passenger simulator (docs/simulator-plan.md, phase S3).
-- ---------------------------------------------------------------------------

-- A file of journeys, uploaded or made up once and kept, so that the same people can be sent
-- through the published timetable and through any scenario. It belongs to no scenario. The file
-- itself is under data/sim/demand; this row is what is known about it.
create table if not exists demand_sets (
  id serial primary key,
  name text not null,
  file text not null,
  -- 'checking' or 'generating' while the router works on it, then 'ready' or 'failed'.
  state text not null default 'ready',
  error text,
  made_up boolean not null default false,
  row_count int not null default 0,
  people bigint not null default 0,
  users int not null default 0,
  earliest int,
  latest int,
  -- What the reader made of the file: rows refused and why, the busiest hour.
  report jsonb not null default '{}',
  -- How many journey ends name each stop id, for telling which ids a timetable does not have.
  stop_counts jsonb not null default '{}',
  made_by text,
  created_at timestamptz not null default now()
);

-- A box on the map that a run can be limited to.
create table if not exists sim_areas (
  id serial primary key,
  name text not null unique,
  south double precision not null,
  west double precision not null,
  north double precision not null,
  east double precision not null,
  -- One of the four the editor comes with; those cannot be removed.
  provided boolean not null default false,
  check (south < north and west < east)
);

insert into sim_areas (name, south, west, north, east, provided) values
  ('Opal area',                    -34.75, 150.10, -32.70, 151.85, true),
  ('Newcastle and the Hunter',     -33.20, 151.15, -32.70, 151.85, true),
  ('Sydney',                       -34.20, 150.60, -33.40, 151.40, true),
  ('Wollongong and the Illawarra', -34.75, 150.60, -34.10, 151.10, true)
on conflict (name) do nothing;

-- Folders of the simulation library. A folder may sit inside another.
create table if not exists sim_folders (
  id serial primary key,
  name text not null,
  parent_id int references sim_folders on delete restrict,
  created_at timestamptz not null default now()
);

-- One run of the simulator. Every run is kept until someone removes it.
--   kind 'bau': on the published timetable. scenario_id is null.
--   kind 'scenario': on a scenario, measured against the BAU run bau_run_id.
-- plans_run_id is set for a run that is another run's plans put on the vehicles again with
-- capacity on; it has that run's kind, scenario and BAU run.
create table if not exists sim_runs (
  id serial primary key,
  name text not null,
  kind text not null check (kind in ('bau', 'scenario')),
  baseline_id int references baselines on delete set null,
  scenario_id int references scenarios on delete set null,
  -- The timetable the run was made on: the router's id for it, and the version of its contents.
  -- A run whose version is no longer the scenario's is out of date.
  timetable_id text not null,
  timetable_version text not null,
  -- The part of the version that capacities do not change. Kept apart because the plans of a
  -- run stay good when only capacities are edited.
  plan_version text not null,
  demand_set_id int references demand_sets on delete set null,
  bau_run_id int references sim_runs on delete set null,
  plans_run_id int references sim_runs on delete set null,
  -- The box the run is limited to, or null for the whole network. Copied here so that removing a
  -- saved area changes no run.
  area_name text,
  area_south double precision,
  area_west double precision,
  area_north double precision,
  area_east double precision,
  capacity boolean not null default false,
  settings jsonb not null default '{}',
  -- 'queued', 'preparing' (the timetable), 'running' (on the router), 'importing' (the results),
  -- then 'done', 'failed' or 'stopped'.
  state text not null default 'queued',
  progress jsonb not null default '{}',
  error text,
  summary jsonb,
  -- The run's id on the router service, which holds its files.
  router_run_id text,
  folder_id int references sim_folders on delete set null,
  made_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- Rows held in the result tables. An archived run keeps its loads and stop figures here and its
  -- journeys and legs only as files on the router.
  result_rows bigint not null default 0,
  archived boolean not null default false
);
create index if not exists sim_runs_bau_idx on sim_runs (bau_run_id);
create index if not exists sim_runs_folder_idx on sim_runs (folder_id);

-- Results. Each table is partitioned by run, so that removing or archiving a run is dropping a
-- table and not deleting millions of rows. Times are seconds from the start of the service day.
-- Trips, routes and stops are the editor's own ids; one the editor no longer has is null.
create table if not exists sim_journeys (
  run_id int not null,
  journey_id text not null,
  part int not null,
  user_id text not null,
  people int not null,
  status text not null,
  start_secs int not null,
  depart int,
  arrive int,
  journey_secs int,
  rides int not null,
  boardings int not null,
  walk_secs int not null,
  wait_secs int,
  left_behind int not null,
  rerouted boolean not null,
  stops text,
  reference_arrive int,
  later_secs int,
  margin_secs int not null,
  origin_changed boolean not null,
  origin_stop_id bigint,
  origin_walk_metres int not null,
  destination_changed boolean not null,
  destination_stop_id bigint,
  destination_walk_metres int not null,
  change_reason text,
  no_journey_reason text,
  stranded_stop_id bigint,
  stranded_time int
) partition by list (run_id);

create table if not exists sim_legs (
  run_id int not null,
  journey_id text not null,
  part int not null,
  leg int not null,
  kind text not null,
  trip_id bigint,
  route_id bigint,
  from_stop_id bigint,
  to_stop_id bigint,
  depart int not null,
  arrive int not null,
  metres int not null,
  stay_aboard boolean not null,
  people int not null
) partition by list (run_id);

create table if not exists sim_trip_loads (
  run_id int not null,
  trip_id bigint,
  trip_gtfs_id text not null,
  position int not null,
  stop_id bigint,
  arrive int not null,
  depart int not null,
  boardings int not null,
  alightings int not null,
  load int not null,
  left_behind int not null,
  capacity int not null
) partition by list (run_id);

create table if not exists sim_stop_activity (
  run_id int not null,
  stop_id bigint,
  stop_gtfs_id text not null,
  quarter_start int not null,
  boardings int not null,
  alightings int not null,
  changes int not null,
  left_behind int not null,
  max_waiting int not null
) partition by list (run_id);

-- Passengers on each stretch between two consecutive calls of a trip, by half hour of the day.
-- Worked out from sim_trip_loads the first time a run's flows are asked for
-- (apps/api/src/sim/results-read.ts) and kept, because it takes several seconds for a big run.
-- A platform counts as its station.
create table if not exists sim_link_loads (
  run_id int not null references sim_runs on delete cascade,
  from_stop bigint not null,
  to_stop bigint not null,
  half_hour smallint not null,
  mode_id text,
  passengers int not null,
  places int not null
);
create index if not exists sim_link_loads_run_idx on sim_link_loads (run_id);
