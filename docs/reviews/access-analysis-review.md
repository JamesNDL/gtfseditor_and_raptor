# Peer review: access analysis (EP-15 to EP-20, AA-1 to AA-24), and the owner's check (AA-26)

| | |
|---|---|
| Tickets | The whole access analysis feature as merged on `feature/access-analysis` (AA-1 to AA-24; AA-25 is docs, still in progress on its own branch). AA-26, the owner's check, run here. Every ticket is Light tier in the tracker (dev only, no production, IAM or data deletion); the owner asked for a peer review of the whole feature before the pull request, so this is a proportionate Full-style review. |
| Reviewer | Peer reviewer agent (Claude) |
| Date | 26 Nov 2026, about 01:25 to 01:50 AEDT |
| Requirements | BRD `docs/brd/access-analysis.md` 1.0; design `docs/architecture/access-analysis.md` 1.0; tickets in `docs/project/access-analysis-tickets.xlsx`. |
| Code reviewed | `git diff refactor/stage-3...feature/access-analysis` at `504fc45` (154 files less the tracker xlsx, listed in `access-analysis/evidence/changed-files.txt`), on branch `review/access-analysis`. |
| Environment | Windows 11 Pro, Node 24 (type stripping), Java 26 / Gradle through `npm run router:dev`, Postgres in Docker on 5433. The check ran in a throwaway database `gtfs_aa_check` on ports 3111 (API), 3112 (router), 5183 (web). The owner's `gtfs_editor` was only read for the service date (20261121); ports 3001, 3002 and 5173 were not touched. |
| Focus (as asked) | The access ratio, car time and traffic factor maths; the sample grid; the contours; the run pipeline (batches, resume, cancel); API input checks; SQL; the road router endpoints. The web code was read only where the check's screenshots led. |
| Verdict | **Approve with notes**. No blocker. One Major under the house standards rule (F-6, files that were already too long grew by wiring lines), which I judge not blocking; the owner should confirm. |

## 1. Summary

The maths is right and simple. The car time is the free-flow drive times the traffic factor for the departure's part of the day, plus the parking allowance; the access ratio is public transport time over car time; public transport time counts from the asked departure, so waiting at home is waiting (D23). The sample grid is an even grid of cell centres in local metres, and the contours are a careful marching triangles that never let a missing point shape a line. The run pipeline stores one row per pair, works in batches of 1,000 drives and 500 journeys with progress and a cancel check after each, and picks up an unfinished analysis when the API starts again. Inputs are checked at the API edge with plain-English refusals, and SQL is all parameterised.

The owner's check passed on the real data in about 3 minutes end to end. The Mayfield zone, Newcastle city centre and Westfield Kotara are where they should be, and both results maps show clear bands and labelled lines of equal access ratio, with legend, summary, settings line and the OpenStreetMap credit. The ratios look sensible: Mayfield to the city centre has a median of 2.68, to Kotara 3.96. See §7 for my judgement of each screenshot, and the timing of the speed run.

Findings (ranked):

