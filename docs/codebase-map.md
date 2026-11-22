# Codebase map

Read this first, then only the files it points to. It was last checked against commit `c33fbef` on 22 Nov 2026. The conventions and the planned layout were added on 23 Nov 2026 (against `58adcf1`).

A GTFS timetable editor and passenger simulator for NSW. It has a React web app, a Fastify API over Postgres and PostGIS, shared TypeScript packages, and a separate Java journey router and simulator.
- How the parts fit together: `docs/architecture/system.md`
- Status and next steps: `PLAN.md`
- The router: `docs/router-plan.md` and `services/router/README.md`
- The simulator: `docs/simulator-plan.md`
- No glossary or BRDs exist yet (`docs/glossary.md` and `docs/brd/` are planned).

## Running, building and testing

The commands and their quirks are in `CLAUDE.md`. In short:
- `npm run db:up`, then `npm run dev` (web on :5173, API on :3001).
- `npm run router:dev` (on :3002).
- Tests: `npm test` (unit), `npm run typecheck` (every workspace), `npm run lint`, `npm run router:test`. `npm run test:e2e:fixture` runs the scenario e2e suite on its own: a small test feed, a throwaway database and its own API on port 3101. `npm run test:e2e`, `npm run test:sim` and `npm run test:ui` need the servers running.

## Parts of the application

Status is **existing** for everything listed unless marked otherwise. Issues found in the code are tracked in `docs/architecture/system.md` §11.

### apps/web: the user interface

| Part | Purpose | Depends on / used by | Start reading | Tests |
|---|---|---|---|---|
| `src/app/App.tsx`, `src/main.tsx` | The composition root. It loads days, modes and packs, keeps the URL hash in step, and handles keyboard shortcuts. No domain logic. | Everything | `App.tsx` | ui-smoke |
| `src/app/store.ts` | The single zustand store: selection history, scenario state, tool state, simulator state, the timeline window. Data that changes many times a second (clock, vehicles, loads) is kept outside it. | Used by everything | `store.ts` | n/a |
| `src/shared/api-client.ts` | Response types, plus `useApi(url)`, which adds `?s=<scenario>` and refetches when `dataVersion` changes | Inspector, timelines | `api-client.ts` | n/a |
| `src/scenarios/scenario-client.ts` | Every change: `applyEdit` (one at a time, with the confirm flow and `idMap`), undo and redo, `refreshScenario`, `fixAll`. | `/api/scenarios/*` | `applyEdit` | ui-smoke, e2e |
| `src/vehicles/vehicles.ts`, `src/shared/clock.ts`, `src/shared/live-stats.ts` | Vehicle animation: decodes packs, computes each frame, terminus waits, hides removed trips. Kept outside React. | `packages/core` pack and waits | `computeFrame` | `core/waits.test.ts` |
| `src/map/MapView.tsx` | The whole map (about 2,000 lines): MapLibre layers, the deck.gl vehicle layer, click and hover logic, scenario and simulator layers, the animation loop. It does not send edits; it calls `builder.ts`. | store, builder, sim | Section comments; layers start around line 518 | ui-smoke |
| `src/editing/builder.ts` | Map-click tools: picking stops for a new or reshaped line, placing a new stop, closure points | MapView, panels | `pickStop`, `placeStop` | ui-smoke |
| `src/app/LeftRail.tsx`, `TopBar.tsx`, `TimeBar.tsx`; `src/map/ModePanel.tsx` | The frame around the map: rail buttons and folding panes, day picker and search, clock and scrubber, mode toggles | store | | ui-smoke |
| `src/scenarios/ScenarioPanel.tsx`, `ScenarioManager.tsx`, `EditConfirm.tsx` | The Timetable pane (stats, impact, clash list with fixes, export link), the scenario manager, the "adds N vehicles" dialog | scenario-client.ts | `ConflictRow` | ui-smoke |
| `src/editing/`: `new-line/NewLinePanel.tsx`, `reshape/ReshapePanel.tsx`, `NewStopTool.tsx`, `closures/ClosurePanel.tsx` | Network-editing tools, each previewing before applying: `createLine`, `reshape`, `addStop`, `close` | `/api/*-preview`, `applyEdit` | | ui-smoke, e2e |
| `src/catalogue/CataloguePanel.tsx` | The vehicle catalogue modal (`CataloguePanel`) and `VehicleTypePicker` (`setVehicleType`). | `/api/vehicle-types` | | e2e |
| `src/inspector/` | The right-hand panel: route, trip (with `TripEditTools`), vehicle day, station, delete stop, frequency editor. Its small shared pieces are in `src/shared/ui/parts.tsx`. | `useApi`, `applyEdit` | `Inspector.tsx` | ui-smoke |
| `src/timeline/` | Canvas charts: trip diagram (`StringlineView`), platforms, vehicles. Dragging is handled in one place, `TimelineCanvas.tsx`. | `/api/patterns/:id/stringline`, `/api/stations/:id/platforms`, `/api/routes/:id/vehicles` | `TimelineCanvas.tsx` | ui-smoke |
| `src/sim/` | The simulator interface: Simulate pane and `sim-api.ts` at the top; `wizard/` (four steps), `library/`, and `results/` (the results window with five tabs, passenger figures, map key, colouring by how full) | `/api/sim-*`, `/api/demand*` | `SimPanel.tsx`, `results/results.ts` | ui-smoke 1b and 18 |
| `src/app/theme.ts`, `src/app/styles.css` | Light and dark theme: CSS variables under `:root[data-theme='light']`, plus colours for the map and timelines | | | ui-smoke 15 |
| `test/ui-smoke.mjs` | Headless Edge or Chrome over CDP, about 20 steps through the whole interface | needs `npm run dev` | | n/a |

