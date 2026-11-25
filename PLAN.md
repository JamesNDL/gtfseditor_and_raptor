# GTFS Editor plan

A visual, game-like editor for NSW public transport timetables (GTFS), built in React. It will later become a simulator of how people move through the network, so the editor must capture the data that simulator needs.

The build goes in seven phases, each ending in something usable: a read-only viewer first, then schedule editing, network editing, fleet, and export.

## Where we are (26 Nov 2026)

**Next step: to be agreed with the owner before building.** (Goals and a score were built on 14 Nov from an earlier version of this line and removed the next day: the owner had not asked for them. Do not add game features.)

Latest, 26 Nov 2026:

- **Refactor stage 3 and T-16 are done** (pull request #7): `scenarios.ts` is split into `apps/api/src/scenarios/` (the engine, the clash rules, one file per edit kind and a registry), and the database schema is numbered migrations in `packages/gtfs/sql/migrations/`, each run once (`docs/refactor-plan.md`, `docs/codebase-map.md`).
- **Access analysis is built** on the branch `feature/access-analysis` (BRD `docs/brd/access-analysis.md`, design `docs/architecture/access-analysis.md`, tickets AA-1 to AA-24 in `docs/project/access-analysis-tickets.xlsx`). The journey router now plans drives on OpenStreetMap roads of the Opal area (GraphHopper, `npm run road:data`) and answers the editor's road requests in OSRM's shape, so the public OSRM server is no longer needed. The **Access** pane draws a zone, places points of interest, and maps the access ratio (public transport time over car time) from an even grid of sample points, with a legend, a summary, one point's journey, a comparison of two analyses, and CSV and GeoJSON downloads. The owner's check on real data (AA-26: Mayfield to Newcastle city centre and Westfield Kotara, with screenshots) and merging the branch are what is left of it. Its known small gaps are AAI-10 to AAI-13 in the design's §9.
- **Map editor and basemaps** (asked for by the owner on 26 Nov; branch `feature/aa-map-editor` off `feature/access-analysis`, D35 to D37): a basemap button beside the zoom buttons (Light, Streets with buildings, Dark, Satellite from Esri), and on the Access pane a tool bar on the map (Draw zone, Place point of interest) with a name box that opens on the map; pins and a picked zone's corners are dragged to move and reshape them (a zone's PATCH now takes `ring`). What was built is in `docs/architecture/access-analysis.md` §12, "Map editor"; screenshots `docs/pr/access-analysis/09` to `14`.

Earlier: The last thing built is a closure for part of the day. Phases 1 to 4 of the journey router (the timetable loader, the search, the HTTP service, and capacity with bulk requests) are built; phase 5 (the benchmark harness and demand generator) is next in `docs/router-plan.md`. Dragging in the platform and vehicle charts is built, and the router's empty project (`services/router`, phase 0 of its plan) builds and starts. Run times by time of day, the schedule editing gaps (free platforms, re-planning a line's vehicles, a stop added to one trip, a trip added to a line, whole-line frequency across branches), station details on the right, a light version of the interface and the pinned tool buttons are now built; what they leave out is listed under phases 3 and 4.

Status by phase; details are under "Phases" below.

| Phase | Status |
|---|---|
| 0. Data audit | Done |
| 1. Import and viewer | Built |
| 2. Timeline views | Built |
| 3. Scenarios and schedule editing | Built; the remaining gap (vehicle planning across lines) is listed in the phase |
| 4. Network editing | Five tools: draw a new line (two-way or a one-way loop), change the route of an existing line, add a stop or station where there is none, close a road or a line, and delete a station, a stop or a platform. Bus lines follow roads; trains, trams and ferries follow the track and routes that published services use |
| 5. Fleet and capacity | First slice built |
| 6. Export and deployment | GTFS export built and verified against the feed; deployment not started |

Everything is committed to git on `master`. Tests: `npm test`, `npm run test:e2e`, `npm run test:ui`, `npm run export:check` (see "Testing status").

Remaining work, roughly in order:

