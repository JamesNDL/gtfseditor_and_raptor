# Peer review: T-3, end-to-end scenario tests run on a small test feed, without the real data

| | |
|---|---|
| Ticket | T-3 (EP-1), status In review, `docs/project/refactor-tickets.xlsx` |
| Reviewer | Peer reviewer agent (independent; has not seen the developer's reasoning) |
| Date | 23 Nov 2026, 08:50 to 09:05 (AEDT) |
| Requirements | No BRD, test plan or glossary for this refactor (the owner's choice). Traced to `docs/refactor-plan.md` §1.4 and issue I5 in `docs/architecture/system.md`. |
| Code reviewed | Detached at `d3d7c0e` (tip of `refactor/T-2-T-3`, PR #2). T-3 is `be813a0`, `814aa83` and `6a480fb`. `import-cli.ts` reviewed as merged with T-2. |
| Environment | Windows 11 Pro 10.0.26300, Git Bash; Node v26.13.0 (not 24); `npm install` at the root; existing container `gtfseditor-db-1` (`postgis/postgis:17-3.5`) on 5433. A clean checkout: no `.env`, no `data/`. The machine was shared with another reviewer, so some timings are slower. |
| Test data | The checked-in `mini-feed` and a zip of it; throwaway databases `gtfs_e2e` (made by the runner) and `gtfs_review_t3` (all dropped). API only on 3101, 3110 and 3111; the owner's ports were never touched. |
| **Verdict** | **Changes requested** |

## 1. Summary

The runner works and is robust. `npm run test:e2e:fixture` passed twice in a row from a clean checkout (47 s and 41 s, 59 checks each). Each run dropped `gtfs_e2e`, freed port 3101 and removed its temporary packs folder. A forced failure exited 1 and cleaned up. `FEED_PATH` works with a folder and with a zip (even one with a space in its name), needs no API key, and gives a clear error for a missing path. `PACKS_DIR` is honoured, and with it unset, packs go to the repo's `data/packs` from any working folder (I5 fixed). The generator is deterministic. The real-API suite is unchanged.

Changes are requested for two coding-standards breaches and one acceptance-criteria deviation that needs the owner's decision:
- **Major** (standard): `make-mini-feed.mjs` is 724 lines (limit 300).
- **Major** (standard): an unexplained non-null assertion `apiKey!` at `import-cli.ts:70`.
- **Major** (needs owner): AC1 asks for "a few kilobytes of hand-written" files. The fixture is 459 KB and generated. The developer said so in the ticket notes; the owner should accept it or not.
- **Minor**: every run leaves `data/exports/check-e2e` in the checkout. In the owner's checkout this overwrites the folder that `npm run test:e2e` writes.
- **Minor**: a run that is stopped part way leaves `gtfs_e2e` and an orphaned temporary folder, and there is no Ctrl+C handling.
- **Minor** (QA): nothing checks that packs went to `PACKS_DIR`. With I5 broken on purpose, the suite stays green and writes into the repo's `data/packs/1`, which in the owner's checkout holds a real baseline's packs.
- **Minor**: `FEED_PATH` errors come out as stack traces.

Tests run: 27. Passed 21, failed 6. Not run: 1 (`npm run test:e2e` against the owner's API).

## 2. Charter and coverage

| Area | What I tried, and why | Done |
|---|---|---|
| Runner, happy path | Two runs in a row from a clean state; time taken; what is left (database, port, temporary folders, `data/`) | Yes |
| Runner, failure | Fixture broken so checks fail; runner killed part way, then run again; port already taken (HTTP and non-HTTP); database unreachable; `E2E_DB` set to the owner's database, with SQL in it, or in capitals | Yes |
| `FEED_PATH` | Folder; zip (name with a space); zip again (cached); missing path; not a zip; folder missing files; empty value; no key at all; a copy of the same feed | Yes |
| I5 / `PACKS_DIR` | Set; unset and started from another folder | Yes |
| Fixture | Generator run twice: are the files byte-identical (SHA-1 and `git status`)? Size against AC1. | Yes |
| Real-API mode (AC5) | Read only: is `scenarios.e2e.mjs` or the `test:e2e` script changed? | By reading; live run Not run (needs owner) |
| Test quality | Broke `packsDir` (ignores `PACKS_DIR`), and renamed F1 and T1 in the fixture, to see what the suite notices | Yes |
| Skipped | UI and accessibility (none); `test:sim` and `test:ui` (out of scope) | n/a |

## 3. Test log

Evidence is in `docs/reviews/T-3/evidence/`. Scripts are run with `bash <script> <repo-root> <evidence-or-scratch-dir>`: `t3-state.sh` (what is left behind), `t3-run.sh` (a timed run with the state before and after), `t3-feedpath.sh`, `t3-interrupt.sh` and `t3-negative.sh`.

| ID | Category | Test | Expected | Actual | Outcome | Evidence |
|---|---|---|---|---|---|---|
| PR-T3-01 | AC3, AC6 | `npm run test:e2e:fixture`, clean checkout, no `data/`, no `.env` | Passes and cleans up | 59 `ok`, "all scenario checks passed", exit 0, 47 s. After: no `gtfs_e2e`, nothing on 3101, no temp packs folder. **But a `data/exports/check-e2e` folder (462 KB) now exists in the checkout.** | Pass (see F-4) | `fixture-run1.txt` |
| PR-T3-02 | AC3 | Second run straight after (`data/` removed first) | Passes | 59 `ok`, exit 0, 41 s, same clean state, and `data/` again | Pass | `fixture-run2.txt` |
| PR-T3-03 | AC3 | Forced failure: T1 renamed T9 in `routes.txt` (scratch change, then reverted) | Exit non-zero, cleaned up | `TypeError ... reading 'id'`, "the scenario checks failed (code 1)", "failed; cleaned up", exit 1; no database, port free, no temp folder | Pass | `forced-failure-checks.txt` |
| PR-T3-04 | negative | Runner killed part way (`taskkill /F` while the checks run), then run again | Leftovers recovered | Left behind: database `gtfs_e2e` and one `gtfs-e2e-packs-*` temp folder; the API child had gone, port free. The next run dropped and rebuilt `gtfs_e2e` and passed, but the **orphaned temp folder stayed** until I removed it. | Fail (Minor, F-5) | `interrupt-output.txt`, `interrupt-runner-log.txt` |
| PR-T3-05 | security | `E2E_DB=gtfs_editor`; `E2E_DB="gtfs_e2e; drop database x"`; `E2E_DB=GTFS_E2E` | Refused before connecting | All exit 1 at module load. The throw at `run-e2e-fixture.mjs:19-20` runs before `postgres()` is called. The message is buried under a stack trace. | Pass | `t3-negative-output.txt` |
| PR-T3-06 | dependency | An HTTP server already on `E2E_PORT=3110` | Refused, nothing created | "something is already listening on http://localhost:3110; set E2E_PORT", exit 1, nothing left | Pass | `t3-negative-output.txt` |
| PR-T3-07 | dependency | A non-HTTP listener on 3111 | Refused or fails fast | Not seen by the busy check. The API logged "listening" (the two ended up on different address families), the runner waited 60 s, then "did not answer ... within a minute", exit 1, cleaned up | Pass (Note F-10) | `t3-negative-output.txt` |
| PR-T3-08 | dependency | Database unreachable (`E2E_ADMIN_URL` on port 5999) | Exit 1, no hang | `ECONNREFUSED`, "could not drop gtfs_e2e: " (empty message), exit 1, no hang | Pass (Note F-10) | `t3-negative-output.txt` |
| PR-T3-09 | AC2 | `FEED_PATH` is a zip named `mini feed.zip`, no `API_KEY`, `PACKS_DIR` set | Imports | Extracted to `%TEMP%\gtfs-editor-feeds\local-mini-feed-5864fe5a7c`, baseline 1, packs in `PACKS_DIR`, exit 0 | Pass | `t3-feedpath-output.txt` |
| PR-T3-10 | AC2 | The same zip again, another day | Reuses the extraction and the staging | "already staged", baseline 2, exit 0 | Pass | same |
| PR-T3-11 | negative | `FEED_PATH` doesn't exist | Clear error | "FEED_PATH ... does not exist", but as an uncaught stack trace, exit 1 | Fail (Minor, F-7) | same |
| PR-T3-12 | negative | `FEED_PATH` is a text file named `.zip` | Clear error, no half-extracted folder | yauzl stack trace, exit 1; the `.part` folder was removed (good) | Fail (Minor, F-7) | same |
| PR-T3-13 | negative | `FEED_PATH` folder with only two files | Clear error | "Feed is missing calendar.txt" as a stack trace, exit 1 | Fail (Minor, F-7) | same |
| PR-T3-14 | negative | `FEED_PATH=` (empty) and no `API_KEY`; neither set | Clear error | "API_KEY is not set. Add it to .env ..., or set FEED_PATH to a feed on disk.", exit 1 | Pass | same |
| PR-T3-15 | usage | A copy of the same feed (new file times), same day | Probably treated as the same feed | A new feed id, re-staged, and a **second baseline for 2026-07-07** beside the first | Pass as designed (Note F-8) | same |
| PR-T3-16 | AC4 / I5 | `PACKS_DIR` unset, importer started from another folder | Packs in `<repo>/data/packs` | `data/packs/4` in the repo; nothing in the other folder | Pass | same |
| PR-T3-17 | AC4 / I5 | `PACKS_DIR` set (also seen in the T-2 runs) | Packs only there | Yes | Pass | same; `../T-2/evidence/t2-guard-output.txt` |
| PR-T3-18 | AC1 | Generator run twice; SHA-1 of every file before and after; `git status` | Identical | Identical SHA-1s; `git status` clean | Pass | `generator-determinism.txt` |
| PR-T3-19 | AC1 | Fixture size | "a few kilobytes", hand-written | 458,867 bytes over nine files (`stop_times.txt` 331 KB), generated | Fail (needs owner, F-3) | `wc -c` in §5 |
| PR-T3-20 | AC5 | Real-API mode unchanged? | Suite and script unchanged | `git diff --stat 61dde1f..d3d7c0e -- apps/api/test/scenarios.e2e.mjs apps/api/src` is empty. `test:e2e` is still `node apps/api/test/scenarios.e2e.mjs`. The suite still defaults to `API=http://localhost:3001`. | Pass (by reading) | n/a |
| PR-T3-21 | AC5 | `npm run test:e2e` live against the owner's API | | | Not run (needs owner) | n/a |
| PR-T3-22 | test quality | `packsDir` changed to ignore `PACKS_DIR`, then the fixture run | Some check fails | **Still green** (exit 0, 36 s). The packs were written to the repo's `data/packs/1`. | Fail (test gap, F-6) | `mutation-packsdir.txt` |
| PR-T3-23 | test quality | Ferry renamed F1 to F9 in the fixture | Some check fails? | Still green: the suite doesn't look for F1 by name. Not a defect; it shows the ferry line isn't checked by name. | Pass (info) | `mutation-rename-F1-still-green.txt` |
| PR-T3-24 | regression | `npm test` | Green | 61/61 | Pass | `../T-2/evidence/npm-test.txt` |
| PR-T3-25 | regression | `npm run lint` | Nothing in the changed files | Exit 0; warnings only in untouched web files | Pass | `../T-2/evidence/lint.txt` |
| PR-T3-26 | regression | `npm run format:check`, and `npx prettier --check` on the changed files | Clean | The changed files are clean. The 13 flagged files are untouched and only CRLF in this worktree. | Pass (changed files) | `../T-2/evidence/format-check.txt` |
| PR-T3-27 | standards | gtfs typecheck (strict), plus `--noUnusedLocals --noUnusedParameters` | Clean | Both exit 0 | Pass | `../T-2/evidence/typecheck-gtfs.txt`, `tsc-unused.txt` |
| PR-T3-28 | coverage | Which checks skip on the fixture | | "road closure: no routing server answered ... (skipped)" and "line 100 does not cross the bridge on this day (skipped)" | Info (Note F-9) | `fixture-run1.txt` |

## 4. Code readability review

Read in full: `apps/api/test/run-e2e-fixture.mjs`, `feed-cache.ts` (`localFeed`), `import/packs.ts` (`packsDir`), `import-cli.ts` (merged), the doc changes, and `make-mini-feed.mjs` (structure, the train section, the writing section, and samples of the bus and ferry sections).

**Readable?**
- `run-e2e-fixture.mjs` is clear. The header says what it does, its settings and its one prerequisite. The `try/finally` makes the always-clean-up promise easy to check. Good.
- `localFeed` is short and explains its id scheme. Good.
- `packsDir` now matches `server.ts`, and the comment says why. Good.
- `make-mini-feed.mjs` has good section headers and a header describing what the feed holds. However, it is one 724-line top-level script with many short, cryptic names (`hms`, `at`, `p`, `f`, `k`, `s`, `r`) and long inline object literals. The train section (`:186-260`) is a bare block with a three-level nested loop. A reader can follow it, but slowly.

**Single purpose?** The runner's helpers (`envFor`, `run`, `waitForApi`, `stopApi`) each do one thing. `localFeed` does three jobs (check, hash, extract) but is short. `make-mini-feed.mjs` mixes geometry, timetable rules for four modes, and CSV writing in one file. That is F-1; splitting it by those lines would also fix the length.

**Comments?** Mostly good, and they say why ("No road routing server, so the run is the same everywhere; the suite allows for its absence"). The Australia Day comment is correct (26 Jan 2027 is a Tuesday).
- Minor: `waitForApi` and `stopApi` (`run-e2e-fixture.mjs:50, 65`) have no doc comment.
- Minor: the `make-mini-feed.mjs` header says "The file is deterministic", which is true (PR-T3-18). The ticket's design said "hand-written", which it isn't (F-3).
- Note: `docs/codebase-map.md:73` still says "issue **I1** is at line 54" (T-3 edited this row and kept the stale text), and `:21` says "Open issues (I1 to I4)".

## 5. Coding standards check

| File | Lines | Limit | Result |
|---|---|---|---|
| `packages/gtfs/test/fixtures/make-mini-feed.mjs` | **724** (new) | 300 | **Over: Major (F-1)** |
| `apps/api/test/run-e2e-fixture.mjs` | 126 (new) | 300 | OK |
| `packages/gtfs/src/feed-cache.ts` | 176 (was 122) | 300 | OK |
| `packages/gtfs/src/import/packs.ts` | 191 (was 184) | 300 | OK |
| `packages/gtfs/src/import-cli.ts` (merged) | 102 | 300 | OK |
| `mini-feed/*.txt` | 458,867 bytes | exempt (static data) | See F-3 for size against AC1 |

Typing:
- TypeScript changes pass `tsc --noEmit` in strict mode (`typecheck-gtfs.txt`).
- `import-cli.ts:70`, `: await ensureFeed({ apiKey: apiKey!, log });`. An **unexplained non-null assertion** (introduced in `be813a0`). It is safe in practice, because lines 22-26 exit when neither `API_KEY` nor `FEED_PATH` is set, but nothing says so, and the type system can't see it: **Major (F-2)**. Fix by narrowing instead, for example `feedPath ? localFeed(...) : apiKey ? ensureFeed({ apiKey, log }) : fail()`, or a small `chooseFeed()` returning a union.
- Search of added lines for `any`, `@ts-` and casts: none in T-3's TypeScript other than the above. (`feed-cache.ts:154 res.body as any` is pre-existing and untouched.)
- `run-e2e-fixture.mjs` and `make-mini-feed.mjs` are plain JavaScript, so they have no type annotations at all. That follows the project's convention for scripted tests (`scenarios.e2e.mjs`, `sim.e2e.mjs`, `ui-smoke.mjs` are all `.mjs`), so I don't count it as a breach. But the standard is "everything typed", and Node here runs `.ts` directly, so these could be `.ts` at no cost. Raised as a Note to the architect (F-11). A few functions have JSDoc descriptions but none have JSDoc types.

## 6. Unused code check

- `tsc --noUnusedLocals --noUnusedParameters` (gtfs): exit 0.
- oxlint `no-unused-vars` on `run-e2e-fixture.mjs`, `make-mini-feed.mjs`, `feed-cache.ts`, `packs.ts` and `import-cli.ts`: no hits.
- Manual search:
  - `localFeed` is used by `import-cli.ts`.
  - `test:e2e:fixture` runs the runner.
  - `E2E_PORT`, `E2E_DB` and `E2E_ADMIN_URL` are read in the runner and documented in its header.
  - `FEED_PATH` and `PACKS_DIR` are read.
  - `os` and `createHash`, new imports in `feed-cache.ts`, are used.
  - `make-mini-feed.mjs` is documented as the way to rebuild the fixture (cleared: a tool run by hand).
- No new dependencies. Nothing unused was introduced.

## 7. Findings

| # | Severity | Finding | Where | Owner |
|---|---|---|---|---|
| F-1 | **Major** (standard) | `make-mini-feed.mjs` is 724 lines. Suggest `fixtures/mini-feed-gen/` with `geometry.mjs`, `train.mjs`, `buses.mjs`, `ferry.mjs` and `write.mjs`, plus a short entry script. | `packages/gtfs/test/fixtures/make-mini-feed.mjs` | developer |
| F-2 | **Major** (standard) | Unexplained non-null assertion `apiKey!`. | `packages/gtfs/src/import-cli.ts:70` | developer |
| F-3 | **Major** (needs owner) | AC1 and the design say "a few kilobytes of hand-written GTFS text files". The fixture is 459 KB and generated (the developer flagged it). It is still tiny next to the 4 GB feed and is deterministic. Owner to accept the deviation (then close this) or ask for a smaller timetable, such as fewer trips per hour or a shorter day. | `packages/gtfs/test/fixtures/mini-feed/` | owner, then PM to update the ticket |
| F-4 | Minor | Each run leaves `data/exports/check-e2e/` (462 KB) in the checkout. The suite's export check (`scenarios.e2e.mjs:1742`, `--out=check-e2e`) writes it, and `export-check.ts:46` resolves it against the working folder. In the owner's checkout it overwrites the export from the last real `npm run test:e2e`. AC3 says the runner cleans up, and AC6 implies no `data/` is needed. Suggest the runner points that export at its temp folder, or removes it afterwards. | `apps/api/test/run-e2e-fixture.mjs`, `export-check.ts:46` | developer |
| F-5 | Minor | A run stopped part way (closed window, Ctrl+C, kill) leaves `gtfs_e2e` (recovered by the next run) and an orphaned `%TEMP%\gtfs-e2e-packs-*` folder (never recovered). There is no SIGINT or SIGTERM handler, so even Ctrl+C skips the `finally`. Suggest a signal handler that runs the same cleanup, and a fixed temp folder name cleared at start. | `run-e2e-fixture.mjs:95-124` | developer |
| F-6 | Minor (QA) | Nothing protects I5: with `packsDir` made to ignore `PACKS_DIR`, the fixture run stays green, and packs land in the repo's `data/packs/1`. In the owner's checkout that folder belongs to a real baseline (id 1), so an I5 regression would quietly overwrite the owner's packs. Suggest the runner checks the temp packs folder has the baseline's files after import (and the API serves one). | `run-e2e-fixture.mjs:98-100` | qa |
| F-7 | Minor | `FEED_PATH` errors (missing path, not a zip, missing files) print an uncaught stack trace. The message is right but hard to spot. Catch them in `import-cli.ts` and print one line, as the T-2 refusal does. | `import-cli.ts:96-100`, `feed-cache.ts:66` | developer |
| F-8 | Note | The id of a local feed comes from file names, sizes and modification times. A fresh checkout or a copy of the same feed gets a new id, so importing a day again creates a second baseline for that date rather than replacing it, and T-2's guard (which keys on the feed id) never comes into play. Extracted zips in `%TEMP%\gtfs-editor-feeds` are never removed. A content hash would be more predictable; at least document it. | `feed-cache.ts:62-90` | developer / architect |
| F-9 | Note | On the fixture, two checks skip themselves (road-closure re-route with no routing server; the line 100 bridge check). So the fixture run covers a little less than the real one. Worth saying in CLAUDE.md. | `scenarios.e2e.mjs:1215` | qa |
| F-10 | Note | The busy-port check only sees an HTTP server; any other listener costs a 60-second wait before a clear failure. "could not drop gtfs_e2e: " prints an empty message when the database is unreachable (`err.message` of an `AggregateError`). | `run-e2e-fixture.mjs:86-90, 118-121` | developer |
| F-11 | Note | New `.mjs` scripts are untyped. That follows the existing e2e convention, but since Node runs `.ts` directly, the architect may want new scripts in `.ts`. | `run-e2e-fixture.mjs`, `make-mini-feed.mjs` | architect |
| F-12 | Note | Stale map lines: `codebase-map.md:73` "issue **I1** is at line 54"; `:21` "Open issues (I1 to I4)". | `docs/codebase-map.md` | architect |

## 8. Not run

- `npm run test:e2e` against the owner's running API on 3001 (AC5). I may not call it. Checked by reading: neither the suite nor its script changed, and the suite's own `API` default is untouched. The owner should run `npm run dev` and then `npm run test:e2e`, and expect the same result as before this branch.

## 9. Issues routed

The tracker is the spreadsheet, which I was told not to edit. Findings F-1 to F-12 are listed above for the project manager to record against T-3. F-3 needs the owner's decision; F-1 and F-2 send the ticket back to In progress.

## 10. Reviewer notes

- Timing: 47 s and 41 s on a quiet machine, and about 2 minutes while another job ran. That is within the ticket's 5-minute limit. CLAUDE.md says "about half a minute", which is a little optimistic.
- The runner's safety is good: the database name is checked against a pattern before any connection, the port is checked before anything is created, and cleanup runs in `finally`, including on a failed check.
- The importer and API live in this worktree, but the runner's database and ports are shared machine-wide. Two runs at once (for example two reviewers) would fight over `gtfs_e2e` and 3101. The port check catches the second API, but `drop database ... with (force)` at the start would end the first run's connections. Use `E2E_DB` and `E2E_PORT` to run side by side.
- Cleanup: no `gtfs_e2e` or `gtfs_review_*` database remains. Nothing listens on 3101, 3110 or 3111. I removed the temp packs folder orphaned by PR-T3-04, the zip extraction from PR-T3-09, and the worktree's `data/` folder. The fixture files I changed for mutation tests were restored with `git checkout`; the worktree is clean at `d3d7c0e`.
