# BRD: Edits you can trust and check

| | |
|---|---|
| Date | 23 Nov 2026 |
| Status | **Approved** |
| Version | 1.1 |
| Owner | Project owner |
| Source | Code review of 23 Nov 2026 (schedule editing, network editing, import and export) and the owner's answers the same day |

**Glossary terms used** (`docs/glossary.md`): Baseline, Call, Clash, Closure, Detour, Dwell, Edit, Estimate, Line, Mode, Part, Pinned trip, Platform, Ripple, Run time, Scenario, Station, Stop, Stop across the road, Stop pattern, Trip, Turn-back stop, Vehicle day, Vehicle type.

**New terms proposed** (added to the glossary marked "proposed"): **Change list**, **Minimum turnaround**, and **new end** (inside the Turn-back stop entry).

**Assumptions**

- A1. Edits applied before this work ships show their trip-by-trip change list, but without reasons: "Reasons were not recorded for this change" (changed in 1.1, AI-3).
- A2. "Flagged" means listed in the preview and in the change list. A flag never blocks an edit or an export.
- A3. Minimum turnarounds are one editor-wide setting per mode, not one per scenario.
- A4. Starting values for the minimum turnaround are the ones vehicle chaining already uses (`packages/core/src/vehicle-days.ts`): 2 minutes for train, metro, light rail and ferry, 1 minute for bus and coach.
- A5. The editor's purpose is "what if" scenarios for the passenger simulator. Strict GTFS conformance beyond what the simulator and the journey router read is not a goal of this work.
- A6. The change list of an undone edit is not shown. It is deleted with the edit when a new edit discards the redo history.

**Open questions**

- Q1. Are the starting minimum turnarounds in A4 right? Rail termini often need 5 minutes or more for the driver to change ends.
- Q2. For a run time learned from published trips (FR-5), how close must their path length be to the new stretch's? This BRD assumes within 10%.
- Q3. Should the turnaround clash (FR-23.3) be reported for published trips the scenario did not touch? This BRD assumes not, as for every other clash.

**Issues and discrepancies**

| ID | Found | Who acts | State |
|---|---|---|---|
| I-1 | `PLAN.md` "Rules by mode" promises minimum turnaround, valid terminating station and a berth count per ferry wharf. None is checked in the code; only overlaps are. This BRD adds the minimum turnaround (FR-23) and flags new ends (FR-18). Berth counts are not covered: build them, or take them out of the plan? | Owner | Open |
| I-2 | `PLAN.md` "Simulator readiness" says the export carries a network graph, transfers generated from distance and editable, stable ids for links and vehicle days, and repositioning runs, and that the catalogue has door counts and dwell characteristics. None of these exists. The journey router works out walks itself (`services/router/README.md`), so some may no longer be needed. Does the simulator need them, or is the plan out of date? | Owner, then architect | Open |
| I-3 | `PLAN.md` "Core concepts" says the edit log allows later rebasing. `scenario_edits` keeps only each edit's kind and summary, so edits cannot be replayed. `docs/architecture/system.md` 5.3 already says so (decision D3). `PLAN.md` is out of date. | Developer (doc fix) | Open |
| I-4 | Changes in the vehicle catalogue (capacity, fleet size) apply to every scenario at once and cannot be undone. Is that intended, or should they be scenario edits? | Owner | Open |
| I-5 | `PLAN.md` phase 4 says new stretches are "straight for other modes"; they follow track. It also names `apps/api/src/delete-stop.ts`, which is now `apps/api/src/scenarios/edits/delete-stop.ts`. | Developer (doc fix) | Open |
| I-6 | The ripple option reads "every later trip on the line", but only trips in the same direction move (`scenarios.ts:1103`). | Resolved by FR-22 | Resolved 23 Nov 2026 |
| AI-1 | (From the architect.) FR-20 v1.0 said only whole modes could be left running. In fact a drawn closure already lets any line in any mode be left running; the gap is that the panel lists only the first 60 lines. | Owner | Resolved 23 Nov 2026: FR-20 reworded (1.1) |
| AI-2 | (From the architect.) Clashes are counted against every trip a scenario owns, not only trips it changed, so re-planning vehicles or choosing a line's vehicle type turns the feed's own clashes into scenario clashes. | Owner | Resolved 23 Nov 2026: count only trips that differ from their published origin; FR-24 added (1.1) |
| AI-3 | (From the architect.) The chosen design can show older edits trip by trip, only without reasons. | Owner | Resolved 23 Nov 2026: FR-16 and A1 changed (1.1) |
| AI-4 | (From the architect.) The minimum turnaround should also be used when the editor assigns vehicles in a scenario, or a raised setting makes the editor's own chains clash. | Owner | Resolved 23 Nov 2026: added to FR-23 (1.1) |