- F-1 **Minor**: a pair can be `ok` with no ratio when its car time is 0 (drive 0 and parking allowance 0). The summary then counts it nowhere, so the counts no longer add up to the sample points (AC-FR-20.1). `packages/core/src/analysis/ratio.ts:62`, `apps/api/src/analysis/run-journeys.ts:231`, `packages/core/src/analysis/summary.ts:265`.
- F-2 **Minor**: `runner.cancel` deletes an analysis's results before it checks the state, so a cancel that loses a race with the run finishing leaves a `done` analysis with no results. `apps/api/src/analysis/runner.ts:211-216`.
- F-3 **Minor**: the sample grid's geometry is worked out twice, once to lay the points (`packages/core/src/analysis/grid.ts:138-150`) and once to rebuild it for the contours (`apps/api/src/analysis/results-read.ts:131-149`). They agree today only because both were written the same way by hand.
- F-4 **Minor**: any list of words is taken as the allowed modes. `["spaceship"]` (or a typo such as `"buss"`) is stored and run, and every pair comes back no service. `apps/api/src/analysis/create-body.ts:38-45`.
- F-5 **Minor (typing)**: the shared API type says a summary band's `from` and `to` are numbers, but the open ends are ±Infinity and go over the wire as `null`. The web works round it with its own type. `packages/core/src/api/analysis.ts:117`, `packages/core/src/analysis/summary.ts:210-215`.
- F-6 **Major (house standards rule), not blocking in my judgement**: three files already over the length limit grew: `apps/web/src/map/MapView.tsx` (2,011 lines, +8), `services/router/router-server/.../RouterServer.java` (738, +23), `apps/web/src/app/store.ts` (335, +13). All the added lines are wiring.
- F-7 **Note**: an outline with a corner repeated straight after itself is refused as "crosses itself" (only reachable through the API; the web drops the repeated click). `packages/core/src/analysis/polygon.ts:153-163`.
- F-8 **Note**: `Settings.from` ignores `ROUTER_DATA` for the road graph's default folder, while `Settings.defaults(data)` uses it. `Settings.java:71` against `:131`.
- F-9 **Note**: names are written into `results.csv` as they are, so a point of interest called `=HYPERLINK(...)` becomes a formula in a spreadsheet. `apps/api/src/analysis/export-rows.ts:104-106`.
- F-10 **Note, for the BA**: the published day the check used is a Saturday, yet the "morning peak" traffic factor of 1.4 applies at 08:00. The traffic factors follow the time of day only, not the day of the week (FR-9 as written). This lowers every ratio on a weekend day.
- F-11 **Note**: `apps/api/src/sim/router-client.ts:19,31` keeps two `any`s, moved unchanged out of `sim.ts` (AA-13). Pre-existing.

Tests run by me: 15 entries; 12 Pass, 3 Pass with a finding. Not run: the per-ticket check that tests were committed before code (each ticket had its own review), and `.\gradlew build` (the router compiled and ran under `router:dev`, which builds the main code only).

## 2. Charter and coverage

| Category | What I tried | Why |
|---|---|---|
| Maths | Read `ratio.ts`, `defaults.ts`, `limits.ts`, `summary.ts`, `compare.ts`; ran `probe-core.ts` on the Mayfield zone and edge values | The ratio is the product; a wrong factor or sign spoils every map |
| Grid and contours | Read `grid.ts`, `local-metres.ts`, `polygon.ts`, `contours.ts`, `contour-lines.ts`, `results-read.ts`; probed bands and lines with a missing point | Lines that are drawn through missing points, or a grid that shifts between laying and drawing, would mislead silently |
| Run pipeline | Read `runner.ts`, `run-drives.ts`, `run-journeys.ts`, `routes.ts`; followed cancel, delete, failure and restart | Long runs, resume and cancel are where state goes wrong |
| API input | Read `create-body.ts`, `create.ts`, `places-routes.ts`, `results-routes.ts`, `export-routes.ts` | Bad input must be refused with a reason, not stored |
| SQL | Read `0010_access_analysis.sql` and every query in `apps/api/src/analysis/` | Injection, cascade scope, the resume keys |
| Road router | Read `RoadApi.java`, `RoadJson.java`, `GraphHopperTable.java`, `Settings.java` | The car side of every ratio |
| Real use | The owner's check (AA-26) in real mode, and `--speed` | The owner's success line |
| Skipped | Accessibility and small screens (the check is desktop only); the OSRM-shaped endpoints beyond a skim (AA-4 and AA-6 have their own tests and check); the web components beyond the screenshots | Proportionate to the brief |

## 3. Test log

Evidence is in `docs/reviews/access-analysis/evidence/`; screenshots in `docs/pr/access-analysis/`.

