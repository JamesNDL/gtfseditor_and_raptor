# GTFS Editor plan

A visual, game-like editor for NSW public transport timetables (GTFS), built in React. It will later become a simulator of how people move through the network, so the editor must capture the data that simulator needs.

The build goes in seven phases, each ending in something usable: a read-only viewer first, then schedule editing, network editing, fleet, and export.

## Where we are (13 Nov 2026)

**Next step: reshape existing lines** (extend, cut short, re-route, add or remove a stop from a line). This is the rest of phase 4.

Status by phase; details are under "Phases" below.

| Phase | Status |
|---|---|
| 0. Data audit | Done |
| 1. Import and viewer | Built |
| 2. Timeline views | Built |
| 3. Scenarios and schedule editing | Built, with gaps listed in the phase |
| 4. Network editing | First tool only: draw a new line through existing stops, with bus lines following roads |
| 5. Fleet and capacity | First slice built |
| 6. Export and deployment | GTFS export built and verified against the feed; deployment not started |

Everything is committed to git on `master`. Tests: `npm test`, `npm run test:e2e`, `npm run test:ui`, `npm run export:check` (see "Testing status").

Remaining work, roughly in order:

1. Route editing: reshape existing lines; new stops, stations and platforms; one-way loop lines; rail, light rail and ferry paths that follow track or water; road closures; cutting a rail line.
2. Timings for new lines: by time of day, a learned stop time, better estimates where no bus runs today.
3. Schedule editing gaps: choosing a free platform, platform clashes that count waiting vehicles, whole-line frequency on branching lines, vehicle planning across lines, adding a stop to one trip, creating a trip from nothing, dragging in the platform and vehicle charts.
4. Usability: station details in the right-hand panel, goals and scoring, showing edits on the map, watching real people use it.
5. Data: real vehicle capacities (all are placeholders), transfers between nearby stops, capacity on the map.
6. Export and deployment: MobilityData validator, export progress, a self-hosted routing server, AWS, logins, shrinking the vehicle data, updating to a new feed while keeping scenarios.
7. Later, as planned: the passenger simulator, the interchange file, track-level conflicts.

Things a new session needs to know:

- Start with `npm run db:up`, then `npm run dev`. On the development machine the dev servers have been stopped several times for lack of memory; starting them in a separate terminal avoids that.
- `.env` holds the TfNSW key and `ROUTER_URL`, currently the public OSRM demo server. Stop coordinates are sent to it; host a routing server for real use.
- The "Decisions made" and "Architecture" sections below were written before the build. Two have since changed: the validity rules run on the server only, not also in the browser, and timeline dragging exists only on the trip diagram.
- The interface has been driven by a scripted browser (`npm run test:ui`), not yet by a person other than the developer. The untested parts are listed under "Testing status".
- Lines drawn before the road-following and opposite-stop fixes keep their old paths and should be redrawn.

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
| Deferred | Interchange file, track-level conflicts (Level 2), feed rebasing, the passenger simulator |

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
- `npm run test:e2e` exercises all of the above through the API.

Not built yet:

- Smarter vehicle use. New trips only look at vehicles already running the same line, and a frequency change in one direction adds a vehicle per trip because nothing brings them back. Re-planning a whole line's vehicles, and fleet-size caps, are not built.
- Showing changes on the map itself beyond the white edge on changed vehicles (for example highlighting touched lines).
- Adding a stop to a trip, and creating a trip from nothing (today a new trip is a copy of an existing one).
- Dragging in the platform and vehicle charts.
- The live scoreboard beyond the three numbers in the scenario panel; the top bar and the line search still show published-timetable counts.
- Platform conflicts compare calls only, not a vehicle waiting between trips.
- The rules run on the server only, not also in the browser as first planned.
- Scenario changes are not in any export (Phase 6).

### Testing status

