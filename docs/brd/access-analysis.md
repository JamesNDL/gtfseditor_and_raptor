# BRD: Access analysis

| | |
|---|---|
| Date | 25 Nov 2026 |
| Status | **Approved** (the owner asked for it to be taken as approved, 25 Nov 2026) |
| Version | 1.2 |
| Owner | Project owner |
| Source | The owner's description and answers, 25 Nov 2026 |

**Glossary terms used** (`docs/glossary.md`): Baseline, Line, Mode, Part of the day, Scenario, Stop, Trip.

**New terms proposed** (added to the glossary marked "proposed"): **Access analysis**, **Access ratio**, **No service**, **Parking allowance**, **Point of interest**, **Road router**, **Sample point**, **Traffic factor**, **Zone**.

**Assumptions**

- A1. Walking to and from stops stays as the journey router does it today: straight lines, 1.3 times as long on the ground, at 1.03 m/s (`services/router/README.md`, "Walks").
- A2. A drive starts and ends at the nearest road to the sample point or point of interest. The few metres from the point to that road are not counted.
- A3. Driving times from the road router are free-flow (no traffic). The traffic factor (FR-9) is how traffic is allowed for.
- A4. Road data is OpenStreetMap, covering at least the Opal area (Newcastle, Sydney, Wollongong). OpenStreetMap must be credited wherever road results are shown (ODbL).
- A5. The road router must be able to run as its own process ("road only") when the development machine has too little memory to hold it beside the timetables (`docs/router-plan.md` section 7).
- A6. There is one user, the owner, as for the rest of the editor. No logins or sharing.
- A7. "Avoid a closed area" in the road router (so a closure's detour is one request instead of a search) is not part of this work. The OSRM-shaped endpoints are (FR-13).
- A8. Sample points are not weighted by population.

**Open questions**

- Q1. Default traffic factors for each part of the day. This BRD assumes 1.0 overnight and in the evening, 1.4 in the morning and afternoon peaks, and 1.2 in the middle of the day, all editable (FR-9).
- Q2. Default parking allowance. This BRD assumes 5 minutes.

**Issues and discrepancies**

| ID | Found | Who acts | State |
|---|---|---|---|
| I-1 | `PLAN.md` lists "a self-hosted routing server" and "a routing server that can be told a road is closed" as remaining work. FR-13 does the first. The second stays open (A7). | Developer (doc fix at close-out) | Resolved 26 Nov 2026 (AA-25): "a self-hosted routing server" struck from `PLAN.md`; the second kept |

**Change log**

| Version | Date | What changed | Why | IDs | Approved by |
|---|---|---|---|---|---|
| 0.1 | 25 Nov 2026 | Created from the owner's description and four rounds of questions | New feature | FR-1 to FR-20, NFR-1 to NFR-6 added | |
| 1.0 | 25 Nov 2026 | Approved as written; Q1, Q2 and A5, A7 taken as stated | The owner asked for it to be taken as approved and built overnight | none | Owner |
| 1.1 | 26 Nov 2026 | Arrive-by added (FR-21), with a backward search in the journey router and the early wait counted; drawing and editing on the map made editor-like (tool bar, name box on the map, drag to move and reshape); basemap choice added (FR-22) | The owner's first hands-on check: "If I want to arrive at Westfield for work at 8"; drawing "doesn't feel right"; the map "doesn't let me see where certain buildings are" | FR-21, FR-22 added; FR-4, FR-5, FR-6, FR-9, FR-11, FR-15 changed | Owner |
| 1.2 | 26 Nov 2026 | The setup lists only the saved zones and points of interest near where the map is looking, plus the ones picked; the rest are a Show all away | The owner: "I don't need Newcastle points and zones in my Dee Why analysis" | FR-4, FR-5 changed; AC-FR-4.4 added | Owner |

---

## 1. Requirement of the feature

### What is being built

An **access analysis** tool in the editor. The owner draws a **zone** on the map and places **points of interest** (a hospital, a shopping centre). The editor lays an even grid of **sample points** over the zone and, for each sample point and each point of interest, asks the journey router how long the trip takes by public transport and asks a new **road router** how long it takes to drive. The **access ratio** is the public transport time divided by the car time. The result is a map for each point of interest with lines of equal access ratio drawn over the zone, so that areas poorly served by public transport stand out.

To give driving times, the journey router gains road routing (phase 6 of `docs/router-plan.md`), and the editor's own road requests (drawing bus paths, detours and closures) move from the public OSRM demo server to it.

### Users

The project owner, for their own planning and for maps and figures that go into reports for others.

### In scope

- Drawing, naming, saving and reusing zones; placing, naming, saving and reusing points of interest.
- Running an access analysis on a baseline or one of its scenarios, at one departure time or one arrive-by time, with the settings in FR-5 to FR-9.
- Road routing in the journey router, and the editor using it in place of the public OSRM server.
- The results map, the detail for one sample point, comparing two analyses, and export.

### Out of scope

- Points of interest loaded from a dataset (hospitals, shopping centres from OpenStreetMap or government data). Later.
- A spread of departure times. Later. (Arrive-by was moved into scope in version 1.1: FR-21.)
- Population or other weighting of sample points.
- Traffic from real data. Traffic factors only (FR-9).
- "Avoid a closed area" in the road router (A7).
- Walking on the street network (A1).

### Functional requirements

**Road routing**

- **FR-1 The journey router can plan a drive.** Given two points, it returns the driving time, the distance and the path, using OpenStreetMap roads.
- **FR-2 The journey router can plan many drives at once.** Given a list of starting points and a list of ending points, it returns the driving time and distance for every pair, fast enough for NFR-1.
- **FR-3 Road data is prepared by a command.** One command fetches or takes an OpenStreetMap extract, cuts it to the area the editor needs, and builds what the road router reads, into `data/`.
- **FR-13 The editor's road requests use the journey router.** The journey router answers the three OSRM requests the editor makes today (`route`, `table`, `nearest`, driving) in the same shape, so the editor's road router address can point at it with no other change. The public OSRM server is no longer needed.

**Zones and points of interest**

- **FR-4 A zone can be drawn, named, saved and reused.** The owner picks the zone tool from a tool bar on the map, clicks the corners, finishes the outline, and names it in a box that appears on the map above it. It can be picked again for later analyses. A zone can be renamed, reshaped by dragging its corners, and deleted. Reshaping a zone changes no analysis already run (each keeps its own copy). The setup lists the saved zones and points of interest near where the map is looking, plus any already picked; the others are left out of the list until the owner asks to show all.
- **FR-5 Points of interest can be placed, named, saved and reused.** The owner picks the point tool from the tool bar on the map, clicks the map to place a point of interest, and names it in a box that appears on the map above it. Points of interest are saved and can be picked for later analyses, moved, renamed and deleted. A point of interest may lie outside the zone.

**Running an analysis**

- **FR-6 An analysis is set up on one screen.** The owner chooses the zone, one or more points of interest, the timetable (a baseline or one of its scenarios), the time and whether it is a departure time or an arrive-by time (FR-21), and the grid spacing. Before running, the screen shows how many sample points the spacing gives and how many journeys that means.
- **FR-7 Sample points are an even grid over the zone.** Points are laid at the chosen spacing (in metres) and only those inside the zone are kept.
- **FR-8 Public transport limits are set on screen.** Longest walk to or from a stop, longest journey, most changes, and the modes allowed, each starting at a sensible value and changeable for each analysis.
- **FR-9 Car settings are set on screen.** A parking allowance in minutes, added to every car time, and a traffic factor for each part of the day; the car time is multiplied by the factor for the part of the day the analysis time (departure or arrive-by) falls in. Both are changeable for each analysis.
- **FR-10 An analysis runs in the background.** It shows its progress, can be cancelled, and the editor stays usable while it runs. A failed analysis says why.
- **FR-11 Each pair gets an access ratio.** For each sample point and point of interest: the public transport time is the journey router's door-to-door time (walk, wait, ride, changes, walk) leaving at the departure time, or for arrive-by as set out in FR-21; the car time is the road router's driving time times the traffic factor plus the parking allowance; the access ratio is the first divided by the second.
- **FR-12 No service is marked.** A sample point with no public transport journey to a point of interest within the limits of FR-8 is **no service** for that point of interest. It has no access ratio and is kept out of the lines of equal ratio.

**Results**

- **FR-14 Results show as lines of equal access ratio, one map per point of interest.** Lines at ratios 1, 1.5, 2, 3 and 4 by default, which the owner can change, with the areas between them coloured from well served to poorly served. No service points are shown in their own style. The owner switches between points of interest.
- **FR-15 One sample point can be looked at.** Clicking a sample point shows, for the chosen point of interest, its public transport journey (each walk, wait and ride, with the lines used), the car path, both times, the access ratio, and how the public transport time splits into walking, waiting and riding (and, for arrive-by, the early wait at the point of interest).
- **FR-16 Analyses are saved and can be reopened.** Each finished analysis is kept with its zone, points of interest, settings and results, listed, and can be reopened or deleted.
- **FR-17 Two analyses can be compared.** For two analyses of the same zone and point of interest (for example the baseline and a scenario), the map shows where the access ratio got better or worse.
- **FR-18 Results can be exported.** Sample points with their times and access ratios as CSV and GeoJSON, and the lines of equal ratio as GeoJSON.
- **FR-19 The map has a legend and credits.** The results map shows a legend of the ratio bands and no service, the analysis settings, and the OpenStreetMap credit.
- **FR-20 Summary figures.** For each point of interest: the number of sample points in each ratio band and with no service, and the median access ratio.

**Added in version 1.1**

- **FR-21 Arrive-by.** An analysis can be set to "arrive by" a time instead of "depart at" one. For each sample point and point of interest, the journey router finds the latest departure that reaches the point of interest by that time, within the limits of FR-8 (a backward search from the point of interest). The public transport time runs from that departure until the arrive-by time, so any wait between arriving and the arrive-by time (the **early wait**) counts. The car time is the drive time for the same pair. No journey that arrives in time within the limits is no service (FR-12).
- **FR-22 Basemap choice.** The map can be shown as Light, Streets (with building outlines and place names), Dark or Satellite, whatever the app's light or dark theme. The choice is remembered. Each basemap's credit is shown.

### Non-functional requirements

- **NFR-1 Speed.** An analysis of 5,000 sample points and 3 points of interest finishes within 5 minutes on the development machine, with the progress shown at least every few seconds.
- **NFR-2 Memory.** The road router fits on the development machine (16 GB, shared with Postgres, the API and the web app). If it cannot share the journey router's process, it runs as its own process (A5).
- **NFR-3 Limits.** An analysis is refused before it starts if it would have more than 10,000 sample points or more than 10 points of interest, with a message saying why.
- **NFR-4 Sameness.** Running the same analysis twice on the same timetable gives the same results.
- **NFR-5 Privacy.** No coordinates are sent outside the machine once FR-13 is built.
- **NFR-6 Plain English.** All UI text follows the project's writing style (British spelling, no jargon).

## 2. Why we are writing the feature

The editor can change the timetable and simulate passengers, but it cannot answer a simple planning question: which places are poorly served by public transport for the trips people need to make? Comparing public transport with driving gives a fair yardstick, because it allows for distance: a 40-minute bus ride is good if the drive takes 35 minutes and poor if it takes 10.

Who benefits: the owner, to find areas to improve and to test scenarios against them, and the readers of reports that use the maps.

Success:

- The access ratios for places the owner knows match expectations (for example central Newcastle well served, outer suburbs poorly served).
- An analysis of a suburb-sized zone runs in minutes (NFR-1).
- The maps are clean enough to put in a report (FR-19).
- The editor no longer sends coordinates to the public OSRM server (NFR-5).

## 3. How the feature should work

### Main flow

1. The owner opens **Access analysis** (a new panel, like the Simulation panel).
2. They draw a zone by clicking its corners on the map and closing it, and name it, for example "Mayfield". Or they pick a saved zone.
3. They place points of interest by clicking the map and naming each, for example "Newcastle city centre" and "Westfield Kotara". Or they pick saved ones.
4. They choose the timetable (the baseline, or a scenario of it), the departure time (for example 08:00), and the grid spacing (for example 250 m). The screen shows "312 sample points, 2 points of interest: 624 public transport journeys and 624 drives".
5. They check or change the public transport limits and car settings (FR-8, FR-9).
6. They press **Run**. A progress bar shows how far it has got. They can carry on using the editor or cancel.
7. When it finishes, the map shows the zone with coloured bands and lines of equal access ratio for the first point of interest, the legend, and the summary figures. They switch points of interest with a list.
8. They click a sample point to see its journey, car path, times and time split.
9. They export, or reopen it later from the list of analyses, or compare it with another analysis.

### Alternative flows

- **Compare:** the owner picks two finished analyses of the same zone and point of interest. The map shows where the access ratio fell (better) or rose (worse), in a diverging colour scale, with no service changes marked.
- **Scenario:** the owner runs the same analysis on a scenario. The scenario's timetable is loaded into the journey router as the simulator already does.

### Edge cases and errors

- A zone that crosses itself is refused when drawn.
- A spacing that gives no sample points inside the zone, or more than NFR-3 allows, is refused with the count shown.
- A sample point that is in water or has no road nearby: if the road router cannot find a road within a set distance, the car time is missing and the pair is shown as "no road" (kept out of the lines, like no service).
- The journey router or the road router is not running: the analysis does not start, and the message says which one.
- A scenario whose timetable cannot be loaded: the analysis fails with the router's message.

## 4. Definition of done

- **AC-FR-1.1** Given the road router with Opal-area data, when a drive from Mayfield to Newcastle city centre is asked for, then it returns a time between 5 and 20 minutes, a distance, and a path along roads.
- **AC-FR-2.1** Given 100 starting points and 3 ending points, when a table is asked for, then it returns 300 times and distances in one request.
- **AC-FR-3.1** Given an OpenStreetMap extract, when the preparation command is run, then the road router's data is written into `data/` and the router loads it.
- **AC-FR-13.1** Given `ROUTER_URL` pointing at the journey router, when a bus line is drawn in the editor, then its path follows roads as before, and no request goes to the public OSRM server.
- **AC-FR-4.1** Given a drawn and named zone, when the panel is reopened, then the zone can be picked; renaming and deleting work.
- **AC-FR-4.2** Given a polygon that crosses itself, when it is closed, then it is refused with a message.
- **AC-FR-5.1** Given points of interest placed and named, when the panel is reopened, then they can be picked; moving, renaming and deleting work.
- **AC-FR-6.1** Given a zone and spacing, then the screen shows the sample point count and the journey count before running.
- **AC-FR-7.1** Given a square zone 1 km across and a spacing of 250 m, then the sample points are an even grid inside it (16 points, give or take the edges).
- **AC-FR-8.1** Given a longest walk of 400 m, when the analysis runs, then no journey walks more than 400 m to or from a stop.
- **AC-FR-9.1** Given a departure in the morning peak, a traffic factor of 1.4 and a parking allowance of 5 minutes, then the car time is the drive time × 1.4 + 5 minutes.
- **AC-FR-10.1** Given a running analysis, then progress is shown and updates; when cancelled, it stops and is marked cancelled.
- **AC-FR-11.1** Given a sample point with a 30-minute public transport journey and a 15-minute car time, then its access ratio is 2.0.
- **AC-FR-12.1** Given a sample point with no journey within the limits, then it is shown as no service and not used for the lines.
- **AC-FR-14.1** Given a finished analysis, then the map shows lines at the chosen ratios over the zone with coloured bands, and switching point of interest changes the map.
- **AC-FR-15.1** Given a finished analysis, when a sample point is clicked, then its journey legs and lines, the car path, both times, the ratio and the walk/wait/ride split are shown.
- **AC-FR-16.1** Given a finished analysis, when the editor is restarted, then it is listed and reopens with the same results.
- **AC-FR-17.1** Given two analyses of the same zone and point of interest, when compared, then sample points whose ratio fell are shown as better and those whose ratio rose as worse.
- **AC-FR-18.1** Given a finished analysis, when exported, then the CSV has one row per sample point and point of interest with both times and the ratio, and the GeoJSON files open in a GIS.
- **AC-FR-19.1** Given the results map, then a legend, the settings and the OpenStreetMap credit are visible.
- **AC-FR-20.1** Given a finished analysis, then the counts per band and no service add up to the number of sample points, and the median is shown.
- **AC-FR-21.1** Given an arrive-by time of 08:00 and a sample point whose latest bus in time arrives at the point of interest at 07:35 after leaving the sample point at 07:05, then the public transport time is 55 minutes, of which 25 are early wait.
- **AC-FR-21.2** Given the same sample point, point of interest and timetable, then the arrive-by journey found leaves no earlier than a depart-at search would need to arrive by 08:00 (no later departure arrives in time).
- **AC-FR-21.3** Given an arrive-by analysis, then its settings, legend, export and comparison say "arrive by" and the time, and an arrive-by analysis and a depart-at analysis are not offered for comparison as if they were alike without saying so.
- **AC-FR-22.1** Given the map, when Streets, Satellite, Dark or Light is chosen, then the basemap changes, the network and analysis layers stay on top, the credit changes, and the choice is kept after a reload.
- **AC-FR-4.4** Given saved zones and points of interest around Newcastle and the map looking at Dee Why, when a new analysis is set up, then the lists show only those around Dee Why with a count of the others, and Show all lists every one.
- **AC-FR-4.3** Given a saved zone, when a corner is dragged, then the zone's outline is saved with the new corner, and analyses already run keep their old outline.
- **AC-NFR-1.1** Given 5,000 sample points and 3 points of interest on the development machine, then the analysis finishes within 5 minutes.
- **AC-NFR-3.1** Given settings that would make 10,001 sample points, then Run is refused with the reason.
- **AC-NFR-4.1** Given the same analysis run twice, then the results are identical.
- **AC-NFR-5.1** Given `ROUTER_URL` pointing at the journey router, then no request leaves the machine while drawing lines or running analyses.

Also done when:

- **The owner's check:** an analysis of a zone around Mayfield (Newcastle) with points of interest at Newcastle city centre and Westfield Kotara, on the baseline, shows a clear map, captured in screenshots in the pull request.
- The glossary, `docs/codebase-map.md`, `services/router/README.md` and `PLAN.md` are updated.
- All existing tests still pass.

## 5. Standards and tests the feature must pass

- The project's rules in `CLAUDE.md` and `docs/architecture/system.md` §14: feature folders, files under 300 lines, no `any`, erasable TypeScript, `.ts` import extensions, Java built with `-Xlint:all -Werror`.
- Logic that needs no database (the sample grid, the access ratio, the traffic factor, the lines of equal ratio) lives in `packages/core` with unit tests beside it.
- Java: unit tests for the road module with a small OpenStreetMap fixture; a service test for the new endpoints.
- API: an end-to-end test on the small test feed (`test:e2e:fixture`) that creates a zone and points of interest, runs a small analysis against a running journey router, and checks the results' shape. Where the router is not available, the step is skipped with a message.
- UI: a scripted browser test (`test:ui` style) that draws a zone, places points of interest, runs and shows the map, with screenshots.
- Regression: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `test:e2e:fixture`, and the router's Gradle tests.

## 6. Strategic fit, required changes, and future-proofing

### How it fits

- **Journey router** (`services/router`): the empty `router-road` module (phase 6 of its plan) gains the road router, and the service gains road endpoints beside `/v1/journeys` and `/v1/journeys/bulk`, which already give the public transport side.
- **Editor API** (`apps/api`): a new feature folder for zones, points of interest and analyses, with tables added by a numbered migration (T-16). Running an analysis follows the pattern of simulation runs (`apps/api/src/sim/`): a job with progress, stored results.
- **Web app** (`apps/web`): a new feature folder with the panel, the drawing tools and the map layers.
- **Core** (`packages/core`): the pure logic and its tests.

### Other changes needed

- A numbered migration for the new tables.
- The road data preparation command and its documentation.
- `ROUTER_URL` pointing at the journey router by default, and the public OSRM server removed from `.env` examples.
- OpenStreetMap credit in the map.

### Risks

- **Memory (NFR-2).** Road data for the Opal area plus the timetables may not fit beside Postgres and the dev servers. Mitigation: A5.
- **Road data download.** OpenStreetMap extracts are large. Mitigation: cut to the Opal area once and keep only what is needed.
- **Speed (NFR-1).** 15,000 public transport journeys and 15,000 drives in 5 minutes depend on the bulk endpoints. Mitigation: one table request per point of interest for drives; the existing bulk endpoint for journeys.
- **Ratio meaning near the point of interest.** A sample point next to a point of interest has very short times, so its ratio is noisy. Mitigation: shown as is; a later version may set a floor.

### Future-proofing

- Keep the sample points, the ratio and the lines of equal ratio separate, so other measures (for example journey time alone, or number of changes) can be mapped the same way later.
- Store results per sample point and point of interest, not only the lines, so comparison and export work from the same data.
- Points of interest have a kind and a source, so a dataset can supply them later.

### Suggested phasing

1. Road routing in the journey router (FR-1 to FR-3).
2. The editor's road requests moved to it (FR-13).
3. Zones, points of interest and running an analysis (FR-4 to FR-12).
4. The results map, one sample point, legend and summary (FR-14, FR-15, FR-19, FR-20).
5. Saving, comparing and export (FR-16 to FR-18).
