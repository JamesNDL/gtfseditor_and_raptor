# Journey router

A standalone Java service that will answer journey queries on a GTFS timetable. The design is in
[`docs/router-plan.md`](../../docs/router-plan.md).

**Status: phases 0 to 4 and phase 6 (road routing, for cars) are built.** The library loads a GTFS
zip into memory and plans journeys on it (plain RAPTOR). It can respect how full the vehicles are,
and add the passengers it routes to them. Journeys can be planned from the command line or over
HTTP: the service loads, reloads and unloads timetables, keeps named load states, and answers one
journey per request or many. It also plans drives on OpenStreetMap roads (`router-road`, with
GraphHopper), and answers the editor's three road requests in OSRM's own shape: see "Roads" below.
The passenger simulator (`router-sim`) runs from the command line and as jobs on the service: see
"The passenger simulator" below. The editor's API calls the service for simulations and access
analyses (`ROUTER_SERVICE_URL`) and for road paths (`ROUTER_URL`).

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
| Start the road-only service (see "Roads" below) | `.\gradlew :router-server:runRoad` |
| Build a road graph from an OpenStreetMap file | `.\gradlew :router-road:roadImport -ProadArgs="<osm file> <graph folder>"` |
| Make up or check a demand file (see "The passenger simulator") | `.\gradlew -q :router-sim:demand` |
| Run a simulation | `.\gradlew -q :router-sim:simulate` |
| Run the benchmarks (a placeholder for now) | `.\gradlew :router-bench:jmh` |
| Stop the background build process | `.\gradlew --stop` |

## The service

`.\gradlew :router-server:run` (or `npm run router:dev` from the repository root) starts it on port
3002 with no timetable loaded. It runs from the repository root with a 1 GB heap (768 MB before road
routing was added). Road routing is on if the road graph has been built (see "Roads"). To have a
timetable loaded at start, set `ROUTER_LOAD` first (PowerShell):

```
$env:ROUTER_LOAD = "b1=data/exports/check/export.zip"; npm run router:dev
```

| Method and path | Purpose |
|---|---|
| `GET /v1/health` | Up or not, the ids of the timetables that are ready, and `road`: whether road routing is available (see "Roads"). |
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
| `POST /v1/demand/check` | A demand CSV as the body (gzipped with `Content-Type: application/gzip`): the reader's report, and how many journey ends name each stop id. Needs no timetable. |
| `POST /v1/demand/generate` | Makes a demand set up on a loaded timetable and answers it as a gzipped CSV: `timetable`, `journeys`, `seed`, `area`, `withinKm`, `focus`, `people`. |
| `POST /v1/road/route`, `POST /v1/road/table` | One drive, or drives from many starting points to many ends; see "Roads". |
| `GET /route/v1/driving/…`, `/table/v1/driving/…`, `/nearest/v1/driving/…` | The editor's road requests, in OSRM's shape, at the root rather than under `/v1`; see "Roads". |

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
- `"water": {"path": ..}` or `{"url": ..}` in the JSON names a water file, so that no walk is
  offered across water: see "Walks" below. Left out, every straight walk is offered. The editor's
  API sends it with every timetable it loads (`GET /api/sim/water?baseline=1`). A zip sent as the
  body cannot have one.
- A path is read where it lies, relative to the folder the service runs in. A fetched or uploaded
  zip is kept as `<ROUTER_DATA>/zips/<id>.zip`.
- A reload builds the new timetable beside the old one and swaps it in when ready. Journeys are
  answered on the old one until then. If the build fails the old one stays, and the metadata shows
  the reason under `lastFailure`.