- `npm test`: unit tests for the shared logic.
- `npm run test:e2e`: the scenario engine through the API.
- `npm run export:check`: a GTFS export against the source feed.
- `npm run test:ui`: the interface itself, driven in a headless browser. It loads the app, pauses with Space, searches for a line, changes a frequency (which starts a scenario on its own), undoes and redoes with the keyboard, retimes a trip, skips a stop, drags a trip on the trip diagram, clicks a station on the map, draws a new line by clicking two stations, opens the fleet screen, and runs "Fix all". All twelve steps pass with no browser errors.

Not covered by any test: the platform and vehicle charts beyond opening them, the vehicle-type pickers and fleet editing in the browser, following roads in the drawing tool, export from the button, a second day, and anything on a small screen. No person other than the developer has used it.

### Usability pass (after a review of how easy the editor is to pick up)

Done:

- Editing needs no setup: edit controls are always shown, and the first change starts a scenario automatically.
- Whole-line frequency: one card per line with five parts of the day, showing how often it runs now; typing a new gap changes both directions together and works out vehicles across them. On a line with several stop patterns the card says so, gives the overall peak gap across all of them, and makes clear it shows and changes only the most common pattern in each direction.
- "Fix all" applies the suggested fix to each clash in turn.
- A trip's departure time can be typed directly.
- Plainer wording ("Trip diagram", "clashes", "placed by hand", the what-else-moves options), a short "How to play" card, and keyboard shortcuts (Ctrl+Z, Ctrl+Y, Space).

Still open from the review:

- Station details open in the bottom panel while everything else opens on the right.
- New trips reuse the copied trip's platforms, so a frequency change or a new line still creates many platform clashes; picking a free platform automatically is not built.
- No goals or scoring, and the map shows changes only as a white edge on changed vehicles and the colour of new lines.
- Nobody other than the developer has been watched using it.

### 4. Network editing (first tool built; needs hands-on testing)

Built:

- Draw a new line: "Draw a new line" in the left panel, then click existing stops or stations on the map in order. Choose a name, mode, colour and how often it runs. Creating it adds the line, a timetable in both directions from 06:00 to 22:00, and the vehicles to run it, as one undoable change.
- New lines appear on the map in their colour, in the line search, in the impact list, and can be edited like any other line (frequency, trips, vehicle type).

Limits of this first tool:

- New bus and coach lines follow roads ("Follow roads", on by default, with a live preview while drawing). With a routing server set in `ROUTER_URL` (anything that speaks the OSRM route API) the path comes from the road network, each direction routed separately. Without one, the path reuses published bus routes wherever one already runs between two consecutive stops, and is straight elsewhere; the return direction runs back along the outbound path. Vehicles are checked by a test to stay within 25 m of the drawn path in both directions.
- The way back uses the stop across the road. A stop's partner is taken from the published timetable: among the lines calling at it, the stop within 150 m that their opposite direction calls at most often. Stops with no partner are used both ways. This avoids the loops a routing server makes when sent back to a stop on the wrong side.
- One-way loop lines (out and round, never back the same way) cannot be drawn yet.
- Rail, light rail and ferry lines are still straight from stop to stop.
- Run times for a new line are learned from the timetable, section by section. Where at least three published trips already run from one stop to the next, their median time is used. Otherwise the section's length is divided by the typical speed of that mode on that day (the median over published trips of path length divided by scheduled time; 22 km/h for buses on the imported weekday). The change summary says how many sections used each.
- What the run times do not know: time of day (one figure is used all day, so peaks are not slower), traffic, speed limits, and turns. The routing server's own drive times are for cars and are not used.
- The stop time is still a fixed figure per mode (20 seconds for buses).
- At a station the platform is picked automatically (the first one out, the second one back).
- Only existing stops can be used.

Not built yet:

- Changing an existing line's path: extending it, cutting it short, re-routing it, adding or removing a stop from the pattern.
- New stops, stations and platforms.
- The road network and routing engine, snapping bus lines to roads, and road closures.
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
