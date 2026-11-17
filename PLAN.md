# GTFS Editor plan

A visual, game-like editor for NSW public transport timetables (GTFS), built in React. It will later become a simulator of how people move through the network, so the editor must capture the data that simulator needs.

The build goes in seven phases, each ending in something usable: a read-only viewer first, then schedule editing, network editing, fleet, and export.

## Where we are (15 Nov 2026)

**Next step: to be agreed with the owner before building.** (Goals and a score were built on 14 Nov from an earlier version of this line and removed the next day: the owner had not asked for them. Do not add game features.) The last thing built is a closure for part of the day. Phases 1 to 4 of the journey router (the timetable loader, the search, the HTTP service, and capacity with bulk requests) are built; phase 5 (the benchmark harness and demand generator) is next in `docs/router-plan.md`. Dragging in the platform and vehicle charts is built, and the router's empty project (`services/router`, phase 0 of its plan) builds and starts. Run times by time of day, the schedule editing gaps (free platforms, re-planning a line's vehicles, a stop added to one trip, a trip added to a line, whole-line frequency across branches), station details on the right, a light version of the interface and the pinned tool buttons are now built; what they leave out is listed under phases 3 and 4.

Status by phase; details are under "Phases" below.

| Phase | Status |
|---|---|
| 0. Data audit | Done |
| 1. Import and viewer | Built |
| 2. Timeline views | Built |
| 3. Scenarios and schedule editing | Built; the remaining gap (vehicle planning across lines) is listed in the phase |
| 4. Network editing | Four tools: draw a new line (two-way or a one-way loop), change the route of an existing line, add a stop or station where there is none, and close a road or a line. Bus lines follow roads; trains, trams and ferries follow the track and routes that published services use |
| 5. Fleet and capacity | First slice built |
| 6. Export and deployment | GTFS export built and verified against the feed; deployment not started |

Everything is committed to git on `master`. Tests: `npm test`, `npm run test:e2e`, `npm run test:ui`, `npm run export:check` (see "Testing status").

Remaining work, roughly in order:

1. Route editing: the gaps listed in phase 4 (reshaping, new stops, closures); a routing server that can be told a road is closed; re-planning vehicles across lines after a line is cut.
2. Schedule editing: vehicle planning across lines rather than one line at a time.
3. Usability: watching real people use it.
4. The journey router: a standalone Java RAPTOR service, capacity aware with a switch, with bulk and road-routing endpoints. Planned in `docs/router-plan.md`. Phases 0 and 1 of that plan are built: `services/router` is a Gradle project of five modules. It loads the exported weekday zip into memory in about 4 seconds (59,014 trips, 57 MB), saves a snapshot, and plans journeys from the command line (`npm run router:route`); the search agrees with a brute-force check. On test journeys inside the Opal area it meets its single-query speed targets (median 8 ms for any two stops, under 1 ms within 10 km) and meets the bulk target only for short journeys; journeys leave as late as they can, slow alternatives are dropped and one journey is recommended. Its server (port 3002, `npm run router:dev`) loads, reloads and unloads timetables, plans one journey per request (`POST /v1/journeys`) or many (`POST /v1/journeys/bulk`), and keeps named load states so that a request can ignore how full vehicles are, respect it, or respect it and add its passengers (`off`, `check`, `assign`); the editor does not call it yet. Every vehicle capacity is still a placeholder. There is no road routing, and its Docker image has not been rebuilt since the endpoints were added. The plan has 16 questions for the owner, each with a default.
5. Data: real vehicle capacities (all are placeholders), transfers between nearby stops, capacity on the map.
6. Export and deployment: MobilityData validator, export progress, a self-hosted routing server, AWS, logins, shrinking the vehicle data, updating to a new feed while keeping scenarios.
7. The passenger simulator: planned in `docs/simulator-plan.md` (18 Nov 2026), agreed with the owner section by section. It sends a file of journeys through the timetable using the journey router, is started from the editor by a wizard, and shows results in the editor. Its build order is section 10 of that file (S0 to S6). Phases S0 to S3 are built: demand files, the simulator itself (`services/router/router-sim`), runs as jobs on the router service, and the editor's back end (`apps/api/src/sim.ts`: demand sets, saved areas, folders, BAU and scenario runs, results copied into PostgreSQL, out-of-date marking, archiving). The export gained two options, without shapes (14 s instead of minutes) and cut to a box. What was measured is in sections 14 to 16 of that file. There are no panels in the web app yet: the next phase is S4, which is the first version usable from the editor. The owner's decisions and answers are in its section 12, and no question is open.
8. Later, as planned: the interchange file, track-level conflicts.