1. Route editing: the gaps listed in phase 4 (reshaping, new stops, closures); a routing server that can be told a road is closed; re-planning vehicles across lines after a line is cut.
2. Schedule editing: vehicle planning across lines rather than one line at a time.
3. Usability: watching real people use it.
4. The journey router: a standalone Java RAPTOR service, capacity aware with a switch, with bulk and road-routing endpoints. Planned in `docs/router-plan.md`. Phases 0 to 4 are built, and phase 6 (road routing, for cars) was built for the access analysis on 25 Nov (section 21 of that file); the rest of this item is as it stood after phase 1: `services/router` is a Gradle project of five modules. It loads the exported weekday zip into memory in about 4 seconds (59,014 trips, 57 MB), saves a snapshot, and plans journeys from the command line (`npm run router:route`); the search agrees with a brute-force check. On test journeys inside the Opal area it meets its single-query speed targets (median 8 ms for any two stops, under 1 ms within 10 km) and meets the bulk target only for short journeys; journeys leave as late as they can, slow alternatives are dropped and one journey is recommended. Its server (port 3002, `npm run router:dev`) loads, reloads and unloads timetables, plans one journey per request (`POST /v1/journeys`) or many (`POST /v1/journeys/bulk`), and keeps named load states so that a request can ignore how full vehicles are, respect it, or respect it and add its passengers (`off`, `check`, `assign`); the editor does not call it yet. Every vehicle capacity is still a placeholder. There is no road routing, and its Docker image has not been rebuilt since the endpoints were added. The plan has 16 questions for the owner, each with a default.
5. Data: real vehicle capacities (all are placeholders), transfers between nearby stops, capacity on the map.
6. Export and deployment: MobilityData validator, export progress, AWS, logins, shrinking the vehicle data, updating to a new feed while keeping scenarios. (A self-hosted routing server was here; the journey router's road side is it, since the access analysis work.)
7. The passenger simulator: planned in `docs/simulator-plan.md` (18 Nov 2026), agreed with the owner section by section. It sends a file of journeys through the timetable using the journey router, is started from the editor by a wizard, and shows results in the editor. Its build order is section 10 of that file (S0 to S6). Phases S0 to S4 are built, so it can be used from the editor: demand files, the simulator itself (`services/router/router-sim`), runs as jobs on the router service, the editor's back end (`apps/api/src/sim.ts`) and the panels (`apps/web/src/sim`): a Simulation panel with a wizard and a library, passenger figures on the line, trip and station panels, and one person's journeys by `user_id`. What was measured and done differently is in sections 14 to 17 of that file. S5 and S6 are replaced by the results view of its section 18, asked for by the owner on 19 Nov: a results window beside the map that sets one run against another (`apps/web/src/sim/SimResults.tsx`, `apps/api/src/sim-results.ts`). All five tabs are built (Overview, Travel time, Lines, and on 20 Nov Travel patterns and People), and on the map passenger flow, who is affected, "through here" and vehicles coloured by how full; trips in the three timelines can be coloured the same way. Left for later: flows that follow the road and the track, and a separate browser window. The owner's decisions and answers are in its section 12, and no question is open.
8. Later, as planned: the interchange file, track-level conflicts.

Asked for by the owner on 19 Nov 2026, not yet built or planned in detail:

- **Delete a station, a parent stop or single platforms (built 20 Nov 2026; needs hands-on testing).** "Delete this station" or "Delete this stop" on the station panel, and "Delete" beside each platform. The owner had not said what should happen to the trips, so the cautious rule was built, and the panel states it before anything changes: one platform of a station that has others moves its calls to another platform there; a stop, a whole station or a last platform means trips no longer call there (timed like "skip a stop"), trips that started or ended there are cut short to the next or previous stop at the times they had, and a trip left with fewer than two stops is removed. Nothing is re-routed and no vehicle is added. It is one undoable change. **For the owner to confirm: this rule.** What is built and what it leaves out is under phase 4.
- **Delays in the simulator.** A way to simulate a train breaking down on a line, or a signalling fault, so that the delay also reaches people who have already boarded. The simulator's vehicles are always on time today (section 4.4 of `docs/simulator-plan.md`), and a closure only changes the timetable before anyone travels, so this needs a new kind of event that holds or slows vehicles from a given time and place, and passengers who plan again from where they are, aboard or waiting.
- **Vehicles that vanish at stations on the map (built 20 Nov 2026; needs hands-on testing).** The owner saw vehicles enter a station and disappear. The cause was as suspected: the map drew one dot per trip, and a trip is over the second it arrives, so a train that reached its terminus vanished and a new dot appeared when its next trip left. Stops inside a trip were never the problem; a vehicle is drawn standing through every dwell and at its first and last call. Now a vehicle that has finished a trip stays drawn where the trip ended until the next trip of its vehicle day starts. What is built and what it leaves out is under phase 1.

Things a new session needs to know:

- Start with `npm run db:up`, then `npm run dev`. On the development machine the dev servers have been stopped several times for lack of memory; starting them in a separate terminal avoids that.
- `.env` holds the TfNSW key and `ROUTER_URL`. `ROUTER_URL` should be `http://localhost:3002`, the journey router's road side (as `.env.example` says); until the owner changes it, `.env` names the public OSRM demo server and stop coordinates are sent to it. The road side needs the road graph, built once by `npm run road:data` (about 3 minutes, 2 GB; stop the dev servers first). `npm run test:roads` checks it.
- Access analysis (on `feature/access-analysis` until merged): the **Access** pane, `apps/web/src/analysis/`; the API in `apps/api/src/analysis/` (an analysis runs in the API process, one at a time, and carries on after a restart); the pure logic in `packages/core/src/analysis/`; six tables in migration `0010_access_analysis.sql`. It needs both the API and the router (`npm run router:dev`, now with a 1 GB heap). `npm run test:e2e:fixture` covers it with a fake router; `npm run test:access -- --fixture` drives it in a headless browser. Words: `docs/glossary.md`.
- The "Decisions made" and "Architecture" sections below were written before the build. Two have since changed: the validity rules run on the server only, not also in the browser, and timeline dragging exists only on the trip diagram.
- The interface has been driven by a scripted browser (`npm run test:ui`), not yet by a person other than the developer. The untested parts are listed under "Testing status".
- Lines drawn before the road-following and opposite-stop fixes keep their old paths and should be redrawn.
- Reshaping a line is one edit kind, `reshape`, in `apps/api/src/scenarios/edits/reshape.ts`; the parts that need no database (which stops are kept, trip times, the other direction) are in `packages/core/src/edits/reshape.ts` with unit tests.
- New stops are rows in `stops` owned by the scenario (`apps/api/src/scenarios/stops.ts`). They are not in the map tiles; the map draws them from `/api/scenarios/:id/stops`.
- Paths for trains, trams and ferries come from `apps/api/src/routing/tracks.ts`: a network of station-to-station links built from the published stop patterns, once per day and mode, kept in memory. There is no track or water map behind it.
- Deleting a station, a stop or a platform is one edit kind, `deleteStop`, in `apps/api/src/scenarios/edits/delete-stop.ts`; the per-trip rule and the platform choice are in `packages/core/src/edits/delete-stop.ts` with unit tests. Deleted stops are rows in `scenario_removed_stops`, and `stopVisible` in `apps/api/src/scenarios/stops-visible.ts` leaves them out, so anything that looks stops up through it cannot use one. In the feed every stop, bus stops included, sits under a "station" row.
- Closures are one edit kind, `close`, in `apps/api/src/scenarios/edits/closure.ts`. It finds every stop pattern whose path enters the closed area and changes each with the route-change code (`planReshape`, `applyReshape`). Stops are placed along a path by the feed's distances (`stopFractions`), and the cut is decided stretch by stretch. The closed areas are rows in `scenario_closures`, used to draw them and by the clash rule for paths made afterwards.
- The routing server cannot be told a road is closed (neither the public one nor ours yet). `routedAround` in `apps/api/src/routing/roads.ts` finds a way round by asking it for the road distances between a ring of points and searching those; every path is checked to stay out of the closure before it is used. Requests to the routing server take turns, two at a time.
- Run times for new stretches come from `apps/api/src/routing/timings.ts`, for five parts of the day (`DAY_BANDS` in `packages/core/src/time.ts`). A trip uses the times of the part of the day it sets out in.
- The schedule edits added last (`setPlatform`, `replan`, `moveToVehicle`, `addTrip`, `addCall`) each have their own file in `apps/api/src/scenarios/edits/`. New trips are moved off a busy platform automatically by `settlePlatforms` in `apps/api/src/scenarios/platforms.ts`.
- The light version is a second set of CSS variables under `:root[data-theme='light']`; the map and the timeline charts take their colours from `apps/web/src/theme.ts` and are rebuilt when the theme changes.
- Dragging in the three timeline charts is handled in one place, `apps/web/src/timeline/TimelineCanvas.tsx`. A chart that passes `onDragTrip` gets sideways drags (a retime); one that also passes `rowAt` and `onDropRow` gets drags onto another row. One drag does one or the other, never both: over another row it is a move, otherwise a retime.
- The router is run with `npm run router:build`, `router:test`, `router:load` (loads `data/exports/check/export.zip` and prints counts, time and memory) and `router:dev` (Windows form; they call `.\gradlew` in `services/router`). It is not part of `npm run dev`. In `docker-compose.yml` it sits behind a profile: `docker compose --profile router up -d router`. What was checked about GraphHopper, Javalin and Gradle before building is under "Phase 0 findings" in `docs/router-plan.md`; what the first real load and the first real searches measured is under "Phase 1 findings", "Phase 2 findings", "Quality and speed of results" and "Compared with the TfNSW trip planner" (300 journeys: 42% arrive within a minute of TfNSW's, ours sooner in 52%, TfNSW sooner in 6%); what the service measured over HTTP is under "Phase 3 findings", what capacity and bulk requests measured is under "Phase 4 findings", and its requests are described in `services/router/README.md`. Router test journeys stay inside the Opal area (Newcastle, Sydney, Wollongong).
- The dev API restarts whenever a source file changes, which cuts off an export in progress. Run `npm run export:check` only while no files are being edited.
- `npm run export:check` gives up if the download is silent for five minutes, and a full weekday export now takes about that long on the development machine. It timed out twice on 13 Nov; the export itself had not failed.

## Decisions made

| Topic | Decision |
|---|---|
| Scope | Full NSW network, all modes (train, metro, light rail, ferry, bus, coach) |
| Time scope | One day type at a time |
| Physical validity | Level 1: platform/wharf occupancy, vehicle continuity, turnarounds, valid terminating points. No signalling or headway modelling |
| Tracks | Lightweight network graph (stations and links), not real track geometry |
| Broken edits | Never blocked. Flagged in red with one-click fixes |
| Run times | Derived from the existing timetable; defaults per mode for new links; manual override |
| Ripple | Toggle: off, this vehicle's later trips, or following trips on the line |
| Fleet | Vehicle catalogue assigned to routes and vehicle days; optional fleet-size caps that warn |
| Users | The organisation. One editor per scenario; others view or branch a copy |
| Output | Valid GTFS, with non-GTFS data in separate files alongside |
| Hosting | Local Docker first, AWS eventually |
| Deferred | Interchange file, track-level conflicts (Level 2), feed rebasing. (The passenger simulator was deferred here; it is now planned and partly built, see "next" item 7.) |

## Architecture

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript, Vite | Required, plus type safety for a complex data model |
| Map | MapLibre GL + deck.gl | Handles the whole network and thousands of animated vehicles |
| Timelines | Custom Canvas rendering | SVG will not cope with a full day of trips |
| Backend | Node + TypeScript | Validity rules are shared with the browser as one package |
| Database | PostgreSQL + PostGIS | Spatial queries, and it serves map tiles directly |
| Hosting | Docker locally, then AWS (ECS, RDS, S3/CloudFront) | Same containers in both places |

Repository layout:

- `apps/web`: the React app.
- `apps/api`: the server.
- `packages/core`: the data model, the validity rules and the run-time model.
- `packages/gtfs`: import and export.

The server holds the data and does import and export. The browser loads only what is on screen or selected. The validity rules run in both places so feedback is instant.

## Data pipeline

The GTFS zip is only the transport format in and out. All work happens in the database.

1. **Download once.** The feed zip is saved to a local `data/feeds/` folder (S3 on AWS), named by its publish date. Before downloading, the importer asks TfNSW whether the feed has changed; if not, the saved copy is reused. The API key is read from `.env`, and both `.env` and `data/` are excluded from git.
2. **Import once.** Each feed version is loaded into the database a single time as an immutable baseline.
3. **Pre-process once, at import:**
   - convert times to seconds since the start of the service day (GTFS times run past 24:00);
   - split out day types;
   - derive patterns by grouping trips with the same stop sequence;
   - build the network graph and the run time per link;
   - build route and link geometries as spatial columns with indexes;
   - seed vehicle assignments from the feed where it encodes them.
4. **Scenarios copy nothing.** A new scenario is an empty list of edits layered over the baseline, so creating one is instant. Only changed rows are stored.

## Geospatial

PostGIS covers spatial questions over the feed itself: which routes pass through an area, which stops are within walking distance of a point, where routes overlap.

GTFS shapes are plain lines with no link to the road network, so anything that reasons about roads needs two more components, both added in Phase 4:

- **OpenStreetMap road network** for NSW, loaded into the database, with bus shapes matched onto road segments at import.
- **A routing engine (Valhalla)** that can route around excluded roads, for drawing bus routes and computing detours.

Road closures then work the same way as cutting a rail link:

1. Select a road segment, or draw a closure area, and optionally a time window.
2. The editor lists every route and trip that uses it.
3. For each affected pattern it proposes a detour between the last stop before and the first stop after the closure, with a new geometry and an adjusted run time.
4. Stops on the closed section are flagged as skipped, to be accepted, moved or replaced with a temporary stop.
5. Schedule changes ripple according to the ripple toggle, and conflicts are flagged as usual.

## Core concepts

- **Baseline:** an immutable import of a TfNSW feed, for one day type.
- **Scenario:** a baseline plus an ordered log of edits. The log gives undo/redo, comparison against the baseline, and later rebasing onto a new feed.
- **Pattern:** a line's stop sequence, derived by grouping trips. Edits like "skip this stop" apply to a pattern or to selected trips, so nobody edits hundreds of trips by hand.
- **Vehicle day:** one physical vehicle's trips for the day, in order. The feed does not provide this (see `docs/phase-0-findings.md`), so the importer builds it: from run numbers for suburban trains, and by chaining trips for other modes, marked "inferred" and editable. Includes empty repositioning runs.
- **Stay-aboard link:** passengers can remain on the vehicle between two trips, such as a T8 becoming a T1 at Central. This is what `block_id` means in the TfNSW feed; it is imported from and exported to that field, and keeps passenger metrics continuous.
- **Network graph:** stations and the links between them, with a run time per link and "can terminate here" flags per station. Seeded from existing stop sequences and from where trips terminate today.
- **Vehicle catalogue:** see below.
- **Rules engine:** each rule returns issues with suggested fixes.

## Vehicle catalogue

GTFS does not reliably say which vehicle runs a trip, and the simulator cannot work without capacity. The catalogue fills that gap.

- **Catalogue entries:** name, mode, number of cars, seated capacity, standing capacity, and (for the simulator) door count and dwell characteristics. Shipped with NSW defaults (Waratah, Tangara, Metro sets, light rail vehicles, ferry classes, standard and articulated buses) and fully editable.
- **Assignment levels:** a default vehicle type per mode, overridden per route, overridden per vehicle day, overridden per trip. Picking a type for a route is the common case.
- **Resolution rule:** every trip always resolves to exactly one vehicle type by walking trip, vehicle day, route, mode. Nothing is ever left without a capacity.
- **Seeding from the feed:** where the feed encodes it (Sydney Trains trip IDs appear to carry set type and car count; to be confirmed in Phase 0), assignments are pre-filled. Everything else starts on the mode default and is marked "assumed".
- **Fleet caps:** optional count per vehicle type. Exceeding it warns, never blocks.
- **Coverage indicator:** the scoreboard shows how many trips have a confirmed vehicle type versus an assumed one.

## Rules by mode

| Mode | Rules |
|---|---|
| Train, metro, light rail | Platform conflicts, vehicle continuity, minimum turnaround, valid terminating station |
| Ferry | Wharf conflicts against a berth count per wharf (default one, editable), vehicle continuity, minimum turnaround |
| Bus, coach | Vehicle continuity and layover only (several buses can share a stop) |

## Simulator readiness

The simulator is out of scope for now, but the editor must produce everything it will need. These are requirements on the data model from Phase 0:

- **Capacity on every trip**, via the vehicle catalogue resolution rule.
- **Vehicle continuity** through vehicle days and stay-aboard links, so passengers staying on a through-running vehicle are not counted as alighting.
- **Transfers and walking links** between stops and platforms. In-station pathways are imported from the feed; the feed has no transfers file, so transfers between nearby stops are generated from distance. Both are editable.
- **Dwell times** stored explicitly per stop, not just implied by arrival and departure.
- **Stable identifiers** for stops, links, trips and vehicle days across edits, so simulator results can be compared between scenarios.
- **Non-GTFS data exported** in separate files next to the GTFS (vehicle catalogue, assignments, network graph), so the simulator can read one complete package.

## Phases

### 0. Data audit and foundations (done)

Findings are in `docs/phase-0-findings.md`. Run `npm run feed:fetch` to download or reuse the feed and `npm run feed:audit` to repeat the audit.

- Set up the repository, the database and the feed download with its local cache.
- Check what the design depends on:
  - `block_id` coverage per mode;
  - whether train trip IDs encode set type and car count;
  - platform coverage;
  - transfer data coverage;
  - row counts for one day.
- Result: a short findings note, and any design adjustments before real code.

### 1. Import and viewer (built; needs hands-on testing)

Built:

- Import pipeline: raw feed staged once, then one baseline per service day (about two minutes each), including vehicle days, stay-aboard links, a mode table, placeholder vehicle capacities, and overlaps already in the feed.
- Full-screen map with every mode, mode toggles, a day picker, line search, and a time scrubber with all vehicles moving.
- Inspector: click a line for trips, vehicles, departures per hour, vehicle types and stopping patterns; drill into a trip's stops or a vehicle's whole day. Links are shareable.
- Vehicles stay on the map between trips. A vehicle that has finished a trip is drawn where the trip ended until the next trip of its vehicle day starts, when that trip starts at the same stop, at the same station, or within 500 m, and within an hour (`vehicleWaits` in `packages/core/src/waits.ts`, with unit tests). On the Tuesday that is 40,468 of 59,014 trips, and at 8 am about 630 more dots than before. Pointing at a waiting vehicle says it has finished its trip and when it leaves again; clicking it opens the trip it has just finished, and the ring stays on it. The count on the time bar is now "vehicles out", every vehicle drawn, with the number of them that are waiting underneath. The waits are served by `/api/baselines/:id/waits` (with `?s=` for a scenario, whose deleted, moved and added trips change them) and are fetched apart from the animation files, whose format is unchanged. A frame costs the same as before: a waiting vehicle's place is worked out once, not every frame.

Still to confirm or do:

- Limits of vehicles waiting between trips:
  - Only suburban trains have real vehicle days (run numbers). For buses, ferries, light rail, metro and coaches the days are inferred, so which vehicle is shown waiting for which trip is a best guess, as it is on the vehicle chart.
  - A vehicle that waits more than an hour is not drawn or counted until it leaves again (161 train, 84 ferry, 43 metro and 23 light rail waits on the Tuesday). Nor is one whose next trip starts somewhere else, or the last trip of a vehicle's day: these still disappear when they arrive, because nothing says where they go.
  - Where the next trip starts at a different platform or a stand up to 500 m away, the dot stands where the last trip ended and then jumps to where the next one starts. About one bus wait in nine is more than 150 m apart.
  - The backdrop of the time bar still counts trips running, not vehicles out.
  - After an edit the scenario's waits arrive a moment after the rest (about a second on the development machine under load); until then the map uses the ones it had.

- Smoothness in a real browser. Positioning about 6,400 simultaneous vehicles takes about 1.3 ms per frame in a benchmark, but frame rate with the map has only been seen in headless screenshots.
- Clicking, hovering, searching and scrubbing have not been exercised by hand.
- Vehicle data for a weekday is about 53 MB before compression (buses are most of it). Fine locally; worth shrinking before AWS.
- Vehicle capacities are round-number placeholders, flagged as such in the interface.

### 2. Timeline views (built; needs hands-on testing)

Built, in a panel that opens above the time bar ("Timelines" button, or from a line, station or stop):

- Stringline per corridor: pick a line and one of its stopping patterns as the station axis; other lines sharing three or more of those stations are drawn fainter and can be switched off.
- Platform occupancy per station: a bar per call, a thin tick for trains passing through, a neutral band where a vehicle waits between trips, and a red box around overlaps already in the feed.
- Vehicle chart per line: every vehicle that runs a trip on it, with stay-aboard links and empty runs marked.
- Linked selection: clicking a trip in any view opens it in the inspector, rings its vehicle on the map and outlines it in the other views. All views share one zoomable time window and the clock's "now" line.

Still to confirm or do:

- Zooming, panning, hovering and clicking in the timelines have not been exercised by hand. The drawings were checked by exporting each canvas; the headless screenshot tool does not capture them in place.
- The platform chart counts a waiting vehicle as occupying its platform, but conflict detection still only compares calls. Phase 3's rules should use occupancy.
- Interchanges list bus stands and coach bays alongside rail platforms.

### 3. Scenarios and schedule editing (first slice built; needs hands-on testing)

Built:

- Scenarios: created instantly, nothing copied. An edited trip is a new row owned by the scenario and the original is marked as replaced; each row records the edit that made or removed it, so undo and redo only move a pointer.
- Edits: retime a trip (buttons, or drag it on the stringline), delete, add a copy, skip a stop on one trip or on every trip with the same stopping pattern, and set an even frequency for a stopping pattern over a time band.
- Ripple: a retimed trip can move alone, with its vehicle's later trips, or with every later trip on the line.
- Run times: skipping a stop uses the median time of baseline trips that already run between the neighbouring stops without stopping; where there are fewer than three such trips it falls back to the dwell plus a per-mode allowance, and the change is labelled "estimated".
- Hand-placed trips are pinned: a frequency change leaves them where they are and spaces new trips around them.
- Conflicts caused by the scenario: two trips on a platform or wharf at once, and a vehicle whose next trip leaves before it arrives. Each has a one-click fix. Since 20 Nov also: a stretch run faster than the mode can go or backwards in time, a vehicle that cannot reach its next trip, and a new path through a closure (see "What a scenario cannot do").
- Every view (map, inspector, all three timelines) shows the scenario; the scenario panel shows trips, vehicles and conflicts against the published timetable.
- Vehicles for new trips: a copy or a frequency change gives each new trip a vehicle in the same edit. A vehicle already on the line takes it if it is free and in the right place before and after; otherwise a new vehicle is added. A trip can also be put on its own new vehicle by hand.
- Before and after: the scenario panel lists each touched line with trips and vehicles before and after; the line inspector shows "was" figures and the published departures as an outline on the hourly chart; the stringline draws changed trips with a white core and a dashed grey line where they were; the vehicle chart lists added vehicles first, named in blue.
- Platforms: a trip's call can be moved to another platform at the same station ("change" beside the platform in the trip's stop list), with each platform marked free or busy for the time the trip is there. New trips (a copy, a frequency change, a new line, an added trip) that land on an occupied platform are moved to a free one the line already uses, and the change summary says how many. A platform clash offers "Use platform N instead" as a fix where one is free.
- Platform clashes count a waiting vehicle: a vehicle that ends a trip at a platform and starts its next from the same one within an hour holds it in between, and a trip calling there meanwhile is a clash. It is reported only where a trip the scenario made, moved or re-assigned is involved.
- Work out a line's vehicles again ("Work out the vehicles again" under Vehicles used): every trip on the line comes off its vehicle and the trips are chained afresh, both directions together. On the test line this took a line from 82 vehicles to 57.
- Add a trip to a line at a typed time and direction (above the trip list). It is timed like the nearest trip of the most-used stop pattern; a line whose trips were all deleted falls back to the published ones.
- Add a stop to one trip ("Add a stop" in the trip's edit tools): a stop the trip runs through, or one beside its path that is not in its stop pattern. Only that trip changes, and later stops are later by the stop time plus an allowance.
- Whole-line frequency on a line with branches: "Change the whole line, shared between all its stop patterns" spaces departures evenly across the line and deals them out to each stop pattern in the share it has in that part of the day.
- Changes on the map: lines the scenario has touched are outlined in yellow (switch beside "What changed, by line"). The top bar shows the scenario's own trip and vehicle counts.
- Dragging in the platform and vehicle charts. In the platform chart a call dragged up or down moves to that platform, and dragged sideways retimes its trip. In the vehicle chart a trip dragged up or down moves to that vehicle, and dragged sideways is retimed. A dashed outline shows where it would land and a label beside the pointer says what the drop would do; holding a trip at the top or bottom edge scrolls the rows.
- `npm run test:e2e` exercises all of the above through the API, except the dragging, which `npm run test:ui` does in a browser.

Not built yet:

- A drag changes the platform or vehicle, or the time, but not both at once.
- A drop is never refused in advance. A call dropped on a bus stand or another mode's platform at an interchange is turned down by the server with a message; a trip dropped on a vehicle that is busy is accepted and shows as a clash, and so does one dropped on a vehicle that is somewhere else and has no time to get there (since 20 Nov; before that only the time was checked).
- A trip cannot be dragged onto a new, empty vehicle; "Its own new vehicle" in the trip's edit tools does that.
- Vehicle planning across lines. Working out a line's vehicles again treats that line alone: a vehicle that also ran other lines keeps those trips, so the total across the network can go up even though the line's own count goes down. Fleet-size caps are not enforced, only reported.
- A free platform is judged by time only. Whether the track layout lets a train reach it is not known, which is why only platforms the line already uses are chosen automatically.
- An added stop's time is an estimate: the published stop time there, plus 20 to 120 seconds by mode for slowing and starting.
- The line search still shows published-timetable counts.
- The rules run on the server only, not also in the browser as first planned.

### What a scenario cannot do (20 Nov 2026, after a review of the whole project)

A review on 20 Nov found ways an edit could write something no vehicle can do, or invalid GTFS. These are the guards built in answer. `npm run test:e2e` has a block for them ("Reality"), which ends by exporting its scenario and checking the files.

- **The same trip twice.** An edit that names a trip which is no longer in the scenario (already replaced or removed) is refused with a message, and the editor reloads. Before, two quick drags of one trip made two copies of it; "Scenario 1" held a T9 train twice and was repaired. The editor also sends one edit at a time.
- **A trip that arrives before it left.** "Skip this stop on every trip like this one" took the seconds saved from the clicked trip and took them off every trip, so a trip that was quicker there ran backwards by 20 to 30 seconds. Each trip now saves the same share of its own time, and the edit is refused outright if any trip would run backwards.
- **Loop lines through a closure.** Stops were placed on a path by nearest point, so a loop's last stop sat at the path's start and the line was passed over, unlisted (line 100 on the Harbour Bridge: 134 trips). Stops are now placed by the feed's own distances, and whether a line is cut is decided stretch by stretch. On the bridge, line 100 is listed in full (184 trips).
- **A bus put back together across a closure.** The two halves of a split bus trip, a minute and a few hundred metres apart, were given to one bus. A vehicle now works one side of a closure only, and is never linked from one stop to another across the closed area. Each part is also checked to stay out of the closure before it is applied.
- **Many vehicles without warning.** A change that would add ten or more vehicles is worked out, undone, and described: how many it adds, the network's count before and after, and the most trips running at once on the lines it changes. It is applied only on "Go ahead". This covers every kind of change (closure, frequency, new line, working vehicles out again). The API applies an edit straight away unless it is sent with `confirm: false`, which is what the editor sends first.
- **The vehicle count as a number to trust.** The count is of chains of trips one vehicle could run, so it rises when a vehicle's day is cut in two. Closure summaries and the scenario panel now also give the most trips running at once, which is the firmer figure (Bondi Rd, all lines split: 112 new vehicles, 90 more across the network, and the most running at once on those lines goes from 34 to 33).
- **Fleet sizes.** None was set, so the fleet warning could never show. The vehicle catalogue offers "Set each to what the published timetable uses"; the scenario panel says when no sizes are set and the scenario uses more vehicles than published. The figures set this way are the editor's own estimates.
- **Clashes for the impossible**, alongside the platform and vehicle ones:
  - a stretch a scenario trip runs backwards in time, or faster than its mode can go in a straight line (train 165 km/h, metro 110, light rail 80, ferry 60, bus 100, coach 115; `packages/core/src/limits.ts`), unless a published trip runs that same stretch as fast. The published feed has hundreds of bus stretches timed at over 150 km/h, so a flat limit would flag the feed, not the scenario;
  - a vehicle whose next trip starts somewhere it cannot have reached in the time between (more than 600 m away by road, 800 m by rail, 400 m by ferry, and too far to cover at 50, 70 and 30 km/h). It is looked for on every vehicle the scenario has touched, with "Put the later trip on another vehicle" as the fix;
  - a path made after a closure that runs through it.
- **Detours.** A way round a closure was timed as the published time times the length ratio, with the ratio capped at 6, so a published time of nought (bus timetables are in whole minutes) stayed nought however long the way round. The cap is gone. Up to three times the length the trip's own time is scaled; beyond that, or where the result would be faster than the vehicle can go, the extra distance is timed at the mode's typical speed.
- **New stretches.** A stretch timed from the typical speed of its mode lost a stop time that was never added back (a 1.66 km coach stretch came out at 30 seconds). Only the stop time actually added is taken out, and no stretch is timed faster than its mode can go.
- **Stops on a path that doubles back.** A stop is placed on the first pass of a path that comes about as close as any, not the nearest point of the whole path.
- **Stay-aboard links in the export.** A block id is kept only where two trips still meet (the first ends where and before the second starts). A block the scenario has touched is written as the runs of trips that still join; a trip left alone has none.
- **Limits on what an edit accepts.** Hours and frequencies of a new line, time bands, and how late a shift can push a trip are bounded; a vehicle type of the wrong kind (a train type on a bus line) is refused; a trip cannot be moved onto another scenario's vehicle; a stop added to a trip must be a stop or platform, not a station.
- The clash count says when it has reached its limit ("200+"), "Fix all" says when it stops after 40 fixes, and the export link says how many clashes are not sorted out.

The same review covered the journey router and the simulator; those fixes are written up where they belong:

- Router (`docs/router-plan.md` section 18, `services/router/README.md` "Walks"): a change on foot takes at least `changeSecs` (2 minutes); a platform takes its pathway time to the street (60 s assumed where the feed has none); no walk across water a ferry sails, with bridges found where a bus or light rail path crosses a ferry path. Against TfNSW, measured from first boarding to last alighting, ours is now sooner on 33 of the test journeys where the old measure said 132; 8 of those fit none of the known reasons and have been checked only against the timetable.
- Simulator (`docs/simulator-plan.md`): "arrive sooner" is split into people truly sooner and people who now use a nearby stop that was already quicker, and the second group is left out of the net; people who gave up count in the hours lost; made-up journeys are labelled on the results, and the generator starts people at the stop the router recommends; a wait of more than four hours is no longer an ordinary journey. Run 84 against run 75 (410 trips removed) read as 280 hours saved; it now reads as at least 102 hours lost.
- Runs made before 20 Nov show as out of date, because they were planned under the old walking rules.

What these leave undone:

- Nothing stops an impossible edit in advance, apart from the two refusals above. The rest is found afterwards and listed as a clash; the export still goes ahead, with the count beside the link.
- The limits are straight-line speeds, set above what each mode does. A bus timed at 95 km/h down a suburban street passes.
- Splitting at a closure still needs more vehicle chains than a planner would use: each side is chained on its own, greedily, and a vehicle's leftover trips on other lines are not re-planned. Bondi Rd gives line 333 162 chains where it had 70, while the most running at once barely changes.
- A vehicle that kept unsplit trips either side of a closure is flagged only when it has no time to get round; nothing times the way round.
- Lines left running through a closure by choice, or because no way round was found, are named in the closure's summary but are not clashes.
- An export is not one moment in time: the trips are fixed at the start, but an edit made while it runs could change their stop times.
- The API has no limit on the size of an uploaded demand file and listens on every network interface with no logins. Both are for the deployment work.
- The MobilityData validator has still not been run (it needs a Java download).

### Testing status

- `npm test`: unit tests for the shared logic, including the route-change rules.
- `npm run test:e2e`: the scenario engine through the API, including cutting a bus line short, extending it again, adding a stop, checking that vehicles follow the new path, adding a bus stop with its partner across the road and extending a line to it, adding a station and running a new train line to it, a one-way loop, a train line that follows the track between two distant stations, cutting a train line between two stations and undoing it, the same cut made by a line drawn across the track, closing a road on a bus line (every new path is checked to stay out of the closed stretch), run times that differ by time of day, a trip added to a line, a line's vehicles worked out again, a trip moved between vehicles, a stop put back on one trip and a stop added to one trip, whole-line frequency shared between stop patterns, a platform change, the free-platform fix offered for clashes. Added 20 Nov 2026 and run on their own against the API, where they pass, but not yet as part of the whole suite: deleting a stop in the middle of a bus line, a terminus, one platform of a station, a whole station and a stop the scenario added, each previewed, applied, checked (no call left there, times in order, no stretch slower or under half as long, vehicles as the preview said, the clash count in the summary) and undone.
- `npm run export:check`: a GTFS export against the source feed.
- `npm run test:ui`: the interface itself, driven in a headless browser. It loads the app, checks that a train which has finished a trip is still drawn at its terminus until its next trip leaves (added 20 Nov 2026, run on its own but not yet as part of the whole suite), pauses with Space, searches for a line, changes a frequency (which starts a scenario on its own), undoes and redoes with the keyboard, retimes a trip, skips a stop, drags a trip on the trip diagram, clicks a station on the map, draws a new line by clicking two stations, opens the fleet screen, changes that line's route by clicking a third station, names a new station and places it with a click, ticks the one-way loop option, draws a closure round a station by clicking the map, leaves all but the trains running, applies it and undoes it, runs "Fix all", checks that the two tool buttons are in view on the map, adds a trip from the line panel at a typed time, switches the light version on and off, drags a trip onto another vehicle in the vehicle chart, and drags a call onto another platform in the platform chart. A station click now opens the station panel, and the platform chart from there. A step added 20 Nov 2026 deletes a ferry wharf from its panel after reading the preview and puts it back; it has not been run (the same clicks were made once by hand-written script on a train station, and worked).

Not covered by any test: the platform picker, "Add a stop" and "Work out the vehicles again" in the browser (all three are tested through the API), the outline of changed lines on the map, the light version beyond the panels turning white, a sideways drag and edge scrolling in the platform and vehicle charts (the up-and-down drag is tested in both), the vehicle-type pickers and fleet editing in the browser, following roads in the drawing tool, changing a bus route or placing a bus stop in the browser (the browser test uses a train line), a GTFS export containing new stops (checked against the database only, because the export check timed out), drawing a whole loop or closing a road in the browser (both are tested through the API), a GTFS export after a closure, a whole-day GTFS export after a stop is deleted (an export cut to a box round the deleted station was checked: the stop, its platforms and its pathways are absent and every reference resolves), deleting a single platform or a bus stop in the browser (tested through the API), a deleted stop's marker on the map (seen in one screenshot), export from the button, a second day, and anything on a small screen. No person other than the developer has used it.

### Usability pass (after a review of how easy the editor is to pick up)

Done:

- Editing needs no setup: edit controls are always shown, and the first change starts a scenario automatically.
- Whole-line frequency: one card per line with five parts of the day, showing how often it runs now; typing a new gap changes both directions together and works out vehicles across them. On a line with several stop patterns the card says so, gives the overall peak gap across all of them, and makes clear it shows and changes only the most common pattern in each direction.
- "Fix all" applies the suggested fix to each clash in turn.
- A trip's departure time can be typed directly.
- Plainer wording ("Trip diagram", "clashes", "placed by hand", the what-else-moves options), a short "How to play" card, and keyboard shortcuts (Ctrl+Z, Ctrl+Y, Space).

Still open from the review:

- Nobody other than the developer has been watched using it.

Done since:

- A station or stop clicked on the map opens on the right like a line or a trip: calls a day, calls per hour, platforms, and the lines that call there, with the platform chart one click away.
- "Draw a new line" and "Close a road or a line" are two large buttons on the map itself, beside the left panel, and are lit while their tool is in use (18 Nov; they were in the left panel before, where the owner found the closing tool hard to find). Since 20 Nov they are the first two buttons of the rail below.
- A rail down the left edge in place of the column of panels (20 Nov, `apps/web/src/LeftRail.tsx`; the owner found the screen cluttered). "Draw a line" and "Close a road" are always on it. "Timetable" (scenarios, changes, clashes, export), "Simulate" and "Layers" (the modes shown) each fold their panel out beside the rail and away again; one is out at a time, none to begin with, and the choice is remembered between visits. Folded away, the Timetable button carries the number of clashes or of changes and the Simulate button a dot while a run is going. A failed edit folds the Timetable panel out, since that is where it says why. The timeline and the map's key take the room left.
- A light version of the interface ("Light" in the top bar), remembered between visits. The base map, the network colours and the three timeline charts change with it.
- New trips are moved to a free platform where the line has one, and clashes offer one as a fix (see phase 3).

### 4. Network editing (five tools built; needs hands-on testing)

Built:

- Draw a new line: "Draw a new line" in the left panel, then click existing stops or stations on the map in order. Choose a name, mode, colour and how often it runs. Creating it adds the line, a timetable in both directions from 06:00 to 22:00, and the vehicles to run it, as one undoable change.
- New lines appear on the map in their colour, in the line search, in the impact list, and can be edited like any other line (frequency, trips, vehicle type).

- Change the route of an existing line: "Change route" on a line's panel. The line's stops are listed and marked on the map. Click a stop on the map to add it, click one already on the line (or "Remove" in the list) to take it off. That covers extending, cutting short, sending the line a different way, and adding or removing a stop. A clicked stop joins where it adds the least distance, or at the end or start if chosen. The panel shows what the change does before it is applied: stops added and removed, how many trips, and how much longer or shorter they become. It is one undoable change.
- What a route change keeps: stretches between stops that did not change keep the published path and each trip's own times, so peak and off-peak differences survive. Each trip still leaves the first unchanged stop at its published time, so adding stops at the start makes trips begin earlier and adding them at the end makes them finish later. Trips keep their vehicles.
- What a route change works out: new stretches get a path (along roads for buses, straight for other modes) and a run time learned from published trips between the two stops, or estimated from the mode's typical speed, as for new lines. A removed stop saves its stop time plus a small allowance, and the vehicle keeps to its path; for buses, "take the direct road" re-routes between the neighbouring stops instead.
- The other direction changes to match by default: removed stops are matched to the platform at the same station or the nearest stop within 150 m, and added stops use the stop across the road. If the two directions do not line up, the other one is left alone and the change summary says so.

- Add a stop that does not exist yet: "Add a stop that does not exist yet" at the bottom of the line-drawing and route-changing panels. Name it, click "Place it on the map", then click where it goes. It joins the line being worked on straight away, and is its own undoable change. New stops are drawn on the map ringed in blue at every zoom, belong to the scenario, and are in its GTFS export.
- For buses and coaches the stop across the road is added with it (on by default), and lines use it on the way back. The road is found through the routing server: a click beside the road puts the partner the same distance on the other side; a click on the road puts the pair 6 m either side.
- For trains, metro, light rail and ferries the new stop is a station with one to four platforms (two by default), named the way the feed names them. Lines use a different platform each way.

- One-way loops: "One-way loop, back to the first stop" in the drawing panel. The line runs round in one direction and returns to its first stop; there is no return direction, and a vehicle that finishes a lap starts the next. A loop needs at least three stops.
- Train, metro, light rail and ferry lines follow the track or the ferry routes ("Follow existing track", on by default, with a live preview). The path between two stations is the shortest way over the links that published services of that mode already run, so a new train line between two distant stations runs along the railway through the stations between them. The same applies to new stretches when a route is changed.
- Close a road or a line: the "Close a road or a line" button on the map. Click the map on one side of what is closed, then on the other (more clicks carry the line on). Every service whose path the line crosses is cut there, whatever its mode; the panel lists the modes found, and any can be unticked to leave it running (a bridge over the closed road, say). How far either side of the line counts as closed is 10 to 100 m (20 unless changed). The panel lists every line affected and what happens to its trips before anything changes; applying it is one undoable change, and the closed strip is drawn in red on the map.
  - **A cut splits; it does not close stops** (the owner's rule, 18 Nov). Each line crossed becomes a part on each side of the closure: a line of its own, named after the original with the side as a suffix (B1 becomes B1-N and B1-S; a scenario route whose `extra` records `variantOf` and `side`), with its own path and timetable. Trips keep the times they had at the stops they keep. Vehicles are worked out again for the parts and turn back at the last stop before the closure.
  - "Which side to keep": both, or one side only; the other parts are removed. Each line's parts are buttons in the list, to keep or drop one line's part on its own.
  - "Buses and coaches": split at the line (the default), or sent round by other roads as before. Each line has its own choice in the list: split, send round, or leave running.
  - A bus line that crosses the closure and comes back to the same side (out over a bridge and back) keeps both ends and turns round before the closure, as one trip; a new stretch joins the two ends and the later stops move earlier by the time saved.
  - On the map the parts are drawn in a colour for each side, dropped parts in grey dashes, and a ring with the stop's name marks each place vehicles turn back.
  - Sides are named by compass from the line drawn (N/S for a line that runs more east-west, E/W otherwise). A line that doubles back on itself, such as one drawn round a station, has no left and right, so its sides are judged from its middle.
  Rebuilt this way on 18 Nov at the owner's request: before, the tool asked what was closed, then for a point on a road or for the station on each side of a line. The API still takes those two older forms (`what: 'road'` and `what: <mode>`); the interface only sends `what: 'cut'`.
- A closed road: every bus and coach stop pattern whose path enters the closed area is sent another way between the last stop before it and the first stop after it, and no longer calls at stops inside it. Each trip keeps its own times, with the time between those two stops scaled by how much longer the new way is. A line that ends inside the closure is cut short.
- A closed line: trains cannot go round, so each trip through the closure becomes two: one that ends at the last station before it and one that starts from the first station after it, at the times the trip called there. Services on parallel tracks in the same corridor are closed too. Split trips are taken off their vehicles and given vehicles again.

- Delete a station, a stop or a platform (20 Nov; the owner's request of 19 Nov): on the station panel, "Delete this station" (or "this stop") and "Delete" beside each platform. A card then says what it would do, before anything changes: how many trips on which lines no longer call there and how much quicker they are, how many are cut short, how many are removed, how many calls move platform and how many of those land on a platform in use, what it does to the number of vehicles, and a warning where a line loses its only stop within 800 m or is left with no trips. "Delete" on the card applies it as one undoable change; published stops and stops the scenario added are deleted the same way.
  - **One platform of a station that has others** (trains, metro, light rail, ferries): every call there moves to another platform of the same station, at the same time. The choice is the one new trips get: a platform the line already uses that is free a minute either side; failing that the one with the fewest other trips there at that time. Calls are placed in time order, each seeing those placed before it. A call that lands on a platform in use shows as a clash, as usual.
  - **A stop, a whole station, or a station's last platform:** a trip that calls there in the middle of its run no longer does. The time between the stops either side becomes the median of published trips that already run between them without stopping (three or more, and only when their path is the same length as this trip's), otherwise the old time less the stop time and the allowance "skip a stop" uses, labelled estimated. An estimate is held back so that the vehicle never passes the deleted stop faster than it runs today on the stretches either side of it, nor faster than 90 km/h on the road, 160 on rails, 55 on the water; so a bus stop on a street where buses already run at a steady speed saves nothing. No stretch ever takes longer than before or less than half as long. A trip that started or ended there is cut short to its next or previous stop and keeps every time it had at the stops it keeps. A trip left with fewer than two stops is removed.
  - **What does not change:** every trip keeps its path, so nothing is re-routed; vehicles stay on their trips and none is added. A vehicle is only lost when every one of its trips was removed, and the summary says how many. The summary also says how many clashes the scenario had before and has now, because trips that run earlier can land on another train further along the line.
  - **Nothing is left pointing at a deleted stop:** the edit takes its rows out of every trip that could be seen in the scenario, gives those trips stop patterns without it, and renames the stay-aboard groups (`block_id`) of trips that no longer meet there. A deleted stop is not offered to "Change route", "Draw a new line", "Add a stop" or the platform picker, has no row in the platform chart, and is in no file of a GTFS export (stops, stop times, pathways), which is also what the simulator and the journey router read. A station's entrances and other rows under it go with it.
  - **On the map a deleted stop is still drawn,** greyed and crossed out with "(deleted)" after its name, at every zoom, and can be clicked. Hiding it was the other choice; it is drawn because the owner must be able to see what he deleted and find it again. The station panel says which change deleted it and offers "Put it back (undo)" when that was the latest change. The lines that called there are outlined as changed.
  - Buses and coaches are never moved to another stop under the same station: in the feed a bus stop's "station" is usually the pair of stops either side of the road, and the other one serves the other direction. Their calls go, as for a deleted stop.
  - The stops are rows in `scenario_removed_stops`; the edit kind is `deleteStop` in `apps/api/src/delete-stop.ts`, the rules with no database in `packages/core/src/delete-stop.ts`.

Limits of deleting a stop:

- The rule itself is a first guess, to be confirmed by the owner: he may want trips re-routed past a deleted stop, a different stop to end at, or the frequency thinned where a terminus goes.
- A trip cut short still turns back at whatever its next or previous stop is. Nothing checks that a vehicle can turn round or wait there, and the published path is still drawn to the old end of the line.
- A vehicle whose trips were cut short now ends one trip and starts the next at different stops. It has at least the time it had before to get between them, but that run is not drawn or timed. It shows as a clash when its next trip leaves before it arrives or, since 20 Nov, when the next trip starts too far away to reach in the time between. The summary counts these vehicles.
- Trains that end their run one station early wait at a platform there that other trains use, and trips that run earlier can meet another train further on. Both show as clashes and are counted, not fixed: deleting Newcastle Interchange left 20, deleting Double Bay wharf 14, deleting platform 1 at Hamilton 2.
- Whether the track lets a train reach the platform its call moved to is not known (as for every platform change). At a station with two platforms, deleting one puts both directions on the other; the summary says how many calls went to a platform their line does not normally use.
- "In use" for a moved call means within a minute either side, the same test as the platform picker; the clash list counts only trips that are there at the same moment, so it shows fewer.
- The warning about a line's only stop in an area looks 800 m in a straight line, for every mode, from the stops of the line's stop patterns.
- A stop is deleted for the whole day. Several stations cannot be deleted in one change; platforms of one station can (the API takes a list, the panel deletes one at a time).
- A deleted stop cannot be put back except by undoing back to that change. While drawing a line a deleted stop can still be clicked on the map; the server then refuses it.
- A trip added afterwards to a line with no trips left is copied from the published timetable; if that trip calls at a deleted stop it is refused, with a message.
- Timings: the preview takes 0.1 to 0.5 seconds, applying 0.4 to 2.5 seconds for up to 630 trips (Newcastle Interchange, 23 stop rows, 627 trips). A very large station has not been timed.

Limits of closures:

- A closure can last all day or part of it ("When" in the panel: a start and an end time; an end at or before the start means the next morning). Only trips that would be between the last stop before the closure and the first stop after it at some moment in those hours are changed; the rest run as published. Built 15 Nov. The planning was checked against the database (Chatswood to Artarmon: 376 trips all day, 65 between 10:00 and 14:00, none missed and none caught wrongly). Applying one and undoing it is a step in `npm run test:e2e`, and the preview in the panel is a step in `npm run test:ui`; both pass. Applying one from the panel, and a road closure for part of the day, are not tested.
- A part-day closure does not hold or turn back a trip that reaches the closure just before it ends; such a trip is changed like the others. The map draws the closed area all day and does not show the hours; they are in the change list on the left.
- It cannot be edited or lifted except by undoing it. Lines drawn or re-routed afterwards are not stopped from crossing it; since 20 Nov a path made afterwards that runs through it is listed as a clash.
- The way round a closed road is found by trial against a routing server that has no notion of a closed road (see the notes above). It can take a longer way than a driver would, or include a short side trip, and where it finds nothing the stop pattern is left as it is and the summary says so.
- Detour times are each trip's published time scaled by distance, not by the speed of the roads used. Beyond three times the length, or where scaling would be faster than the vehicle can go, the extra distance is timed at the mode's typical speed (20 Nov; the ratio was capped at 6 before, which let a long way round take no time at all).
- Measured on the Harbour Bridge, split: preview 4 s; applying it 21 s (62 lines, 2,974 trips changed, 97 parts made); undo at once. Sent round instead, the preview takes about 40 s.
- The turn-back stop is the last stop of the published stop pattern before the closure, however far away that is: express buses over the bridge turn back at "M2 Motorway". Nothing looks for a nearer place to turn, and nothing checks that a bus can turn round there.
- A part with fewer than two stops is not kept (a line with one stop beyond the closure loses that end).
- Splitting adds vehicle chains, because each side is worked on its own and a vehicle never crosses. The count of chains overstates what is needed on the road (732 more was once quoted for the bridge as if it were a need; it was mostly this effect). The summary now gives the network's change and the most trips running at once before and after, and a closure that adds ten or more vehicles asks first.
- Times on the far side are the published ones; nothing re-spaces a part to an even frequency.
- A closure changes at most 400 bus and coach stop patterns that are sent round or joined at once and says how many it left; splitting has no limit. (It was 80 until the owner closed the Harbour Bridge, which carries 162; all of them now change, and the preview takes about 40 seconds.)
- A bus line that crosses a drawn line more than once (over a bridge and back) is sent round at each crossing and keeps the stops between them. Before 18 Nov those stops were dropped and listed as closed.
- A drawn line cuts everything it crosses, including a service that passes over or under on a bridge or in a tunnel; the mode ticks are the only way to leave one running, and they work by mode, not by line.
- The preview of a drawn line across a busy road takes 15 to 25 seconds, because a way round is looked for on each bus stop pattern (measured near Strathfield: 14 lines in 15 s; trains and buses together, 18 lines in 25 s).
- Where a bus line runs along the drawn line, not across it, no way round is found and it is left as it is; the panel says so.
- In the older between-two-stations form, the line through a closure is the shortest way between the two stations; where two routes join them, only that one is closed. A service that passes neither station but shares the track is found by its path lying along the closed stretch for at least half its length.
- Vehicles after a cut are worked out by the same simple rule as for new trips, one line at a time, so the count is higher than a planner would manage (cutting T1 between two stations added about 250). Trips that were not split keep their vehicles, even where the vehicle's other trips were.
- Light rail is treated as track, so a road closure does not affect it.
- A trip with fewer than two stops left on either side is removed.
- Cutting a busy line is slow: about 20 seconds for a line with 400 trips through the closure, because each stop pattern is rewritten in turn.

Limits of loops and of following track:

- A loop cannot be reshaped into a two-way line or the reverse.
- A loop's headsign is the stop furthest from its start.
- Track and ferry paths only exist between stations that published services of the same mode link. A new station, or two networks that do not touch (Sydney and Newcastle light rail), is joined by a straight line.
- A path is built station to station, so a ferry line between two wharves may call past the wharves in between rather than taking open water.
- New track cannot be drawn by hand.

Limits of new stops:

- They can only be added while drawing or changing a line, not on their own.
- A new stop cannot be moved or renamed afterwards except by undoing it. It can be deleted, like any other stop (see "Delete a station, a stop or a platform" above).
- A platform cannot be added to an existing station.
- Without a routing server, or more than 60 m from a road, a bus stop gets no partner and is used both ways.
- Which of the pair is on the correct side for a given direction is not known; the routing server may add a small loop where it is wrong.
- New stops have no walking links or transfers to nearby stops.
- Every run time to or from a new stop is an estimate from the mode's typical speed.

Limits of changing a route:

- It changes one stop pattern (and its opposite) at a time. A line with branches or short workings needs each pattern changed separately; the panel lists them.
- Trips that end somewhere new are not re-planned onto vehicles. A vehicle whose next trip now leaves before it arrives is flagged as a clash, but a vehicle left at the wrong end of the line is not.
- The published path of a re-routed line is still drawn faintly underneath the new one, because other stop patterns may still use it.
- A stop cannot be moved up or down the list; take it off and click it again with "at the end" or "at the start".
- At a station the platform is the one the line already uses in that direction, otherwise picked automatically.

Limits of drawing a new line:

- New bus and coach lines follow roads ("Follow roads", on by default, with a live preview while drawing). With a routing server set in `ROUTER_URL` (anything that speaks the OSRM route API) the path comes from the road network, each direction routed separately. Without one, the path reuses published bus routes wherever one already runs between two consecutive stops, and is straight elsewhere; the return direction runs back along the outbound path. Vehicles are checked by a test to stay within 25 m of the drawn path in both directions.
- The way back uses the stop across the road. A stop's partner is taken from the published timetable: among the lines calling at it, the stop within 150 m that their opposite direction calls at most often. Stops with no partner are used both ways. This avoids the loops a routing server makes when sent back to a stop on the wrong side.
- Run times for a new line, and for new stretches of a changed route, are learned from the timetable section by section and by part of the day (before 06:30, 06:30 to 09:30, 09:30 to 15:00, 15:00 to 19:00, after 19:00). Best evidence first: published trips that already run from one stop to the next (their median time, three or more trips); otherwise the median speed of published trips of the same mode between stops within about 400 m of the section (30 or more); otherwise the typical end-to-end speed of the mode. Each is taken for the part of the day where it has enough trips and for the whole day where it does not. A trip uses the times of the part of the day it sets out in. The change summary says how many sections used each source and the end-to-end time at the slowest and quietest times; a test bus line came out at 71 minutes in the morning peak and 64 in the middle of the day.
- The stop time is what published trips do at that stop, otherwise what the mode usually does. Bus timetables give no stop time of their own (it is inside the run time), so new bus lines have none either; trains come out at 30 seconds.
- What the run times do not know: traffic beyond what the timetable already allows for, speed limits and turns. The routing server's own drive times are for cars and are not used. A trip that crosses from one part of the day into the next keeps the times it set out with.
- At a station the platform is picked automatically (the first one out, the second one back).

Not built yet:

- The road network and a routing engine of our own (the public server is used instead), and matching published bus paths to road segments.
- New lines are not in the map tiles; they are drawn as a separate layer.

Original scope for reference:


- Create, edit and delete routes.
- Add stops, stations and platforms.
- Draw rail links and ferry routes; bus routes snap to roads.
- Load the OpenStreetMap road network and the routing engine; match bus shapes to road segments.
- Cut a link: affected trips are flagged with fixes such as terminate short or redirect.
- Close a road: find affected routes, propose detours, and adjust geometries and schedules.
- Re-link trips between vehicle days, and add or remove stay-aboard links such as through-running at Central.

### 5. Fleet and capacity (first slice built; needs hands-on testing)

Built:

- Vehicle catalogue screen ("Fleet" in the top bar): every vehicle type with cars, seated and standing capacity, fleet size, and how many vehicles and trips use it on the chosen day or scenario. Values are edited in place; types can be added, and removed when unused. Typing a capacity clears its "placeholder" tag.
- Choosing the vehicle type, while editing a scenario: for a whole line, for one vehicle's day, or for one trip. It is an ordinary scenario edit, so it can be undone.
- Fleet limits: where a scenario needs more vehicles of a type than its fleet size, the scenario panel says how many it is short.
- Capacity: the line inspector's hourly chart switches between departures and places per hour, with the published level outlined; the per-line impact list shows places a day before and after.

Not built yet:

- Capacity drawn on the map, by line or by link.
- A default vehicle type per line or mode set outside a scenario; the mode defaults are fixed in the seed data.
- Fleet limits are checked per day against vehicles in use, not against a depot or stabling plan.

Original scope for reference:


- Vehicle catalogue editor with NSW defaults.
- Assign types to routes, vehicle days and trips; fleet caps.
- Capacity per hour by line and by link, on the map and in the inspector.
- The catalogue's data model and resolution rule are built in Phase 1 so capacity is present from the start; this phase adds the editing interface and the capacity views.

### 6. Export and deployment (export built; deployment not started)

Built:

- GTFS export of one service day, with a scenario's changes applied, as a zip ("Export GTFS" in the scenario panel). It takes two to four minutes for a full weekday.
- The zip holds agency, routes, stops, calendar, trips, stop_times, shapes, pathways and feed_info, plus two files that are not GTFS (`editor_vehicle_types.txt`, `editor_trip_vehicles.txt`) carrying vehicles and capacities for the simulator.
- `npm run export:check` verifies an export: every reference resolves, ids are unique, every trip has two or more stop times and calls only at stops and platforms, times and distances never run backwards (along shapes and along each trip). For the published day it also confirms trips, stop times and shapes match the original TfNSW feed. For a scenario (`npm run export:check -- <id>`, on the scenario's own day; `--box=south,west,north,east --no-shapes` makes it quick) it also requires that the editor finds no stretch faster than its mode can go or backwards, and that the blocks the scenario changed do not overlap. `npm run test:e2e` runs it on a scenario with a closure, split lines and skipped stops.

Known differences from the TfNSW feed:

- The export covers one day under a single service id, not the feed's full calendar.
- TfNSW's extra columns and files are left out: station levels, notes, trip and stop notes, route direction.
- Stop distances are stored as 32-bit numbers, so they can differ from the feed by up to 3 cm.

Not done:

- Running the MobilityData validator (it needs a Java download; say the word and I will add it).
- AWS deployment, logins and onboarding.

Original scope for reference:


- Export valid GTFS, with the extra data in separate files alongside.
- Check every export with the MobilityData GTFS validator.
- Round-trip test: importing then exporting an unedited baseline must reproduce it.
- AWS deployment, organisation logins and first-run onboarding.

## Risks

- **Scale:** full NSW with buses is the main performance risk. Phase 1 is the proof point.
- **Inferred vehicle days:** the feed has no vehicle days for buses, metro, light rail, ferries or intercity trains. Inferred chains are a plausible guess, not the operator's real rosters, so vehicle counts for those modes are estimates until someone corrects them.
- **Capacity numbers:** set types and car counts come from the feed for 94% of train trips, but seated and standing capacities are not in the feed and must be sourced.
- **Run times with nothing to compare:** where every trip on a link has the same stopping pattern, the time saved by skipping a stop falls back to a default per mode.
- **Bus route drawing:** snapping to roads needs a road-routing service, an extra component in Phase 4.
- **Assumed vehicle types:** capacity figures are only as good as the assignments. The coverage indicator keeps this visible.
