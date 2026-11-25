# Codebase map

Read this first, then only the files it points to. It was last checked against commit `c33fbef` on 22 Nov 2026. The conventions and the planned layout were added on 23 Nov 2026 (against `58adcf1`). The road router and access analysis parts were checked against `504fc45` (branch `feature/access-analysis`) on 26 Nov 2026.

A GTFS timetable editor and passenger simulator for NSW. It has a React web app, a Fastify API over Postgres and PostGIS, shared TypeScript packages, and a separate Java journey router and simulator.
- How the parts fit together: `docs/architecture/system.md`
- Status and next steps: `PLAN.md`
- The router: `docs/router-plan.md` and `services/router/README.md`
- The simulator: `docs/simulator-plan.md`
- What the words mean: `docs/glossary.md`
- Requirements: `docs/brd/` (one per feature), each with its design in `docs/architecture/<same name>.md`. The first is `trustworthy-edits` (BRD 1.1 and its design approved 23 Nov 2026). Its planned files are listed under "Planned for trustworthy-edits" below. The second is `access-analysis` (BRD 1.0 and its design, 25 Nov 2026), built on `feature/access-analysis` (26 Nov 2026): its parts are in the tables below and summed up under "Access analysis (built)".

## Running, building and testing

The commands and their quirks are in `CLAUDE.md`. In short:
- `npm run db:up`, then `npm run dev` (web on :5173, API on :3001).
- `npm run router:dev` (on :3002; plans drives too once `npm run road:data` has built the road graph). `npm run router:road` is a roads-only copy on :3003.
- Tests: `npm test` (unit), `npm run typecheck` (every workspace), `npm run lint`, `npm run router:test`. `npm run test:e2e:fixture` runs the scenario and access analysis e2e suites on their own: a small test feed, a throwaway database, a fake router and its own API on port 3101. `npm run test:access -- --fixture` drives the Access pane in a headless browser on a throwaway stack. `npm run test:e2e`, `npm run test:sim`, `npm run test:ui` and `npm run test:roads` need the servers running.

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
| `src/map/MapView.tsx` | The whole map (about 2,000 lines; the access analysis layers are in their own hooks, below): MapLibre layers, the deck.gl vehicle layer, click and hover logic, scenario and simulator layers, the animation loop. It does not send edits; it calls `builder.ts`. | store, builder, sim | Section comments; layers start around line 518 | ui-smoke |
| `src/editing/builder.ts` | Map-click tools: picking stops for a new or reshaped line, placing a new stop, closure points | MapView, panels | `pickStop`, `placeStop` | ui-smoke |
| `src/app/LeftRail.tsx`, `TopBar.tsx`, `TimeBar.tsx`; `src/map/ModePanel.tsx` | The frame around the map: rail buttons and folding panes, day picker and search, clock and scrubber, mode toggles | store | | ui-smoke |
| `src/scenarios/ScenarioPanel.tsx`, `ScenarioManager.tsx`, `EditConfirm.tsx` | The Timetable pane (stats, impact, clash list with fixes, export link), the scenario manager, the "adds N vehicles" dialog | scenario-client.ts | `ConflictRow` | ui-smoke |
| `src/editing/`: `new-line/NewLinePanel.tsx`, `reshape/ReshapePanel.tsx`, `NewStopTool.tsx`, `closures/ClosurePanel.tsx` | Network-editing tools, each previewing before applying: `createLine`, `reshape`, `addStop`, `close` | `/api/*-preview`, `applyEdit` | | ui-smoke, e2e |
| `src/catalogue/CataloguePanel.tsx` | The vehicle catalogue modal (`CataloguePanel`) and `VehicleTypePicker` (`setVehicleType`). | `/api/vehicle-types` | | e2e |
| `src/inspector/` | The right-hand panel: route, trip (with `TripEditTools`), vehicle day, station, delete stop, frequency editor. Its small shared pieces are in `src/shared/ui/parts.tsx`. | `useApi`, `applyEdit` | `Inspector.tsx` | ui-smoke |
| `src/timeline/` | Canvas charts: trip diagram (`StringlineView`), platforms, vehicles. Dragging is handled in one place, `TimelineCanvas.tsx`. | `/api/patterns/:id/stringline`, `/api/stations/:id/platforms`, `/api/routes/:id/vehicles` | `TimelineCanvas.tsx` | ui-smoke |
| `src/sim/` | The simulator interface: Simulate pane, `sim-api.ts`, and the results parts other features use (`results.ts` state, `loads.ts` colouring by how full, `SimFigures.tsx` passenger figures, `SimMapKey.tsx`) at the top; `wizard/` (four steps), `library/`, and `results/` (the results window with five tabs) | `/api/sim-*`, `/api/demand*` | `SimPanel.tsx`, `results.ts` | ui-smoke 1b and 18 |
| `src/app/theme.ts`, `src/app/base.css` | Light and dark theme: CSS variables under `:root[data-theme='light']`, plus colours for the map and timelines. `base.css` also holds the resets and the classes many features share; each feature's own styles are in its CSS file beside its components | | | ui-smoke 15 |
| `src/analysis/` | **The Access pane** (access analysis). At the top: `AnalysisPanel.tsx` (the day's analyses, progress, Open, Cancel, Delete, New analysis), `analysis-api.ts` (the API calls, and a feature-local store of the day's analyses and the saved zones and points of interest; the rail's badge reads it), `analysis-state.ts` (`AnalysisView`, the one app-store field, and its helpers), `analysis-map.ts` (`analysisMapClick`: corners, placing and moving points of interest, picking a sample point within 12 px), `analysis-results.ts`, `point-detail.ts` and `analysis-compare.ts` (small stores for the open results, the picked point and the comparison), `point-journey.ts` (stored legs as map lines), `analysis-colours.ts`, `analysis.css`. `setup/`: `AnalysisSetup.tsx`, `ZonePicker.tsx`, `ZoneDrawing.tsx`, `PoiPicker.tsx`, `PlaceRow.tsx`, `NameForm.tsx`, `AnalysisSettingsForm.tsx`, with the pure `setup-form.ts` and `setup-choices.ts`. `results/`: `AnalysisResults.tsx`, `AnalysisLegend.tsx`, `PointDetail.tsx`, `CompareView.tsx`, their words in `results-text.ts`, `point-detail-text.ts`, `compare-text.ts`, and `point-detail.css`, `compare-export.css` | `/api/analysis/*`, `/api/analyses/*`; core types; app store | `AnalysisPanel.tsx` | `*.test.ts` beside, `test:access` |
| `src/map/use-analysis-layers.ts`, `use-analysis-result-layers.ts`, `use-analysis-point-layers.ts`, `use-analysis-compare-layers.ts` | The access analysis on the map: places (zone being drawn, picked zone, points of interest), results (bands, lines with labels, no service and no road points, zone outline), the picked sample point's journey and car path, and a comparison. Sources and layers are named `aa-…`; result sources carry the OpenStreetMap credit. `MapView.tsx` calls the first two; the results hook calls the other two | `src/analysis/` stores | `use-analysis-result-layers.ts` | `test:access` |
| `test/ui-smoke.mjs` | Headless Edge or Chrome over CDP, about 20 steps through the whole interface | needs `npm run dev` | | n/a |
| `test/run-access-check.mjs` and `access-*.mjs` | `npm run test:access`: brings up a throwaway stack (database, API on 3111, the fake or the real router on 3112, web on 5183) and drives the Access pane in a headless browser, saving screenshots 01 to 08; `--speed` times 5,000 × 3 through the API. `access-stack.mjs` (the stack), `access-check.mjs` (the steps), `access-browser.mjs`, `access-map.mjs`, `access-places.mjs`, `access-results-checks.mjs`, `access-speed.mjs` | the database container; `--fixture` needs nothing else | `run-access-check.mjs` header | n/a |

### apps/api: HTTP API, edit engine, simulator back end

| Part | Purpose | Depends on / used by | Start reading | Tests |
|---|---|---|---|---|
| `src/server.ts` | Entry point. Connects, migrates, registers the route files below, and listens (`PORT`). Nothing else. | `packages/gtfs` db | `server.ts` | e2e |
| `src/http.ts` | `fail()` (an error with its HTTP status), `int()` and `notFound()`, used by every route file | | | n/a |
| `src/network/` | The baseline's read routes, moved out of `server.ts`: `baselines.ts` (days, modes, the lines of a day), `map-data.ts` (packs from `PACKS_DIR`, waits, vector tiles), `inspector.ts` (line, trip, vehicle day, station summary), `timelines.ts` (trip diagram, platforms, a line's vehicles) | scenarios (`scenarioOf`, `visible`), core waits | `inspector.ts` | e2e |
| `src/scenarios/engine.ts` | **The scenario engine.** `Scenario`, `scenarioOf()`, `visible()` (the copy-on-write rule), `applyEdit` (transaction, 409, confirm), `cloneTrips`, `removeTrips`, `requireLive`, and for now the fleet and day figures (`fleetFigures`, `dayFigures`), which `applyEdit` needs for its confirm message. Imports no edit kind and not `routes.ts` | http | `applyEdit`, `visible` | e2e |
| `src/scenarios/routes.ts` | The scenario routes: list, create, rename, delete, undo, redo, the stats and impact, `POST /edits` (which looks the kind up in `edits/registry.ts`), the reshape and road-path previews, and the scenario's stops, lines, removed trips and pack for the map | core; engine; clashes; stops; edits/registry, edits/deps, edits/reshape and the edit modules' preview routes | `registerScenarioRoutes` | e2e |
| `src/scenarios/wording.ts`, `describe.ts` | Words the edit summaries share: `minutes()` (also used by the clash list) and `fleetNote`; `describe`, the label a trip is named by | core; engine (types) | `describe` | e2e |
| `src/scenarios/clashes.ts` | **The clash rules.** `conflictsIn` (and `findConflicts`, the route's way in) turns the rows read by `clashes-read.ts` (platform, vehicle, waiting vehicle, trips with no vehicle) and `clashes-reality.ts` (speed, place, closure) into clashes, with the fix suggested for each | core; engine; clashes-read; clashes-reality; wording; platforms (`bestFree`, `platformChoices`) | `conflictsIn` | e2e |
| `src/scenarios/platforms.ts` | The platforms a call could use (`platformChoices`), the best free one (`bestFree`), moving a call (`movePlatform`), and moving new trips off busy platforms (`settlePlatforms`, with `platformNote` for the summary). Used by the clash list and the edit kinds that make trips | engine, stops-visible | `settlePlatforms` | e2e |
| `src/scenarios/schedule-routes.ts` | Read-only routes for the trip panel: the platforms a call could use and the stops a trip could add | engine, platforms, stops-visible | `scheduleRoutes` | e2e |
| `src/scenarios/vehicles.ts` | `assignVehicles`: which vehicle runs each new trip (one with spare time, or a new one) | core; engine | `assignVehicles` | e2e |
| `src/scenarios/stops-visible.ts` | `stopVisible` (hides deleted stops) and `stopDeleted` | engine (`Scenario` type) | `stopVisible` | e2e |
| `src/scenarios/stops.ts` | The stops a scenario added, as GeoJSON for the map | engine, stops-visible | `scenarioStopsGeoJson` | e2e |
| `src/scenarios/edits/registry.ts` | **Every edit kind**, by the `kind` the editor sends, with its function. Each kind's body type is its function's last parameter (`EditBodies`, `EditRequest`); `runEdit` applies one | every edit module, deps | `EDIT_KINDS` | e2e |
| `src/scenarios/edits/` one file per kind | `set-vehicle.ts`, `create-line.ts`, `line-frequency.ts`, `set-vehicle-type.ts`, `shift.ts`, `delete.ts`, `delete-line.ts`, `duplicate.ts`, `skip-stop.ts`, `headway.ts`, `add-stop.ts`, `set-platform.ts`, `replan.ts`, `move-to-vehicle.ts`, `add-trip.ts`, `add-call.ts`: each holds `editX` and its exported body type | engine, vehicles, describe, wording, platforms, stops-visible, assumptions | the kind's `editX` | e2e |
| `src/scenarios/edits/assumptions.ts`, `deps.ts` | `SKIP_PENALTY` and `NEW_LINE`, figures assumed where the timetable has nothing to learn from; the helpers handed to closures and deleting a stop (`closureDeps`, `deleteStopDeps`) | engine, vehicles, clashes, reshape | `deps.ts` | e2e |
| `src/scenarios/edits/reshape.ts` | `reshape` edits (`editReshape`, `ReshapeBody`, `reshapeDeps`). Also the one door to the files below for closures, new lines and the preview routes, which import from here | engine, assumptions, reshape/ | `editReshape` | `core/edits/reshape.test.ts`, e2e |
| `src/scenarios/edits/reshape/` | `plan.ts` works out a reshape (`planReshape`); `apply.ts` writes it (`applyReshape`, `typicalChange`); `other-way.ts` carries it to the other direction (`planOtherWay`); `stops.ts` loads stops and finds the stop across the road and a station's platform; `describe.ts` the summary words; `types.ts` the plan, options and deps types | routing, engine, stops-visible, core/edits/reshape | `plan.ts` | `core/edits/reshape.test.ts`, e2e |
| `src/scenarios/edits/closure.ts` | `close` edits (`editClose`): whole line, drawn cut, road, part of the day. Re-exports `CloseBody` and `ClosureDeps` | reshape, closure/ | `editClose` | e2e |
| `src/scenarios/edits/closure/` | The closure's parts: `plan.ts` (`planClosure`: the closed area, the lines that cross it, and what happens to each; over 300 lines until it is split in a later ticket), `routes.ts` (`closureRoutes`: the preview and the closures a scenario has made), `types.ts` (`CloseBody`, `ClosureDeps` and the plan's types), `wording.ts` (names, times and counts in the label and summary) | reshape, routing, engine | `planClosure` | e2e |
| `src/scenarios/edits/delete-stop.ts` | `deleteStop` edits (`editDeleteStop`, `DeleteStopBody`), the preview and the deleted-stops map routes (`deleteStopRoutes`) | engine, delete-stop/ | `editDeleteStop` | `core/edits/delete-stop.test.ts`, e2e |
| `src/scenarios/edits/delete-stop/` | `plan.ts` works out what a deletion does (`planDeleteStop`; over 300 lines, as the one function is split in a later ticket); `describe.ts` the summary and its words; `assumptions.ts` the speed limits, warning distance and rail modes; `types.ts` the body, deps and plan types | engine, stops-visible, core/edits/delete-stop | `plan.ts` | `core/edits/delete-stop.test.ts`, e2e |
| `src/routing/roads.ts` | Road paths through the road router (`ROUTER_URL`, OSRM's request shape), including getting round a closure (`routedAround`). `ROUTER_URL` is the journey router's road side (`http://localhost:3002`) since the access analysis work; unset means none | the router's OSRM-shaped endpoints | `roadPath` | e2e, `test:roads` |
| `src/routing/tracks.ts` | Train, tram and ferry paths over an in-memory station-link graph built from published patterns | database | `trackPath` | e2e |
| `src/routing/timings.ts` | Run times for new stretches by time of day: published medians, then nearby speeds, then the mode's typical speed | core/time | `sectionTime` | `core/edits/reshape.test.ts` |
| `src/catalogue/routes.ts` | Vehicle-type catalogue routes | | | e2e |
| `src/export/routes.ts` | GTFS zip export (optional shapes, bounding box, `editor_*.txt`) | database | | e2e Reality block, `export:check` |
| `src/sim/sim.ts` | Simulator back end: demand sets (`SIM_DEMAND_DIR`), areas, folders, runs; drives the Java router (`drive()`); loads results into partitions. About 1,440 lines; the rest of its split (refactor plan §3.2) is not ticketed. | router-client, timetables | `drive` | `test/sim.e2e.mjs` |
| `src/sim/router-client.ts`, `src/sim/timetables.ts` | Moved out of `sim.ts` unchanged (AA-13): the call to the journey router (`ROUTER_SERVICE_URL`) and its "not running" words; the timetable key, the water file and `ensureTimetable`. Used by `sim.ts` and the access analysis | Java router | `ensureTimetable` | `*.test.ts` beside, `test/sim.e2e.mjs` |
| `src/analysis/` | **The access analysis.** `places-routes.ts` (zones and points of interest), `routes.ts` (list, make, read, cancel, delete analyses), `create.ts` and `create-body.ts` (checks, copies, sample points), `runner.ts` (the queue: one at a time, resumed at start), `run-drives.ts` and `road-client.ts` (car times from `/v1/road/table` on `ROUTER_URL`), `run-journeys.ts` and `journeys-client.ts` (public transport from `/v1/journeys/bulk`), `results-routes.ts` and `results-read.ts` (points, lines of equal ratio, one pair), `compare-read.ts`, `export-routes.ts` and `export-rows.ts` (compare, CSV and GeoJSON) | core `analysis/` and `api/analysis.ts`; sim/router-client, sim/timetables; both routers | `runner.ts` | `*.test.ts` beside, `test/analysis*.e2e.mjs` |
| `src/sim/results-read.ts` | Results comparisons for the results window, and `buildLinkLoads`. | `sim_*` tables | | `test/sim.e2e.mjs` |
| `test/scenarios.e2e.mjs`, `test/sim.e2e.mjs` | Scripted HTTP tests of every edit kind, and of the simulator | need the API (and the router) | | n/a |
| `test/analysis.e2e.mjs` and the suites it runs | The access analysis through the API: `analysis-runs`, `analysis-pairs`, `analysis-progress` (progress, cancel, restart), `analysis-results`, `analysis-compare` (`.e2e.mjs`), with helpers `analysis-e2e-client.mjs`, `analysis-results-lines.mjs`, `analysis-export-checks.mjs` | an API and the fake router | `analysis.e2e.mjs` | n/a |
| `test/fake-router.mjs` | A fake journey and road router in Node (D32): repeatable made-up answers to health, timetable, bulk journey and road requests, on any free port. Answers no OSRM-shaped request | | `startFakeRouter` | n/a |
| `test/roads.e2e.mjs` | `npm run test:roads`: sends the editor's three OSRM-shaped requests to `ROUTER_URL` as `roads.ts` builds them, and a 100 × 3 road table; checks `ROUTER_URL` names this machine | a running road router | | n/a |
| `test/run-e2e-fixture.mjs` | `test:e2e:fixture`: imports the test feed into `gtfs_e2e`, starts the fake router (as `ROUTER_SERVICE_URL` and `ROUTER_URL`) and an API on 3101, checks the packs went to its `PACKS_DIR` and that re-importing a day with a scenario is refused, runs `scenarios.e2e.mjs` (its export check writes under `EXPORTS_DIR`, in the run's temp folder) and then `analysis.e2e.mjs` (which starts a second API on 3102 to check that runs carry on), and always cleans up, also on Ctrl+C | the database container | | n/a |

### packages

| Part | Purpose | Used by | Start reading | Tests |
|---|---|---|---|---|
| `packages/core/src/` | Pure logic with no IO and no dependencies: `vehicle-days`, `pack`, `waits`, `limits`, `time`, `simplify` at the top; `edits/reshape` and `edits/delete-stop` (the parts of those edit kinds that need no database); `analysis/` (below); `api/` (types the web app and the API share, D9: so far `analysis.ts`). Exported as raw `.ts` from `index.ts`. | api, gtfs, web (formatting, packs, waits, analysis) | `index.ts` | `*.test.ts` beside each |
| `packages/core/src/analysis/` | The access analysis's pure logic: `local-metres.ts` (flat-earth metres about a centre), `polygon.ts` (`pointInRing`, `ringProblem`), `grid.ts` (`sampleGrid`, `gridCount`), `limits.ts` (`ANALYSIS_LIMITS`, `analysisProblem`), `defaults.ts` (`AnalysisSettings`, `DEFAULT_ANALYSIS_SETTINGS`, `settingsProblem`), `ratio.ts` (traffic factor, car time, access ratio, `pairStatus`, `ptSplit`), `summary.ts`, `contours.ts` with `contour-lines.ts` (bands and lines of equal ratio by marching triangles), `compare.ts` (`compareRatios`) | api, web | `ratio.ts` | `*.test.ts` beside each |
| `packages/gtfs/sql/migrations/` | **The database schema**, as numbered migrations `NNNN_<what>.sql`. `0001_initial.sql` is the schema as it was before migrations; a schema change is a new file, and a merged file is never edited. Each runs once, at the first API start or import after it lands (`migrate()`), and is recorded in `schema_migrations`. | db.ts | `0001_initial.sql` | n/a |
| `packages/gtfs/src/db.ts` | `connect()` (postgres.js, `DATABASE_URL`) and `migrate()`, which keeps `schema_migrations` | api, CLIs | | n/a |
| `packages/gtfs/src/migrate.ts`, `migration-files.ts` | The migration runner (which numbered files to run, in what order; a database with nothing recorded runs 0001 like a fresh one) and the reading of the files | db.ts | `runMigrations` | `*.test.ts` beside each |
| `packages/gtfs/src/feed/` | `feed-cache.ts` downloads the TfNSW feed into `data/feeds/` (`API_KEY`), or uses a feed on disk (`FEED_PATH`, `localFeed`); `unzip.ts`; `audit.ts` and `audit-db.ts`, the phase 0 data audit (DuckDB, `feed:audit`) | import, CLIs | `ensureFeed` | n/a |
| `packages/gtfs/src/import/` | `stage.ts` (COPY into `staging.*`), `baseline.ts` (one service date into the baseline tables), `replace-guard.ts` (refuses a day that has scenarios without `--replace`; date checks), `finish.ts` (counts, marks ready), `vehicle-days.ts`, `packs.ts` (writes under `PACKS_DIR`) | `cli/import.ts`, `cli/packs.ts` | `cli/import.ts` | `replace-guard.test.ts` |
| `packages/gtfs/src/road/road-data-plan.ts` | The pure plan behind `road:data`: reads the arguments, chooses the extract (given, found or downloaded), and lists the steps (download, cut, build, swap) | `cli/road-data.ts` | | `road-data-plan.test.ts`, `road-data-graph.test.ts` |
| `packages/gtfs/src/cli/` | What the npm scripts run: `fetch.ts` (`feed:fetch`), `import.ts` (`import`), `packs.ts` (`packs`), `backup.ts` (`db:backup`, `db:restore`; writes `data/backups/`), `road-data.ts` (`road:data`: the Opal-area OpenStreetMap cut with osmium in Docker, then the road graph into `data/router/road/opal`), and `export-check.ts` with `export-references.ts` and `export-vehicles.ts` (`export:check`: downloads an export from the running API into `data/exports/` or `EXPORTS_DIR` and checks it: references, ids, monotonic times, and that it matches the feed for the published day) | npm scripts, e2e | | n/a |
| `packages/gtfs/test/fixtures/` | `mini-feed/`: a small made-up weekday feed in central Sydney (T1 train, buses 333, 373 and 389, F1 ferry), written by `make-mini-feed.mjs` and its modules in `mini-feed-gen/` | `test:e2e:fixture` | `make-mini-feed.mjs` | n/a |

### services/router: the Java journey router and simulator

| Module | Purpose | Start reading | Tests |
|---|---|---|---|
| `router-core` | Timetable (flat arrays), snapshots, RAPTOR search, capacity modes (off, check, assign), load states, walking links over water. No dependencies. | `Timetable.java`, `Router.java` | `BruteForceTest`, `CapacityTest`, … |
| `router-gtfs` | Reads a GTFS zip (with `editor_*.txt`), builds walking links, snapshot cache; the `loadTimetable` and `route` CLIs | `GtfsLoader.java`, `TransferBuilder.java` | `GtfsLoaderTest`, `JourneyScenariosTest`, `RealExportTest` (needs `ROUTER_REAL_ZIP`) |
| `router-sim` | The passenger simulator: plan, then replay with capacity; demand reading, writing and generation; result files | `Simulation.java`, `SimRun.java` | `StopRuleTest`, `HonestyTest`, `SimRunTest`, … |
| `router-server` | Javalin HTTP service: named timetables (`Timetables.java`), journeys, bulk, load states, demand, simulation jobs (`Simulations.java`), settings from env (`Settings.java`, with `ROUTER_ROAD*`); the road endpoints `/v1/road/route` and `/table` and road-only mode (`RoadApi.java`, `RoadJson.java`); the OSRM-shaped `route`, `table`, `nearest` at the root (`OsrmApi.java`, `OsrmRequest.java`). Gradle tasks `run` (1 GB) and `runRoad` (roads only, 512 MB, port 3003) | `RouterServer.java` | `RouterServerTest`, `SimulationsTest`, `RoadApiTest`, `RoadModesTest`, `OsrmApiTest`, `OsrmRefusalsTest` (with `RoadFixture`) |
| `router-road` | Road routing for cars with GraphHopper 11.1 behind `RoadRouter` (the only module that uses GraphHopper): `GraphHopperRoads.java` (route, nearest), `GraphHopperTable.java` (many drives on a thread pool), `GraphHopperAlternatives.java`, `RoadGraphBuilder.java` and `RoadImport.java` (the `roadImport` task), records `LatLon`, `Snapped`, `RoadRoute`, `RoadTable`, `RoadSettings`. Test map `src/test/resources/mini-roads.osm` | `RoadRouter.java`, `GraphHopperRoads.java` | `GraphHopperRoadsTest`, `RoadTableTest`, `RoadGraphBuilderTest` (with `MiniRoads`) |
| `tools/osmium/Dockerfile` | osmium from Debian's own package, used by `road:data` to cut the Opal area | | |
| `router-bench` | **Planned** (phase 5): benchmarks. Only a placeholder JMH benchmark. | | |
| `tools/compare-tfnsw.mjs` | Compares the router's journeys with the TfNSW trip planner | | |

## Data and information

| Entity | Defined in | Stored | Written by |
|---|---|---|---|
| Baseline (one service date) | `migrations/0001_initial.sql` `baselines` | Postgres | importer |
| Routes, patterns, trips, stop times, stops, shapes, vehicle days | `migrations/0001_initial.sql` | Postgres; scenario rows carry `scenario_id` and `created_edit` | importer; edit engine |
| Scenario, edit | `migrations/0001_initial.sql` `scenarios`, `scenario_edits`, `scenario_removed`, `scenario_removed_stops`, `scenario_closures` | Postgres | `apps/api/src/scenarios/engine.ts` (`applyEdit`), `routes.ts` and the edit modules in `scenarios/edits/` |
| Clash | `scenarios/clashes.ts` `conflictsIn` | Not stored (feed clashes: `baseline_conflicts`) | API, on request |
| Vehicle type | `migrations/0001_initial.sql` `vehicle_types`, view `trip_vehicle` | Postgres | seed, import, `catalogue/routes.ts` |
| Pack | `packages/core/src/pack.ts` | `data/packs/<baseline>/<mode>.bin` | `import/packs.ts` |
| Demand set | `migrations/0001_initial.sql` `demand_sets`; format in `services/router/README.md` | `data/sim/demand/` | `sim/sim.ts`; the router generates made-up sets |
| Sim run and results | `migrations/0001_initial.sql` `sim_*` | Postgres partitions per run; router files in `data/router/sim/` | `sim/sim.ts`, the router |
| Router timetable and snapshot | `Timetable.java`, `TimetableSnapshot.java` | Memory; `data/router/snapshots/` | router |
| Road graph | `RoadGraphBuilder.java` (with `road-graph.json`) | `data/osm/opal.osm.pbf`, `data/router/road/opal/` | `npm run road:data` |
| Zone, point of interest | `migrations/0010_access_analysis.sql` `analysis_zones`, `points_of_interest` | Postgres (belong to no day) | `apps/api/src/analysis/places-routes.ts` |
| Access analysis, its sample points and results | `0010_access_analysis.sql` `analyses`, `analysis_pois`, `analysis_points`, `analysis_results`; types in `packages/core/src/api/analysis.ts` | Postgres | `analysis/create.ts`, `runner.ts`, `run-drives.ts`, `run-journeys.ts` |

## Where do I find…

- **Adding an edit kind:** add one file in `apps/api/src/scenarios/edits/` with the function and its exported body type, and one line in `edits/registry.ts`. Send it from the web with `applyEdit({ kind, … })`, and cover it in `apps/api/test/scenarios.e2e.mjs`. Put any logic that needs no database in `packages/core` with a unit test.
- **Adding an API route:** register it in the relevant `register*Routes` or `*Routes` function under `apps/api/src/` (baseline reads in `network/`), and take `?s=` through `scenarioOf()` if it reads timetable data.
- **What a scenario can see:** `visible()` in `apps/api/src/scenarios/engine.ts`; for stops, `stopVisible()` in `apps/api/src/scenarios/stops-visible.ts`.
- **Clash rules:** `conflictsIn` in `apps/api/src/scenarios/clashes.ts`, reading from `clashes-read.ts` and `clashes-reality.ts` beside it. Limits are in `packages/core/src/limits.ts`. The display is in `apps/web/src/scenarios/ScenarioPanel.tsx` (`ConflictRow`) and `timeline/PlatformView.tsx`.
- **Run times for new stretches:** `apps/api/src/routing/timings.ts`, with time-of-day bands in `packages/core/src/time.ts` (`DAY_BANDS`).
- **Road and track paths:** `apps/api/src/routing/roads.ts` (the road router, through its OSRM-shaped endpoints) and `apps/api/src/routing/tracks.ts`.
- **Access analysis:** the API in `apps/api/src/analysis/` (start at `runner.ts`), the pure logic in `packages/core/src/analysis/`, the pane in `apps/web/src/analysis/`, the map in `apps/web/src/map/use-analysis-*.ts`, the tables in `0010_access_analysis.sql`. The design is `docs/architecture/access-analysis.md` (§12 for what was built differently).
- **Database tables:** `packages/gtfs/sql/migrations/0001_initial.sql`, plus the later numbered migrations beside it (`0010_access_analysis.sql`; 0002 to 0009 are left for `trustworthy-edits`). Sim partitions are created at runtime in `apps/api/src/sim/sim.ts`.
- **Map layers:** `apps/web/src/map/MapView.tsx`; newer ones in hooks beside it (`use-analysis-*.ts`). Tiles come from `apps/api/src/network/map-data.ts` `/tiles`.
- **Vehicle animation:** `apps/web/src/vehicles/vehicles.ts`, `packages/core/src/pack.ts`, `waits.ts`.
- **Timeline dragging:** `apps/web/src/timeline/TimelineCanvas.tsx`.
- **Theme:** `apps/web/src/app/theme.ts`, and `app/base.css` line 32.
- **URL deep links and keyboard shortcuts:** `apps/web/src/app/App.tsx`.
- **How the API talks to the router:** `apps/api/src/sim/router-client.ts` and `timetables.ts` (`ensureTimetable`), used by `sim.ts` (`drive`, `importResults`) and the access analysis; roads through `apps/api/src/analysis/road-client.ts` and `routing/roads.ts`.
- **Router endpoints:** `services/router/router-server/.../RouterServer.java` (around lines 97-119; the road ones in `RoadApi.java` and `OsrmApi.java`), and `services/router/README.md`.
- **Environment variables:**
  - API side: `DATABASE_URL` (`db.ts`), `PORT` (`server.ts`), `PACKS_DIR` (`network/map-data.ts`, and `import/packs.ts` in the gtfs package), `ROUTER_URL` (the road router: `routing/roads.ts`, `analysis/road-client.ts`), and `ROUTER_SERVICE_URL` (`sim/router-client.ts`), `API_PUBLIC_URL`, `ROUTER_SHARES_FILES`, `SIM_DEMAND_DIR` (`sim/sim.ts`, `sim/timetables.ts`). `API_KEY` is used by the CLIs.
  - Web side, for a private dev server: `WEB_PORT`, `API_TARGET` (`apps/web/vite.config.ts`).
  - Router side: `ROUTER_PORT`, `ROUTER_THREADS`, `ROUTER_MAX_TIMETABLES`, `ROUTER_DATA`, `ROUTER_LOAD`, `ROUTER_BULK_LIMIT`, `ROUTER_ROAD`, `ROUTER_ROAD_GRAPH`, `ROUTER_ROAD_SNAP_METRES`, `ROUTER_ROAD_TABLE_LIMIT` (`Settings.java`).

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
- **Styles beside their component.** `app/base.css` holds the variables, both themes, resets and the classes several features share; each feature has its own CSS file beside its components (e.g. `map/map.css`, `sim/results/results.css`), imported by that feature's top component. `base.css` loads first, from `main.tsx`. Vite emits CSS in import order, so moving an `import './x.css'` line can change which rule wins: `app/shell.css` is the first import in `App.tsx` and `app/left-rail.css` the last, because its rules must come after the timeline and simulator ones.
- **What may import what:**
  - `shared/` imports nothing from features. `app/` (the shell) is not a feature, and `shared/` may read the app store (`app/store.ts`) but nothing else in `app/`.
  - A feature may import `shared/` and the app store. It imports another feature only through files at the top of that feature's folder, never from its subfolders.
  - In the API, `scenarios/engine.ts` imports no edit kinds. Edit kinds import the engine; the registry imports the edit kinds.
  - No import circles. oxlint's `import/no-cycle` rule will enforce this once the API circles are broken (stage 3); until then, don't add new ones.
- **No barrel files** (an `index.ts` that only re-exports), except each package's public entry, such as `packages/core/src/index.ts`. Barrels hide circles and slow Vite's reload.
- **Shared web and API types** go in `packages/core/src/api/` and are imported by both sides (decision D9; the folder is created in stage 4). Don't hand-copy a response type into the web app.
- **Folder names use the glossary terms** once `docs/glossary.md` exists.

## Planned layout

**Status: moved.** The web app (ticket T-7), the API and the packages (ticket T-6) are in these folders. Splitting the long files inside them is stages 3 and 5. This is the target from `docs/refactor-plan.md` §2.3–2.5. Files move into it one PR at a time; until a file has moved, the tables above say where it is. `→` means the file is renamed when it moves.

### apps/web/src (moved)

**Status: files moved (T-7).** Every file is in its folder below. The stylesheet is split (T-8): `app/base.css` plus one CSS file per feature. Still to come: `send()` has not yet moved from `scenario-client.ts` into `api-client.ts`; the response types move in stage 4; `MapView.tsx` is split in stage 5.

```
apps/web/src/
  main.tsx
  app/              the shell: App.tsx, TopBar.tsx, LeftRail.tsx, TimeBar.tsx, store.ts, theme.ts, base.css,
                    shell.css (top bar, time bar), left-rail.css (rail and its panes)
  shared/           used everywhere, owns nothing: api-client.ts (the one fetch wrapper: useApi()
                    and getJson() from today's api.ts, and send() from scenario.ts; the response
                    types go to packages/core/src/api/ in stage 4), clock.ts,
                    live-stats.ts, ui/ (today's inspector/parts.tsx and other small pieces)
  map/              MapView.tsx (later split into hooks here, stage 5), ModePanel.tsx (show or hide
                    each mode's lines), map.css
  vehicles/         vehicles.ts (animation packs and vehicle positions)
  scenarios/        scenario.ts → scenario-client.ts, ScenarioPanel.tsx, ScenarioManager.tsx, EditConfirm.tsx,
                    scenarios.css
  editing/          the tools that change the network; editing.css
    builder.ts      picking stops (shared by new-line and reshape)
    NewStopTool.tsx
    new-line/       NewLinePanel.tsx
    reshape/        ReshapePanel.tsx
    closures/       ClosurePanel.tsx
  inspector/        as now: RoutePanel, TripPanel, StationPanel, DeleteStop, TripEditTools…, inspector.css
  catalogue/        FleetPanel.tsx → CataloguePanel.tsx (the vehicle catalogue), catalogue.css
  timeline/         as now, timeline.css
  sim/
    sim-api.ts, SimPanel.tsx, sim.css (Simulate pane, passenger figures, map key)
    wizard/         SimWizard.tsx, wizard.css
    library/        SimLibrary.tsx, library.css
    results/        SimResults.tsx, SimResultsPeople.tsx, SimFigures.tsx, SimMapKey.tsx, results.ts, loads.ts,
                    results.css (the window), results-charts.css, results-tabs.css (Lines, Patterns, People)
  analysis/         the Access pane (access analysis): AnalysisPanel.tsx, its stores and map clicks at the top,
                    setup/ and results/; its map layers are hooks in map/ (use-analysis-*.ts)
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
    platforms.ts    platform choices and settlePlatforms (from schedule.ts)
    schedule-routes.ts  the trip panel's platform and addable-stop routes (from schedule.ts)
    edits/
      registry.ts   edit kind → its function
      create-line.ts, line-frequency.ts, reshape.ts, set-vehicle.ts, set-vehicle-type.ts,
      shift.ts, delete.ts, delete-line.ts, duplicate.ts, skip-stop.ts, headway.ts,
      add-stop.ts (from stops.ts), delete-stop.ts, closure.ts (from closures.ts),
      closure/ (plan.ts, routes.ts, types.ts, wording.ts),
      set-platform.ts, replan.ts, move-to-vehicle.ts, add-trip.ts, add-call.ts (from schedule.ts)
      reshape/      plan.ts, apply.ts, other-way.ts, stops.ts, describe.ts, types.ts
      delete-stop/  plan.ts, describe.ts, assumptions.ts, types.ts
  catalogue/        routes.ts: the vehicle catalogue routes (was fleet.ts)
  export/           routes.ts (was export.ts)
  sim/              routes.ts, timetables.ts, runner.ts, router-client.ts, results-import.ts,
                    results-read.ts (today's sim-results.ts)
  analysis/         the access analysis (built): places, analyses, runner, router clients, results,
                    compare and export
```

`sim/router-client.ts` and `sim/timetables.ts` exist (moved out of `sim.ts` by AA-13); the other `sim/` files above are still inside `sim.ts`.

**Built so far (stage 2, T-6):** `server.ts`, `http.ts`, `network/` (as four files: `baselines.ts`, `map-data.ts`, `inspector.ts`, `timelines.ts`), `routing/`, `catalogue/routes.ts`, `export/routes.ts`, `scenarios/scenarios.ts` and `scenarios/stops.ts`, `scenarios/edits/` (`closure.ts`, `delete-stop.ts`, `reshape.ts`, `schedule.ts`), `sim/sim.ts` and `sim/results-read.ts`. `scenarios.ts` and `sim.ts` moved whole; stage 3 splits them into the files above.

**Stage 3 so far:** T-10 took `scenarios/engine.ts` out of `scenarios.ts` and `scenarios/stops-visible.ts` out of `stops.ts`, which broke the API import circles. The fleet and day figures sit in `engine.ts` for now, not `vehicles.ts`, because `applyEdit` uses them and `vehicles.ts` would need `visible()` back from the engine. T-11 took the clash rules into `scenarios/clashes.ts` (with `clashes-read.ts` and `clashes-reality.ts` beside it, to keep each file under 300 lines) and `assignVehicles` into `scenarios/vehicles.ts`; both import the engine, not `scenarios.ts`. T-12 renamed `scenarios.ts` to `scenarios/routes.ts`, moved each edit kind into its own file in `scenarios/edits/` (and `editAddStop` from `stops.ts` into `edits/add-stop.ts`), and added `edits/registry.ts`, which gives each kind its own body type. `edits/assumptions.ts` and `edits/deps.ts` hold what several kinds share, and `wording.ts` and `describe.ts` the words the summaries share. `routes.ts` is still over 300 lines: the scenario routes, the previews and the pack are all routes, and moving them out is not a move this ticket covers. T-13 split `edits/schedule.ts` into one file per kind (`set-platform.ts`, `replan.ts`, `move-to-vehicle.ts`, `add-trip.ts`, `add-call.ts`), `scenarios/platforms.ts` (the platform helpers, which the clash list and the kinds that make trips share) and `scenarios/schedule-routes.ts`; the kinds import their helpers directly, so `deps.ts` no longer makes a `schedule` instance. The kinds in `closure.ts`, `delete-stop.ts` and `reshape.ts` are split later (T-14, T-15).

**T-15** split `edits/delete-stop.ts` and `edits/reshape.ts`. Each stays its kind's entry and keeps its helpers in a folder of the same name: `delete-stop/` and `reshape/`. Code was moved, not changed. `reshape.ts` re-exports what closures, new lines and the preview routes use, so their imports did not change. `delete-stop/plan.ts` is over 300 lines on purpose: `planDeleteStop` alone is about 510 lines, and splitting it is a rewrite for a later ticket.

### packages (planned)

```
packages/core/src/
  index.ts          public entry
  api/              the shared request and response types (stage 4)
  time.ts, limits.ts, simplify.ts, pack.ts, waits.ts, vehicle-days.ts
  edits/            reshape.ts, delete-stop.ts (the pure parts of edit kinds), with tests
                    (core.test.ts is now split into a test beside each file it covers)

packages/gtfs/
  sql/migrations/   0001_initial.sql, then one numbered file per schema change
  src/
    db.ts, migrate.ts, migration-files.ts
    feed/           feed-cache.ts, unzip.ts, audit.ts, audit-db.ts
    import/         as now
    cli/            fetch.ts, import.ts, packs.ts, backup.ts, export-check.ts, export-references.ts
                    (the npm scripts point here)
  test/fixtures/    the small test feed (stage 1.4)
```

**Built (stage 2, T-6).** `migrations/` came with T-16 (`0001_initial.sql`, then `0010_access_analysis.sql`). `core/src/api/` exists with the access analysis's types (`analysis.ts`); moving the older response types there is still stage 4. `packages/gtfs/src/road/` and `cli/road-data.ts` came with the access analysis.

## Planned for trustworthy-edits

**Status: planned**, not built. From `docs/architecture/trustworthy-edits.md` §4, which has the full list and the reasons. It is built after refactor stages 3 and 6 (decision D10), so the paths below assume `scenarios.ts` has been split.

| Part | Purpose |
|---|---|
| `packages/core/src/changes/` | `trip-diff.ts`: compare one trip's old and new calls. `reasons.ts`: the reason codes for estimates (run time source, platform, vehicle, detour, template trip, new end). |
| `packages/core/src/edits/` (new files) | `ripple.ts` (soak up a delay), `template.ts` (choose a template trip), `overlap.ts` (the one overlap test), `new-ends.ts` (find new ends) |
| `packages/core/src/api/changes.ts` | Types for the change list routes, shared by the web app and the API |
| `apps/api/src/scenarios/changes/` | `read.ts` works out an edit's change list from the rows it tagged; `notes.ts` is the note buffer an edit writes reasons into; `routes.ts` has the four `GET /api/scenarios/:id/edits/:seq/changes…` routes; `new-ends.ts` holds the published ends per day |
| `scenario_edit_notes`, `scenario_route_vehicle_types`, `modes.min_turnaround_secs` | New tables and a new column, added by migrations after stage 6 |
| `apps/web/src/scenarios/changes/` | The change list: `ChangeList.tsx`, `ChangeTrip.tsx`, `changes-api.ts`, `changes.css` |
| `apps/web/src/map/use-change-layers.ts` | Draws one edit on the map |
| `apps/web/src/editing/NewEndsList.tsx` | The new ends list, used by the delete-stop card and the closure panel |
| `apps/web/src/catalogue/TurnaroundSettings.tsx` | Minimum turnaround per mode |

Rule this work depends on: **an edit changes only rows it made itself**, apart from the tag that removes an earlier row (`docs/architecture/system.md` §5.3, issue I7).

## Access analysis (built)

**Status: built** (26 Nov 2026, AA-1 to AA-24, on the branch `feature/access-analysis`), checked against the code. The tables above have each part in its place; this is the summary. The design is `docs/architecture/access-analysis.md` (§6 the planned files, §12 what was built differently); decisions D14 to D34 in `docs/architecture/system.md`. Tickets AA-1 to AA-26 in `docs/project/access-analysis-tickets.xlsx`.

| Part | Purpose |
|---|---|
| `services/router/router-road/` | Road routing with GraphHopper behind `RoadRouter`: `GraphHopperRoads.java` (route, nearest), `GraphHopperTable.java` (table), `GraphHopperAlternatives.java`, `RoadGraphBuilder.java` and `RoadImport.java` (the `roadImport` task). Test map `src/test/resources/mini-roads.osm`. |
| `services/router/router-server/.../RoadApi.java`, `RoadJson.java`, `OsrmApi.java`, `OsrmRequest.java` | `POST /v1/road/route`, `POST /v1/road/table`, and the OSRM-shaped `GET /route|table|nearest/v1/driving/…` that `ROUTER_URL` points at. Settings `ROUTER_ROAD`, `ROUTER_ROAD_GRAPH`, `ROUTER_ROAD_SNAP_METRES`, `ROUTER_ROAD_TABLE_LIMIT`; road-only process `npm run router:road` (port 3003). |
| `services/router/tools/osmium/Dockerfile` | osmium from Debian's package, used by `npm run road:data` to cut the Opal area |
| `packages/gtfs/src/cli/road-data.ts`, `src/road/road-data-plan.ts` | `npm run road:data`: Australia extract → Opal area cut → road graph in `data/router/road/opal` |
| `packages/gtfs/sql/migrations/0010_access_analysis.sql` | `analysis_zones`, `points_of_interest`, `analyses`, `analysis_pois`, `analysis_points`, `analysis_results` |
| `packages/core/src/analysis/` | Pure logic: `local-metres`, `polygon` (inside, crossing check), `grid` (sample points), `limits`, `defaults`, `ratio` (traffic factor, car time, access ratio, status, time split), `summary`, `contours` and `contour-lines` (marching triangles), `compare` |
| `packages/core/src/api/analysis.ts` | Types shared by the web app and the API |
| `apps/api/src/analysis/` | Zone and point-of-interest routes, analyses (create, queue, run, cancel), the drives and journeys steps, typed router clients, result reads, compare and export (14 files; listed in the API table above) |
| `apps/api/src/sim/router-client.ts`, `timetables.ts` | Moved out of `sim.ts` (AA-13): the router call, the timetable key, the water file, loading a timetable. Used by `sim.ts` and the analysis. |
| `apps/api/test/analysis.e2e.mjs` (and `analysis-*.mjs`), `fake-router.mjs`, `roads.e2e.mjs` | The analysis e2e (in `test:e2e:fixture`, against the fake router); `npm run test:roads` against a real road router |
| `apps/web/src/analysis/` | The Access pane: `AnalysisPanel.tsx`, `analysis-api.ts` (with the list store), `analysis-state.ts`, `analysis-map.ts` (map clicks), `analysis-results.ts`, `point-detail.ts`, `point-journey.ts`, `analysis-compare.ts`, `analysis-colours.ts`, `setup/` (zone, points of interest, settings, run), `results/` (results, legend, one sample point, compare, and their words), `analysis.css` |
| `apps/web/src/map/use-analysis-layers.ts`, `use-analysis-result-layers.ts`, `use-analysis-point-layers.ts`, `use-analysis-compare-layers.ts` | The zone and points of interest; bands, lines and sample points; one point's journey and car path; the comparison |
| `apps/web/test/run-access-check.mjs` and `access-*.mjs` (eight files) | `npm run test:access`: the owner's check in a headless browser, on a throwaway stack, with screenshots |

Rule this work depends on: the router never reads the database; the API joins the two routers' answers and stores them.