Things a new session needs to know:

- Start with `npm run db:up`, then `npm run dev`. On the development machine the dev servers have been stopped several times for lack of memory; starting them in a separate terminal avoids that.
- `.env` holds the TfNSW key and `ROUTER_URL`, currently the public OSRM demo server. Stop coordinates are sent to it; host a routing server for real use.
- The "Decisions made" and "Architecture" sections below were written before the build. Two have since changed: the validity rules run on the server only, not also in the browser, and timeline dragging exists only on the trip diagram.
- The interface has been driven by a scripted browser (`npm run test:ui`), not yet by a person other than the developer. The untested parts are listed under "Testing status".
- Lines drawn before the road-following and opposite-stop fixes keep their old paths and should be redrawn.
- Reshaping a line is one edit kind, `reshape`, in `apps/api/src/reshape.ts`; the parts that need no database (which stops are kept, trip times, the other direction) are in `packages/core/src/reshape.ts` with unit tests.
- New stops are rows in `stops` owned by the scenario (`apps/api/src/stops.ts`). They are not in the map tiles; the map draws them from `/api/scenarios/:id/stops`.
- Paths for trains, trams and ferries come from `apps/api/src/tracks.ts`: a network of station-to-station links built from the published stop patterns, once per day and mode, kept in memory. There is no track or water map behind it.
- Closures are one edit kind, `close`, in `apps/api/src/closures.ts`. It finds every stop pattern whose path enters the closed area and changes each with the route-change code (`planReshape`, `applyReshape`). The closed areas are rows in `scenario_closures`, used only to draw them.
- The public routing server cannot be told a road is closed. `routedAround` in `apps/api/src/roads.ts` finds a way round by asking it for the road distances between a ring of points and searching those; every path is checked to stay out of the closure before it is used. Requests to the routing server take turns, two at a time.
- Run times for new stretches come from `apps/api/src/timings.ts`, for five parts of the day (`DAY_BANDS` in `packages/core/src/time.ts`). A trip uses the times of the part of the day it sets out in.
- The schedule edits added last (`setPlatform`, `replan`, `moveToVehicle`, `addTrip`, `addCall`) are in `apps/api/src/schedule.ts`. New trips are moved off a busy platform automatically by `settlePlatforms` there.
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

Still to confirm or do:

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
- Conflicts caused by the scenario: two trips on a platform or wharf at once, and a vehicle whose next trip leaves before it arrives. Each has a one-click fix.
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
- A drop is never refused in advance. A call dropped on a bus stand or another mode's platform at an interchange is turned down by the server with a message; a trip dropped on a vehicle that is busy or in the wrong place is accepted and shows as a clash.
- A trip cannot be dragged onto a new, empty vehicle; "Its own new vehicle" in the trip's edit tools does that.
- Vehicle planning across lines. Working out a line's vehicles again treats that line alone: a vehicle that also ran other lines keeps those trips, so the total across the network can go up even though the line's own count goes down. Fleet-size caps are not enforced, only reported.
- A free platform is judged by time only. Whether the track layout lets a train reach it is not known, which is why only platforms the line already uses are chosen automatically.
- An added stop's time is an estimate: the published stop time there, plus 20 to 120 seconds by mode for slowing and starting.
- The line search still shows published-timetable counts.
- The rules run on the server only, not also in the browser as first planned.

### Testing status

- `npm test`: unit tests for the shared logic, including the route-change rules.
- `npm run test:e2e`: the scenario engine through the API, including cutting a bus line short, extending it again, adding a stop, checking that vehicles follow the new path, adding a bus stop with its partner across the road and extending a line to it, adding a station and running a new train line to it, a one-way loop, a train line that follows the track between two distant stations, cutting a train line between two stations and undoing it, closing a road on a bus line (every new path is checked to stay out of the closed stretch), run times that differ by time of day, a trip added to a line, a line's vehicles worked out again, a trip moved between vehicles, a stop put back on one trip and a stop added to one trip, whole-line frequency shared between stop patterns, a platform change, the free-platform fix offered for clashes.
- `npm run export:check`: a GTFS export against the source feed.
- `npm run test:ui`: the interface itself, driven in a headless browser. It loads the app, pauses with Space, searches for a line, changes a frequency (which starts a scenario on its own), undoes and redoes with the keyboard, retimes a trip, skips a stop, drags a trip on the trip diagram, clicks a station on the map, draws a new line by clicking two stations, opens the fleet screen, changes that line's route by clicking a third station, names a new station and places it with a click, ticks the one-way loop option, closes a train line between two stations clicked on the map and undoes it, runs "Fix all", checks that the two tool buttons stay in view when the scenario panel is scrolled, adds a trip from the line panel at a typed time, switches the light version on and off, drags a trip onto another vehicle in the vehicle chart, and drags a call onto another platform in the platform chart. A station click now opens the station panel, and the platform chart from there.

