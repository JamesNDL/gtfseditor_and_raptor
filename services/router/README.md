# Journey router

A standalone Java service that will answer journey queries on a GTFS timetable. The design is in
[`docs/router-plan.md`](../../docs/router-plan.md).

**Status: phase 4 (capacity and bulk).** The library loads a GTFS zip into memory and plans journeys
on it (plain RAPTOR). It can respect how full the vehicles are, and add the passengers it routes to
them. Journeys can be planned from the command line or over HTTP: the service loads, reloads and
unloads timetables, keeps named load states, and answers one journey per request or many. Road
routing is not built, and the editor does not call the service yet. The passenger simulator
(`router-sim`) runs from the command line and as jobs on the service: see "The passenger simulator" below.

## Requirements

- A JDK, version 25 or newer, on the `PATH` or in `JAVA_HOME`. The code is compiled for Java 25.
- Nothing else. Gradle is fetched by the wrapper (`gradlew`) on first use.

## Commands

Run these from `services/router`. On Windows use `.\gradlew`; elsewhere use `./gradlew`.

| Task | Command |
|---|---|
| Build everything and run the tests | `.\gradlew build` |
| Run the tests only | `.\gradlew test` |
| Load a GTFS zip and report counts, time and memory | `.\gradlew -q :router-gtfs:loadTimetable` |
| Start the service (see "The service" below) | `.\gradlew :router-server:run` |
| Make up or check a demand file (see "The passenger simulator") | `.\gradlew -q :router-sim:demand` |
| Run a simulation | `.\gradlew -q :router-sim:simulate` |
| Run the benchmarks (a placeholder for now) | `.\gradlew :router-bench:jmh` |
| Stop the background build process | `.\gradlew --stop` |

## The service

`.\gradlew :router-server:run` (or `npm run router:dev` from the repository root) starts it on port
3002 with nothing loaded. It runs from the repository root with a 768 MB heap. To have a timetable
loaded at start, set `ROUTER_LOAD` first (PowerShell):

```
$env:ROUTER_LOAD = "b1=data/exports/check/export.zip"; npm run router:dev
```

| Method and path | Purpose |
|---|---|
| `GET /v1/health` | Up or not, and the ids of the timetables that are ready. |
| `GET /v1/timetables` | Every timetable with its status, version and counts. |
| `GET /v1/timetables/{id}` | The same for one, with the settings it was built with and the loader's notes. |
| `PUT /v1/timetables/{id}` | Load or reload. Answers `202` at once; ask the address above until `building` is gone. |
| `DELETE /v1/timetables/{id}` | Unload. |
| `POST /v1/journeys` | Plan one journey. |
| `POST /v1/journeys/bulk` | Plan many journeys; one line of answer each. |
| `GET /v1/timetables/{id}/loads` | The timetable's load states, each with its totals. |
| `POST /v1/timetables/{id}/loads` | Make a load state: empty, or from a CSV of loads. |
| `GET /v1/timetables/{id}/loads/{name}` | One load state's totals, or with `?format=csv` every load above 0. |
| `DELETE /v1/timetables/{id}/loads/{name}` | Discard a load state. |
| `POST`, `GET`, `DELETE /v1/simulations...` | Simulation runs as jobs; see "Runs on the service" below. |

An id is the caller's choice: up to 64 letters, digits, dots, dashes or underscores, for example
`b1` or `b1-s7`. An error is a `4xx` or `5xx` status with `{"error": "..."}`.

### Loading

Name the zip, or send it:

```
curl -X PUT localhost:3002/v1/timetables/b1 -H "Content-Type: application/json" -d "{\"source\":{\"path\":\"data/exports/check/export.zip\"},\"version\":\"v1\"}"
curl -X PUT localhost:3002/v1/timetables/b1 -H "Content-Type: application/json" -d "{\"source\":{\"url\":\"http://localhost:3001/api/baselines/1/export\"}}"
curl -X PUT "localhost:3002/v1/timetables/b1?version=v1" -H "Content-Type: application/zip" --data-binary @export.zip
```

- `version` is the caller's name for these contents and comes back with every answer; left out, it
  is the time of the request. `serviceDate` (for example `20261117`, in the JSON or the query
  string) is needed only for a feed that covers more than one day.
