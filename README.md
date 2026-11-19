# GTFS Editor

A visual editor for NSW public transport timetables. See `PLAN.md` for the roadmap and `docs/phase-0-findings.md` for what the TfNSW feed does and does not contain.

## Running it

Requirements: Node 24 or later, Docker Desktop, and a TfNSW Open Data API key in `.env` (see `.env.example`).

```
npm install
npm run db:up        # PostgreSQL + PostGIS on port 5433
npm run import       # download the feed (once) and import the first Tuesday it covers
npm run dev          # API on :3001, web app on http://localhost:5173
```

`npm run import -- 20261121` imports a specific service day (YYYYMMDD). Each imported day appears in the day picker. A day takes about two minutes.

## Commands

| Command | What it does |
|---|---|
| `npm run feed:fetch` | Download the TfNSW feed, or reuse the saved copy if it has not changed |
| `npm run feed:audit` | Repeat the Phase 0 data audit |
| `npm run import [-- dates]` | Import service days as baselines |
| `npm run packs` | Rebuild the vehicle animation files for existing baselines |
| `npm test` | Unit tests for the core logic |
| `npm run export:check [-- scenarioId]` | Export the first day (or a scenario) as GTFS through the running API and check it; for the published day, compare it with the original feed |
| `npm run test:ui` | Drive the real interface in a headless browser (click, type, drag, shortcuts) against the running app; screenshots go to `data/ui-test/`. With the router running it also sets up and runs simulations |
| `npm run test:e2e` | End-to-end test of scenario editing against the running API (creates and deletes its own scenario) |
| `npm run test:sim` | End-to-end test of the simulator through the running API and router (makes and removes its own journeys, runs and scenario) |
| `npm run router:dev` | Start the journey router service, which also runs the simulator |
| `npm run dev` | Start the API and web app |

## The passenger simulator

The simulator sends a file of journeys through a timetable and records where the passengers ended up. It is planned in `docs/simulator-plan.md`. The simulator itself runs in the journey router service (`services/router`); the API keeps the journeys, the runs and their results.

In the web app it is the **Simulation** panel, which folds out from the **Simulate** button on the rail down the left edge:

- **New simulation** opens a four-step wizard. With no scenario open it sets up a BAU run on the published timetable: pick, upload or make up the journeys, choose an area (the whole network, a saved area, what is on screen, or a box dragged on the map), and how people travel. With a scenario open it sets up a run of that scenario against a BAU run you pick.
- The panel follows the run in progress, then shows the chosen run's summary, offers "Run again with capacity", and looks one person up by `user_id`, drawing their journeys on the map.
- **Results** opens a window beside the map that sets the run against another: Overview, Travel time, Lines, Travel patterns and People. A key beside the left column chooses what the map draws: passenger flow, who is affected, "through here" (click a stretch or a stop to follow its passengers), or vehicles coloured by how full. "How full" in the timeline's header colours trips the same way.
- While a run is chosen, the line, trip and station panels gain a "Passengers" section. The figures show when the timetable the run was made on is the one open.
- **Library** lists every run, by folder or by date, with scenario runs under their BAU run: open, rename, move, archive, remove.
- A link can name the run to show: `#route=<id>&sim=<run id>`.

The same things are available through the API:

It needs the router running as well as the API: `npm run router:dev` (port 3002, see `services/router/README.md`). The API has the router load whatever timetable a run needs.