Not covered by any test: the platform picker, "Add a stop" and "Work out the vehicles again" in the browser (all three are tested through the API), the outline of changed lines on the map, the light version beyond the panels turning white, a sideways drag and edge scrolling in the platform and vehicle charts (the up-and-down drag is tested in both), the vehicle-type pickers and fleet editing in the browser, following roads in the drawing tool, changing a bus route or placing a bus stop in the browser (the browser test uses a train line), a GTFS export containing new stops (checked against the database only, because the export check timed out), drawing a whole loop or closing a road in the browser (both are tested through the API), a GTFS export after a closure, export from the button, a second day, and anything on a small screen. No person other than the developer has used it.

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
- "Draw a new line" and "Close a road or a line" stay at the top of the left panel however far it is scrolled, and on a short window the panel gives up its lower part before the buttons. (They used to scroll out of sight once a scenario had clashes and changes listed.)
- A light version of the interface ("Light" in the top bar), remembered between visits. The base map, the network colours and the three timeline charts change with it.
- New trips are moved to a free platform where the line has one, and clashes offer one as a fix (see phase 3).

### 4. Network editing (four tools built; needs hands-on testing)

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
- Close a road or a line: "Close a road or a line" in the left panel. For a road, click the map and choose how far the closure reaches (50 to 400 m each way). For a train, metro, light rail or ferry line, click the station on each side. The panel lists every line affected and what happens to its trips before anything changes; applying it is one undoable change, and the closed area is drawn in red on the map.
- A closed road: every bus and coach stop pattern whose path enters the closed area is sent another way between the last stop before it and the first stop after it, and no longer calls at stops inside it. Each trip keeps its own times, with the time between those two stops scaled by how much longer the new way is. A line that ends inside the closure is cut short.
- A closed line: trains cannot go round, so each trip through the closure becomes two: one that ends at the last station before it and one that starts from the first station after it, at the times the trip called there. Services on parallel tracks in the same corridor are closed too. Split trips are taken off their vehicles and given vehicles again.

Limits of closures:

- A closure can last all day or part of it ("When" in the panel: a start and an end time; an end at or before the start means the next morning). Only trips that would be between the last stop before the closure and the first stop after it at some moment in those hours are changed; the rest run as published. Built 15 Nov. The planning was checked against the database (Chatswood to Artarmon: 376 trips all day, 65 between 10:00 and 14:00, none missed and none caught wrongly). Applying one and undoing it is a step in `npm run test:e2e`, and the preview in the panel is a step in `npm run test:ui`; both pass. Applying one from the panel, and a road closure for part of the day, are not tested.
- A part-day closure does not hold or turn back a trip that reaches the closure just before it ends; such a trip is changed like the others. The map draws the closed area all day and does not show the hours; they are in the change list on the left.
- It cannot be edited or lifted except by undoing it, and lines drawn or re-routed afterwards do not know about it.
- The way round a closed road is found by trial against a routing server that has no notion of a closed road (see the notes above). It can take a longer way than a driver would, or include a short side trip, and where it finds nothing the stop pattern is left as it is and the summary says so.
- Detour times are the published time scaled by distance, not by the speed of the roads used.
- A road closure changes at most 80 stop patterns at once and says how many it left.
- The line through a closure is the shortest way between the two stations clicked; where two routes join them, only that one is closed. A service that passes neither station but shares the track is found by its path lying along the closed stretch for at least half its length.
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
- A new stop cannot be moved, renamed or deleted afterwards except by undoing it.
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
- `npm run export:check` verifies an export: every reference resolves, ids are unique, times and distances never run backwards. For the published day it also confirms trips, stop times and shapes match the original TfNSW feed.

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