| ID | Category | What and why | Steps / input | Expected | Actual | Outcome | Evidence, req |
|---|---|---|---|---|---|---|---|
| PR-AA-01 | Maths | Car time and ratio | `probe-core.ts`: 600 s drive, factor 1.4, 300 s parking; PT 1,800 s | 1,140 s; 1.579 | 1,140; 1.5789… | Pass | `probe-core.txt`, FR-9, FR-11 |
| PR-AA-02 | Maths | Traffic factor by part of the day, edges and past midnight | 08:00, 09:30, 25:00 | 1.4, 1.2 (09:30 starts "middle of the day"), 1.0 | 1.4, 1.2, 1 | Pass | `probe-core.txt`, FR-9 |
| PR-AA-03 | Maths | Split from the asked departure (D23) | Asked 08:00, journey 08:10 to 08:40, ride 26 min, walk 4 min | PT 40, wait 10, ride 26, walk 4 min | 2,400 / 600 / 1,560 / 240 s | Pass | `probe-core.txt`, D23 |
| PR-AA-04 | Boundary | Car time 0 | drive 0, parking 0 | A ratio, or a status that is not `ok` | Status `ok`, ratio `null`; the summary counts the pair nowhere (all counts 0, okCount 0) | Pass with F-1 | `probe-core.txt`, AC-FR-20.1 |
| PR-AA-05 | Grid | The check's zone at 250 m | Corners as in AA-26 | About 2.8 × 2.8 km → 11 × 11 | 121 points, 11 columns, 11 rows; the real run's setup says the same | Pass | `probe-core.txt`, FR-7 |
| PR-AA-06 | Contours | Bands and lines on a rising 3 × 3 grid, then with the centre missing | `probe-core.ts` | Lines at 1 and 2; nothing at all once every square has a missing corner | 1 line each; with the centre missing, 0 band pieces and 0 lines | Pass | `probe-core.txt`, D27, NFR-4 |
| PR-AA-07 | Negative | Outline checks | Closing corner repeated; corner repeated straight after itself | First accepted; second refused with a fitting reason | First accepted; second refused as "crosses itself" | Pass with F-7 | `probe-core.txt`, AC-FR-4.2 |
| PR-AA-08 | Code reading | Cancel and delete paths | Read `routes.ts:106-122`, `runner.ts:206-217` | Results deleted only for an active analysis | The route checks the state first; the runner itself deletes before its own check (F-2) | Pass with F-2 | FR-10 |
| PR-AA-09 | Code reading | Resume after a restart | Read `runner.ts:95-103,219-223`, `server.ts:48-50` | Unfinished analyses carried on from the first unfinished pair | `resume()` runs at start; pending rows are made once (`not exists`); drives pick `not drive_checked`, journeys `status = 'pending'` | Pass | FR-10, NFR-4 |
| PR-AA-10 | Security | SQL | Read every query in `apps/api/src/analysis/` and the migration | Parameters only; cascades scoped to one analysis | All tagged-template parameters; the only `unsafe` is in the test runner with a fixed name; cascades follow `analysis_id` | Pass | |
| PR-AA-11 | Usage | The owner's check, real mode | `npm run test:access -- --out docs/pr/access-analysis --router-graph … --feed …nsw-complete-20261112-1750.zip` | Passes; screenshots 01 to 08 | Passed in 182 s, all eight screenshots written, database dropped and servers stopped | Pass | `access-real-run.log`, AA-26 AC1, AC4 |
| PR-AA-12 | Usage | Summary adds up | From the run: city centre 0+1+0+91+24+2 + 1 no service + 2 no road | 121 | 121; Kotara 0+0+0+23+41+54+1+2 = 121 | Pass | `access-real-run.log`, AC-FR-20.1 |
| PR-AA-13 | Speed | `--speed` (about 4,900 points × 3) | Same flags plus `--speed` | Under 5 minutes | 4,900 × 3 = 14,700 pairs in 18.6 s | Pass | `access-speed.log`, AC-NFR-1.1 |
| PR-AA-14 | Static | Lint | `npm run lint` | No errors | 0 errors, 28 warnings, none in a file this feature added (`LeftRail.tsx:92` is an old line) | Pass | `lint.txt` |