**Change log**

| Version | Date | What changed | Why | IDs | Approved by |
|---|---|---|---|---|---|
| 0.1 | 23 Nov 2026 | Created | Code review found hidden behaviour and promises the code does not keep; owner asked for fixes, a way to see what an edit did, and rules for deleting stops, closures and ripple | Added FR-1 to FR-23, NFR-1 to NFR-5 | — |
| 1.0 | 23 Nov 2026 | Approved as written. I-1, I-2 and I-4 stay open: they are outside this BRD's scope and block none of its requirements. Q1 to Q3 stay open; the assumptions A4, the 10% in FR-5 and the rule in FR-23.3 apply until answered | Owner approval | None changed | Owner, 23 Nov 2026 |
| 1.1 | 23 Nov 2026 | FR-16 and A1: older edits show their trips without reasons. FR-20: every line crossed can be chosen, however many. FR-23: also used when assigning vehicles. FR-24 added: clashes count only trips that really changed. New criteria AC-FR-16.1 (changed), AC-FR-20.2, AC-FR-23.3, AC-FR-24.1, AC-FR-24.2 | The architect's issues AI-1 to AI-4, agreed by the owner | Changed FR-16, FR-20, FR-23; added FR-24 | Owner, 23 Nov 2026 |

---

## 1. Requirement of the feature

### What is being built

Three things, in this order:

1. **Fixes** for the problems the 23 Nov review confirmed, each with a test (part A).
2. **A change list** for every edit, so the owner can see trip by trip what an edit did and which rule or estimate it used, in the editor and on the map (part B).
3. **Agreed rules** for deleting stops, closures and ripple, replacing rules that were first guesses (parts C to E).

### Users

The project owner, editing scenarios to feed the passenger simulator. There are no logins and no other roles yet.

### In scope

Parts A to F below. Part F (clashes) was added in 1.1.

### Out of scope

- Better vehicle planning across the parts of a split line and nearby lines. The owner wants it (vehicle counts should be believable as a cost), but it is large enough to need its own BRD. This is the next stage after this one.
- A "check this scenario" button and a downloadable change file. Neither was chosen; both are easy to add later.
- Ferry berth counts, the network graph file, transfers and the other items under I-1 and I-2, until the owner decides.
- Detecting bridges and tunnels automatically.

### Functional requirements

**Part A: fixes from the review**

- **FR-1 New trips are copied from an unedited trip.** When a frequency change, a whole-line frequency change or "add a trip" makes new trips, the trip it copies is the one nearest the time wanted among trips no edit has changed. Only if there is none does it copy an edited trip, and then the change list says which one and why. Today it can copy a trip whose stop was skipped or platform moved, and every new trip inherits that (`scenarios.ts:1340`, `930`; `schedule.ts:276`).
- **FR-2 Platform clashes include calls that only touch.** Two calls at one platform clash when they share any moment, including a train arriving at the same second another leaves. Today the test is strict and misses these, most often at first and last stops (`scenarios.ts:1414`; `schedule.ts:142`). When new trips are moved off busy platforms, the clash list is checked again before each move, so only as many trips move as needed.
- **FR-3 The vehicle warning gives the real change.** "Work out the vehicles again" and any other edit that asks before adding ten or more vehicles count the change in the number of vehicles, not the number of vehicles rebuilt. A line going from 82 to 57 vehicles does not ask, and never says "would add 57" (`scenarios.ts:339`).
- **FR-4 A copy of a trip that is no longer there is refused.** "Add a copy" of a trip that is replaced, removed, or belongs to another scenario or day is refused with a message, as every other edit already is (`scenarios.ts:1177`).
- **FR-5 Run times are learned only from comparable journeys.** A new stretch between two stops is timed from published trips only when they call at the first stop and next call at the second (passing without stopping in between is allowed), and their path between the two is within 10% of the new stretch's length (Q2). Today any trip that reaches the second stop later in its run counts, whatever way it went (`timings.ts:174`). So "take the direct road" past a loop keeps the old time, and a bus turned round before a closure saves nothing.
- **FR-6 No call is ever left at a deleted stop.** Choosing the stop across the road for a new or changed line skips deleted stops (`reshape.ts:142`). If an export meets a call at a deleted stop, it stops with an error naming the trip, rather than dropping the call quietly.
- **FR-7 Deleting a platform keeps turnaround waits.** When calls move off a deleted platform, a train that waited there between trips holds its new platform for the whole wait, and its arrival and its next departure go to the same platform (`delete-stop.ts:304`, `340`).
- **FR-8 Re-importing a day cannot lose scenarios.** `npm run import -- --replace` either finishes completely or leaves the database as it was, scenarios included. Today it deletes first and then runs about 20 steps with no way back (`packages/gtfs/src/import/baseline.ts:61`).
- **FR-9 The vehicle files in an export are checked.** `export:check` checks that every trip and vehicle type in `editor_trip_vehicles.txt` and `editor_vehicle_types.txt` exists. Each changed trip's row there carries the published trip id it came from, so runs can be compared across scenarios.
- **FR-10 A line's vehicle type carries to trips added later.** After a vehicle type is chosen for a line, trips added to that line later (a copy, a frequency change, "add a trip") run with that type, not their template's (`scenarios.ts:1073`).
- **FR-11 "Depart at" can cross midnight.** Typing a departure time moves a trip to the nearest such time, either side of midnight. Today 23:50 to 00:10 is refused as a change of minus 23.7 hours (`TripEditTools.tsx:80`).