- One build runs at a time; a second request for an id that is still building is refused with `409`.
- At most `ROUTER_MAX_TIMETABLES` are held. Loading one more drops the one used longest ago. An
  access analysis loads a timetable of its own (the day cut to a box round its zone), so it can
  push out a timetable a simulation was using; that one is loaded again when it is next needed.
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
| `depart` | `"HH:MM"`, `"HH:MM:SS"` or seconds from the start of the service day, up to `36:00:00`. After midnight keep counting: `"24:30"`. | Required, unless `arriveBy` is given. |
| `arriveBy` | In place of `depart`: the time to arrive by, written the same way. Plans the journey that leaves latest and still arrives by then; see "Arriving by a time" below. Giving both is a `400`. | |
| `maxRides` | Most vehicles to board. | 8 |
| `maxWalkMetres` | Furthest to walk to the first stop or from the last, as straight lines (one, or two by way of a bridge); up to 5000. | 1200 |
| `avoid` | Kinds of vehicle to leave out: `train`, `metro`, `light_rail`, `ferry`, `bus`, `coach`, `school_bus`, `other`. `[]` leaves out nothing. | `["school_bus"]` |
| `changeSecs` | Least time to change vehicles, at one stop or by a walk to another: see "Walks" below. | 120 |
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
  `depart`, `arrive`, `metres`. `metres` is the straight line (or two, by way of a bridge); the
  time is for 1.3 times that, so show it as "about" 1.3 times the figure, or as a straight line.
- `warning`, when `depart` is before 04:00: the time is the small hours at the start of the
  service day, and a journey after midnight at the end of it is asked for as `"24:20"`.