| PR-AA-15 | Regression | Unit tests after the check | `npm test` | All pass | 40 files, 392 tests passed | Pass | `npm-test.txt` |

The coordinator's other runs at `504fc45` (typecheck, format:check, no import circles, `test:e2e:fixture`) were not repeated, as the machine had to stay quiet for the check.

## 4. Code readability review

Read in full: everything in `packages/core/src/analysis/`, `apps/api/src/analysis/` (bar the tests), the migration, `RoadApi.java`, `RoadJson.java`, `GraphHopperTable.java`, `Settings.java`; the web files only where the screenshots led.

- **Readable:** yes, and well above the old code around it. Names follow the glossary (sample point, point of interest, access ratio, no service, no road). Functions are short, with early returns. Constants are named (`DRIVE_BATCH`, `JOURNEY_BATCH`, `BOX_MARGIN_M`, `SAME_WITHIN`). The contours file is a model of explaining *why* (the diagonal, the "worked out from the lower end every time" so neighbouring triangles agree, why no library).
- **Single purpose:** yes. The run is split three ways (queue and states; drives; journeys), and each core file holds one rule. `driveAnalysis` (`runner.ts:109-177`) is the longest function; it is a straight list of steps with the error path at the end and reads well.
- **Comments:** every file has a header naming its requirement and decision IDs; every exported function has a one-line doc. One stale comment: `LeftRail.tsx:3` was re-wrapped to well past the line width. No commented-out code, no TODOs.
- **F-3** is the one maintainability point worth fixing: the grid's frame and origin are written twice and must stay in step by hand. One core function that gives the frame, origin and size for a ring and spacing, used by both `sampleGrid` and `contourGridOf`, would remove the risk.

## 5. Coding standards check

- **Folders:** new code sits where the codebase map says: `packages/core/src/analysis/`, `apps/api/src/analysis/`, `apps/web/src/analysis/{setup,results}/`, router road code in `router-road` and `router-server`. Map layers live in `apps/web/src/map/use-analysis-*.ts`, beside the other map layer hooks. Tests sit beside their files; end-to-end tests and the check scripts in each package's `test/`. No catch-all folders.
- **File length:** no new file is over 300 lines; the longest are `analysis-runs.e2e.mjs` (291), `analysis.css` (289), `access-check.mjs` (288) and `use-analysis-result-layers.ts` (276). Three old files grew (F-6): `MapView.tsx` 2,011 (+8), `RouterServer.java` 738 (+23), `store.ts` 335 (+13). `sim.ts` shrank by about 220 lines (AA-13).
- **Typing:** `grep` of the added lines for `any`, `@ts-ignore`, `@ts-expect-error`, `as unknown as` and non-null assertions finds only the two moved `any`s in `router-client.ts` (F-11). Outside data is parsed into typed values at the edge (`create-body.ts`, `places-routes.ts`, `road-client.ts`, `journeys-client.ts`). F-5 is the one place where a type does not tell the truth about the wire.
- **Migration:** one new numbered migration, `0010_access_analysis.sql`, adding tables only, with the way back written in its header (D24 keeps 0002 to 0009 free). It ran from empty in the check (`Ran migrations 0001, 0010` in `access-real-run.log`).

## 6. Unused code check

Lint (oxlint, which reports unused imports and variables) is clean for the new files. I searched the repo for every exported name in `packages/core/src/analysis/` and `apps/api/src/analysis/` (a shell loop over `export function|const|type|interface`). Every function has a caller outside its own file. About twenty exported types and two constants (`NOT_FINISHED`, `EXPORT_COLUMNS`) are used only in their own file or its tests; they describe exported functions' inputs and outputs, so they are not dead code. Nothing unused found.

## 7. The owner's check (AA-26)

Run from this worktree at 01:34 to 01:37: the real feed `nsw-complete-20261112-1750.zip`, the owner's day 20261121 (Saturday 21 Nov 2026), the router on 3112 with the Opal road graph, API 3111, web 5183, headless browser. Import 112 s, router up in 20 s, the browser part with the analysis about 46 s (timetable cut and loaded in 16.5 s: 1,717 trips, 2,928 stops). Everything was stopped and `gtfs_aa_check` dropped by the script.

