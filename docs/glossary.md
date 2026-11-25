# Glossary

One plain-English meaning for each word the editor, its documents and its code use about public transport. Requirements (`docs/brd/`), plans and UI text use these words exactly as defined here. If a word is missing or means something different in the code, raise it rather than coining a new one.

Each entry gives the meaning, other names it goes by (and words not to confuse it with), where it lives in the code, the rules that apply to it, and related words. Entries marked **(proposed)** are agreed in an approved requirements document but not built yet; the mark comes off when they are built. Entries marked **(to confirm)** were taken from the code and need the owner's agreement.

Started 23 Nov 2026 from `PLAN.md`, `docs/architecture/system.md` and the code.

---

**Access analysis** (BRD `access-analysis`, built 26 Nov 2026): a comparison, over a zone, of how long trips to chosen points of interest take by public transport and by car, shown as a map of access ratios. One analysis is run on one timetable (the published day or a scenario) at one departure time.
- *Also known as*: analysis (in code). "Access" is its pane on the rail.
- *In code*: `analyses` table and its `analysis_pois`, `analysis_points` and `analysis_results` (migration `0010_access_analysis.sql`); `apps/api/src/analysis/` (`runner.ts` runs it); `apps/web/src/analysis/`; pure logic in `packages/core/src/analysis/`.
- *Business rules*: it runs in the background, one at a time, and can be cancelled; one left going when the API stops carries on when it starts. At most 10,000 sample points and 10 points of interest. It copies its zone and points of interest when made, so later changes to them do not change it. Running it twice on the same timetable gives the same results.
- *Related*: Zone, Point of interest, Sample point, Access ratio, Comparison.

**Access ratio** (BRD `access-analysis`, built 26 Nov 2026): the public transport time divided by the car time, for one sample point and one point of interest. 1 means public transport takes as long as driving; 2 means twice as long.
- *In code*: `accessRatio` and `carSecs` in `packages/core/src/analysis/ratio.ts`; `analysis_results.ratio`.
- *Business rules*: the public transport time is door to door from the asked departure time (walking, waiting, riding and changing), so waiting for the first vehicle counts as waiting. The car time is the road router's driving time times the traffic factor, plus the parking allowance. A pair with no service or no road has no access ratio. The map shows it as bands and lines of equal ratio, by default at 1, 1.5, 2, 3 and 4.
- *Related*: Access analysis, Traffic factor, Parking allowance, No service, No road.

**Baseline**: one published day of the TfNSW timetable, imported once and never changed. Every scenario starts from one.
- *Also known as*: the published timetable, a day. Not the same as a *feed*, which is the whole download from TfNSW covering many days.
- *In code*: `baselines` table; `packages/gtfs/src/import/baseline.ts`.
- *Business rules*: one day type at a time. Importing the same date again deletes the baseline and every scenario on it, so the importer refuses unless given `--replace`.
- *Related*: Scenario, Feed.

**Call**: one stop that a trip makes: the stop, the platform, and the arrival and departure times there.
- *Also known as*: stop time (GTFS `stop_times`). Do not confuse with *Stop*, the place itself.
- *In code*: `stop_times` table.
- *Business rules*: times are seconds from the start of the service day and can go past 24:00. A call can be pick-up only, set-down only, or pass without stopping.
- *Related*: Trip, Stop, Dwell.

**Change list** (proposed, BRD `trustworthy-edits`): for one edit, every trip it added, removed or changed, with the old and new times at each stop and the rule or estimate behind each change.
- *Related*: Edit, Estimate.

**Comparison** (BRD `access-analysis`, built 26 Nov 2026): two finished access analyses of the same zone outline and spacing set side by side for one point of interest they share, sample point by sample point. The change is the other analysis's access ratio less the open one's.
- *Also known as*: "Compare with…" (UI text).
- *In code*: `compareRatios` in `packages/core/src/analysis/compare.ts` (kinds `better`, `worse`, `same`, `gainedService`, `lostService`, `bothNone`); `apps/api/src/analysis/compare-read.ts`; `apps/web/src/analysis/results/CompareView.tsx` and `compare-text.ts`.
- *Business rules*: each sample point is one of six kinds, named in the UI as **Better** (the access ratio fell), **Worse** (it rose), **About the same** (it changed by 0.05 or less), **Gained service** (no public transport journey before, one now), **Lost service** (one before, none now) and **No service in either** (no journey, or no road, in either analysis). A zone redrawn between the two runs is a different zone, and they cannot be compared.
- *Related*: Access analysis, Access ratio, No service.