- `ride`: `trip`, `route`, `routeId`, `mode`, `headsign`, `board` and `alight` (stop id, name,
  latitude and longitude, time, and `position`: the stop's place in the trip, counting from 0),
  `stops` (every stop from boarding to alighting, with latitude, longitude and times), and
  `stayAboard`.

### Arriving by a time

```
curl -X POST localhost:3002/v1/journeys -H "Content-Type: application/json" -d "{\"from\":{\"lat\":-32.897,\"lon\":151.736},\"to\":{\"lat\":-32.940,\"lon\":151.698},\"arriveBy\":\"08:00\"}"
```

With `arriveBy` in place of `depart`, the router finds the latest departure that still arrives by
then, within the request's limits, and plans the journey forwards from it. The answer has the same
shape as for `depart`, and also:

- `arriveBy` at the top, echoed;
- on each journey, `arriveBy` and `earlyWait`: the seconds between arriving and `arriveBy`.
  `depart` and `arrive` are the journey's real times.

Only journeys that arrive in time are listed. None in time is `noJourney`, with the reason
"Nothing gets there by that time on this service day." There is no limit on how long before
`arriveBy` the journey may leave, as there is none on how long a journey may take.

Arrive-by takes no account of how full vehicles are: it needs `capacity` `off` (the default) and
no `blocked`, or the request is refused with `400`. How it works: section 22 of
`docs/router-plan.md`.

### Walks

The router has no map of streets. A walk is a straight line between two points, taken to be 1.3
times as long on the ground and walked at 1.03 m/s. Three rules keep that honest.

**A change of vehicle takes at least `changeSecs`, on foot as well.** After getting off, the
passenger may board again no sooner than `changeSecs` later (2 minutes unless said), whether the
next vehicle leaves from the same stop or from one a walk away; a walk that takes longer takes its
own time. The walk leg shows the walking time, and the rest is waiting. Staying aboard a vehicle
that runs on as another trip takes no time. TfNSW's planner never offered less than 2 minutes
between two platforms in 1,045 such changes. What this does not give: after a walk longer than
`changeSecs` the next vehicle may leave the second the walk ends. The walk's time has 30 s in it
that is not walking, and the pace is a slow one, but there is no margin beyond that.

**A platform takes time to reach.** A generated walk to or from a platform adds the feed's
pathway time between that platform and the nearest entrance of its station (`stopExitSecs` and
`stopEntrySecs` in the timetable), or 60 s for a railway platform the feed gives no pathways for
(`platformSecs`, a setting, not a sourced figure). It applies to walking links between a platform
and a stop outside its station, and to walks between a point on the map and a platform. Two stops
of one station keep the pathway's own time, or the 60 s station minimum. A journey asked for from
a stop starts on the platform, at no walk.

**No walk across water, as far as the water file says.** The router is given a water file when
the timetable is loaded: straight pieces of the paths ferries sail, and the places where a bridge
crosses one. A walk whose straight line comes within 20 m of a piece is over water. It may go by
a bridge instead (to the bridge in a straight line, and on from it in another) if that keeps it
within the limit for the walk; otherwise it is not offered. This applies to the walking links
between stops within the radius, to walks between a point and a stop, to walking the whole way,
and so to the simulator's stops near a place.

The file is a CSV, `kind,lat1,lon1,lat2,lon2`, with rows `water,<one end>,<other end>` and
`bridge,<position>,,`. The editor's API writes it from the day's own paths:

- **water**: the path of every ferry pattern, less 100 m round every wharf and 150 m round every
  bridge, so that walking up to a wharf or onto a bridge is not refused;
- **bridge**: each place where a bus or light rail path crosses a ferry path, taken to be a
  bridge that can be walked, and a short list of foot bridges that no bus crosses (one so far:
  John Whitton Bridge at Meadowbank). Coaches are left out because they use the harbour tunnel,
  trains because a railway bridge or tunnel cannot be walked.

On the published weekday that is 1,749 pieces and 10 bridges; 20 pairs of stops within 500 m lose
their link and none gains one by a bridge. What it cannot do:

- **Water no ferry sails is not known.** Rivers, bays and lakes without a ferry, the coast,
  motorways, railway lines and fences are all walked across as before.
- **A foot bridge that a ferry sails under and no bus crosses is not known** unless it is on the
  list. The foot bridges over the Parramatta River between Parramatta wharf and Rydalmere are not
  on it, so stops either side of them are not linked.
- **A bus in a road tunnel under a ferry path would look like a bridge.** None does on the
  published weekday.
- **A walk is refused if its straight line clips a ferry path** even where the real walk goes
  round on land, as at the head of a small bay. The stop is then not offered from there.
- **A bridge is one point.** A walk by a bridge is two straight lines through it, and is not
  checked for anything else.
- A feed loaded with no water file has none of this. `--water <file>` gives one to the commands.

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
`depart` (or `arriveBy`), and optionally `id` and `group`. At most `ROUTER_BULK_LIMIT` queries per
request.

A query may give `arriveBy` in place of `depart` (see "Arriving by a time"); its line then has
`arriveBy`, and its journey `arriveBy` and `earlyWait`. Arrive-by and depart-at queries may be
mixed in one request, which then needs `capacity` `off`. Arrive-by queries with the same `to`,
time and settings share one backward search, so many starting points to one end cost little more
than the same number of depart-at queries. The lines are in the order asked.

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

## Roads

The service plans drives for cars on OpenStreetMap roads, with GraphHopper 11.1 embedded in
`router-road` behind a small interface (`RoadRouter`). Times are free-flow (no traffic) and
distances are metres. There is no turn cost and no walking or cycling profile. Designed in
`docs/architecture/access-analysis.md` §3; what was measured is section 21 of the plan.

### Road data

From the repository root, `npm run road:data` does it all (about 3 minutes, 2 GB of memory at
its peak; stop the dev servers first on a small machine):

1. takes `data/osm/australia-latest.osm.pbf`, downloading it from Geofabrik if it is missing
   (about 1 GB);
2. cuts it to the Opal area (150.10, -34.75 to 151.85, -32.70) with osmium, in a small Docker
   image built from Debian's own package (`tools/osmium/Dockerfile`), into `data/osm/opal.osm.pbf`;
3. builds the road graph with `:router-road:roadImport` into a new folder and swaps it in for
   `data/router/road/opal` only when the build succeeds, so a failed build keeps the old graph.

Options: `--data <folder>` (a worktree names the main checkout's `data`), `--pbf <file>`,
`--no-cut` (the file is already cut) and `--dry-run` (prints the steps and runs none). The graph
folder holds `road-graph.json`: the file it was built from, its size and date, the box, the
GraphHopper version and when it was built. On 25 Nov 2026 the Opal-area graph was 56 MB and took
31 s to build.

`roadImport` can also be run by hand on any `.osm` or `.osm.pbf` file; it rebuilds a folder that
already holds a road graph and refuses any other folder with files in it. Footways, cycleways,
paths, steps and the like are left out of the graph, and a point is never placed on an island of
road with fewer than 200 links (the real data only; the tests keep every one). The tests build `router-road/src/test/resources/
mini-roads.osm`, a few hand-made streets in Mayfield, Newcastle, and need no `data/`.

### Turning road routing on

| `ROUTER_ROAD` | What the service does |
|---|---|
| `auto` (the default) | Road routing is on if `ROUTER_ROAD_GRAPH` holds a road graph; otherwise off, with one line saying so. |
| `on` | Road routing is on; the service will not start without a graph. |
| `off` | No road routing. The road endpoints answer `503`. |
| `only` | Roads and health only: every other `/v1/` endpoint (timetables, journeys, loads, demand, simulations) answers `503` `{"error": "this router runs roads only"}`. The OSRM-shaped endpoints answer as normal. |

The graph is memory-mapped, so it sits in the operating system's file cache rather than the heap.
**The road-only process** is the same jar started a second time with `ROUTER_ROAD=only`, for when
memory is too short to plan journeys and drives in one process: `npm run router:road` (or
`.\gradlew :router-server:runRoad`) starts it on port 3003 (or `ROUTER_PORT` if set) with a 512 MB
heap. On the development machine it has not been needed: the main router with roads on stayed under
800 MB.

`GET /v1/health` gains:

```json
"road": {"available": true, "graph": "data/router/road/opal", "builtFrom": "opal.osm.pbf", "builtAt": "…", "mode": "on"}
```

`available` is false when road routing is off; `builtFrom` and `builtAt` are there only when it is on.

### Our own road endpoints

Places are `{"lat": .., "lon": ..}`; `profile` may be left out or be `"car"`, and anything else is a
`400`.

```
curl -X POST localhost:3002/v1/road/route -H "Content-Type: application/json" -d "{\"from\":{\"lat\":-32.897,\"lon\":151.736},\"to\":{\"lat\":-32.927,\"lon\":151.772}}"
```

`POST /v1/road/route` plans one drive from `from` to `to`, through any `via` points in order. The
answer has `status` (`ok`, `noRoute` when no road joins them, or `noRoad` when a point is more than
`ROUTER_ROAD_SNAP_METRES` from a road a car may use, with a `reason` naming it), `profile`,
`freeFlow: true`, `metres`, `durationSecs`, `geometry` (`[lon, lat]` pairs), `snapMetres` (how far
each end was from the road) and `computeMicros`.

`POST /v1/road/table` takes `sources` and `destinations` (lists of places) and answers
`durationsSecs` and `metres` as rows of sources by columns of destinations, `null` where there is
no way or no road, with `sourceSnapMetres` and `destinationSnapMetres` (`null` for a place with no
road). The drives are planned at once on `ROUTER_THREADS` threads, about 2 ms each per thread: 5,000
starting points to one end took about a second. More pairs than `ROUTER_ROAD_TABLE_LIMIT` is a
`400`; the access analysis sends 1,000 at a time.

### The editor's road requests (OSRM's shape)

The editor's API sends three requests to `ROUTER_URL` in the form of the OSRM routing server
(`apps/api/src/routing/roads.ts`). The service answers them at its root, not under `/v1`, so
`ROUTER_URL=http://localhost:3002` (or `:3003` for the road-only process) needs no other change.
`npm run test:roads` sends them as the editor does and checks the answers.

| Request | Answer |
|---|---|
| `GET /route/v1/driving/{lon,lat;lon,lat;…}?overview=full&geometries=geojson&steps=false` | `routes` (distance, duration, weight, geometry as GeoJSON, a leg between each pair of points) and `waypoints`. Up to 500 points. `alternatives=true` or a number, for two points only, adds up to 2 other routes (3 in all) where GraphHopper finds ones different enough. `overview=false` leaves out the geometry. |
| `GET /table/v1/driving/{lon,lat;…}?annotations=distance` | `distances` and/or `durations` (`annotations` is `duration`, the default, `distance` or `duration,distance`), `sources` and `destinations`; optional `sources=` and `destinations=` indexes separated by `;`. `null` where there is no way. Up to 100 points. |
| `GET /nearest/v1/driving/{lon,lat}` | One `waypoint`: the nearest point on a road, and how far it is. A `number` above 1 still gives one. |

An answer is `200` with `"code": "Ok"`. A refusal is `400` with `code` and `message`, as OSRM
does: `NoRoute` (no way by road), `NoSegment` (a point with no road within the snap limit),
`InvalidQuery` (bad coordinates), `InvalidOptions` (`geometries` other than `geojson`,
`steps=true`, or a bad option) or `TooBig`. `geometries` left out is taken as `geojson`. The
request line may be up to 32 KB, room for a route through 500 points. With road routing off they
answer `503` `{"error": ...}`.

### Credit

The road data is © OpenStreetMap contributors, under the Open Database Licence (ODbL). Anything
that shows drive times or road paths from it must say so; the web app's access analysis legend and
map do.

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
| `--water <file>` | A water file, so that no walk crosses water (see "Walks"). Left out, every straight walk is offered. `route` and the simulator's commands take it too. |
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

`--change 120` sets the least time, in seconds, to change vehicles (2 minutes unless said), at one
stop or by a walk to another. Staying aboard a vehicle that runs on as another trip takes no time.

`--arrive-by` takes the time as the time to arrive by, and plans the journey that leaves latest
and still arrives then:

```
.\gradlew -q :router-gtfs:route -ProuteArgs="-32.897,151.736 -32.940,151.698 08:00 --arrive-by --walk 800 --rides 4"
```

To compare with the TfNSW trip planner, write test journeys to a file and hand it to the comparer.
It needs `API_KEY` in `.env`, sends only stop positions, a date and a time, and keeps TfNSW's
answers so that a second run asks nothing again; with `--offline` it asks nothing at all:

```
curl -o data/router/water-b1.csv "http://localhost:3001/api/sim/water?baseline=1"
npm run router:route -- "-ProuteArgs=--random 200 --within 25 --seed 7 --water data/router/water-b1.csv --dump data/router/compare/within25.r2.jsonl"
npm run router:compare -- data/router/compare/within25.r2.jsonl --water data/router/water-b1.csv
```

The two planners start from different places (ours on the platform, TfNSW at a street address),
so the comparer's headline is from the first boarding to the last alighting: when each gets off
its last vehicle. For every journey of ours it prints the least time to change and the least
spare once the walk is done, and with `--water` it marks a walk over water. Where ours gets off
sooner it counts every reason that fits (ours boards a vehicle TfNSW's walk from the street could
not reach, a tight change, more changes, a walk over water), and what is left is listed as "none
of these": a different journey that nothing has checked beyond the timetable. See section 18 of
the plan.

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
The design is in [`docs/simulator-plan.md`](../../docs/simulator-plan.md); phases S0 (demand files),
S1 (the simulator, from the command line), S2 (runs as jobs on the HTTP service) and S3 (the editor's
API starts runs and keeps their results) are built, and S4 put it in the web app: see the root
`README.md`.

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
`--zip` it also looks the stop ids up. It warns when rows start before 04:00 (times count from the
start of the service day, so `00:20` is the small hours of the morning and a journey after
midnight at the end of the day is `24:20`), and says when every user id has the generator's form
(`u0000001`), which marks a made-up set whoever uploaded it. `POST /v1/demand/check` answers the
same as `rowsBefore4am`, `warnings` and `madeUpIds`.

`generate` makes a set up, for use until real journey data exists. A made-up set says nothing about
real travel. Each person is drawn at a stop and then moved to the stops the router recommends for
their journey, as a default BAU run would judge it, up to four times over: otherwise most people
would start at a stop that one nearby already beats, and a scenario run that lets them change stop
would report that as a gain. On the published weekday, 20,000 journeys for Newcastle left 1% of
travellers with a better stop nearby (72% before this was done).

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
| `--longest-wait` | BAU only. Seconds a person will wait in all, before setting off and between vehicles, or `none`. A journey that needs more is no journey: without this, someone who turns up after the morning's last service "travels" by waiting for the evening's. | 14400 |
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
| `journeys.csv.gz` | One line per journey: status (`ok`, `noJourney`, `gaveUp`, `stranded`), times, rides, walking, waiting, times left behind, the BAU arrival and the difference, the margin, the stop used at each end and whether it is the person's own. For someone who gave up, `later_secs` is how much later the journey they turned down would have arrived. Someone whose own stop the scenario removed counts as having changed stop. A row of several people that a full vehicle split has a line for each `part`. |
| `legs.csv.gz` | One line per walk, change or ride, with the trip and stops. |
| `trip_loads.csv.gz` | Each trip at each stop where anything happened: boardings, alightings, passengers aboard on leaving, passengers left behind, capacity. `position` counts the trip's stops from 0. |
| `stop_activity.csv.gz` | Each stop by quarter hour: boardings, alightings, changes between vehicles, passengers left behind, the most waiting at once. |
| `plans.bin.gz` | The plans, kept for `--from-plans` and as the reference for scenario runs. |
| `demand.csv.gz` | A BAU run only: the journeys it ran, each with its positions. Scenario runs read it from there. |
| `run.properties` | What the run was, for the runs made from it. |

Times in the files are seconds from the start of the service day. Every capacity in the editor's
export is a placeholder for now, so "left behind" and "stranded" figures are illustrative.

### Runs on the service

The service runs the same three kinds of run as jobs. Its 1 GB heap holds a bounded run or a
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
| `maxWaitSecs` (`null` for no limit) | BAU. The longest wait in all. A run made from a BAU run that had no limit has none. | 14400 |
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
| `ROUTER_ROAD` | `auto` | Road routing: `auto`, `on`, `off` or `only` (see "Roads"). |
| `ROUTER_ROAD_GRAPH` | `data/router/road/opal` | The road graph folder, relative to where the service runs. |
| `ROUTER_ROAD_SNAP_METRES` | `500` | How far a point may be from a road a car may use; further than that it has no road (10 to 5000). |
| `ROUTER_ROAD_TABLE_LIMIT` | `100000` | Most pairs of sources and destinations in one `/v1/road/table` request. |

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
| `router-road` | Road routing for cars: the `RoadRouter` interface, GraphHopper behind it (`GraphHopperRoads`, with `GraphHopperTable` and `GraphHopperAlternatives`), and the graph build (`RoadGraphBuilder`, `RoadImport`). Only this module depends on GraphHopper. | `router-core`, GraphHopper |
| `router-server` | The HTTP service (Javalin). | The three above and `router-sim` |
| `router-sim` | The passenger simulator: demand files, planning, the replay in time order, result files, and its commands. | `router-core`; `router-gtfs` for the commands |
| `router-bench` | Benchmarks (JMH). | `router-core` |

Library versions are in `gradle/libs.versions.toml`. The Gradle version is in
`gradle/wrapper/gradle-wrapper.properties`.