What I see in each screenshot (`docs/pr/access-analysis/`):

- `01-zone.png`: the Mayfield zone is drawn as a square over Mayfield, Mayfield West, Mayfield North, Mayfield East and Waratah, with Waratah Station inside. Right place.
- `02-pois.png`: both points of interest placed and listed. The Newcastle city centre marker sits in the city centre near Civic and Queens Wharf; the Westfield Kotara marker is beside Kotara Station, with its label partly under the panel. The setup line reads 121 sample points, 2 points of interest, 242 journeys and 242 drives.
- `03-setup.png`: the rest of the setup: limits, modes (school buses off), parking 5 min, the traffic factors by part of the day, and the name.
- `04-running.png`: the analysis in the list, "Loading the timetable", with Cancel and Delete.
- `05-city-centre.png`: the results for Newcastle city centre. Bands fill the zone. Most of it is the "2 to 3" colour, with a "3 to 4" patch in the south-east and small ones round the edges. Lines are labelled 2, 3 and 4. Three white rings in the north-east corner mark the no service and no road points. Legend, summary (median 2.68), settings line and credit are all there.
- `06-kotara.png`: the same for Westfield Kotara: mostly "3 to 4" and "4 or more", with a "2 to 3" band along the west side and the railway. Median 3.96. Clearly worse than the city centre, as it should be.
- `07-point-detail.png`: sample point 49 to Kotara: public transport 44 min (walk 13, wait 1, ride 31 on bus 11), car 16 min (drive 8 min × 1.4 + 5 min parking), ratio 2.71. The drive and the journey are drawn on the map.
- `08-legend.png`: the legend cropped: six bands, no service, no road, the settings line and the credit.

**My judgement: golden, with notes.** The zone is over Mayfield; the points of interest are at Newcastle city centre and Westfield Kotara; the map is clear and sensible, with bands, labelled lines, legend and credit. The ratios make sense by eye: the drive from the middle of Mayfield to the city centre is 7.2 min free-flow, so about 15 min with the peak factor and parking; a 40-minute public transport trip on a Saturday morning, counting the wait for the first bus from 08:00, gives the 2.68 median. The city centre is the better-served destination (no point at 4 or more bar two, against 54 for Kotara). Note that the zone is Mayfield, not central Newcastle itself, so "central Newcastle is well served" shows as the city centre being the easier place to reach from Mayfield, not as ratios under 1.5: only one sample point is under 1.5.

Things a careful eye will notice (none is a defect I can show):

- The results shots frame the zone, so neither point of interest is in view in 05 and 06.
- In 06 there are three or four short dark strokes inside the "4 or more" area (near 1160,290, 1085,610 and 735,548 in the image) that do not follow a band edge. They may be short pieces of the line at 4 where the value touches 4 inside a square. Worth a look in the web layer, not raised as a defect.
- "2 to 3" and "3 to 4" are close in colour on the dark map.
- The day is a Saturday with the weekday morning peak factor (F-10).

**Speed (AC-NFR-1.1):** `--speed` (01:38 to 01:41, the whole check again plus the timed run) laid a 7 × 7 km zone over Newcastle at 100 m: 4,900 sample points × 3 points of interest (city centre, Westfield Kotara, John Hunter Hospital), 14,700 drives and journeys, done in **18.6 s** from the request to `done`, against the 5-minute target. Progress moved in steps of 1,000 drives and 500 journeys as designed. The browser part gave exactly the same counts as the first run (NFR-4).

## 8. Findings