**Clash**: something a scenario has made that cannot happen in real life, such as two trains at one platform at once or a vehicle starting its next trip before it has arrived. A clash is shown with a suggested fix; it never blocks an edit or an export.
- *Also known as*: conflict (in code).
- *In code*: the clash rules in `apps/api/src/scenarios/clashes.ts`.
- *Business rules*: only clashes the scenario caused are listed, not ones already in the published timetable. "Fix all" applies the suggested fixes in turn. Agreed 23 Nov 2026 (BRD `trustworthy-edits` FR-24, not built yet): "caused by the scenario" means at least one trip involved differs from its published origin; a trip copied without change does not count.
- *Related*: Scenario, Minimum turnaround.

**Closure**: a line drawn on the map, for all of the day or part of it, across which services cannot run. Each service it crosses is split into parts, sent round, or left running.
- *In code*: edit kind `close`, `apps/api/src/scenarios/edits/closure.ts`; table `scenario_closures`.
- *Business rules*: a cut splits a line; it does not close stops. It can only be lifted by undoing it.
- *Related*: Part, Detour, Turn-back stop.

**Detour**: a way round a closed road for a bus or coach, between the last stop before the closure and the first stop after it.
- *Also known as*: "send round".
- *In code*: `routedAround` in `apps/api/src/routing/roads.ts`.
- *Business rules*: stops inside the closed area are no longer called at. The extra time is the trip's own time scaled by the extra length, or the mode's typical speed beyond three times the length.
- *Related*: Closure, Run time.

**Dwell**: the time a vehicle spends at a stop, from arriving to leaving.
- *Also known as*: stop time (in UI text). Do not confuse with GTFS `stop_times`, which is a *Call*.
- *Business rules*: bus timetables give no dwell of their own; it is inside the run time.
- *Related*: Call, Run time.

**Edit**: one change to a scenario that can be undone in one step, such as retiming a trip, deleting a stop or drawing a closure.
- *Also known as*: change (in UI text).
- *In code*: `scenario_edits` table, one row per edit with its kind and summary; rows made or removed by it record its number.
- *Business rules*: undo and redo move a pointer (`head`). A new edit after an undo discards the redo history. Edits are applied one at a time. An edit that would add ten or more vehicles is described first and applied only after "Go ahead".
- *Related*: Scenario, Change list.

**Estimate**: a number the editor made up because the timetable gives no evidence, such as a run time from the mode's typical speed. Estimates are labelled "estimated".
- *Related*: Run time, Change list.

**Feed**: the GTFS download from TfNSW, covering many days. A baseline is imported from one day of it.
- *Related*: Baseline.

**Line**: a public transport route that passengers know by a name or number, such as T1, 333 or F1.
- *Also known as*: route (GTFS `routes`, and in code). Do not confuse with *Stop pattern*, one of the ways a line runs.
- *In code*: `routes` table.
- *Related*: Stop pattern, Part.

**Minimum turnaround** (proposed, BRD `trustworthy-edits`): the least time a vehicle needs between arriving at the end of one trip and leaving on its next, set for each mode.
- *Related*: Ripple, Vehicle day, Clash.

**Mode**: the kind of service: train, metro, light rail, ferry, bus or coach.
- *In code*: `modes` table.

**No road** (BRD `access-analysis` edge cases, built 26 Nov 2026): a sample point, or a point of interest, more than 500 m from a road a car may use, so with no car time. It has no access ratio and is left out of the lines of equal ratio, and is drawn as a hollow light grey point.
- *In code*: status `noRoad` (`PairStatus` in `packages/core/src/analysis/ratio.ts`; `analysis_results.status`); the road router's `noRoad` and OSRM-shaped `NoSegment`; the distance is `ROUTER_ROAD_SNAP_METRES`.
- *Business rules*: when a pair has neither a public transport journey nor a road, it counts as no service, not no road.
- *Related*: No service, Access ratio, Road router.

**No service** (BRD `access-analysis`, built 26 Nov 2026): a sample point with no public transport journey to a point of interest within the analysis's limits (longest walk, longest journey, most changes, modes allowed). It has no access ratio and is left out of the lines of equal ratio, and is drawn as a grey point with a white ring.
- *In code*: status `noService` (`pairStatus` in `packages/core/src/analysis/ratio.ts`; `analysis_results.status`).
- *Business rules*: a journey longer than the longest journey allowed is no service, though its time and legs are kept for the sample point's detail.
- *Related*: No road, Access ratio, Sample point.

