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
| `npm run test:ui` | Drive the real interface in a headless browser (click, type, drag, shortcuts) against the running app; screenshots go to `data/ui-test/` |
| `npm run test:e2e` | End-to-end test of scenario editing against the running API (creates and deletes its own scenario) |
| `npm run test:sim` | End-to-end test of the simulator through the running API and router (makes and removes its own journeys, runs and scenario) |
| `npm run router:dev` | Start the journey router service, which also runs the simulator |
| `npm run dev` | Start the API and web app |

## The passenger simulator

The simulator sends a file of journeys through a timetable and records where the passengers ended up. It is planned in `docs/simulator-plan.md`. The simulator itself runs in the journey router service (`services/router`); the API keeps the journeys, the runs and their results. There are no panels for it in the web app yet, so for now it is used through the API.

It needs the router running as well as the API: `npm run router:dev` (port 3002, see `services/router/README.md`). The API has the router load whatever timetable a run needs.

| Route | Purpose |
|---|---|
| `GET /api/sim/status` | Whether the router is there |
| `POST /api/demand?name=&madeBy=` | Upload a demand CSV as the body (`text/csv`, or `application/gzip`). Answers the set with the report of its check. The format is in `services/router/README.md` |
| `POST /api/demand/generate` | Make a set up: `{ name, baselineId, journeys, seed, areaId, withinKm, focus, people }` |
| `GET /api/demand`, `GET /api/demand/:id?baseline=`, `DELETE /api/demand/:id` | List; one set, with the stop ids that day does not have; remove |
| `GET`, `POST /api/sim-areas`, `DELETE /api/sim-areas/:id` | Boxes a run can be limited to. Four come with the editor |
| `GET`, `POST /api/sim-folders`, `PATCH`, `DELETE /api/sim-folders/:id` | Folders of the library |
| `POST /api/sim-runs` | Start a run (below). Answers at once with the run |
| `GET /api/sim-runs?baseline=&scenario=&folder=&kind=&q=&madeBy=` | The library |
| `GET /api/sim-runs/:id` | One run: state, progress, and when done its summary |
| `PATCH /api/sim-runs/:id` | Rename, or move to a folder: `{ name, folderId }` |
| `DELETE /api/sim-runs/:id` | Stop a run that is going, or remove one that has ended |
| `POST /api/sim-runs/:id/archive`, `/restore` | Take a run's journeys and legs out of the database, and bring them back |
| `GET /api/sim-runs/:id/journeys?user=` | One person's journeys, with their legs |
| `GET /api/sim-runs/:id/trips/:tripId`, `/stops/:stopId` | Passengers along one trip; one stop or station by quarter hour |
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
