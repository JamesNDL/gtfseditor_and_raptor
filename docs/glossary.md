# Glossary

One plain-English meaning for each word the editor, its documents and its code use about public transport. Requirements (`docs/brd/`), plans and UI text use these words exactly as defined here. If a word is missing or means something different in the code, raise it rather than coining a new one.

Each entry gives the meaning, other names it goes by (and words not to confuse it with), where it lives in the code, the rules that apply to it, and related words. Entries marked **(proposed)** are agreed in an approved requirements document but not built yet; the mark comes off when they are built. Entries marked **(to confirm)** were taken from the code and need the owner's agreement.

Started 23 Nov 2026 from `PLAN.md`, `docs/architecture/system.md` and the code.

---

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

**Clash**: something a scenario has made that cannot happen in real life, such as two trains at one platform at once or a vehicle starting its next trip before it has arrived. A clash is shown with a suggested fix; it never blocks an edit or an export.
- *Also known as*: conflict (in code).
- *In code*: the clash rules in `apps/api/src/scenarios/scenarios.ts`.
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

**Ripple**: what else moves when one trip is retimed: nothing else, the later trips of the same vehicle, or the later trips of the line.
- *In code*: `ripple` on the shift edit in `apps/api/src/scenarios/scenarios.ts`.
- *Business rules*: today "the line" moves only trips in the same direction, and "the vehicle" moves every later trip by the full amount. BRD `trustworthy-edits` makes both choices options.
- *Related*: Minimum turnaround, Vehicle day.

**Run time**: the time a vehicle takes from leaving one stop to arriving at the next.
- *Business rules*: for new stretches it is learned from published trips where three or more run between the two stops; otherwise from the speed of nearby services of the same mode; otherwise from the mode's typical speed. Never faster than the mode can go.
- *In code*: `apps/api/src/routing/timings.ts`; speed limits in `packages/core/src/limits.ts`.
- *Related*: Part of the day, Estimate.

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