| Route | Purpose |
|---|---|
| `GET /api/sim/status` | Whether the router is there |
| `POST /api/demand?name=&madeBy=` | Upload a demand CSV as the body (`text/csv`, or `application/gzip`). Answers the set with the report of its check. The format is in `services/router/README.md` |
| `POST /api/demand/generate` | Make a set up: `{ name, baselineId, journeys, seed, areaId, withinKm, focus, people }` |
| `GET /api/demand`, `GET /api/demand/:id?baseline=`, `DELETE /api/demand/:id` | List; one set, with the stop ids that day does not have; remove |
| `GET /api/demand/:id/coverage?baseline=&s=&south=&west=&north=&east=&walk=` | How many journey ends lie inside a box (by the end's own position where the file gives one, as made-up journeys do, otherwise by its stop), and how many name a stop nothing calls at |
| `GET`, `POST /api/sim-areas`, `DELETE /api/sim-areas/:id` | Boxes a run can be limited to. Four come with the editor |
| `GET`, `POST /api/sim-folders`, `PATCH`, `DELETE /api/sim-folders/:id` | Folders of the library |
| `POST /api/sim-runs` | Start a run (below). Answers at once with the run |
| `GET /api/sim-runs?baseline=&scenario=&folder=&kind=&q=&madeBy=` | The library |
| `GET /api/sim-runs/:id` | One run: state, progress, and when done its summary |
| `PATCH /api/sim-runs/:id` | Rename, or move to a folder: `{ name, folderId }` |
| `DELETE /api/sim-runs/:id` | Stop a run that is going, or remove one that has ended |
| `POST /api/sim-runs/:id/archive`, `/restore` | Take a run's journeys and legs out of the database, and bring them back |
| `GET /api/sim-runs/:id/journeys?user=` | One person's journeys, with their legs |
| `GET /api/sim-runs/:id/routes/:routeId`, `/trips/:tripId`, `/stops/:stopId` | A line's passengers and how full it gets; passengers along one trip; one stop or station by quarter hour |
| `GET /api/sim-runs/:id/results/overview`, `/lines`, `/lines/:lineId`, `/flows`, `/places?by=&end=` | The results view: one run against another made on the same people. Who arrives sooner and later; each line before and now; one line by hour, its stations, and where its passengers went; passengers on each stretch between stops, for the map; and where the people affected start from or are going, by stop or in squares (`by=stop`, or a side in metres). Each takes `vs=` (the run compared with; left out, a scenario run's BAU run) and `from=`, `to=` (seconds, for a part of the day) |
| `GET /api/sim-runs/:id/results/patterns`, `/people?who=&limit=&offset=&order=`, `/people/:journeyId`, `/trace?who=`, `/vehicle-loads` | More of the results view: how people travel (boardings by mode, vehicles a journey, who uses another stop, the stations that changed most); a set of people listed, worst affected first; one journey in both runs, leg by leg; a set of people followed on the map (the stretches they ride in each run, where they start and end); and how full each vehicle is through the day. `who` is `all`, `changed`, `later`, `sooner`, `lost`, `gained`, `group:<0 to 8>`, `user:<user_id>`, `line:<id>:<a or b>`, `stop:<id>:<a or b>` or `link:<from>-<to>:<a or b>` |
| `GET /api/sim-runs/:id/files/:name` | A result file as the simulator wrote it |

A run is one of three kinds, told apart by what the request names:

- `{ "baselineId": 1, "demandSetId": 3, "areaId": 2 }`: a **BAU run**, on the published timetable. Leave out the area for the whole network.
- `{ "bauRunId": 7 }` with `?s=<scenario>`: a **scenario run**, measured against that BAU run. It uses the BAU run's journeys and area; they are not asked for again.
- `{ "fromRunId": 7 }`: that run's plans again with **capacity** on, without planning again.

Any of them may add `name`, `folderId`, `madeBy` and `settings`. A run is `queued`, `preparing` (its timetable), `running`, `importing` (its results), then `done`, `failed` or `stopped`. A run made on a scenario that has been edited since shows `outOfDate`.

`npm run test:sim` runs the whole of this against the running API and router.

| Setting | Default | Meaning |
|---|---|---|
| `ROUTER_SERVICE_URL` | `http://localhost:3002` | The journey router. (`ROUTER_URL` is the road-routing server.) |
| `API_PUBLIC_URL` | `http://localhost:3001` | Where the router can reach this API, to fetch an export |
| `ROUTER_SHARES_FILES` | yes | Set to `0` if the router runs on another machine and cannot read demand files from this one's disk |

## Layout

- `apps/web`: React app (MapLibre map, deck.gl vehicles, inspector).
- `apps/api`: Fastify server (map tiles, vehicle data, inspector queries).
- `packages/core`: shared logic (vehicle-day chaining, animation file format, time formatting).
- `packages/gtfs`: feed download, database schema and import.
- `services/router`: the journey router and passenger simulator (Java).
- `docs/`: the plans for the router and the simulator, with what was found building them.
- `data/`: downloaded feeds and generated files. Not in git.

## Links

The address bar tracks what is open, so links can be shared: `#route=<id>`, `#trip=<id>`, `#vehicleDay=<id>`, optionally with `&t=<seconds since midnight>`. Timeline extras: `&tl=stringline|platforms|vehicles`, `&station=<id>`, `&view=<start>-<end>` in seconds.