- A path is read where it lies, relative to the folder the service runs in. A fetched or uploaded
  zip is kept as `<ROUTER_DATA>/zips/<id>.zip`.
- A reload builds the new timetable beside the old one and swaps it in when ready. Journeys are
  answered on the old one until then. If the build fails the old one stays, and the metadata shows
  the reason under `lastFailure`.
- One build runs at a time; a second request for an id that is still building is refused with `409`.
- At most `ROUTER_MAX_TIMETABLES` are held. Loading one more drops the one used longest ago.
- `status` is `ready`, `building` (a first load not finished) or `failed` (a first load that failed).

There is no access control: anyone who can reach the port can load a file the service can read or
have it fetch a URL. Keep it on a trusted network.

### One journey

```
curl -X POST localhost:3002/v1/journeys -H "Content-Type: application/json" -d "{\"timetable\":\"b1\",\"from\":{\"stop\":\"200060\"},\"to\":{\"lat\":-33.8915,\"lon\":151.2767},\"depart\":\"07:45\"}"
```

| Field | Meaning | If left out |
|---|---|---|
| `timetable` | The id to plan on. | The only one loaded. |
| `from`, `to` | `{"stop": id}`, `{"station": id}` or `{"lat": .., "lon": ..}`. Ids are GTFS ids. A `stop` that names a station is taken as the station. | Required. |
| `depart` | `"HH:MM"`, `"HH:MM:SS"` or seconds from the start of the service day, up to `36:00:00`. After midnight keep counting: `"24:30"`. | Required. |
| `maxRides` | Most vehicles to board. | 8 |
| `maxWalkMetres` | Furthest to walk to the first stop or from the last, in a straight line; up to 5000. | 1200 |
| `avoid` | Kinds of vehicle to leave out: `train`, `metro`, `light_rail`, `ferry`, `bus`, `coach`, `school_bus`, `other`. `[]` leaves out nothing. | `["school_bus"]` |
| `changeSecs` | Least time to change vehicles at one stop. | 120 |
| `lessWalking` | `true` searches a second time with shorter walks; slower. | `false` |
| `detail` | `legs`, or `summary` to leave out the stops each ride passes. | `legs` |
| `capacity` | How full vehicles are treated; see "Capacity" below. | `{"mode": "off"}` |
| `group` | How many passengers travel together. They board only where all of them fit. | 1 |
| `blocked` | Boardings this passenger has been refused: `[{"trip": id, "stop": id}]`. The trip may still be boarded elsewhere. | none |

The answer has `status` (`ok`, or `noJourney` with a `reason`), the `journeys` (fastest first),
which one is `recommended` (its place in the list, or -1), the timetable's id and version, and
`computeMicros`. Times are seconds from the start of the service day. Each journey has `label`,
`depart`, `arrive`, `durationSecs`, `rides`, `changes`, `walkSecs`, `waitSecs` and its `legs`:

- `walk` (to the first stop or from the last) and `transfer` (between two stops): `from`, `to`,
  `depart`, `arrive`, `metres`.
