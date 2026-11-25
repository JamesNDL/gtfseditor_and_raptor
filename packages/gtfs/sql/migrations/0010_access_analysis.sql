-- Access analysis (docs/architecture/access-analysis.md §4.3): saved zones and points of interest,
-- and each analysis with its copied zone, points of interest, sample points and results.
-- Numbered 0010 so that 0002 to 0009 stay free for trustworthy-edits (D24).
-- Only adds tables. To take it back by hand: drop analysis_results, analysis_points,
-- analysis_pois, analyses, points_of_interest and analysis_zones, in that order, and delete
-- version 0010 from schema_migrations. The runner has no down step.

-- A zone: an outline drawn on the map. Zones belong to no day and are reused on any (D25).
create table if not exists analysis_zones (
  id serial primary key,
  name text not null,
  geom geometry(Polygon, 4326) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A point of interest: a place people travel to. Like zones, they belong to no day (D25).
create table if not exists points_of_interest (
  id serial primary key,
  name text not null,
  -- What sort of place it is, and where it came from. Only 'place' and 'drawn' for now; kept so
  -- that points of interest loaded from elsewhere can be told apart later.
  kind text not null default 'place',
  source text not null default 'drawn',
  geom geometry(Point, 4326) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One access analysis. Its zone and points of interest are copied in when it is made, so that
-- renaming, moving or deleting them never changes a finished analysis (D25, FR-16).
create table if not exists analyses (
  id serial primary key,
  name text not null,
  -- The timetable: the published day, and the scenario on it or null for the day itself.
  baseline_id int references baselines on delete set null,
  scenario_id int references scenarios on delete set null,
  -- Copied, so the analysis still says what it ran on after the scenario is deleted.
  scenario_name text,
  -- The saved zone it was made from, or null once that is deleted; and the copy it uses.
  zone_id int references analysis_zones on delete set null,
  zone_name text not null,
  zone_geom geometry(Polygon, 4326) not null,
  -- md5 of the copied outline's text. Two analyses can be compared only when their outlines
  -- and spacings match (D31).
  zone_hash text not null,
  -- The AnalysisSettings it was run with (packages/core/src/analysis/defaults.ts).
  settings jsonb not null,
  -- The timetable the run was made on: the router's id for it, and the version of its contents.
  timetable_id text,
  timetable_version text,
  -- 'queued', 'preparing' (the timetable), 'running' (drives, then journeys), then 'done',
  -- 'failed' or 'cancelled'.
  state text not null default 'queued'
    check (state in ('queued', 'preparing', 'running', 'done', 'failed', 'cancelled')),
  -- While running: {stage, done, total} or {stage, secs}. Empty otherwise.
  progress jsonb not null default '{}',
  error text,
  sample_count int not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists analyses_baseline_idx on analyses (baseline_id);

-- The points of interest of an analysis, copied in when it is made, numbered from seq.
create table if not exists analysis_pois (
  analysis_id int not null references analyses on delete cascade,
  seq int not null,
  -- The saved point of interest it was copied from, or null once that is deleted.
  poi_id int references points_of_interest on delete set null,
  name text,
  geom geometry(Point, 4326),
  primary key (analysis_id, seq)
);

-- The sample points of an analysis, laid when it is made, with their grid column (i, west to
-- east) and row (j, south to north) (D26).
create table if not exists analysis_points (
  analysis_id int not null references analyses on delete cascade,
  seq int not null,
  i int,
  j int,
  lon float8,
  lat float8,
  primary key (analysis_id, seq)
);

-- One row per pair: a sample point (point_seq) and a point of interest (poi_seq). Made 'pending'
-- when the run starts; a pair is finished when its status is not 'pending', so a resumed run
-- carries on where it stopped. Times are in seconds.
create table if not exists analysis_results (
  analysis_id int not null references analyses on delete cascade,
  point_seq int not null,
  poi_seq int not null,
  status text not null check (status in ('pending', 'ok', 'noService', 'noRoad')),
  -- Set once the drives step has asked the road router about this pair. A pair with no road
  -- keeps its drive columns null.
  drive_checked boolean not null default false,
  -- The public transport side, from the asked departure time (D23), and the journey's legs
  -- without the stops passed (D30).
  pt_secs int,
  walk_secs int,
  wait_secs int,
  ride_secs int,
  rides int,
  legs jsonb,
  -- The car side: the free-flow drive, then with the traffic factor and parking allowance.
  drive_secs real,
  drive_metres real,
  car_secs real,
  ratio real,
  primary key (analysis_id, poi_seq, point_seq)
);