| ID | Severity | Where | Expected | Actual | Evidence | Who |
|---|---|---|---|---|---|---|
| F-1 | Minor | `ratio.ts:62-64`, `run-journeys.ts:231-234`, `summary.ts:262-270` | Every finished pair lands in exactly one summary row | With parking allowance 0 and a sample point that snaps to the same road spot as its point of interest, car time is 0, the ratio `null` and the status `ok`; the pair is counted nowhere and is missing from the map. Fix: give such a pair a status (or treat a car time of 0 as no road), or refuse a parking allowance of 0. | PR-AA-04 | developer |
| F-2 | Minor | `runner.ts:211-216` | Cancel never touches a finished analysis | `cancel()` deletes from `analysis_results` without a state check, then updates the row only if active. The route checks the state first (`routes.ts:108`), but if the run finishes between that check and the call, a `done` analysis loses its results. Fix: put the state condition on the delete too (`… and exists (select 1 from analyses where id = … and state = any(…))`), or do both in one transaction. | PR-AA-08 | developer |
| F-3 | Minor | `grid.ts:138-150`, `results-read.ts:131-149` | One definition of where point (i, j) is | Two copies; if one changes, the lines shift against the points with no test failing across both. Fix: one core function used by both. | §4 | developer |
| F-4 | Minor | `create-body.ts:38-45` | Unknown modes refused with a reason | Any strings accepted; `avoidedModes` then avoids every real mode and the run gives all no service. Fix: check against the router's mode ids (`ROUTER_MODES`). | Code | developer |
| F-5 | Minor | `api/analysis.ts:117`, `summary.ts:210-215` | The shared type matches the JSON | Open band ends are ±Infinity in core and `null` in JSON; `results-text.ts:71` compares a `number` with `null`. Fix: a wire type with `number \| null`, as `results-routes.ts` already does for the line bands (`bandEnd`). | Code | developer |
| F-6 | Major (rule) | `MapView.tsx`, `RouterServer.java`, `store.ts` | Over-long files do not grow | +8, +23 and +13 lines of wiring. Splitting these files is staged refactor work; I recommend accepting the growth and adding them to the refactor plan rather than holding this pull request. Owner to decide. | `wc -l` in §5 | owner, PM |
| F-7 | Note | `polygon.ts:153-163` | "Two corners in the same place" | "Crosses itself" | PR-AA-07 | developer |
| F-8 | Note | `Settings.java:71,131` | `ROUTER_DATA` moves the road graph default with it, as `defaults(data)` does | Fixed `data/router/road/opal` relative to the working folder | Code | developer |
| F-9 | Note | `export-rows.ts:104-106` | Names that start with `=`, `+`, `-` or `@` made safe for spreadsheets | Written as they are | Code | developer |
| F-10 | Note | FR-9, `defaults.ts:38` | A clear rule for weekends | The morning peak factor applies on a Saturday | 03-setup.png, 05 | BA |
| F-11 | Note | `router-client.ts:19,31` | No `any` | Two, moved unchanged | Code | developer |

## 9. Not run

- The per-ticket "tests before code" history check: each AA ticket had its own review.
- `.\gradlew build`, typecheck and `test:e2e:fixture`: the coordinator ran them at `504fc45`; I kept the machine quiet for the check. (`npm test` and lint were re-run, PR-AA-14 and 15.)
- Small screens and keyboard use of the Access pane.

## 10. Issues routed

No tracker rows added: the coordinator raises fix tickets from this report. Suggested: one developer ticket for F-1 to F-5 (and F-7 to F-9 if cheap), one BA question for F-10, and a refactor-plan line for F-6.

## 11. Reviewer notes

- The car side measures from the snapped road point (up to 500 m away, D19) with no walk to the car, while public transport counts every metre walked. That is the design, and it makes ratios a little higher for points far from a road. Worth a sentence in the user help.
- Analyses keep `baseline_id` with `on delete set null`; re-importing a day with `--replace` would leave its analyses unlisted (the list filters by day). Harmless, but they will sit in the table.
- The run re-scans the analysis's result rows for each batch (`status = 'pending'` has no index of its own). Fine at 15,000 pairs; at the 100,000-pair limit it is about 200 scans of up to 100,000 rows, still seconds.
