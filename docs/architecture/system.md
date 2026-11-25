# System architecture: GTFS Editor

| | |
|---|---|
| Status | Draft (awaiting the owner's approval) |
| Describes | The system as built, checked against commit `c33fbef` (22 Nov 2026); the road router and access analysis parts against `504fc45` (branch `feature/access-analysis`, 26 Nov 2026) |
| Source of truth for | How the parts fit together. Plans and progress stay in `PLAN.md`, `docs/router-plan.md` and `docs/simulator-plan.md`. |
| Navigation | `docs/codebase-map.md` |

This document was first written from the code, before any BRD existed. Where the plans and the code disagree, the code is described here and the disagreement is listed in section 11. Since then: BRDs live in `docs/brd/`, with one feature architecture document each in `docs/architecture/` (the first is `trustworthy-edits.md`), and the glossary is `docs/glossary.md`.

## 1. Purpose, scope and users

A visual editor for NSW public transport timetables (GTFS, the standard file format for timetables), with a passenger simulator. A user picks one service day of the published TfNSW timetable and does the following:

- Watches the vehicles move on a map.
- Inspects lines, trips, vehicles and stations, with timeline charts.
- Makes **scenarios**: copies of the day with changes. A change can retime trips, change frequencies, draw or reshape lines, add or delete stops, close a road or a line, or change vehicles and platforms. Every change can be undone.
- Sees **clashes** (impossible or doubtful results) with one-click fixes.
- Exports a scenario as a GTFS zip.
- Runs the **simulator**: sends a file of journeys (demand) through the published day or a scenario and compares the results.
- Runs an **access analysis**: over a drawn zone, times trips to chosen points of interest by public transport and by car, and maps the access ratio (BRD `access-analysis`).

Users: today, one owner and developer, on one Windows machine. There are no logins. The aim is a hosted service on AWS (not built).

Out of scope as built: journey planning in the web page, deployment, and authentication. Road routing is our own since the access analysis work (the journey router's road side, D16); before that an outside OSRM server was used.

## 2. Architectural drivers

- **Size of the data.** A weekday is about 59,000 trips. Whole-day vehicle animation is about 53 MB per weekday, sent to the browser as binary packs. Edits must stay interactive on tables this size.
- **Every edit can be undone and has no side effects on other scenarios.** This drives the copy-on-write scenario model (section 5.3).
- **Honest results.** The clash rules and the simulator's "honesty" outputs (made-up journeys labelled, people who gave up counted) aim to show only what the data supports.
- **Speed of the journey router.** A median of 8 ms for a single query, and bulk assignment of up to millions of journeys. This is why the router is a separate Java service with flat in-memory arrays.
- **A small machine.** The dev machine is low on memory. The Gradle daemon is limited to 512 MB, the router heap to 1 GB (768 MB before road routing), the road-only router to 512 MB, and the Docker router to 1 GB.
- **One developer.** Simple tooling: no build step for Node, no queues, no ORM.

## 3. System context

```mermaid
flowchart LR
  user([Planner in a browser])
  tfnsw[(TfNSW Open Data<br/>GTFS feed)]
  geofabrik[(Geofabrik<br/>OpenStreetMap extract)]
  ofm[(OpenFreeMap<br/>basemap tiles)]
  subgraph sys[GTFS Editor]
    web[Web app<br/>React, :5173]
    api[API<br/>Fastify, :3001]
    db[(Postgres + PostGIS<br/>:5433)]
    router[Journey router<br/>+ simulator + road router<br/>Java, :3002]
    files[(data/ folder<br/>feeds, packs, exports,<br/>demand, router files,<br/>OSM extract, road graph)]
  end
  user --> web
  web -- /api --> api
  web --> ofm
  api --> db
  api -- ROUTER_SERVICE_URL --> router
  api -- ROUTER_URL<br/>roads --> router
  router -- pulls export + water lines<br/>API_PUBLIC_URL --> api
  importer[Import and road-data CLIs<br/>packages/gtfs] --> tfnsw
  importer --> geofabrik
  importer --> db
  importer --> files
  api --> files
  router --> files
```

| Outside system | Used by | How | Notes |
|---|---|---|---|
| TfNSW Open Data GTFS | `packages/gtfs/src/feed/feed-cache.ts` | HTTPS, `API_KEY` | Downloaded once per feed version, checked by etag |
| Geofabrik (OpenStreetMap) | `packages/gtfs/src/cli/road-data.ts` (`npm run road:data`) | HTTPS download of `australia-latest.osm.pbf` | Only when `data/osm/` has no copy. Cut to the Opal area with osmium in Docker and built into the road graph. The data is © OpenStreetMap contributors (ODbL) and is credited wherever road results are shown. |
| OpenFreeMap | `apps/web/src/app/theme.ts` | Style URLs | Basemap only. Tile addresses say which part of the map is viewed (I9). |

The editor's road requests (`route`, `table`, `nearest` from `apps/api/src/routing/roads.ts`, through `ROUTER_URL`) used to go to the public OSRM demo server. Since the access analysis work they go to the journey router's road side, which answers them in OSRM's shape (D16), so no routing request leaves the machine. The owner's own `.env` must name `http://localhost:3002` for that; `.env.example` does. It still cannot be told a road is closed (A7 of BRD `access-analysis`), and `roads.ts` still sends at most two requests at a time.

## 4. Components

```mermaid
flowchart TB
  subgraph web[apps/web]
    app[App.tsx / store.ts]
    map[MapView.tsx<br/>MapLibre + deck.gl]
    insp[inspector/]
    tl[timeline/]
    simui[sim/]
    aaui[analysis/<br/>Access pane]
    scen[scenario-client.ts<br/>applyEdit, undo]
  end
  subgraph api[apps/api]
    server[server.ts + network/<br/>reads, tiles, packs]
    scenarios[scenarios/<br/>engine, routes, clash rules]
    editmods[scenarios/edits/<br/>one file per edit kind]
    geo[routing/<br/>roads.ts, tracks.ts, timings.ts]
    export[export/routes.ts]
    sim[sim/<br/>sim.ts, router-client.ts,<br/>timetables.ts, results-read.ts]
    analysis[analysis/<br/>places, analyses, runner,<br/>results, compare, export]
  end
  core[packages/core<br/>pure logic]
  gtfs[packages/gtfs<br/>import, schema, CLIs]
  subgraph router[services/router]
    rcore[router-core]
    rgtfs[router-gtfs]
    rsim[router-sim]
    rroad[router-road<br/>GraphHopper]
    rserver[router-server]
  end
  web --> server & scenarios & sim & analysis
  web --> core
  scenarios --> editmods --> geo
  scenarios --> core
  editmods --> core
  analysis --> core
  analysis -- timetables --> sim
  server --> gtfs
  sim --> rserver
  analysis -- journeys, roads --> rserver
  geo -- OSRM-shaped roads --> rserver
  rserver --> rcore & rgtfs & rsim & rroad
  rserver -- GET export --> export
```

| Part | Responsibility | Must not |
|---|---|---|
| `apps/web` | Everything the user sees. It holds one zustand store; the Access pane keeps its lists and results in small stores of its own (`apps/web/src/analysis/`). Vehicle animation, the clock and simulator loads are kept outside React for speed. Every change goes through `scenario-client.ts` `applyEdit`. | Decide whether an edit is valid, or work out clashes (both are done on the server). |
| `apps/api` | The HTTP API, the scenario edit engine, the clash rules, map tiles, export, the simulator back end that drives the router and keeps its results, and the access analysis (zones, points of interest, analyses run in the background, their results, comparison and export). | Import feeds (that is a CLI). |
| `packages/core` | Logic with no database or IO: vehicle-day chaining, the pack format, reshape geometry and timing, the delete-stop rule, waits, physical limits, time formatting, and the access analysis's grid, outline check, access ratio, summary, lines of equal ratio and comparison (`analysis/`). The types the web app and the API share (`api/`). Unit-tested. | Depend on anything. |
| `packages/gtfs` | Download, staging and import of a feed into a baseline; the database schema as numbered migrations (`sql/migrations/`); pack building; the audit, export-check and road-data CLIs. | Serve HTTP. |
| `services/router` | A Java RAPTOR journey router (an algorithm for public transport journey planning), the passenger simulator and the road router (drives on OpenStreetMap roads, with GraphHopper), behind an HTTP service. It loads timetables from the editor's GTFS export and the road graph from `data/router/road/opal`. | Read the editor's database. It only sees exported zips and its own road graph. |

The router's own modules are `router-core`, `router-gtfs`, `router-sim`, `router-server`, `router-road` (road routing for cars, the only module that uses GraphHopper) and `router-bench` (a placeholder). They are described in `services/router/README.md` and `docs/router-plan.md`. The same jar can run roads only (`ROUTER_ROAD=only`, `npm run router:road`, port 3003), for a machine short of memory.

## 5. Information architecture

### 5.1 Key entities

| Entity | Meaning | Stored in | Owner (who writes) |
|---|---|---|---|
| Feed | One downloaded TfNSW GTFS version | `data/feeds/`, `staging.*` | Import CLIs |
| Baseline | One **service date** of one feed, `unique(feed_id, service_date)`, with `day_type` | `baselines` | Importer only |
| Mode | Train, metro, light rail, ferry, bus, coach, school bus, with a rule set of rail, ferry or road | `modes`, `route_type_modes` | Schema seed |
| Route (line), Pattern (stopping pattern), Trip, Stop time, Stop (station, platform, stop), Shape | GTFS data for the day | `routes`, `patterns`, `trips`, `stop_times`, `stops`, `shapes` | Importer; scenarios add rows |
| Vehicle day | Trips chained into one vehicle's day, from the feed's run numbers or inferred | `vehicle_days`, `trips.vehicle_day_id` | Importer (`core/vehicle-days.ts`); scenarios add or change |
| Stay-aboard link | Passengers stay on through two trips of the same block | `stay_aboard_links` | Importer |
| Vehicle type | Capacity (seated and standing), with a placeholder flag and fleet size | `vehicle_types`, `mode_default_vehicle`, view `trip_vehicle` | Seed, import (train sets), user (Fleet screen) |
| Scenario | A baseline plus edits, with a `head` (the edit it is at) | `scenarios`, `scenario_edits` | API edit engine |
| Edit | One change: one of 19 kinds (shift, reshape, close, deleteStop, and so on) | `scenario_edits` (kind and summary only) and the rows it created or removed | API edit engine |
| Clash (conflict) | A doubtful result: platform, vehicle, speed, place, closure | Worked out on request, not stored. Clashes already in the feed are in `baseline_conflicts`. | `scenarios.ts` `conflictsIn` |
| Closure | An area or part of a line closed for some or all of the day | `scenario_closures` | `closures.ts` |
| Pack | Binary whole-day vehicle positions for one mode | `data/packs/<baseline>/<mode>.bin` | Importer (`import/packs.ts`) |
| Demand set | A CSV of journeys (`user_id`, `start_time`, `origin_stop`, `destination_stop`, …) | `demand_sets` plus `data/sim/demand/` | User uploads or made up by the router |
| Sim run | One simulator run: kind BAU (business as usual), scenario or capacity | `sim_runs`; results in the partitions `sim_journeys`, `sim_legs`, `sim_trip_loads`, `sim_stop_activity`; `sim_link_loads` | `sim.ts`, `sim-results.ts` |
| Timetable (router) | An exported day loaded into the router's memory under a named id, with a binary snapshot | Router memory, `data/router/snapshots/` | Router |
| Load state (router) | Passengers aboard per stop time, in memory, at most 8 per timetable | Router memory | Router |
| Road graph (router) | OpenStreetMap roads of the Opal area, built for cars, with `road-graph.json` saying what it was built from | `data/osm/opal.osm.pbf` (the cut extract); `data/router/road/opal/` (memory-mapped when served) | `npm run road:data` |
| Zone | A named outline drawn on the map, reused on any day | `analysis_zones` | `apps/api/src/analysis/places-routes.ts` |
| Point of interest | A named place to reach, reused on any day | `points_of_interest` | `places-routes.ts` |
| Access analysis | One run over a zone to some points of interest, on one timetable at one departure time, with its settings, state and progress, and copies of its zone (outline and hash) and points of interest | `analyses`, `analysis_pois` | `apps/api/src/analysis/create.ts`, `runner.ts` |
| Sample point | One grid point of an analysis, with its column and row | `analysis_points` | `create.ts` |
| Analysis result | One sample point and point of interest: status, public transport time and split, stored legs, drive, car time, access ratio | `analysis_results` | `run-drives.ts`, `run-journeys.ts` |

The terms above follow `docs/glossary.md` (started 23 Nov 2026), which is the place to look for what each one means.

### 5.2 Times and identifiers

- Times are **seconds from the start of the service day** and can pass 24:00. This is used everywhere: database, packs, router and demand files.
- Database ids are integers per baseline. GTFS ids are kept as text. Scenario rows get new ids, and edits answer with an `idMap` so the browser can follow them.

### 5.3 How scenarios store changes (copy-on-write)

```mermaid
flowchart LR
  B[Baseline rows<br/>scenario_id null] -->|edit clones a trip| C[Scenario rows<br/>scenario_id = S<br/>created_edit = n]
  B -->|edit hides a baseline trip| R[scenario_removed<br/>trip_id, edit_seq = n]
  C -->|later edit removes it| X[removed_edit = m]
```

- A row is **visible** in scenario S at head h if it is a baseline row not hidden by an edit at or before h, or a row of S with `created_edit <= h` that has not been removed by h. This is `visible()` in `apps/api/src/scenarios/scenarios.ts`.
- **Undo and redo move `head`.** A new edit after an undo deletes every row with `created_edit > head`, so the redo history is gone.
- **An edit changes only rows it made itself**, apart from the tag that removes an earlier row (`removed_edit`, or a `scenario_removed` row). An edit that needs to change an earlier row copies it first. The change list (D11) depends on this; see I7.
- Each edit runs in one transaction with `FOR UPDATE` on the scenario. An edit naming a trip that has since been replaced gets **409**. An edit that would add ten or more vehicles is rolled back and answers `needsConfirm`, and the browser resends it with `confirm: true`.
- **The stored rows are the source of truth.** `scenario_edits` keeps only each edit's kind and summary, so edits cannot be replayed. Rebasing a scenario onto a new feed is future work that will need its own design (decision D3).

### 5.4 Data flow and lifecycle

```mermaid
flowchart LR
  F[TfNSW zip] -->|feed:fetch| D[data/feeds]
  D -->|stage: COPY all-text| S[staging.*]
  S -->|import: one service date| BL[Baseline tables]
  BL -->|vehicle days, packs| P[data/packs]
  BL -->|edits| SC[Scenario rows]
  BL & SC -->|export.ts| Z[GTFS zip + editor_*.txt]
  Z -->|router pulls by URL| RT[Router timetable + snapshot]
  DM[Demand CSV] --> RT
  RT -->|sim job| RF[Result files .csv.gz]
  RF -->|sim.ts COPY| SR[sim_* partitions]
```

- **Feeds** stay in `data/feeds/` until deleted by hand.
- **Baselines** live until the same date is imported again. That **deletes the baseline and, by cascade, every scenario on it**, so the importer refuses a day with scenarios unless given `--replace` (I1, resolved).
- **Sim results** are kept per run. Archiving a run drops its journey and leg partitions.
- **The router's own zips and snapshots** are pruned when a newer version replaces them. Snapshots of zips loaded by path are never removed.
- **The whole `data/` folder** is gitignored and about 4 GB.

## 6. Interfaces

| Interface | Where defined | Notes |
|---|---|---|
| Editor HTTP API, `/api/*` | `apps/api/src/*.ts` (`register*Routes`) | About 90 routes. Almost every read takes `?s=<scenarioId>`. All changes go through `POST /api/scenarios/:id/edits`. The full list is in `docs/codebase-map.md`. |
| Map tiles | `GET /api/baselines/:b/tiles/:z/:x/:y` | Mapbox vector tiles from `map_lines` and `stops`, for the **baseline only**. What a scenario adds is drawn from GeoJSON routes. |
| Packs and waits | `GET /api/baselines/:b/packs/:mode`, `/waits` | Binary. Format in `packages/core/src/pack.ts`. |
| GTFS export | `GET /api/baselines/:b/export?s=&shapes=0&box=` | Standard GTFS plus `editor_vehicle_types.txt` and `editor_trip_vehicles.txt` |
| Router HTTP API, `/v1/*` | `services/router/router-server/.../RouterServer.java`; road endpoints in `RoadApi.java` | Timetables, journeys (single and bulk NDJSON), load states, demand check and generation, simulations, and `POST /v1/road/route` and `/v1/road/table`. Health says whether road routing is on. See `services/router/README.md`. |
| OSRM-shaped road requests | `services/router/router-server/.../OsrmApi.java`, at the router's root | `GET /route/v1/driving/…`, `/table/v1/driving/…`, `/nearest/v1/driving/…`, exactly as `apps/api/src/routing/roads.ts` sends them to `ROUTER_URL` (D16). Checked by `npm run test:roads`. |
| Access analysis API | `apps/api/src/analysis/` | `/api/analysis/zones`, `/api/analysis/pois`, `/api/analyses` (list, make, read, cancel, delete), and per analysis `points`, `lines`, `points/:seq`, `export/results.csv`, `export/points.geojson`, `export/lines.geojson`, plus `/api/analyses/compare`. Types shared with the web app in `packages/core/src/api/analysis.ts`. Listed in `docs/architecture/access-analysis.md` §4.4, §5.1, §5.3. |
| Demand file | `services/router/README.md`, simulator-plan §3.1 | CSV, gzip allowed |

## 7. Technology

- **Node ≥ 24.** TypeScript 7 is run directly with Node's type stripping. There is no build for the API or the CLIs, so imports use `.ts` extensions and only erasable syntax.
- **Web:** React 19, Vite 8, MapLibre GL, deck.gl 9, zustand, and hand-drawn canvas timelines.
- **API:** Fastify 5, postgres.js (no ORM; SQL in template strings), yazl, @fastify/compress.
- **Import:** postgres `COPY`, yauzl. DuckDB is used only for the audit and export-check.
- **Database:** PostgreSQL 17 with PostGIS 3.5, in Docker.
- **Router:** Java 25, Gradle 9 (Kotlin DSL), Javalin 7, Jackson, JUnit 6, compiled with `-Werror`.
- **Tooling:** npm workspaces, vitest, oxlint, Prettier. There is no CI.

## 8. Cross-cutting concerns

- **Security and privacy:**
  - There is no authentication and no CORS setting.
  - The API listens on `0.0.0.0`, and demand uploads have no size limit.
  - No routing request leaves the machine once `ROUTER_URL` names the journey router (D16; `.env.example` does). Before that, stop coordinates went to the public OSRM server. Basemap tile addresses still go to OpenFreeMap (I9).
  - This is acceptable for one person on one machine, and not for hosting (risk R1).
- **Errors:**
  - Each module throws `Error` with a `statusCode` through a local `fail()` helper. Fastify turns it into JSON, and there is no global handler.
  - 400 means bad input and 404 means not found.
  - 409 means a stale edit, a trip that would run backwards, or a sim run in the wrong state.
  - 503 means the router is down.
  - The router answers `{"error": …}`.
- **Logging:** Fastify's logger at `warn`, and a few `log.error` calls. The router uses slf4j-simple.
- **Configuration:** environment variables only, from `.env` at the repo root, plus the router's own `ROUTER_*` settings. `ROUTER_URL` is the road router and `ROUTER_SERVICE_URL` the journey router; both are usually the Java router on 3002, kept apart in the code so the road side can run on its own (3003). The list is in `docs/codebase-map.md`.
- **Validity (clash) rules:** SQL on the server only (`scenarios.ts` `conflictsIn`), using the limits in `packages/core/src/limits.ts`. Each list is capped (200, 60 and 2000). Guards against impossible edits live in each edit module.
- **Long-running work:**
  - Sim runs are in-process promises in the API (`drive()`), resumed when it starts. The router runs one simulation at a time in a queue.
  - Access analyses run the same way, one at a time (`apps/api/src/analysis/runner.ts`, D20), writing their results batch by batch, so one cut off by a restart carries on from the last batch.
  - Export streams through temporary staging tables.
  - The dev API restarts on any source change, which cuts off an export in progress.

## 9. Deployment and environments

- **Development only.** `docker compose up -d db` starts Postgres on port 5433. `npm run dev` starts the API (`node --watch`) and the web app (Vite). `npm run router:dev` starts the router with Gradle.
- `docker-compose.yml` also has a `router` service behind the `router` profile. Its image has not been rebuilt since the endpoints were added.
- There are no other environments and no CI. AWS and logins are planned (PLAN.md, remaining work item 6). The routing server is our own journey router (D16), so it needs no separate hosting.

## 10. Decision log

| # | Date | Decision | Options considered | Reason |
|---|---|---|---|---|
| D1 | before Nov 2026 (PLAN.md) | Scenarios are copy-on-write rows with a `head` pointer | An edit log replayed on read; copied rows | Fast reads on large tables; undo is a pointer move |
| D2 | before Nov 2026 (PLAN.md) | Clash rules run on the server only | Shared with the browser in `packages/core`; server only | One source of truth; the rules need the database. PLAN.md:46 records the change. |
| D3 | 22 Nov 2026 | The copied rows are the source of truth. Edits are not stored in a form that can be replayed, and rebasing onto a new feed is future work. | Store each edit's parameters now; accept as built | Owner accepted as built |
| D4 | Nov 2026 (router-plan) | The journey router is a separate Java service that reads the editor's GTFS export | In Node; a separate service | Speed targets; a clean boundary (the router never reads the database) |
| D5 | before Nov 2026 | Road paths come from an outside OSRM server. **Superseded by D16** (25 Nov 2026), built 26 Nov 2026. | Valhalla with OSM in the database (the original plan); OSRM API | Nothing to host yet. A routing server of our own is still planned. |
| D6 | 22 Nov 2026 | The vehicle catalogue ships with placeholders, and real NSW vehicle types remain the aim | Placeholders as the design; placeholders for now | Owner: the placeholders are as built and the aim stands |
| D7 | 22 Nov 2026 | Lint with oxlint, not ESLint | ESLint with typescript-eslint; oxlint; Biome | typescript-eslint does not support TypeScript 7 |
| D8 | 23 Nov 2026 | Organise code by feature folders: one folder per part of the product, plus `shared/`, with the conventions in `CLAUDE.md` and `docs/codebase-map.md` | By kind (`components/`, `hooks/`, `routes/`…); by feature | What changes together lives together, and it matches how `sim/`, `timeline/` and `inspector/` already work. By kind spreads one feature over five folders. Moved to in stages (`docs/refactor-plan.md` stage 2). |
| D9 | 23 Nov 2026 | Web and API share request and response types written once in `packages/core/src/api/` (A), with a schema library (B) for request bodies later | A: shared types; B: a schema library (such as Zod); C: a client generated from the API | A needs no new library and no build step. B, checking request bodies when the app runs, can be added route by route before hosting. |
| D10 | 23 Nov 2026 | Refactor stages 3 (split `scenarios.ts`) and 6 (numbered migrations) are done before the work in BRD `trustworthy-edits` | Split first; fixes first then split; build into today's files | That work lands almost entirely in `scenarios.ts`, and it needs schema changes. Details: `docs/architecture/trustworthy-edits.md` §1. |
| D11 | 23 Nov 2026 | An edit's change list is worked out on read from the rows the edit tagged (`created_edit`, `removed_edit`, `scenario_removed.edit_seq`, `cloned_from`). Only the reasons for estimates are stored (`scenario_edit_notes`). | Worked out on read; a full record at apply time; each edit kind writing its own | Covers every edit kind at once, adds almost no time to edits and stores no copy of the timetable. It depends on the rule in 5.3 that an edit changes only rows it made. |
| D12 | 23 Nov 2026 | `import --replace` runs as one database transaction; packs are written after the commit | One transaction; build beside the old day and swap | The smallest change, and Postgres keeps showing the old day to readers until the commit |
| D13 | 23 Nov 2026 | Coding standards gaps become tickets; all new code meets the standards in section 14 now | Tickets with strict new code; record only; fix all first | Fixes land without a week's delay, and the gaps stop growing |

Decisions D14 to D34 come from BRD `access-analysis` 1.0 and were taken by the architect on 25 Nov 2026 under the owner's delegation (the owner may reopen any). The full reasons are in `docs/architecture/access-analysis.md` §1. All are built (26 Nov 2026, branch `feature/access-analysis`), and D5 is superseded by D16.

| # | Date | Decision | Options considered | Reason |
|---|---|---|---|---|
| D14 | 25 Nov 2026 | Road routing is GraphHopper 11.1 embedded in `router-road` behind a `RoadRouter` interface: car profile, speed-up index on, no turn costs | GraphHopper embedded; OSRM in Docker; Valhalla in Docker | One Java service; licence and features checked in router-plan §14; the interface allows another engine later |
| D15 | 25 Nov 2026 | `ROUTER_ROAD` = `auto` (default), `on`, `off`, `only`; road-only is the same jar on port 3003 (`npm run router:road`, 512 MB); the graph is memory-mapped; the main router's heap goes to 1 GB | Always on; a setting; a separate service only | A5 and NFR-2 with no code change between the two ways of running |
| D16 | 25 Nov 2026 | The router answers `POST /v1/road/route`, `POST /v1/road/table`, and OSRM-shaped `route`, `table` and `nearest` at its root, so `ROUTER_URL=http://localhost:3002` needs no change to `roads.ts`; the code default for `ROUTER_URL` stays "unset means none" | Root OSRM paths; a prefix; a new client in `roads.ts` | FR-13 "no other change"; tests that unset `ROUTER_URL` stay unaffected. Supersedes D5 when built. |
| D17 | 25 Nov 2026 | Many drives at once are repeated speed-up-index routes over the thread pool; `/v1/road/table` replaces the planned `/v1/road/bulk` | Repeated routes; a one-to-many search on GraphHopper internals | No open-source matrix (router-plan §14); fast enough for NFR-1 |
| D18 | 25 Nov 2026 | Road data: Geofabrik Australia, cut to the Opal area box with osmium in a Docker image built from Debian's package, built by `npm run road:data` into `data/router/road/opal`; tests use a hand-made `.osm` file | Whole Australia; osmium cut; third-party osmium image | A quarter of the import memory; no stranger's image; tests need no `data/` |
| D19 | 25 Nov 2026 | A point more than 500 m from a road is "no road" | No limit; fixed; a setting (chosen, default 500) | BRD edge case |
| D20 | 25 Nov 2026 | An access analysis runs in the API process like sim runs: one at a time, resumed at start, results written per batch | In the API; on the router | Only the API sees both routers and the database; batches survive the dev API's restarts |
| D21 | 25 Nov 2026 | Public transport times come from `/v1/journeys/bulk` (capacity off, summary) in batches of 500, on a timetable loaded as sim runs load one, cut to a box round the zone and points of interest widened by 15 km; the router client and timetable loading move out of `sim.ts` first | Single requests; bulk; a simulation run | Speed and progress (NFR-1); reuse of tested code |
| D22 | 25 Nov 2026 | Car times: one `/v1/road/table` per point of interest per 1,000 sample points | One big table; single routes | Progress and cancel within seconds |
| D23 | 25 Nov 2026 | Public transport time is arrival minus the asked departure; the first wait counts as waiting | The journey's own duration | FR-11 "leaving at the departure time" |
| D24 | 25 Nov 2026 | Six new tables in `0010_access_analysis.sql`; 0002 to 0009 are left to `trustworthy-edits` | Next free number | Two branches add migrations at once; the runner allows gaps and refuses duplicates |
| D25 | 25 Nov 2026 | Zones and points of interest are global; an analysis copies them when made | Per baseline; global | Places do not change with the timetable; finished analyses never change |
| D26 | 25 Nov 2026 | Sample points are cell centres of a square grid in local metres from the zone's south-west corner, with the flat-earth factors of `roads.ts`; each keeps its column and row | Hexagons; round-coordinate grid | Deterministic; simple lines and comparison |
| D27 | 25 Nov 2026 | Lines and bands of equal ratio by our own marching triangles in `packages/core`, leaving out squares with a missing corner | d3-contour 4.0.2; marching squares | d3-contour cannot leave out missing values (FR-12); no library needed |
| D28 | 25 Nov 2026 | Lines are worked out by the API on request | In the browser | One place for the map and the export |
| D29 | 25 Nov 2026 | Web: an "Access" left pane in `apps/web/src/analysis/`, one app-store field, layers in `map/use-analysis-layers.ts` and `use-analysis-result-layers.ts` | A modal; a pane | Like the Simulation pane; `store.ts` and `MapView.tsx` barely grow |
| D30 | 25 Nov 2026 | Each pair's journey legs (summary) are stored at run time; the car path is asked for on click. Rides drawn as straight lines: superseded by D39 | Ask again on click; store | Reopening and sameness (FR-16, NFR-4) |
| D31 | 25 Nov 2026 | Two analyses compare when their copied zone outline and spacing are the same and both have the point of interest | Same zone id | Points must line up |
| D32 | 25 Nov 2026 | The fixture e2e runs analyses against a fake router written in Node | Skip without routers | Real coverage of the job with no Java |
| D33 | 25 Nov 2026 | Developers may run Gradle on the access analysis router tickets, one Gradle build at a time | Owner-run only | The owner asked for the epic to be built overnight |
| D34 | 25 Nov 2026 | Starting values: walk 800 m, longest journey 120 min, 3 changes, all modes but school buses, parking 5 min, traffic 1.0/1.4/1.2/1.4/1.0, spacing 250 m, lines at 1, 1.5, 2, 3, 4, departure 08:00 | | BRD Q1, Q2 and the router's settled walking rules |

Decisions D35 to D37 answer the owner's request of 26 Nov 2026 to make the Access pane feel like a map editor and to choose the map's look. The owner chose satellite from Esri World Imagery and full editing; the rest was decided by the developer under the owner's delegation (`docs/architecture/access-analysis.md` §12, "Map editor").

| # | Date | Decision | Options considered | Reason |
|---|---|---|---|---|
| D35 | 26 Nov 2026 | The basemap is chosen apart from the theme, for the whole app: Light (OpenFreeMap positron), Streets (liberty), Dark (dark) and Satellite (Esri World Imagery, no key, with Esri's Boundaries and Places labels over it and Esri's credit). It follows the theme until one is picked, and the pick is kept in the browser (`localStorage`, key `basemap`). The map is rebuilt on a change, as for the theme; the map's colours come from the basemap's tone (light set over Light and Streets, dark set over Dark and Satellite). Code: `apps/web/src/map/basemaps.ts`, `basemap-choice.ts`, `BasemapPicker.tsx` | Tied to the theme; a picker; Mapbox or MapTiler satellite (needs a key) | The owner could not see buildings (liberty draws them, with house numbers); Esri's imagery needs no key. Esri's terms want the credit shown, which the attribution does; heavy use would need an ArcGIS account |
| D36 | 26 Nov 2026 | The Access pane's zone and points of interest are made on the map: a tool bar floating beside the side panel (Draw zone, Place point of interest; Z, P, Escape, Backspace, Enter), and a name box on the map over what is to be named. The name box is a plain positioned div placed with `map.project` and moved as the map moves, not a MapLibre popup, so that it is ordinary React. The side panel keeps the lists (pick, tick, rename, delete) and a hint | Keep the side-panel forms; a MapLibre popup with a React portal; a positioned div | The owner found naming first and clicking after awkward; a div needs no portal and follows the app's styles |
| D37 | 26 Nov 2026 | A saved zone is reshaped in place: the picked zone shows corner handles (drag to move) and handles mid-side (drag to add a corner); the new outline is sent as `ring` in the zone's PATCH, checked by the same rules as a new zone, and a name alone still renames. Analyses keep their own copy (D25), so reshaping changes none. A pin is dragged to move it (the PATCH with `lon` and `lat` that already existed) | A new outline as a new zone; PATCH with `ring` | Full editing was asked for; no migration or change to how analyses store zones is needed |

Decision D38 answers FR-21 of BRD `access-analysis` 1.1 (arrive-by) on the journey router's side; the design was set by the coordinator and built by the developer (`docs/router-plan.md` §22). D39 is kept for the ride-paths work.

| # | Date | Decision | Options considered | Reason |
|---|---|---|---|---|
| D38 | 26 Nov 2026 | Arrive-by is a backward RAPTOR search in `router-core` (`BackwardSearch.java`) that finds the latest departure under the forward search's own rules (time to change, longest walk, most rides, kinds of vehicle, staying aboard a vehicle that runs on; loads not looked at), then the ordinary forward search from that departure, keeping its journeys that arrive in time. Requests give `arriveBy` in place of `depart` (exactly one), on `POST /v1/journeys` and per query in `/v1/journeys/bulk`; capacity must be off. Answers add `arriveBy` and `earlyWait` (arriveBy less the arrival) to each journey. In bulk, arrive-by queries that share their end, time and limits share one backward search | A binary search over forward searches; backward search with legs rebuilt from its own labels; backward search then a forward search from its answer | The backward search is the efficient many-to-one direction (one per point of interest); planning the journey forwards gives legs of exactly the forward shape with no second path-building code, and the forward search arriving in time checks the two searches against each other. Forward bulk does not share searches between queries, so sharing is new |
| D39 | 26 Nov 2026 | A picked sample point's rides follow their vehicles' paths. A run keeps each ride's trip id and its two stops' ids in the stored legs JSON (no migration); the point's detail looks up the trip in the analysis's day (its scenario's trips included) and cuts the trip's shape between the two stops (`packages/core` `ride-path.ts`: the feed's distances, else snapping every stop in order so loops are cut on the right pass). No shape, or one far from the stops: stop to stop. Rides stored before ids were kept find a trip of their line at the stored places and times; failing that, the straight line, marked "path not known". Walks stay straight. Supersedes D30's straight rides | Store the paths at run time; ask the router for the stops passed (`detail: legs`); look up on click | The owner saw straight lines where the bus goes. Paths are only needed for one point at a time, so storing about 2 KB more per pair is not worth it; trip rows are never changed once made (an edit adds new rows), so a lookup later gives the same path. The router's `position` is the place in the box-cut export, not `stop_sequence`, so it is not kept; times tell a loop's two calls apart |

## 11. Issues and discrepancies

### Open

| # | Found | Where | Who acts |
|---|---|---|---|
| I6 | Coding standards gaps (section 14): no check for unused variables or parameters; 20 uses of `any` and 32 `as never` casts; 28 files over 300 lines and no file length check. Decided by D13. | `tsconfig.base.json`, `.oxlintrc.json`, `apps/*/src`, `packages/*/src` | Project manager (tickets) |
| I7 | The copy-on-write rule "an edit changes only rows it made, apart from the tag that removes an earlier row" holds in the code sampled but is not enforced or written down in the code. D11 depends on it. | `apps/api/src/scenarios/` | Developer (a check for every edit kind, BRD `trustworthy-edits` step 3) |
| I8 | Java files over 300 lines (`RouterServer.java` 738 since the road endpoints were registered, `Simulations.java` 677, `JourneyApi.java` 659, `Timetables.java` 374). The new road files are all under 300. Section 14's short-file rule is written for TypeScript, and T-19's check covers only `apps/` and `packages/`. Should the rule and its check cover `services/router`? (access-analysis AAI-2) | `services/router/router-server/` | Owner |
| I9 | NFR-5 of `access-analysis` ("no coordinates sent outside the machine") is read as routing requests only; basemap tiles still come from OpenFreeMap, and their addresses say which part of the map is viewed (access-analysis AAI-5) | `apps/web/src/app/theme.ts` | Owner, then BA |

### Resolved: fixed in the code

| # | Found | Fixed | The fix |
|---|---|---|---|
| I2 | The file header said "nothing is written", but `buildLinkLoads` deletes from and inserts into `sim_link_loads`. | 23 Nov 2026 | The header of `apps/api/src/sim/results-read.ts` now says the file reads results and also writes the link loads. |
| I3 | Undo and redo did not check `editBusy`, so Ctrl+Z during an edit in flight was not refused. | 23 Nov 2026 | `step` in `apps/web/src/scenarios/scenario-client.ts` returns at once while `editBusy` is set, as `applyEdit` does, so the button and the keys send nothing until the edit lands. |
| I4 | Two strings said vehicle types are picked "while editing a scenario". | 23 Nov 2026 | `TripEditTools.tsx` and `FleetPanel.tsx` now say the pickers are there whenever a day is open, and the first change starts a scenario. |
| I1 | Re-importing a service date deleted that baseline and all its scenarios by cascade, with no warning. | 23 Nov 2026 | The importer refuses a day that has scenarios unless given `--replace`, and says how many it would delete. `npm run db:backup` and `db:restore` back up and restore the whole database. The cascade itself stays. |
| I5 | The importer wrote packs to `data/packs` relative to the working directory and ignored `PACKS_DIR`, which the API reads. | 23 Nov 2026 | `packsDir` in `packages/gtfs/src/import/packs.ts` now uses `PACKS_DIR`, otherwise the repo's `data/packs` found from the file's own location, as `server.ts` does. |

### Resolved: the docs are stale and the code is right (owner, 22 Nov 2026)

Each line below should be corrected in its document when that document is next edited.

| Doc line | Says | The code |
|---|---|---|
| PLAN.md:87, 95, 98 | Validity rules are shared with the browser and run in both places | Server only (`scenarios.ts` `conflictsIn`) |
| PLAN.md:96, 98 | `packages/gtfs` does import and export; the server does import | Export is `apps/api/src/export/routes.ts`; import is a CLI |
| PLAN.md:98 | The browser loads only what is on screen | Every mode's whole-day pack is loaded at start (`apps/web/src/app/App.tsx` (pack loading)) |
| PLAN.md:110, 139 | Import builds the network graph and run times per link | `tracks.ts` builds the graph in memory when first needed; `timings.ts` works out run times at edit time |
| PLAN.md:121-122 | OSM in the database; Valhalla | An outside OSRM server (`roads.ts`) |
| PLAN.md:135 | The edit log allows rebasing | Kind and summary only (D3) |
| PLAN.md:137 | Vehicle days include empty repositioning runs | Only `gap_count`; no deadhead rows |
| PLAN.md:147 | The catalogue ships with NSW defaults | Seven `DEFAULT-*` placeholders plus train types made at import (D6) |
| PLAN.md:30 | Five modules; "Phases 0 and 1 are built"; "the editor does not call it yet" | Six modules; phases 0 to 4 are built; `apps/api/src/sim/sim.ts` calls the router |
| PLAN.md:9; `router-bench/build.gradle.kts:1-2` | The demand generator is next (phase 5) | Built: `router-sim/.../DemandGenerator.java` |
| PLAN.md:46 | Dragging exists only on the trip diagram | All three charts drag (`PlatformView.tsx`, `VehicleView.tsx`) |
| PLAN.md:334, 348 | "Draw a new line" is in the left panel; the "Close a road or a line" button is on the map | Rail buttons "Draw a line" and "Close a road" (`LeftRail.tsx`) |
| `services/router/README.md:10` | "The editor does not call the service yet" | It does (simulator). Corrected 26 Nov 2026 (AA-25). |
| `services/router/README.md:364` | The "S1" label is missing | Typo. Corrected 26 Nov 2026 (AA-25). |
| `docs/router-plan.md:3` | The website's use of the router is not built | True only for journey planning (phase 7) |
| `docs/router-plan.md:198-200` | Walking links: 400 m, 1.2 m/s, cap of 40 | 500 m, 1.03 m/s, cap of 150 (`TransferSettings.java:50`); §18 already says so |
| `docs/router-plan.md:380` | `route(query, CapacityMode, loads)` | `route(Query, Preferences, Capacity)` (`Router.java:139`) |
| `docs/simulator-plan.md:3, 442` | Only the first two steps of §18 are built | All five tabs and the map layers are built (lines 684, 773) |

## 12. Risks, open questions and future direction

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| R1 | No authentication, an open bind and no upload limit | Fine locally; unsafe once hosted | Must be designed before any deployment (logins). Coordinates no longer go to a public routing server once `ROUTER_URL` names our router (D16). |
| R2 | Re-import cascades and deletes scenarios (I1) | Loss of work | Mitigated: the importer refuses without `--replace`, and `npm run db:backup` takes a whole-database backup first |
| R3 | Edits cannot be replayed (D3) | A new feed means scenarios cannot be carried over | Design rebasing when it is needed |
| R4 | The biggest files carry many concerns: `scenarios.ts` (edit engine, eleven edit kinds and the clash rules), `MapView.tsx` (about 2,000 lines) and `styles.css` (about 3,000 lines) | Changes are slow to review and easy to break | See the suggestions given with this document |
| R5 | The browser downloads all packs (about 53 MB for a weekday) | Slow first load on a poor connection | Load only the modes shown, or load packs by area (PLAN.md lists shrinking the vehicle data) |
| R6 | Sim jobs are in-process promises in the dev API, which restarts on every save | Runs are cut off while code is being edited. They resume at start, but the work is redone. | Run the API without `--watch` for long runs, or move jobs into the router queue alone |
| R7 | Every vehicle capacity is a placeholder | Capacity results in the simulator are not real | Real vehicle types (D6) |
| R8 | There is no CI | Regressions are found late | A small GitHub Actions job running lint, format and unit tests |

Open questions: the 16 router-plan questions (each has a default), and the delete-stop rule awaiting your confirmation (PLAN.md).

## 13. Change log

| Date | Change | Why |
|---|---|---|
| 22 Nov 2026 | First version, written from the code as built | No architecture document existed; requested by the owner. No BRD. |
| 23 Nov 2026 | I2, I3 and I4 fixed and moved to the resolved table (ticket T-4) | Small known issues from section 11 |
| 23 Nov 2026 | Added D8 (feature folders) and D9 (shared web and API types) | Decisions taken in `docs/refactor-plan.md`; recorded here before files move (ticket T-5) |
| 23 Nov 2026 | I1 resolved; R2 mitigated | Refactor ticket T-2: import guard and backup scripts |
| 23 Nov 2026 | I5 resolved: the importer honours `PACKS_DIR`. The importer also takes a feed on disk (`FEED_PATH`), and `npm run test:e2e:fixture` runs the scenario e2e suite on a small test feed. | Ticket T-3: e2e tests without the real data or the dev servers. |
| 23 Nov 2026 | File paths updated for the feature-folder moves | Stage 2 of `docs/refactor-plan.md` (tickets T-6, T-7) |
| 23 Nov 2026 | Added D10 to D13, the copy-on-write rule in 5.3, issues I6 and I7, and section 14 (project structure and coding standards); pointed to the glossary and BRDs | Design of BRD `trustworthy-edits` v1.0 (`docs/architecture/trustworthy-edits.md`) |
| 25 Nov 2026 | Added D14 to D34, marked D5 superseded by D16, added issues I8 and I9. The context and component sections are updated when the work is built (AA-25), not before. | Design of BRD `access-analysis` v1.0 (`docs/architecture/access-analysis.md`) |
| 26 Nov 2026 | Access analysis built: §1, §3 (OSRM replaced by the journey router's road side; Geofabrik added), §4 (`router-road`, `apps/api/src/analysis/`, `apps/web/src/analysis/`), §5.1 (road graph and the five analysis entities), §6 (road and analysis interfaces), §8 (privacy, configuration, long-running work), §9, R1, I8 updated; two stale README lines corrected | Epic close-out, ticket AA-25 (access-analysis AAI-6) |
| 26 Nov 2026 | Added D35 (basemap picker), D36 (the Access pane's map editor) and D37 (reshaping a zone with PATCH `ring`) | The owner's request for a map editor and map views (branch `feature/aa-map-editor`) |
| 26 Nov 2026 | Added D38 (arrive-by in the journey router: a backward search, then the forward search from its answer) | BRD `access-analysis` v1.1 FR-21 (branch `feature/aa-arrive-by-router`) |
| 26 Nov 2026 | Added D39 (rides along their vehicles' paths), superseding D30's straight rides | Owner's report that public transport directions showed straight lines |

## 14. Project structure and coding standards

This section is placed last so that the section numbers other documents cite stay as they are.

**Folder layout and rules.** The layout is by feature (D8). The target tree, the folder rules, the naming rules and what may import what are in `docs/codebase-map.md` ("Conventions that decide where code goes" and "Planned layout"); that is the single copy, kept current with every move. In short:
- one folder per part of the product, plus `shared/` (web) for what everything uses;
- a folder over about 10 to 15 files gets subfolders by sub-feature;
- no catch-all `utils`, `helpers`, `misc` or `common` folders;
- tests beside the file (`name.test.ts`), end-to-end tests in each package's `test/`;
- scripts are npm scripts that point at `packages/gtfs/src/cli/` or a package's `test/`, not loose files at the root.

**Where new things go.**

| If you are adding… | Put it in… |
|---|---|
| Logic with no database or IO | `packages/core/src/<area>/`, with a `.test.ts` beside it |
| A type shared by the web app and the API | `packages/core/src/api/` (D9) |
| An edit kind | `apps/api/src/scenarios/edits/<kind>.ts` and one line in the registry (after stage 3) |
| A clash rule | `apps/api/src/scenarios/clashes.ts` |
| An API route | the `routes.ts` of its feature folder under `apps/api/src/` |
| A schema change | a new numbered file in `packages/gtfs/sql/migrations/` (`NNNN_<what>.sql`, the next free number); never edit a merged one |
| A panel or component | its feature folder in `apps/web/src/`, with its CSS beside it |
| A map layer | a hook `apps/web/src/map/use-<thing>-layers.ts` called from `MapView.tsx` |
| A CLI | `packages/gtfs/src/cli/`, with an npm script |

**The four standards.** Use whichever is stricter of these and the project's own rules.
1. **Folders by purpose**, as above. Checked by review against `docs/codebase-map.md`; there is no automatic check.
2. **Short files.** Aim for under about 200 lines; over 300 is too long and is split by responsibility. Exempt: migrations, generated files, lock files and large fixture data. Not enforced yet: there are 28 files over 300 lines (I6), shrinking under refactor stages 3 and 5.
3. **Strong typing, no `any`.** TypeScript `strict` is on (`tsconfig.base.json`), and `tsconfig.node.json` also rejects imports Node can't run. `any`, `as never` and unexplained casts are not allowed in new code, and request bodies get real types (D9). Not enforced yet: 20 uses of `any` and 32 `as never` (I6). Java compiles with `-Xlint:all -Werror`.
4. **No unused code.** No unused imports, variables, parameters, functions, files or dependencies, and no commented-out code. Not enforced yet: `noUnusedLocals` and `noUnusedParameters` are off, and oxlint runs only its correctness rules (I6).

**Commands that check them:** `npm run typecheck`, `npm run lint`, `npm run format:check`, and `/verify` before each commit. Per D13, the tickets for I6 add `noUnusedLocals`, `noUnusedParameters`, oxlint's `no-explicit-any` and a file length check to these.
