# Peer review: T-4, Fix the small known issues I2, I3 and I4

| | |
|---|---|
| Ticket | T-4 (EP-1), "Fix the small known issues I2, I3 and I4". Treated as In review (the spreadsheet copy at this commit still says In progress). |
| Reviewer | Peer reviewer agent (Claude) |
| Date | 23 Nov 2026, 09:00 to 09:15 AEDT |
| Requirements | No BRD, test plan or glossary exist for this refactor, by the owner's choice. Traced instead to `docs/refactor-plan.md` "The small fixes (I2–I5)" and issues I2, I3, I4 in `docs/architecture/system.md` §11. The ticket's four acceptance criteria (AC1 to AC4) are used as the requirement IDs. |
| Code reviewed | Commit `54b0064` ("Fix issues I2, I3 and I4; move them to the resolved table"), tested at `61dde1f` (tip of `architecture-docs`, PR #1), detached, in an agent worktree. |
| Environment | Windows 11 Pro 10.0.26300, Node 24, npm workspaces, Vitest 5.1.0, oxlint, Prettier, TypeScript (`tsc --noEmit`, strict on in `tsconfig.base.json`). `npm install` on a clean worktree. No dev servers, no database, no browser. |
| Verdict | **Changes requested**, on the file-length rule only. The behaviour is right. See the summary. |

## 1. Summary

The fix to I3 is correct and complete. Every way of undoing or redoing (the Undo and Redo buttons, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y and "Put it back (undo)") goes through `step()` in `scenario.ts`, and `step()` now does nothing while `editBusy` is set. I tested `step()` directly with a mocked `fetch` (9 tests, all pass). Removing the new guard makes 3 of them fail, so they really test it. `editBusy` cannot get stuck after Cancel, Go ahead, Escape, a click on the backdrop or a server error. It can stay stuck only if a request never answers, and that was already true before this ticket. The fix also closes a worse hole: before it, Ctrl+Z while the "This adds N vehicles" question was open would undo the previous change and then clear `editBusy` while the question was still showing.

The I2 and I4 wording is true to the code, plain and British.

Why "Changes requested": the coding standards say a file already over 300 lines must not get longer. `sim-results.ts` (1,139 lines) and `FleetPanel.tsx` (371 lines) each grew by one line of comment or UI text. Under the standard that is a Major. It takes a minute to fix, because both texts fit in their old line count (suggested wording in F-1). The other way out is for the owner to waive it, since refactor plan stages 2 to 3 split both files anyway. With that sorted, this would be **Approve with notes**.

Tests run: 19 entries. 16 Pass, 1 Fail (`format:check`, caused by line endings in the worktree, not by T-4), 1 Pass recorded as an observation (a hung request), and 1 Not run (the browser check, which needs the owner's dev servers).

Top findings:
- F-1 **Major** (standards): two files already over the limit grew by one line each. `apps/api/src/sim-results.ts:1-4`, `apps/web/src/FleetPanel.tsx:282-284`.
- F-2 **Minor**: a third stale "while a scenario is being edited" text, the doc comment of `VehicleTypePicker` at `apps/web/src/FleetPanel.tsx:323`. I4 named only two strings, so this is a gap in the issue rather than a slip by the developer.
- F-3 **Minor** (docs): `docs/codebase-map.md:22,30,37,61` still call I2, I3 and I4 open ("Issue **I3** is here", "Open issues (I1 to I5)").
- F-4 **Note**: Ctrl+Z refused during an edit gives no feedback (the buttons do show as disabled). This matches `applyEdit`, as the brief asked.
- F-5 **Note**: a request that never answers leaves `editBusy` true until the page is reloaded (no timeout in `send()`). This is older than the ticket.

## 2. Charter and coverage

| Category | What I tried | Why |
|---|---|---|
| Entry points | Every caller of `undo`, `redo` and `/api/scenarios/:id/undo|redo` | AC2 only holds if nothing bypasses `step()` |
| State and sequences | Busy then undo; double press; undo while the confirm question is open; after Cancel; after Go ahead; failed undo; edit during undo; hung request | Can `editBusy` stick, or can two changes cross? |
| Test strength | Remove the guard in a scratch edit, re-run | Do the tests really protect AC2? |
| Wording (I2, I4) | Read `buildLinkLoads` and every place the pickers are shown | A wrong comment is worse than none |
| Regression | Full unit suite, typecheck of every workspace, lint, Prettier | |
| Code standards | Line counts, `any` search, `tsc --noUnusedLocals --noUnusedParameters`, lint | Mandatory |
| Skipped | Security, data, performance: the change is a two-line guard, a comment and a UI string with no new input. Browser checks: need the owner's dev servers (Not run). | |

## 3. Test log

Evidence files are in `docs/reviews/T-4/evidence/`.

| ID | Category | What and why | Steps / input | Expected | Actual | Outcome | Evidence, req |
|---|---|---|---|---|---|---|---|
| PR-T4-01 | Regression | Unit suite | `npm test` | All pass | 4 files, 61 tests passed | Pass | `npm-test.txt` |
| PR-T4-02 | Regression | Typecheck, every workspace | `npm run typecheck` | No errors | api, web, core, gtfs: no errors, exit 0 | Pass | `typecheck.txt` |
| PR-T4-03 | Regression | Lint | `npm run lint` | No errors | 0 errors, 28 warnings, none on lines T-4 changed (FleetPanel 304 and 341 are older) | Pass | `lint.txt` |
| PR-T4-04 | Format | Prettier on the 4 changed source files | `npx prettier --check apps/api/src/sim-results.ts apps/web/src/FleetPanel.tsx apps/web/src/inspector/TripEditTools.tsx apps/web/src/scenario.ts` | Clean | "All matched files use Prettier code style!" | Pass | `prettier.txt` |
| PR-T4-05 | Format | Whole-repo check, as the ticket asks | `npm run format:check` | Clean | 13 files flagged, none touched by T-4. They are CRLF in the working copy (`git ls-files --eol`: `i/lf w/crlf`) although `.gitattributes` says LF. This is a worktree checkout artefact, as the developer also reported. | Fail (environment, not T-4) | `prettier.txt` |
| PR-T4-06 | Negative | Undo and redo while `editBusy` is set | Scratch test `step.test.ts`, mocked `fetch` | No request, `editBusy` stays true | No request; true | Pass | `step-test-run.txt`, AC2 |
| PR-T4-07 | Usage | Undo and redo when idle | same | One POST to `/api/scenarios/7/undo` (and `/redo`); `editBusy` false after | As expected | Pass | `step-test-run.txt`, AC2 |
| PR-T4-08 | Repeat | Two quick Ctrl+Z presses while the first is in flight | same, first request held open | One undo sent | One | Pass | `step-test-run.txt`, AC2 |
| PR-T4-09 | Sequence | Ctrl+Z while the "adds N vehicles" question is open, then Cancel, then Ctrl+Z | same; server answers `needsConfirm` | Refused while open; after Cancel `editBusy` false, `editConfirm` null, undo sent | As expected | Pass | `step-test-run.txt`, AC2 |
| PR-T4-10 | Sequence | Go ahead, then Ctrl+Z | same | Edit applied, then undo sent | As expected | Pass | `step-test-run.txt`, AC2 "once the edit finishes, undo works" |
| PR-T4-11 | Failure | Server refuses an undo (400) | same | `editBusy` cleared, `editError` "Nothing to undo", next undo goes | As expected | Pass | `step-test-run.txt` |
| PR-T4-12 | Sequence | An edit started while an undo is in flight | same | Edit refused | Refused, no `/edits` POST | Pass | `step-test-run.txt` |
| PR-T4-13 | Failure | An undo request that never answers | same | (Observation) | `editBusy` stays true, so every later edit, undo and redo is refused until reload. Older than T-4 (applies to `applyEdit` too). | Pass (observation, F-5) | `step-test-run.txt` |
| PR-T4-14 | Test strength | Remove `if (state.editBusy) return;` (scenario.ts:247) in a scratch edit, re-run, then restore with `git checkout` | | The busy tests fail | 3 failed (06, 08, 09), 6 passed. File restored; `git status` clean. | Pass | `step-test-guard-removed.txt` |
| PR-T4-15 | Entry points | Find every way undo and redo are started | `grep` for `undo`, `redo`, `/undo`, `/redo` in `apps/web/src` and `apps/api/src` | All through `step()` | `App.tsx:178,181` (keys), `ScenarioPanel.tsx:119,127` (buttons), `DeleteStop.tsx:237` ("Put it back (undo)"), all call `undo`/`redo` from `scenario.ts`, which call `step()`. No other caller of the API's undo/redo routes (`scenarios.ts:1869,1876`). | Pass | grep in this report, AC2 |
| PR-T4-16 | Wording | I2 header true to the code | Read `sim-results.ts:1-4` against `:62-81`, `:580-592`, and `sim.ts:702` | Says it reads, and that `buildLinkLoads` clears and refills `sim_link_loads` | True. `buildLinkLoads` deletes a run's rows and inserts them again in one transaction, and is the only write in the file. | Pass | AC1 |
| PR-T4-17 | Wording | I4 strings true to the code | `TripPanel.tsx:24,85`, `RoutePanel.tsx:19,207`, `VehicleDayPanel.tsx:11,60`: all show the pickers when `baselineId !== null` (a day is open); `applyEdit` starts a scenario on the first change (`scenario.ts:190-197`) | True | True for both strings. A third stale text was found (F-2). | Pass | AC3, `stale-strings-search.txt` |
| PR-T4-18 | Standards | Unused code in the changed files | `npx tsc --noEmit -p apps/web --noUnusedLocals --noUnusedParameters`, same for `apps/api`, filtered to the changed files | None | None (web: 0 errors in total) | Pass | `tsc-unused.txt` |
| PR-T4-19 | Usage (browser) | I3 and I4 in the real app | See §9 | | | Not run (needs owner) | AC2, AC3 |

AC4 (I2 to I4 marked resolved in `system.md` with a date) is checked by reading: `docs/architecture/system.md:257-263` has a new "Resolved: fixed in the code" table dated 23 Nov 2026, and the change log has a line. Met.

## 4. Code readability review

Files: `apps/web/src/scenario.ts` (`step`), `apps/api/src/sim-results.ts` (header), `apps/web/src/FleetPanel.tsx` (footer), `apps/web/src/inspector/TripEditTools.tsx` (doc comment), plus `applyEdit`, `EditConfirm.tsx` and the callers for context.

- **Readable:** yes. The guard is one line, placed straight after the existing `scenarioId` guard, in the same shape as `applyEdit`'s check at line 187.
  ```ts
  // As in applyEdit: nothing is sent while another change is still on its way.
  if (state.editBusy) return;
  ```
- **Single purpose:** `step` still does one thing (sends one undo or redo and redraws). Not changed.
- **Comments:** the new comment says why and points to the matching rule. The I2 header is now accurate and says where the write is. Small nit: `step` and the exported `undo`/`redo` have no doc comment (older code; Note at most).
- Good: the fix is the smallest one that works, and it follows the brief exactly (no queue, no new message because `applyEdit` shows none).
- Lint: 0 errors; no warnings on changed lines.

## 5. Coding standards check

| File | Lines now | Lines T-4 added (net) | Limit 300 | Result |
|---|---|---|---|---|
| `apps/web/src/scenario.ts` | 293 | +2 | under | Pass |
| `apps/web/src/inspector/TripEditTools.tsx` | 221 | 0 | under | Pass |
| `apps/web/src/FleetPanel.tsx` | 371 | +1 | **over, and grown** | F-1 |
| `apps/api/src/sim-results.ts` | 1,139 | +1 | **over, and grown** | F-1 |
| `docs/architecture/system.md` | 311 | +5 | docs, not code | n/a |

Evidence: `line-counts.txt`. Both long files are older than the ticket and are already planned to be split (`FleetPanel.tsx` becomes `catalogue/CataloguePanel.tsx` in stage 2; `sim-results.ts` becomes `sim/results-read.ts` in stage 3.2).

Typing: `npm run typecheck` passes with `strict: true` (`tsconfig.base.json:9`). The `any` search over the four files found one hit, `sim-results.ts:1075` `.sort((x: any, y: any) => …)`. It is older than the ticket and not on a changed line (Note, for the architect). T-4 added no `any`, no casts and no `@ts-ignore`. Evidence: `any-search.txt`, `typecheck.txt`.

## 6. Unused code check

- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` on `apps/web` and `apps/api`: nothing in the changed files (`tsc-unused.txt`).
- `npm run lint` (oxlint): no unused-code warnings on the changed files (`lint.txt`).
- By hand: the change adds no names, imports, dependencies or settings. Nothing was made unused.

Result: no unused code found.

## 7. Findings

**F-1 Major (coding standards), for the developer, or a waiver from the owner.** Two files already over 300 lines got longer.
- `apps/api/src/sim-results.ts:1-4`: the header went from 3 to 4 lines. It fits in 3, for example:
  `// against another made on the same people. It reads the result tables that sim.ts fills, and`
  `// writes one: buildLinkLoads clears and refills a run's rows in sim_link_loads.`
- `apps/web/src/FleetPanel.tsx:282-284`: the footer went from 2 to 3 lines. A shorter text that keeps 2 lines: "…To run a line, a vehicle or a trip with a different type, open it; the first change starts a scenario."
- Expected: no growth in an over-limit file. Actual: +1 line each (`line-counts.txt`, diff of `54b0064`). Needed back: reflow, or the owner's waiver, given both files are split in stages 2 and 3.

**F-2 Minor, for the architect or owner (I4 named too few strings), then the developer.** `apps/web/src/FleetPanel.tsx:323`:
```ts
/** "Run this with ..." control, shown while a scenario is being edited. */
export function VehicleTypePicker({
```
This is the same stale claim I4 is about: the picker shows whenever a day is open (`RoutePanel.tsx:207`, `VehicleDayPanel.tsx:60`, `TripEditTools.tsx:190` inside `TripPanel.tsx:85`, all gated on `baselineId !== null`). It is outside the two lines the ticket named, so the developer was right not to change it. It should be fixed in a follow-up or added to T-4. Evidence: `stale-strings-search.txt`.

**F-3 Minor (docs), for the developer of T-4 or T-5.** `docs/codebase-map.md` still says the resolved issues are here: line 22 "Open issues (I1 to I5)", line 30 "Issue **I3** is here", line 37 "Issue **I4** is here", line 61 "Issue **I2** is here". T-4 moved them to the resolved table in `system.md`, so the map and the architecture document now disagree. Needed back: drop the three markers and say "Open issues (I1 and I5)".

**F-4 Note, for the owner.** When Ctrl+Z is refused because an edit is still being sent, nothing tells the user. The Undo and Redo buttons and "Put it back (undo)" are disabled while busy (`ScenarioPanel.tsx:120,128`, `DeleteStop.tsx:237`), so mouse users can see why. This matches `applyEdit`, which also refuses without a message, as the brief asked. Edits are usually short, so I would leave it.

**F-5 Note, for the architect.** `send()` (`scenario.ts:85-95`) has no timeout. If the API never answers (for example the dev API restarting during a request), `editBusy` stays true and all editing, undo and redo stop until the page is reloaded (PR-T4-13). This is older than T-4. The ticket only made undo share the same lock. Worth a ticket if it is ever seen in practice.

## 8. Not run

| What | Why | What the owner should run |
|---|---|---|
| I3 by hand in the browser | Needs the owner's dev servers on 5173 and 3001 (do-no-harm rule) | 1. `npm run db:up`, `npm run dev`, open http://localhost:5173 and choose a day. 2. Open a line, and in the frequency editor ask for a much higher frequency, so the "This adds N vehicles" question appears. Press Ctrl+Z: nothing should change (the change count under the Timetable pane stays the same). Press Cancel, then Ctrl+Z: the previous change is undone. 3. In DevTools > Network, set throttling to "Slow 3G". Open a trip and press a "+5 min" nudge, then press Ctrl+Z straight away, several times. The Network tab should show only the `/edits` POST until it lands, then nothing more. Press Ctrl+Z once more: exactly one `/undo` POST. 4. Still throttled, click Undo twice quickly: one `/undo` POST. 5. Delete a stop, then press "Put it back (undo)" twice quickly: one `/undo`. |
| I4 by hand | Same | Open the vehicle catalogue from the left rail and read the footer. With no scenario chosen, open a trip: the retime tools and the "Vehicle type" picker are there. Apply a type: a scenario starts. |
| `npm run test:ui` | Needs `npm run dev` | Run it with the dev servers up. |

## 9. Issues routed

No tracker was edited (the brief says don't edit the spreadsheet or GitHub). For the owner to raise:
- Developer: F-1 (reflow two texts, or waive).
- Architect or owner: F-2 (I4 missed `FleetPanel.tsx:323`), F-5 (no timeout in `send()`), the older `any` at `sim-results.ts:1075`.
- Developer (T-4 or T-5): F-3 (codebase map still lists I2 to I4 as open).

## 10. Reviewer notes

- Process: `54b0064` is on `architecture-docs` directly, not on the `refactor/T-4-small-fixes` branch the ticket names. The owner may have chosen this; noting it.
- The worktree's `format:check` failure (PR-T4-05) is caused by files checked out before `d622176` added `.gitattributes`. A fresh clone or a worktree made after that commit should not have it. Not a T-4 problem.
- The scratch test `evidence/step.test.ts` would make a good start for refactor plan stage 5.3 ("the scenario client: stale-edit and confirm handling"). It mocks only `vehicles.ts` and `fetch`. Run it with `npx vitest run --root "C:/Programming Projects/GTFS Editor/docs/reviews/T-4/evidence"` from a checkout. Its import paths point at the reviewer's worktree, so change them to re-run elsewhere.
- Cleanup: the scratch change to `scenario.ts` was reverted with `git checkout`, and `git status` is clean. No processes or data were left behind.