- `ride`: `trip`, `route`, `routeId`, `mode`, `headsign`, `board` and `alight` (stop id, name,
  latitude and longitude, time, and `position`: the stop's place in the trip, counting from 0),
  `stops` (every stop from boarding to alighting, with latitude, longitude and times), and
  `stayAboard`.

### Capacity

A load state is how many passengers are aboard every trip as it leaves every stop. It belongs to
one loaded timetable and has a name. Make one before asking for `check` or `assign`:

```
curl -X POST localhost:3002/v1/timetables/b1/loads -H "Content-Type: application/json" -d "{\"name\":\"am-peak\"}"
curl -X POST "localhost:3002/v1/timetables/b1/loads?name=am-peak" -H "Content-Type: text/csv" --data-binary @loads.csv
curl "localhost:3002/v1/timetables/b1/loads/am-peak?format=csv"
```

The CSV has the columns `trip_id`, `position` and `load`: the passengers aboard that trip as it
leaves the stop at that position, counting stops from 0. (The timetable does not keep GTFS's
`stop_sequence`.) Places the file does not mention have nobody aboard. What the service writes also
has a `stop_id` column, and can be sent back as it is. A timetable holds at most 8 load states.
**Reloading a timetable discards its load states.**

A request says how to treat loads with `"capacity": {"mode": .., "loads": name}`:

| Mode | What it does |
|---|---|
| `off` | Ignores loads. The default. |
| `check` | A trip is passed over at a stop when those aboard as it leaves, plus this group, would be more than it holds; the next trip with room is taken. Nothing is added to the loads. |
| `assign` | The same, and then the passengers are added to every trip of the recommended journey. |

- A trip's capacity is seated plus standing from the editor's vehicle files, or a default for its
  kind of vehicle. Every capacity in the editor's export is a placeholder for now.
- `"fullAt": 0.6` counts a trip as full at that share of its capacity. The default is 1.
- A passenger already aboard a vehicle that runs on as another trip stays aboard whatever its load.
- With empty loads `check` gives exactly the answers of `off`.
- `status` is `stranded`, with no journeys, when there is a way but no room on it.
- Each ride gains `crowding` (`peakLoad` on the part ridden, `capacity`, `peakFactor`,
  `capacityIsPlaceholder`) and `skippedFullTrips`: full trips of the same line that left the
  boarding stop between when the passenger could first board there and when they did.
- With `assign` the answer also has `assigned` (the journey added to the loads: its place in the
  list, or -1) and `tries`.

The search looks at room only where the passenger boards. With `assign`, a passenger who turns out
not to fit further along the trip is not added: that boarding is refused them and they are routed
again, up to `"maxTries"` times (3 unless said), and then reported as `stranded`.

### Many journeys

```
curl -X POST localhost:3002/v1/journeys/bulk -H "Content-Type: application/json" -d @queries.json
```

```json
{
  "timetable": "b1",
  "capacity": { "mode": "assign", "loads": "run-1" },
  "queries": [
    { "id": "a1", "from": {"stop": "200060"}, "to": {"stop": "2000336"}, "depart": 27900 },
    { "id": "a2", "from": {"stop": "2150101"}, "to": {"stop": "200060"}, "depart": "07:47", "group": 2 }
  ]
}
```

The settings of one journey (`maxRides`, `maxWalkMetres`, `avoid`, `changeSecs`, `lessWalking`,
`detail`, `capacity`) are given once and apply to every query. Each query has `from`, `to`,
`depart`, and optionally `id` and `group`. At most `ROUTER_BULK_LIMIT` queries per request.

The answer is lines of JSON (`application/x-ndjson`), one per query, then one of totals:

```
{"id":"a1","status":"ok","tries":1,"journey":{"label":"fastest","depart":27906,"arrive":28680,...}}
{"id":"a2","status":"stranded","tries":2,"reason":"..."}
{"summary":{"queries":2,"ok":1,"noJourney":0,"stranded":1,"errors":0,"rerouted":1,"elapsedSecs":0.012,"perSecond":167,...}}
```

- Each line carries the one recommended journey, not the alternatives. `detail` is `summary`
  unless the request says `legs`, so rides do not list the stops they pass.
- A query that cannot be read, or names a stop the timetable does not have, gets a line with
  `"status": "error"`; the others are still planned. Those lines come first.
- In `off` and `check` the lines are in the order asked.
- In `assign`, passengers are handled in order of departure time, in slices of 5 minutes
  (`"sliceSecs"` in `capacity`). Everyone in a slice is routed against the loads as they stood when
  the slice began, then added one at a time in order; one who no longer fits is routed again at
  once. The lines are in the order passengers were added. The same request on the same loads gives
  the same answer, whatever `ROUTER_THREADS` is.
- This is first come, first served by departure time, not a simulation: whoever is handled first
  holds the place. `rerouted` and `stranded` in the totals show how much that mattered.
- Only one request at a time may add passengers to a load state; a second is refused with `409`.
- If the caller goes away the run stops. Passengers already added stay in the load state.

## Loading a timetable

`loadTimetable` with no arguments loads `data/exports/check/export.zip` (the editor's export of the
published weekday, written by `npm run export:check`) and keeps a snapshot in
`data/router/snapshots`. To load something else, pass arguments; paths are relative to the
repository root and must not contain spaces:

```
.\gradlew -q :router-gtfs:loadTimetable -PloadArgs="data/feeds/some-feed.zip --date 20261117"
```

| Argument | Meaning |
|---|---|
| `<zip>` | The GTFS zip. |
| `--date 20261117` | The service day. Needed unless the feed covers a single day, as the editor's export does. |
| `--snapshots <folder>` | Read a saved snapshot if one matches this zip and these settings; otherwise build and save one. |
| `--radius <metres>` | How close two stops must be to get a walking link. Default 500. |

From Java:

```java
Timetable timetable = GtfsLoader.load(zipPath, LoadOptions.defaults());
```

One test loads the real export and checks its counts against the editor's database. It is skipped
unless the environment variable `ROUTER_REAL_ZIP` holds the full path of that zip.

## Planning a journey

`route` plans on `data/exports/check/export.zip` unless `-Pzip=<zip>` names another feed. A place
is a stop id, a station id, or `latitude,longitude`. A time is `HH:MM` or `HH:MM:SS`; after
midnight on the same service day keep counting, for example `24:30`.

```
.\gradlew -q :router-gtfs:route -ProuteArgs="200060 202210 07:45"
.\gradlew -q :router-gtfs:route -ProuteArgs="-33.8915,151.2767 229310 07:45 --rides 4 --walk 600"
.\gradlew -q :router-gtfs:route -ProuteArgs="--random 3000"
```

The first is Central to Bondi Junction. School buses are left out. `--avoid ferry` leaves
out other kinds of vehicle instead, and `--avoid none` leaves out nothing.

`--random` plans that many test journeys inside the Opal area (Newcastle, Sydney, Wollongong)
between stops picked by how busy they are, replays every answer against the timetable, and reports
how good and how quick the answers are. It takes a few minutes for 3,000. Options: `--within 25`
keeps the two ends within that many km, `--show 5` prints the first journeys in full, `--threads 6`
sets the threads for the all-at-once run, `--area all` uses the whole state.

`--change 120` sets the least time, in seconds, to change vehicles at one stop (2 minutes unless
said). Staying aboard a vehicle that runs on as another trip takes no time.

To compare with the TfNSW trip planner, write test journeys to a file and hand it to the comparer.
It needs `API_KEY` in `.env`, sends only stop positions, a date and a time, and keeps TfNSW's
answers so that a second run asks nothing again:

```
npm run router:route -- "-ProuteArgs=--random 200 --within 25 --seed 7 --dump data/router/compare/within25.jsonl"
npm run router:compare -- data/router/compare/within25.jsonl
```

Each journey leaves as late as it can for its arrival. The result lists the fastest journey first,
then any with fewer changes that are not much slower, and names one as recommended: the lowest of
arrival time, plus 5 minutes per vehicle, plus the time walked again. Pass
`Preferences.lessWalking()` to `route` to search a second time with shorter walks and be offered a
journey that walks less; it is off unless asked for because queries take about half as long again.

From Java:

```java
Router router = new Router(timetable);   // safe to share between threads
Result result = router.route(new Place.Stop(from), new Place.Point(lat, lon), 7 * 3600 + 45 * 60);
Journey best = result.best();            // the recommended journey, or null

LoadState loads = LoadState.empty(timetable);                  // only for check and assign
Result checked = router.route(query, Preferences.defaults(), Capacity.of(loads));
int noRoom = loads.add(checked.best(), 1, 1.0);                // -1 if added, or the leg with no room
Assignment.run(router, requests, Preferences.defaults(),      // many at once, as the service does
        Assignment.Settings.of(CapacityMode.ASSIGN, loads), threads, (request, outcome) -> { });
```

## The passenger simulator

`router-sim` sends a file of journeys through a timetable and writes where the passengers ended up.
The design is in [`docs/simulator-plan.md`](../../docs/simulator-plan.md); phases S0 (demand files)
(the simulator, from the command line) and S2 (runs as jobs on the HTTP service) are built. The
editor does not call it yet.

### A demand file

A CSV with a header row, one journey to a row. The columns may be in any order.

| Column | Meaning | Needed |
|---|---|---|
| `user_id` | Who is travelling. Any text; one person may have several rows. | Yes |
| `start_time` | When they tapped on at the origin: `HH:MM`, `HH:MM:SS` or seconds from the start of the service day; after midnight keep counting (`24:30`). | Yes |
| `origin_stop`, `destination_stop` | GTFS stop or station ids. May be empty in a row that gives that end's position. | Yes |
| `origin_lat`, `origin_lon`, `destination_lat`, `destination_lon` | Where each end is. Left out, the stop's own position on the published timetable is used. | No |
| `journey_id` | The caller's id for the row. Left out, it is the row's number in the file, counting from 1. | No |
| `people` | How many people the row stands for. | No, 1 |

A value may be in double quotes but may not hold a line break. A file whose name ends in `.gz` is
read and written packed.

```
npm run router:demand -- "-PsimArgs=check data/sim/demand/mine.csv --zip data/exports/check/export.zip"
npm run router:demand -- "-PsimArgs=generate data/exports/check/export.zip --out data/sim/demand/made-up.csv.gz --journeys 100000"
```

`check` reads a file and reports the rows it refuses and why, the users, and the busiest hour; with
`--zip` it also looks the stop ids up. `generate` makes a set up, for use until real journey data
exists. A made-up set says nothing about real travel.

| Option of `generate` | Meaning | If left out |
|---|---|---|
| `--journeys` | Rows to make. | 100000 |
| `--seed` | The same seed gives the same set. | 1 |
| `--area` | `all`, `opal`, `newcastle`, `sydney`, `wollongong`, or `south,west,north,east`. | `opal` |
| `--within` | The furthest apart the two ends may be, in km; 0 for any distance. | 25 |
| `--focus` | The power each stop's weight is raised to. At 1 a stop is picked in proportion to its service and hardly any two journeys share a pair of stops; at 2 the big stations take most of them. | 1 |
| `--people` | How many people each row stands for. | 1 |

Add `--snapshots data/router/snapshots` wherever a zip is named to load it in a second or two.

### A run

There are three kinds. Paths are relative to the repository root and must not contain spaces.

```
npm run router:simulate -- "-PsimArgs=data/exports/check/export.zip --demand data/sim/demand/made-up.csv.gz --out data/router/sim/bau --area newcastle"
npm run router:simulate -- "-PsimArgs=data/exports/scenario-7.zip --bau data/router/sim/bau --out data/router/sim/s7"
npm run router:simulate -- "-PsimArgs=data/exports/check/export.zip --from-plans data/router/sim/bau"
```

1. **A BAU run** (`--demand`): the published timetable. Everyone travels between the stops in the
   data. It also works out each person's *margin*: how much better a nearby stop already was on the
   day, which they did not use.
2. **A scenario run** (`--bau <folder>`): another timetable, measured against a BAU run. It uses
   that run's journeys, area, walking distance and time per change of vehicle. A person changes to
   a stop nearby only if their own stop no longer gets them there, or the other is better by more
   than their margin plus a threshold. One who would arrive too much later than on the published
   timetable gives up and is put on no vehicle.
3. **Capacity added** (`--from-plans <folder>`): puts the kept plans of either kind of run on the
   vehicles again with capacity on, without planning again. The zip must be the one the run was
   planned on. The results go in `<folder>/capacity` unless `--out` says otherwise.

| Option | Meaning | If left out |
|---|---|---|
| `--area` | BAU only. Keep only journeys that start and end in this box. | `all` |
| `--walk` | BAU only. How far people will walk to another stop, in metres in a straight line, 0 to 2000. | 500 |
| `--change-penalty` | BAU only. Seconds a journey with one more vehicle must save to be taken. | 600 |
| `--share` | BAU only. Simulate one row in this many, each standing for that many times its people. | 1 |
| `--school-buses` | BAU only. Let people ride school buses. | left out |
| `--threshold` | Scenario only. Seconds another stop must be better by, beyond the person's margin. | 600 |
| `--give-up` | Scenario only. Seconds later than the BAU run a person accepts arriving, or `none`. | 3600 |
| `--capacity` | A full vehicle leaves people behind, and they plan again from where they stand. | off |
| `--full-at` | The share of its capacity at which a vehicle counts as full. | 1.0 |
| `--left-behind` | A person left behind more often than this is stranded. | 5 |
| `--threads` | Searches at once. | processor threads less 2 |
| `--no-reuse` | Search for every row, even where an earlier search already answers it. Only for measuring. | reuse |
| `--name` | A name for the run. | made from its choices |

A run uses the task's 768 MB heap; `-PsimHeap=1500m` raises it. A run will not write into a folder
that already holds one.

Every run is planned with capacity off. With `--capacity`, where no trip is planned over its
capacity nothing would change, and the run says so and skips the replay.

### What a run writes

| File | Holds |
|---|---|
| `summary.json` | Totals, the settings, the trips planned over capacity, time taken. Printed at the end of the run. |
| `journeys.csv.gz` | One line per journey: status (`ok`, `noJourney`, `gaveUp`, `stranded`), times, rides, walking, waiting, times left behind, the BAU arrival and the difference, the margin, the stop used at each end and whether it is the person's own. A row of several people that a full vehicle split has a line for each `part`. |
| `legs.csv.gz` | One line per walk, change or ride, with the trip and stops. |
| `trip_loads.csv.gz` | Each trip at each stop where anything happened: boardings, alightings, passengers aboard on leaving, passengers left behind, capacity. `position` counts the trip's stops from 0. |
| `stop_activity.csv.gz` | Each stop by quarter hour: boardings, alightings, changes between vehicles, passengers left behind, the most waiting at once. |
| `plans.bin.gz` | The plans, kept for `--from-plans` and as the reference for scenario runs. |
| `demand.csv.gz` | A BAU run only: the journeys it ran, each with its positions. Scenario runs read it from there. |
| `run.properties` | What the run was, for the runs made from it. |

Times in the files are seconds from the start of the service day. Every capacity in the editor's
export is a placeholder for now, so "left behind" and "stranded" figures are illustrative.

### Runs on the service

The service runs the same three kinds of run as jobs. Its 768 MB heap holds a bounded run or a
share of the demand; see `docs/simulator-plan.md` section 5.2 for a whole-network run.

| Method and path | Purpose |
|---|---|
| `POST /v1/simulations` | Queue a run. Answers `202` at once with the run. |
| `GET /v1/simulations` | Every run, with its state. |
| `GET /v1/simulations/{id}` | One run: its state, progress while it runs, and when done its summary and file names. |
| `GET /v1/simulations/{id}/files/{name}` | One result file of a finished run, as it lies on disk. |
| `DELETE /v1/simulations/{id}` | Stop a run that is waiting or running (`202`), or discard one that has ended, files and all (`204`). |

```
curl -X POST localhost:3002/v1/simulations -H "Content-Type: application/json" -d "{\"timetable\":\"b1\",\"id\":\"bau-newcastle\",\"demand\":{\"path\":\"data/sim/demand/made-up.csv.gz\"},\"settings\":{\"area\":\"newcastle\"}}"
curl -X POST localhost:3002/v1/simulations -H "Content-Type: application/json" -d "{\"timetable\":\"b1-s7\",\"bau\":\"bau-newcastle\"}"
curl -X POST localhost:3002/v1/simulations -H "Content-Type: application/json" -d "{\"timetable\":\"b1\",\"fromPlans\":\"bau-newcastle\"}"
curl localhost:3002/v1/simulations/bau-newcastle
curl -o journeys.csv.gz localhost:3002/v1/simulations/bau-newcastle/files/journeys.csv.gz
```

| Field of the request | Meaning | If left out |
|---|---|---|
| `timetable` | The loaded timetable to run on. | The only one loaded. |
| `demand` | `{"path": ..}` or `{"url": ..}`: a BAU run of that demand file. | One of these three is needed. |
| `bau` | A run id: a scenario run against that BAU run, with its journeys and shared settings. | |
| `fromPlans` | A run id: that run's kept plans with capacity on. The timetable must be the one it was planned on. | |
| `id` | The run's id: 1 to 64 letters, digits, dots, dashes or underscores. | `run-<date>-<time>-<n>` |
| `name` | A name for people. | Made from the choices. |
| `settings` | See below. | The defaults. |

| Setting | For | Default |
|---|---|---|
| `area` | BAU. A name (`newcastle`), `"all"`, or `{"south": .., "west": .., "north": .., "east": ..}`. | all |
| `walkMetres`, `changePenaltySecs`, `shareOneIn`, `schoolBuses` | BAU. | 500, 600, 1, false |
| `switchThresholdSecs`, `giveUpSecs` (`null` for no limit) | Scenario. | 600, 3600 |
| `capacity` | BAU and scenario. | false |
| `fullAt`, `maxLeftBehind` | Any run. | 1.0, 5 |

A setting that this kind of run does not choose is refused, with the reason: a scenario run takes
`walkMetres` from its BAU run and cannot be given another.

- `state` is `queued`, `running`, `done`, `failed` (with `error`) or `stopped`. While `running`,
  `progress` has the `stage` (`fetch`, `read`, `plan`, `replay`, `write`) and `done` of `total`. A
  queued run says how many `runsAhead`.
- One run at a time; the others wait their turn in the order they were asked for.
- A run takes hold of its timetable when it is asked for and keeps it to the end. Reloading the
  timetable meanwhile does not change the run; `timetableVersion` says which version it ran on.
- The files are in `<ROUTER_DATA>/sim/<run id>/` and are the ones listed under "What a run writes".
  `files/{name}` serves the result files and a BAU run's `demand.csv.gz`.
- Finished runs are found again when the service starts, including runs made from the command line
  into that folder. A run that failed or was stopped leaves no files and is forgotten at a restart.
- A finished run that others were made from is not discarded unless `?force=true` is added: a
  scenario run reads its BAU run's demand, and capacity is added from kept plans.

From Java:

```java
try (Simulation simulation = new Simulation(new Router(timetable), demand, new SimSettings())) {
    Plans plans = simulation.plan(null, Progress.NONE);            // null: a BAU run
    Simulation.Outcome outcome = simulation.travel(plans, sink, Progress.NONE);
}
SimRun.bau(timetable, demand, report, settings, "BAU", folder, Progress.NONE);  // the same, with files
```

## Settings

| Environment variable | Default | Meaning |
|---|---|---|
| `ROUTER_PORT` | `3002` | Port the service listens on. |
| `ROUTER_THREADS` | processor threads less 2 | Journeys planned at once on each timetable. Each thread keeps about 16 MB of working memory per timetable. |
| `ROUTER_MAX_TIMETABLES` | `2` | Timetables held at once. |
| `ROUTER_DATA` | `data/router` | Folder for snapshots (`snapshots`) and fetched or uploaded zips (`zips`). |
| `ROUTER_LOAD` | none | Timetables to load at start: `id=path`, or several separated by `;`. |
| `ROUTER_BULK_LIMIT` | `200000` | Most queries in one bulk request. |

## Docker

```
docker build -t gtfs-router services/router
docker run --rm -p 3002:3002 -v ./data/router:/data/router gtfs-router
```

Or, from the repository root, `docker compose --profile router up -d router`, which also mounts
`data/exports` read-only at `/data/exports`, so the editor's export can be loaded by the path
`/data/exports/check/export.zip`. The image has not been built or run since the service gained
its endpoints.

The image builds with a Java 25 JDK and runs on a Java 25 runtime. `JAVA_OPTS` sets the Java
options; the default limits the heap to 75% of the container's memory.

## Modules

| Module | Purpose | Depends on |
|---|---|---|
| `router-core` | Timetable, snapshot, search, load states and bulk assignment. | Nothing, and it must stay that way. |
| `router-gtfs` | GTFS zip loader, walking links, snapshot cache, the load and route commands. | `router-core` |
| `router-road` | Road routing. Empty until phase 6. | `router-core` |
| `router-server` | The HTTP service (Javalin). | The three above and `router-sim` |
| `router-sim` | The passenger simulator: demand files, planning, the replay in time order, result files, and its commands. | `router-core`; `router-gtfs` for the commands |
| `router-bench` | Benchmarks (JMH). | `router-core` |

Library versions are in `gradle/libs.versions.toml`. The Gradle version is in
`gradle/wrapper/gradle-wrapper.properties`.