**Part B: seeing what an edit did**

- **FR-12 Every edit records a change list.** When an edit is applied, the editor records each trip it added, removed or changed. For each trip it records the line, direction and stop pattern; the vehicle before and after; each call's old and new arrival, departure and platform; and the reason for each change (see FR-13).
- **FR-13 Every estimate is flagged with its source.** Each made-up value in a change list says where it came from:
  - a run time: published trips (how many), nearby services, the mode's typical speed, or a detour scaled by length;
  - a platform: kept, chosen as free, or the least busy;
  - a vehicle: kept, an existing free vehicle, or a new one;
  - a detour: the routing server's path, or none found.
  The new end flag (FR-18, FR-19) also shows here.
- **FR-14 The change list is shown in the editor, per edit.** Clicking an edit in the scenario's change history opens its change list: a count of trips added, removed and changed by line; then each trip, which opens to show its calls old against new, with estimates marked.
- **FR-15 An edit can be shown on the map.** From an edit's change list, the map can show what that edit moved, cut or added: lines changed, trips added or removed, stops deleted or added, and new ends.
- **FR-16 Older edits show their trips without reasons.** Edits applied before this work show their trip-by-trip change list like any other, with "Reasons were not recorded for this change" in place of the reasons and estimates (A1).

**Part C: deleting stops**