**Parking allowance** (BRD `access-analysis`, built 26 Nov 2026): minutes added to every car time in an access analysis, for parking and walking from the car. 5 minutes unless changed (0 to 60).
- *In code*: `parkingMins` in `AnalysisSettings` (`packages/core/src/analysis/defaults.ts`).
- *Related*: Access ratio, Traffic factor.

**Part**: one side of a line split by a closure, run as a line of its own and named after the original with the side added (B1 becomes B1-N and B1-S).
- *In code*: a scenario route whose `extra` holds `variantOf` and `side`.
- *Related*: Closure, Line.

**Part of the day**: one of five time bands used for run times: before 06:30, 06:30 to 09:30, 09:30 to 15:00, 15:00 to 19:00, after 19:00.
- *Also known as*: day band.
- *In code*: `DAY_BANDS` in `packages/core/src/time.ts`.
- *Business rules*: a trip uses the run times of the part of the day it sets out in. The frequency editor uses its own bands (05:00 to 23:00), which are not these (to confirm).

**Pinned trip**: a trip placed by hand. A frequency change leaves it where it is and spaces new trips around it.
- *Also known as*: "placed by hand".
- *In code*: `trips.pinned`.

**Platform**: one place within a station where a train, tram or ferry stops; a wharf berth for ferries.
- *In code*: a row in `stops` under a station.
- *Related*: Station, Stop.

**Point of interest** (BRD `access-analysis`, built 26 Nov 2026): a place people need to reach, such as a hospital or a shopping centre, placed on the map and named. It is saved and can be reused, moved, renamed and deleted, and may lie outside the zone.
- *Also known as*: POI (in code).
- *In code*: `points_of_interest` table; `apps/api/src/analysis/places-routes.ts`; `apps/web/src/analysis/setup/PoiPicker.tsx`. An analysis keeps its own copy in `analysis_pois`, numbered by `seq` (the `poi` of the results CSV), with the saved one's id in `poi_id` (the `poi` a comparison asks for).
- *Business rules*: it has a kind and a source, so that a dataset can supply them later; today every one is drawn by hand. It belongs to no day.
- *Related*: Access analysis, Zone.

**Ripple**: what else moves when one trip is retimed: nothing else, the later trips of the same vehicle, or the later trips of the line.
- *In code*: `ripple` on the shift edit in `apps/api/src/scenarios/edits/shift.ts`.
- *Business rules*: today "the line" moves only trips in the same direction, and "the vehicle" moves every later trip by the full amount. BRD `trustworthy-edits` makes both choices options.
- *Related*: Minimum turnaround, Vehicle day.

**Road router** (BRD `access-analysis`, built 26 Nov 2026): the part of the journey router that plans drives along OpenStreetMap roads, and answers the editor's road requests in place of the public OSRM server.
- *Also known as*: the address in `ROUTER_URL`. Not the same as the journey router's public transport side (`ROUTER_SERVICE_URL`), though both run in the same Java service unless the road side runs on its own (the road-only process, `npm run router:road`, port 3003).
- *In code*: `services/router/router-road` (GraphHopper behind `RoadRouter`); `RoadApi.java` and `OsrmApi.java` in `router-server`; called from `apps/api/src/routing/roads.ts` and `apps/api/src/analysis/road-client.ts`. Its data is built by `npm run road:data` into `data/router/road/opal`.
- *Business rules*: driving times are free-flow (no traffic), for cars only. A point more than 500 m from a road a car may use has no road. OpenStreetMap is credited wherever its results are shown.
- *Related*: Traffic factor, Access ratio.

**Run time**: the time a vehicle takes from leaving one stop to arriving at the next.
- *Business rules*: for new stretches it is learned from published trips where three or more run between the two stops; otherwise from the speed of nearby services of the same mode; otherwise from the mode's typical speed. Never faster than the mode can go.
- *In code*: `apps/api/src/routing/timings.ts`; speed limits in `packages/core/src/limits.ts`.
- *Related*: Part of the day, Estimate.

**Sample point** (BRD `access-analysis`, built 26 Nov 2026): one point of the even grid laid over a zone, from which trips to each point of interest are timed.
- *In code*: `analysis_points` table (with its grid column and row, `i` and `j`); `sampleGrid` and `gridCount` in `packages/core/src/analysis/grid.ts`.
- *Business rules*: points are the centres of square cells at the chosen spacing in metres (250 unless changed, 50 to 2,000), from the south-west corner of the zone's box, and only those inside the zone are kept. They are not weighted by population.
- *Related*: Zone, Access analysis.