### apps/api: HTTP API, edit engine, simulator back end

| Part | Purpose | Depends on / used by | Start reading | Tests |
|---|---|---|---|---|
| `src/server.ts` | Entry point. Connects, migrates, and serves baselines, modes, routes, the inspector and timeline reads, vector tiles, packs and waits. Registers the other route files. | `packages/gtfs` db, packs | `server.ts` | e2e |
| `src/scenarios.ts` | **The scenario edit engine.** `visible()` (the copy-on-write rule), `applyEdit` (transaction, 409, confirm), `assignVehicles`, the stats, impact and fleet figures, the **clash rules** (`conflictsIn`, around lines 1379-1747), and ten edit kinds plus the reshape wrapper. `POST /edits` dispatches all 19 kinds (around lines 1866-1888). | core; the edit modules below | `applyEdit`, `visible` | e2e |
| `src/reshape.ts` | Reshape planning and applying (`planReshape`, `applyReshape`), also used by closures | roads, tracks, timings, core/reshape | `planReshape` | `core/reshape.test.ts`, e2e |
| `src/closures.ts` | `close` edits: whole line, drawn cut, road, part of the day | reshape | `planClosure` | e2e |
| `src/delete-stop.ts` | `deleteStop` edits and the preview | core/delete-stop | `planDeleteStop` | `core/delete-stop.test.ts`, e2e |
| `src/schedule.ts` | `setPlatform`, `replan`, `moveToVehicle`, `addTrip`, `addCall`, and `settlePlatforms` | scenarios | `scheduleEdits` | e2e |
| `src/stops.ts` | `addStop` edits, `stopVisible` (hides deleted stops), new stops as GeoJSON | roads (`nearestRoad`) | `editAddStop` | e2e |
| `src/roads.ts` | Road paths through OSRM (`ROUTER_URL`), including getting round a closure (`routedAround`) | outside OSRM | `roadPath` | e2e |
| `src/tracks.ts` | Train, tram and ferry paths over an in-memory station-link graph built from published patterns | database | `trackPath` | e2e |
| `src/timings.ts` | Run times for new stretches by time of day: published medians, then nearby speeds, then the mode's typical speed | core/time | `sectionTime` | `core/reshape.test.ts` |
| `src/fleet.ts` | Vehicle-type catalogue routes | | | e2e |
| `src/export.ts` | GTFS zip export (optional shapes, bounding box, `editor_*.txt`) | database | | e2e Reality block, `export:check` |
| `src/sim.ts` | Simulator back end: demand sets, areas, folders, runs; drives the Java router (`ensureTimetable`, `drive()`); loads results into partitions | Java router | `drive` | `test/sim.e2e.mjs` |
| `src/sim-results.ts` | Results comparisons for the results window, and `buildLinkLoads`. | `sim_*` tables | | `test/sim.e2e.mjs` |
| `test/scenarios.e2e.mjs`, `test/sim.e2e.mjs` | Scripted HTTP tests of every edit kind, and of the simulator | need the API (and the router) | | n/a |
| `test/run-e2e-fixture.mjs` | `test:e2e:fixture`: imports the test feed into `gtfs_e2e`, starts an API on 3101, checks the packs went to its `PACKS_DIR` and that re-importing a day with a scenario is refused, runs `scenarios.e2e.mjs` (its export check writes under `EXPORTS_DIR`, in the run's temp folder), and always cleans up, also on Ctrl+C | the database container | | n/a |

### packages

| Part | Purpose | Used by | Start reading | Tests |
|---|---|---|---|---|
| `packages/core/src/` | Pure logic with no IO and no dependencies: `vehicle-days`, `pack`, `waits`, `reshape`, `delete-stop`, `limits`, `time`, `simplify`. Exported as raw `.ts` from `index.ts`. | api, gtfs, web (formatting, packs, waits only) | `index.ts` | `*.test.ts` beside each |
| `packages/gtfs/sql/schema.sql` | **The whole database schema.** Idempotent, and run at every API start and every import (`migrate()`). | db.ts | | n/a |
| `packages/gtfs/src/db.ts` | `connect()` (postgres.js, `DATABASE_URL`) and `migrate()` | api, CLIs | | n/a |
| `packages/gtfs/src/feed-cache.ts`, `fetch-cli.ts` | Download the TfNSW feed into `data/feeds/` (`API_KEY`), or use a feed on disk (`FEED_PATH`, `localFeed`) | import | `ensureFeed` | n/a |
| `packages/gtfs/src/import/` | `stage.ts` (COPY into `staging.*`), `baseline.ts` (one service date into the baseline tables), `replace-guard.ts` (refuses a day that has scenarios without `--replace`; date checks), `finish.ts` (counts, marks ready), `vehicle-days.ts`, `packs.ts` (writes under `PACKS_DIR`) | `import-cli.ts`, `packs-cli.ts` | `import-cli.ts` | n/a |
| `packages/gtfs/test/fixtures/` | `mini-feed/`: a small made-up weekday feed in central Sydney (T1 train, buses 333, 373 and 389, F1 ferry), written by `make-mini-feed.mjs` and its modules in `mini-feed-gen/` | `test:e2e:fixture` | `make-mini-feed.mjs` | n/a |
| `packages/gtfs/src/audit*.ts` | The phase 0 data audit (DuckDB) | `feed:audit` | | n/a |
| `packages/gtfs/src/export-check.ts`, `export-references.ts` | Downloads an export from the running API into `data/exports/` (or `EXPORTS_DIR`) and checks it (references, ids, monotonic times; matches the feed for the published day) | `export:check`, e2e | | n/a |

### services/router: the Java journey router and simulator

| Module | Purpose | Start reading | Tests |
|---|---|---|---|
| `router-core` | Timetable (flat arrays), snapshots, RAPTOR search, capacity modes (off, check, assign), load states, walking links over water. No dependencies. | `Timetable.java`, `Router.java` | `BruteForceTest`, `CapacityTest`, … |
| `router-gtfs` | Reads a GTFS zip (with `editor_*.txt`), builds walking links, snapshot cache; the `loadTimetable` and `route` CLIs | `GtfsLoader.java`, `TransferBuilder.java` | `GtfsLoaderTest`, `JourneyScenariosTest`, `RealExportTest` (needs `ROUTER_REAL_ZIP`) |
| `router-sim` | The passenger simulator: plan, then replay with capacity; demand reading, writing and generation; result files | `Simulation.java`, `SimRun.java` | `StopRuleTest`, `HonestyTest`, `SimRunTest`, … |
| `router-server` | Javalin HTTP service: named timetables (`Timetables.java`), journeys, bulk, load states, demand, simulation jobs (`Simulations.java`), settings from env | `RouterServer.java` | `RouterServerTest`, `SimulationsTest` |
| `router-road` | **Planned** (phase 6): road routing. An empty package; `roadImport` throws. | | |
| `router-bench` | **Planned** (phase 5): benchmarks. Only a placeholder JMH benchmark. | | |
| `tools/compare-tfnsw.mjs` | Compares the router's journeys with the TfNSW trip planner | | |

## Data and information

| Entity | Defined in | Stored | Written by |
|---|---|---|---|
| Baseline (one service date) | `schema.sql` `baselines` | Postgres | importer |
| Routes, patterns, trips, stop times, stops, shapes, vehicle days | `schema.sql` | Postgres; scenario rows carry `scenario_id` and `created_edit` | importer; edit engine |
| Scenario, edit | `schema.sql` `scenarios`, `scenario_edits`, `scenario_removed`, `scenario_removed_stops`, `scenario_closures` | Postgres | `apps/api/src/scenarios.ts` and the edit modules |
| Clash | `scenarios.ts` `Conflict`, `conflictsIn` | Not stored (feed clashes: `baseline_conflicts`) | API, on request |
| Vehicle type | `schema.sql` `vehicle_types`, view `trip_vehicle` | Postgres | seed, import, `fleet.ts` |
| Pack | `packages/core/src/pack.ts` | `data/packs/<baseline>/<mode>.bin` | `import/packs.ts` |
| Demand set | `schema.sql` `demand_sets`; format in `services/router/README.md` | `data/sim/demand/` | `sim.ts`; the router generates made-up sets |
| Sim run and results | `schema.sql` `sim_*` | Postgres partitions per run; router files in `data/router/sim/` | `sim.ts`, the router |
| Router timetable and snapshot | `Timetable.java`, `TimetableSnapshot.java` | Memory; `data/router/snapshots/` | router |

## Where do I find…

- **Adding an edit kind:** write the function in `apps/api/src/scenarios.ts`, or in a module wired in from there. Add it to the dispatch in `POST /api/scenarios/:id/edits`, send it from the web with `applyEdit({ kind, … })`, and cover it in `apps/api/test/scenarios.e2e.mjs`. Put any logic that needs no database in `packages/core` with a unit test.
- **Adding an API route:** register it in the relevant `apps/api/src/*.ts` `register*Routes` or `*Routes` function, and take `?s=` through `scenarioOf()` if it reads timetable data.
- **What a scenario can see:** `visible()` in `apps/api/src/scenarios.ts`; for stops, `stopVisible()` in `apps/api/src/stops.ts`.
- **Clash rules:** `conflictsIn` in `apps/api/src/scenarios.ts`. Limits are in `packages/core/src/limits.ts`. The display is in `apps/web/src/scenarios/ScenarioPanel.tsx` (`ConflictRow`) and `timeline/PlatformView.tsx`.
- **Run times for new stretches:** `apps/api/src/timings.ts`, with time-of-day bands in `packages/core/src/time.ts` (`DAY_BANDS`).
- **Road and track paths:** `apps/api/src/roads.ts` (OSRM) and `apps/api/src/tracks.ts`.
- **Database tables:** `packages/gtfs/sql/schema.sql`. Sim partitions are created at runtime in `apps/api/src/sim.ts`.
- **Map layers:** `apps/web/src/map/MapView.tsx`. Tiles come from `server.ts` `/tiles`.
- **Vehicle animation:** `apps/web/src/vehicles/vehicles.ts`, `packages/core/src/pack.ts`, `waits.ts`.
- **Timeline dragging:** `apps/web/src/timeline/TimelineCanvas.tsx`.
- **Theme:** `apps/web/src/app/theme.ts`, and `app/styles.css` line 32.
- **URL deep links and keyboard shortcuts:** `apps/web/src/app/App.tsx`.
- **How the API talks to the router:** `apps/api/src/sim.ts` (`ensureTimetable`, `drive`, `importResults`).
- **Router endpoints:** `services/router/router-server/.../RouterServer.java` (around lines 89-106), and `services/router/README.md`.
- **Environment variables:**
  - API side: `DATABASE_URL` (`db.ts`), `PORT` and `PACKS_DIR` (`server.ts`), `ROUTER_URL` (`roads.ts`), and `ROUTER_SERVICE_URL`, `API_PUBLIC_URL`, `ROUTER_SHARES_FILES`, `SIM_DEMAND_DIR` (`sim.ts`). `API_KEY` is used by the CLIs.
  - Router side: `ROUTER_PORT`, `ROUTER_THREADS`, `ROUTER_MAX_TIMETABLES`, `ROUTER_DATA`, `ROUTER_LOAD`, `ROUTER_BULK_LIMIT` (`Settings.java`).

## Conventions that decide where code goes

- Logic that needs no database or IO goes in `packages/core`, with a `*.test.ts` beside it. Logic that needs the database goes in `apps/api`.
- Every change to a timetable is a scenario edit sent through `POST /api/scenarios/:id/edits`. No other route writes timetable rows.
- The browser never decides validity. Clashes come only from the API.
- Node runs `.ts` directly: use `.ts` import extensions and erasable syntax only.
- The router never reads the database. It gets everything from GTFS exports and demand files.
- Names follow `PLAN.md`'s plain English: line (route), vehicle day, stay-aboard, clash (conflict in code), closure, baseline (one service day).

### Folders, file names and imports

The code is moving to these rules in stages (`docs/refactor-plan.md` stage 2, decision D8 in `docs/architecture/system.md`). Until they move, the files listed above stay where they are and keep their names; new code follows the rules now, and each move PR updates this map.

- **Feature folders.** Code is grouped by the part of the product it belongs to (`scenarios/`, `map/`, `sim/`, `timeline/`…), not by kind (`components/`, `hooks/`, `lib/`, `routes/`). Each feature folder holds its own components, logic, styles and types. `shared/` holds what everything uses and owns nothing. A feature folder that grows past about 10 files gets subfolders by sub-feature (e.g. `sim/results/`), not by kind.
- **File names.** React components are `PascalCase.tsx`. Everything else is `kebab-case.ts` (`live-stats.ts`, `sim-api.ts`), as in the API and packages already. Older camelCase names (`liveStats.ts`, `simApi.ts`) are renamed when their folder moves.
- **Tests.** Unit tests sit beside the file they cover as `name.test.ts`. End-to-end tests and fixtures live in the package's `test/` folder (as `apps/api/test/` and `apps/web/test/` do now).
- **One main thing per file.** A component file exports one component, with small private helpers beside it.
- **Styles beside their component.** `apps/web/src/app/styles.css` is to be split into `app/base.css` (variables, themes, resets) and one CSS file per feature, imported by that feature's top component. `base.css` loads first.
- **What may import what:**
  - `shared/` imports nothing from features. `app/` (the shell) is not a feature, and `shared/` may read the app store (`app/store.ts`) but nothing else in `app/`.
  - A feature may import `shared/` and the app store. It imports another feature only through files at the top of that feature's folder, never from its subfolders.
  - In the API, `scenarios/engine.ts` imports no edit kinds. Edit kinds import the engine; the registry imports the edit kinds.
  - No import circles. oxlint's `import/no-cycle` rule will enforce this once the API circles are broken (stage 3); until then, don't add new ones.
- **No barrel files** (an `index.ts` that only re-exports), except each package's public entry, such as `packages/core/src/index.ts`. Barrels hide circles and slow Vite's reload.
- **Shared web and API types** go in `packages/core/src/api/` and are imported by both sides (decision D9; the folder is created in stage 4). Don't hand-copy a response type into the web app.
- **Folder names use the glossary terms** once `docs/glossary.md` exists.

## Planned layout

**Status: planned, not built.** This is the target from `docs/refactor-plan.md` §2.3–2.5. Files move into it one PR at a time; until a file has moved, the tables above say where it is. `→` means the file is renamed when it moves.

### apps/web/src (moved)

**Status: files moved (T-7).** Every file is in its folder below. Still to come: `styles.css` sits whole in `app/` until T-8 splits it into `app/base.css` and one CSS file per feature; `send()` has not yet moved from `scenario-client.ts` into `api-client.ts`; the response types move in stage 4; `MapView.tsx` is split in stage 5.

```
apps/web/src/
  main.tsx
  app/              the shell: App.tsx, TopBar.tsx, LeftRail.tsx, TimeBar.tsx, store.ts, theme.ts, base.css
  shared/           used everywhere, owns nothing: api-client.ts (the one fetch wrapper: useApi()
                    and getJson() from today's api.ts, and send() from scenario.ts; the response
                    types go to packages/core/src/api/ in stage 4), clock.ts,
                    live-stats.ts, ui/ (today's inspector/parts.tsx and other small pieces)
  map/              MapView.tsx (later split into hooks here, stage 5), ModePanel.tsx (show or hide
                    each mode's lines), map.css
  vehicles/         vehicles.ts (animation packs and vehicle positions)
  scenarios/        scenario.ts → scenario-client.ts, ScenarioPanel.tsx, ScenarioManager.tsx, EditConfirm.tsx
  editing/          the tools that change the network
    builder.ts      picking stops (shared by new-line and reshape)
    NewStopTool.tsx
    new-line/       NewLinePanel.tsx
    reshape/        ReshapePanel.tsx
    closures/       ClosurePanel.tsx
  inspector/        as now: RoutePanel, TripPanel, StationPanel, DeleteStop, TripEditTools…
  catalogue/        FleetPanel.tsx → CataloguePanel.tsx (the vehicle catalogue)
  timeline/         as now
  sim/
    sim-api.ts, SimPanel.tsx
    wizard/         SimWizard.tsx
    library/        SimLibrary.tsx
    results/        SimResults.tsx, SimResultsPeople.tsx, SimFigures.tsx, SimMapKey.tsx, results.ts, loads.ts
```

The web import circles (`store.ts` ↔ `api.ts`, `store.ts` ↔ `scenario.ts`) break here: `store.ts` imports only types, and those move to `packages/core/src/api/` (stage 4) or into the feature folder that owns them.

### apps/api/src (planned)

```
apps/api/src/
  server.ts         start-up and plugin wiring only
  http.ts           fail(), the small number and id parsers (replaces ten copies)
  network/          routes for the baseline: lines, stops, shapes (moved out of server.ts)
  routing/          finding paths and run times: roads.ts, tracks.ts, timings.ts
  scenarios/
    routes.ts       list, create, rename, delete, undo, redo, the edits endpoint, pack
    engine.ts       visible(), scenarioOf(), applyEdit(), cloning and removing trips
    clashes.ts      the clash rules
    vehicles.ts     assigning vehicles to trips, fleet and day figures
    stops-visible.ts  stopVisible(), stopDeleted() (from stops.ts)
    edits/
      registry.ts   edit kind → its function
      create-line.ts, line-frequency.ts, reshape.ts, set-vehicle.ts, set-vehicle-type.ts,
      shift.ts, delete.ts, delete-line.ts, duplicate.ts, skip-stop.ts, headway.ts,
      add-stop.ts (from stops.ts), delete-stop.ts, closure.ts (from closures.ts),
      and one file per kind now in schedule.ts
  catalogue/        the vehicle catalogue routes (today's fleet.ts)
  export/           export.ts
  sim/              routes.ts, timetables.ts, runner.ts, router-client.ts, results-import.ts,
                    results-read.ts (today's sim-results.ts)
```

The API import circles break when `engine.ts` comes out of `scenarios.ts` (stage 3). Stage 2 moves only the files outside the circle, plus `http.ts`, `network/`, `routing/`, `catalogue/` and `export/`.

### packages (planned)

```
packages/core/src/
  index.ts          public entry
  api/              the shared request and response types (stage 4)
  time.ts, limits.ts, simplify.ts, pack.ts, waits.ts, vehicle-days.ts
  edits/            reshape.ts, delete-stop.ts (the pure parts of edit kinds), with tests
  core.test.ts      split into a test beside each file it covers

packages/gtfs/
  sql/              schema.sql (later migrations/, stage 6)
  src/
    db.ts
    feed/           feed-cache.ts, unzip.ts, audit.ts, audit-db.ts
    import/         as now
    cli/            fetch.ts, import.ts, packs.ts, export-check.ts (the npm scripts point here)
  test/fixtures/    the small test feed (stage 1.4)
```