- **FR-17 A stop in the middle of a line is skipped (confirms today's rule).** Trips no longer call there and keep their path. The time saved is the median of published trips that already pass it without stopping (three or more, on a path of the same length). Failing that, it is the old time less the dwell and the allowance "skip a stop" uses, labelled estimated and held back by the speed limits in `PLAN.md` phase 4. Buses are never moved to another stop. No stretch takes longer than before or less than half as long.
- **FR-18 A deleted end stop cuts trips back, and new ends are flagged.** A trip that started or ended at a deleted stop now starts or ends at the stop next to it on the trip, at the times it had there (today's rule). The preview and the change list list every line whose trips now end at a stop where no published trip of any line ends, called a **new end**, with the stop's name and how many trips end there.

**Part D: closures**

- **FR-19 Cut-short trips follow the same rule, with the same flag.** When a closure splits a line, each part turns back at the last stop before the closure (today's rule), and any turn-back stop that is a new end is flagged as in FR-18.
- **FR-20 Every line crossed can be chosen, however many there are.** A drawn closure already lets any one line, in any mode, be split, sent round (buses and coaches) or left running. But the panel lists only the first 60 lines, so on a closure crossing more (the Harbour Bridge crosses 62) the rest cannot be chosen. Every line crossed must be reachable in the list. (Reworded in 1.1, AI-1.)

**Part E: ripple**

- **FR-21 The vehicle ripple can soak up delay.** "This vehicle's later trips" offers two choices:
  - **Soak up the delay** (the default): each later trip of the vehicle leaves at its own time, or at the previous trip's arrival plus the minimum turnaround, whichever is later. It stops at the first trip that needs no change.
  - **Full delay all day** (today's rule): every later trip moves by the whole amount.
- **FR-22 The line ripple can move both directions.** "Every later trip on the line" offers two choices:
  - **Both directions** (the default): every trip of the line, in either direction, that starts at or after the retimed trip's old start moves by the same amount.
  - **This direction only** (today's rule).
- **FR-23 Minimum turnaround per mode.** There is one minimum turnaround setting per mode, which can be changed (A3, A4, Q1). It is used:
  - by "Soak up the delay" (FR-21);
  - by the one-click fix for a vehicle clash, in place of today's fixed 60 seconds (`scenarios.ts:1749`);
  - as a new clash: a vehicle in a scenario trip that leaves less than the minimum turnaround after its previous trip arrives (Q3);
  - as the least gap between trips when the editor gives trips vehicles in a scenario (copies, frequency changes, new lines, "work out the vehicles again", closures), so its own vehicle chains never break the setting (added in 1.1, AI-4).

**Part F: clashes (added in 1.1)**

- **FR-24 Clashes count only trips that really changed.** A clash is listed only where at least one trip involved differs from its published origin: different calls, times, platforms or vehicle, or no published origin at all. Copying a trip without changing it is not a change. Today every trip the scenario owns counts, so "work out the vehicles again" and choosing a line's vehicle type, which copy trips, turn clashes already in the published timetable into scenario clashes (AI-2).

### Non-functional requirements

- **NFR-1 No regressions.** Every existing suite passes: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e:fixture`, `npm run test:e2e`, `npm run test:ui`, and `npm run export:check` on the published day.
- **NFR-2 Speed.** Recording change lists adds no more than 20% to the time to apply an edit; the Harbour Bridge closure (about 21 s, 2,974 trips) is the yardstick. An edit's change list opens within 2 seconds, showing trips a page at a time.
- **NFR-3 Space.** Change lists are deleted with their edit (when the redo history is discarded, or the scenario or day is deleted). A change list stores only trips that differ from before the edit.
- **NFR-4 Plain English.** UI text uses the glossary's words, plain English and British spelling, as `CLAUDE.md` asks.
- **NFR-5 Where the logic goes.** Rules that need no database (choosing a template trip, soaking up delay, the overlap test, choosing a turn-back stop, describing a change) go in `packages/core` with unit tests beside them, following `CLAUDE.md` and `docs/codebase-map.md`.

---

## 2. Why we are writing the feature

**The problem.** A single edit can change thousands of trips (a Harbour Bridge closure changes 2,974), but the owner sees only a one-line summary. The review on 23 Nov found that several things happen behind the scenes that the owner could not have known:

- new trips can copy an edited trip's skipped stop;
- run times can come from the wrong journeys;
- a new line can call at a deleted stop and lose those calls in the export;
- the line ripple moves only one direction;
- a re-import can lose every scenario on a day.

The owner said: "When I edit the GTFS there is a lot of work that goes on in the background that I can't see or verify."

**Who benefits.** The owner, and anyone who later reads simulator results built on these scenarios.

**The outcome expected.** Scenarios whose run times, calls and vehicles are believable enough to put through the simulator, plus a way to check any edit trip by trip without reading code or the database.

**How success is measured.**

- Every problem in part A has a test that failed before the fix and passes after.
- For any edit, the owner can answer "which trips did this change, by how much, and why" from the editor alone.
- In a hands-on session after this work, the owner checks five real edits (a frequency change, a deleted stop, a deleted terminus, a closure, a ripple) and finds nothing they cannot explain from the change list.

---

## 3. How the feature should work

### Seeing what an edit did (FR-12 to FR-16)

1. The owner opens the Timetable panel and its change history. Each edit is listed with its summary, as now.
2. Clicking an edit opens its change list:
   - a header: "Changed 412 trips on 6 lines; added 3 vehicles; 37 run times estimated; 2 new ends";
   - one row per line: trips added, removed and changed, and vehicles before and after;
   - opening a line lists its trips. Each trip opens to its calls, old against new, with changed values highlighted and estimates marked "estimated (mode's typical speed)" and the like.
3. "Show on map" draws that edit alone: changed lines outlined, deleted and added stops marked, and new ends ringed.
4. An edit made before this work shows the same list, with "Reasons were not recorded for this change" in place of reasons and estimates.

Edge cases:
- An edit that changes nothing (a ripple with nothing after it) says "No trips changed".
- Undoing an edit hides its change list. Redoing it shows the list again.

### Deleting a stop (FR-17, FR-18)

The behaviour is today's, with the new end flag added.

**Example.** Line 999 runs A–B–C–D. The owner deletes D:
- outbound trips end at C, at the times they reached C;
- inbound trips start at C, at the times they left C.

If no published trip of any line ends at C, the preview says "New end: C (line 999, 64 trips). Check a vehicle can turn round here." The same shows in the change list and on the map.

### Closures (FR-19, FR-20)

The preview lists each line crossed, with a choice for each, for every mode:
- bus and coach lines: split, send round, or leave running;
- other modes: split or leave running.

Each part's turn-back stop is shown, and new ends are flagged as for deleting a stop.

### Ripple (FR-21 to FR-23)

**Soak up the delay.** Bus 1 arrives at B at 8:50 and leaves at 9:00. The minimum turnaround for buses is 3 minutes. The owner delays its A→B trip by 12 minutes, so it now arrives at 9:02:
- the 9:00 leaves at 9:05, 5 minutes late;
- at A, its next trip leaves on time if the 5 minutes fit in the wait there;
- the change list shows how much each trip moved.

**Both directions.** The owner moves the 9:00 northbound trip 5 minutes later. Every trip of the line, in either direction, that started at 9:00 or later moves 5 minutes.

**Minimum turnarounds** are set in one place, beside the vehicle catalogue, for each mode.

### Fixes (FR-1 to FR-11)

These change results, not screens. Where a fix changes what an edit does, the change list explains it. For example, FR-1: "Copied from trip 1234 (published), the nearest unedited trip to 08:15."

### Errors

- An export that meets a call at a deleted stop stops with "Trip X calls at deleted stop Y". This should never happen after FR-6, and is there as a safety net.
- A failed re-import says which step failed and that nothing was changed.

---

## 4. Definition of done

**Part A**

- **AC-FR-1.1** Given a stop pattern whose middle trip in a band had a stop skipped, when the frequency in that band is changed, then no new trip skips that stop, and the change list names the trip copied.
- **AC-FR-1.2** Given every trip of the pattern has been edited, when a trip is added, then it copies the nearest one and the change list says it copied an edited trip.
- **AC-FR-2.1** Given a scenario trip whose arrival at a platform is the same second another trip leaves it, then a platform clash is listed.
- **AC-FR-2.2** Given two new trips that clash only with each other on a platform, when they are settled, then only one moves.
- **AC-FR-3.1** Given a line with 82 vehicles that re-plans to 57, when "Work out the vehicles again" is sent with `confirm: false`, then it is applied without asking.
- **AC-FR-3.2** Given an edit that adds 10 or more vehicles net, then it asks first, and the number given is the net change.
- **AC-FR-4.1** Given a trip already replaced in this scenario, or a trip from another scenario, when "Add a copy" names it, then the edit is refused with a message.
- **AC-FR-5.1** Given published trips that reach stop Y from stop X only by a longer way (more than 10% longer), when a new stretch X→Y is timed, then they are not used.
- **AC-FR-5.2** Given a bus line that crosses a closure and comes back, when it is turned round before the closure, then the new stretch is not timed from the line's own trips over the bridge, and the trip is shorter than before.
- **AC-FR-6.1** Given a deleted bus stop D whose partner is S, when a new bus line through S is drawn, then its way back does not call at D.
- **AC-FR-6.2** Given a call at a deleted stop in the database, when the scenario is exported, then the export fails with a message naming the trip and the stop.
- **AC-FR-7.1** Given a train that waits on platform 1 between two trips, when platform 1 is deleted, then both calls move to the same platform, and that platform is not given to another train during the wait.
- **AC-FR-8.1** Given a day with scenarios, when `import --replace` fails partway, then the day and its scenarios are as they were before.
- **AC-FR-9.1** `export:check` fails on an export whose vehicle file names a missing trip or vehicle type, and passes on a correct one.
- **AC-FR-9.2** Each changed trip in `editor_trip_vehicles.txt` gives the published trip id it came from.
- **AC-FR-10.1** Given a vehicle type chosen for a line, when a trip is added to that line, then it runs with that type.
- **AC-FR-11.1** Given a trip departing 23:50, when "Depart at" is set to 00:10, then it moves 20 minutes later.

**Part B**

- **AC-FR-12.1** Given any edit kind (retime, copy, delete trip, skip a stop, frequency, add trip, add a stop, platform, re-plan, vehicle type, reshape, new line, new stop, closure, delete a stop), when it is applied, then its change list holds every trip whose calls, platforms or vehicle differ, and no other trip.
- **AC-FR-13.1** Given a new line timed partly from published trips and partly from the mode's speed, then each stretch in the change list names its source.
- **AC-FR-13.2** Given a closure where one bus line has no way round, then the change list says "no way round was found" for that line.
- **AC-FR-14.1** Given an applied edit, when it is clicked in the change history, then its change list opens with counts by line and trips listed below.
- **AC-FR-14.2** Given a change list of over 2,000 trips, it opens within 2 seconds (NFR-2).
- **AC-FR-15.1** Given a change list, when "Show on map" is clicked, then the lines, stops and new ends of that edit alone are drawn.
- **AC-FR-16.1** Given an edit applied before this work, then its change list shows its trips with old and new calls, and "Reasons were not recorded for this change".

**Parts C and D**

- **AC-FR-17.1** Given a bus stop in the middle of a line is deleted, then trips keep their path, do not call there, and no stretch is longer than before or under half as long. (Today's e2e test keeps passing.)
- **AC-FR-18.1** Given line A–B–C–D where no published trip ends at C, when D is deleted, then the preview and change list show "New end: C" with the trip count.
- **AC-FR-18.2** Given a deleted terminus where the next stop in is already a published end, then no new end is shown.
- **AC-FR-19.1** Given a closure that cuts an express bus back to a stop where no published trip ends, then that stop is flagged as a new end.
- **AC-FR-20.1** Given a closure across two train lines, when one is set to "leave running", then that line is unchanged and the other is split.
- **AC-FR-20.2** Given a closure that crosses more than 60 lines, then every line can be found in the panel and given its own choice.

**Part E**

- **AC-FR-21.1** Given the Bus 1 example (arrives 8:50, leaves 9:00, minimum turnaround 3 minutes), when its trip is delayed 12 minutes with "Soak up the delay", then the 9:00 leaves at 9:05, and later trips move only as far as they must.
- **AC-FR-21.2** The same with "Full delay all day" moves every later trip of the vehicle 12 minutes.
- **AC-FR-22.1** Given "Both directions", when a 9:00 northbound trip moves 5 minutes, then every trip of the line in either direction that started at 9:00 or later moves 5 minutes.
- **AC-FR-22.2** "This direction only" moves only later northbound trips.
- **AC-FR-23.1** Given the bus minimum turnaround is changed to 4 minutes, then "Soak up the delay" and the vehicle clash fix both use 4 minutes.
- **AC-FR-23.2** Given a scenario trip leaving 1 minute after its vehicle's previous trip arrives, with a bus minimum turnaround of 3 minutes, then a turnaround clash is listed.
- **AC-FR-23.3** Given the train minimum turnaround is set to 5 minutes, when a frequency change adds trains, then no vehicle the edit makes or changes leaves less than 5 minutes after its previous trip arrives, and no turnaround clash comes from that edit.

**Part F**

- **AC-FR-24.1** Given a line whose published trips include a platform clash, when "Work out the vehicles again" is applied to it, then the clash count does not rise.
- **AC-FR-24.2** Given a scenario trip retimed onto a platform another trip is using, then the platform clash is listed.

**Non-functional**

- **AC-NFR-1.1** All the suites named in NFR-1 pass.
- **AC-NFR-2.1** Applying the Harbour Bridge closure (split) takes no more than 20% longer than before this work, measured on the development machine.
- **AC-NFR-3.1** After an undo and a new edit, the undone edit's change list rows are gone.
- **AC-NFR-4.1** New UI text is reviewed against the glossary and uses British spelling.
- **AC-NFR-5.1** The rules named in NFR-5 live in `packages/core` with unit tests.

**Also done when:**
- `PLAN.md` "Where we are" and phases 3 and 4 describe the new behaviour, and I-3 and I-5 are fixed in it;
- the proposed glossary entries are marked as built;
- `docs/codebase-map.md` lists any new files.

---

## 5. Standards and tests the feature must pass

**Standards** (from `CLAUDE.md` and `docs/codebase-map.md`):
- New code goes in feature folders, with no barrel files.
- File names: components in PascalCase, everything else in kebab-case.
- Node runs `.ts` directly, so only erasable syntax, with explicit `.ts` imports.
- oxlint and Prettier pass.
- Work goes on a feature branch with a PR, and commits follow the house style with a `Tests:` line.

**Tests expected**

- **Unit** (`packages/core`, vitest): choosing a template trip; the overlap test including touching calls; soaking up delay (no spare, part spare, all spare, past midnight); both-directions ripple selection; new end detection; turn-back stop choice; describing a change (old against new calls); run-time evidence filtering by path length.
- **End-to-end through the API** (`npm run test:e2e`, and `test:e2e:fixture` where the mini feed allows):
  - each AC in part A;
  - a change list for every edit kind (AC-FR-12.1);
  - deleting after a route change and after a closure, and a route change after a deletion (the review found no test that combines edits);
  - a closure that leaves one train line running;
  - both ripple choices.
- **Import**: a failed `--replace` leaves the day and scenarios intact (AC-FR-8.1). Run against the fixture database, not `gtfs_editor`.
- **Export**: `export:check` on a scenario with a new line, an added stop, a deleted stop and a vehicle-type choice, with shapes, plus the vehicle-file checks.
- **Browser** (`npm run test:ui`): open an edit's change list, open a trip in it, show it on the map; choose each ripple option; leave one line running in a closure.
- **Regression**: all existing suites (NFR-1).
- **Speed**: time the Harbour Bridge closure before and after (AC-NFR-2.1), and record it in `PLAN.md`.

---

## 6. Strategic fit, required changes, and future-proofing

### How it fits

- **Edits** already run inside one transaction per edit in `apps/api/src/scenarios/scenarios.ts`, with each new or removed row tagged by the edit's number. The change list can be built at the end of that transaction by comparing the trips the edit removed with the ones it made (`created_edit = seq`), so most edit kinds need no change of their own.
- **Reasons and estimates** (FR-13) are the exception. The code that makes each estimate (`timings.ts`, `roads.ts`, `settlePlatforms`, vehicle chaining, closure planning) must report it, not only use it. This is the bulk of part B.
- The **ripple** changes sit in the shift edit. The minimum turnaround replaces the fixed values in the vehicle clash fix and joins the clash rules.
- The **closure line list** already has per-line choices for buses and coaches; FR-20 widens it to other modes.

### Other changes needed

- **New storage** for change lists, keyed by scenario and edit number and deleted with them (NFR-3). The architect decides its shape. Storing old and new calls only for trips that differ keeps it small.
- **New storage** for the minimum turnaround per mode (`modes` is the natural place).
- **Import**: make `--replace` one transaction, or build the new day beside the old and swap it in at the end.
- **Docs**: update `PLAN.md` (including I-3 and I-5), the glossary and the codebase map.

### Risks

- **Speed.** Recording reasons for 3,000 trips could slow big closures. NFR-2 sets the limit; measure early.
- **Changed results.** FR-1, FR-2, FR-5 and FR-23 change what edits produce, so older scenarios may show new clashes, and run times on a redone edit may differ. Existing scenarios are not rewritten; the change shows only on new edits and in the clash list.
- **New clashes.** FR-2 and FR-23 will show more clashes than today. That is intended, but the owner should expect it.
- **Doing the fixes first.** Part A must land before part B, so that the change lists describe correct behaviour.

### Future-proofing

- One "reason" vocabulary shared by every edit (source of a run time, platform choice, vehicle choice, detour result, new end) makes the change list, a later "check this scenario" button and a later downloadable file the same data shown three ways. Do not build those two now.
- The change list is a natural base for comparing two scenarios trip by trip, and for the simulator to say which edit caused a passenger's change. Keep trip identity (the published id before `~`) in it.
- Better vehicle planning (the next stage) will need the minimum turnaround from FR-23. Keep it per mode now, with room for per-station values later; do not build per-station values yet.

### Suggested phasing

1. **Part A fixes**, each as its own ticket with a failing test first.
2. **Minimum turnaround and ripple** (FR-21 to FR-23).
3. **Change list storage and the editor view** (FR-12, FR-14, FR-16), without reasons.
4. **Reasons and estimates** (FR-13), edit kind by edit kind, and the map view (FR-15).
5. **Deleting and closures** (FR-18 to FR-20), which use the change list for their flags.