**Scenario**: a "what if" version of a baseline: the baseline plus a list of edits. Scenarios never affect each other.
- *In code*: `scenarios` table; changed trips are new rows owned by the scenario and the originals are marked replaced.
- *Related*: Baseline, Edit.

**Station**: a place with one or more platforms or stops grouped under it. In the feed every stop, bus stops included, sits under a station; for a bus stop the "station" is usually the pair of stops either side of the road.
- *In code*: a `stops` row with `location_type = 1`.
- *Related*: Platform, Stop, Stop across the road.

**Stay-aboard link**: two trips run by the same vehicle where passengers can stay on, such as a T8 becoming a T1 at Central.
- *Also known as*: block (GTFS `block_id`).
- *Business rules*: kept in an export only where the two trips still meet.
- *Related*: Vehicle day.

**Stop**: a place where passengers board or leave a vehicle: a bus stop, or a platform.
- *Do not confuse with*: *Call*, a trip's visit to a stop.
- *In code*: `stops` table. Stops the scenario added are rows owned by it; deleted stops are rows in `scenario_removed_stops`.
- *Related*: Station, Platform.

**Stop across the road**: for a bus stop, the stop on the other side of the road that the opposite direction of the same lines uses.
- *Also known as*: partner (in code, `partner_id`).
- *Related*: Stop, Station.

**Stop pattern**: one ordered list of stops that some of a line's trips run. A line with branches or short workings has several.
- *Also known as*: pattern (in code).
- *In code*: `patterns` table.
- *Related*: Line, Trip.

**Traffic factor** (BRD `access-analysis`, built 26 Nov 2026): the number a free-flow driving time is multiplied by to allow for traffic, set for each part of the day. Starting values: 1.0 before 06:30 and after 19:00, 1.4 in the morning and evening peaks, 1.2 in the middle of the day.
- *In code*: `trafficFactors` in `AnalysisSettings` (`packages/core/src/analysis/defaults.ts`); `trafficFactorAt` in `ratio.ts` picks the one for the departure time.
- *Related*: Part of the day, Access ratio, Parking allowance.

**Trip**: one run of a vehicle along a line from its first stop to its last.
- *In code*: `trips` table. Each scenario change makes a new trip row with a new id; the published id is kept before the `~`.
- *Related*: Call, Vehicle day, Stop pattern.

**Turn-back stop**: the stop where a trip that has been cut short now ends or starts, because its end stop was deleted or a closure cut the line.
- *Business rules*: today, the next stop in from the old end (deleting) or the last stop before the closure (closures). BRD `trustworthy-edits` flags any turn-back stop where no published trip ends, as a **new end**.
- *Related*: Closure, Clash.

**Vehicle day**: one vehicle's trips for the day, in order.
- *Also known as*: vehicle, chain. The vehicle count is the number of these, not the number of physical vehicles needed at once.
- *In code*: `vehicle_days` table; built at import by `packages/core/src/vehicle-days.ts`.
- *Business rules*: the feed does not give them, so they are inferred: from run numbers for suburban trains, and by chaining trips for other modes. Inferred chains are a plausible guess, not real rosters.
- *Related*: Trip, Stay-aboard link, Minimum turnaround.

**Vehicle type**: a kind of vehicle with its number of cars and seated and standing places, from the vehicle catalogue.
- *In code*: `vehicle_types` table; `apps/api/src/catalogue/routes.ts`.
- *Business rules*: every trip resolves to exactly one type: trip, then vehicle day, then line, then mode. Capacities are placeholders until set. Changes in the catalogue apply to every scenario at once (to confirm).
- *Related*: Vehicle day.

**Zone** (BRD `access-analysis`, built 26 Nov 2026): an area drawn on the map as a polygon and named, over which an access analysis lays its sample points. Saved and reusable; it can be renamed and deleted.
- *In code*: `analysis_zones` table; `apps/api/src/analysis/places-routes.ts`; `ringProblem` in `packages/core/src/analysis/polygon.ts`; `apps/web/src/analysis/setup/ZonePicker.tsx` and `ZoneDrawing.tsx`.
- *Business rules*: an outline that crosses itself is refused. 3 to 200 corners. It belongs to no day. Its outline cannot be changed once saved (only its name); a redrawn zone is a new one.
- *Related*: Sample point, Access analysis. Not the same as a simulation's area, which is a box.
