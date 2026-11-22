# Peer review: T-1, Every workspace is type-checked and duckdb is pinned

| | |
|---|---|
| Ticket | T-1 (EP-1, Foundation, P1, size M), `docs/project/refactor-tickets.xlsx` |
| Reviewer | Peer reviewer agent (independent; has not seen the developer's reasoning) |
| Date | 23 Nov 2026, from 08:46 AEDT |
| Requirements | No BRD, test plan or glossary exists for this refactor, by the owner's choice. The ticket traces to `docs/refactor-plan.md` §1.1 (type-check everything) and §1.2 (pin dependencies). Reviewed against the ticket's five acceptance criteria and its Agent brief instead. |
| Code reviewed | Commit `2f92076` ("Type-check every workspace; pin duckdb"), diffed against its parent `34fd027`. Tests run on `61dde1f` (tip of `architecture-docs`, PR #1), detached. Later commits on that branch touch none of the T-1 files except a header change in `sim-results.ts` (I2). |
| Environment | Windows 11 Pro 10.0.26300, Node v26.13.0, npm 10.8.2, TypeScript 7.0.2, oxlint and Prettier from the lockfile. Fresh reviewer worktree, `npm install` (no change to the lockfile). No database, no servers. |
| Ticket status | The spreadsheet at `61dde1f` still shows T-1 as "In progress"; the owner says it is In review. Reviewed as In review. |
| **Verdict** | **Changes requested.** The code is sound and behaviour is unchanged, but the skill's file-length and type-silencing rules are breached as written, and the typecheck has two gaps that undercut the purpose stage 1.1 gives it. |

## 1. Summary

T-1 does what it says. `npm run typecheck` at the root checks all four workspaces (web, api, core, gtfs), passes, and fails when a type error is put into any of them. The duckdb pin is exact and the lockfile agrees. No `any`, `@ts-ignore` or `@ts-expect-error` was added; one `Record<string, any>` cast and one `as unknown as` cast were removed. I proved "no behaviour change" directly: stripping the types from the before and after copy of every changed source file (the same way Node does) leaves only one real JavaScript change, an extra `await` in `export-check.ts`, and a DuckDB run shows it returns the same rows as before. Every non-null assertion (`!`) added holds, given the schema.

Tests: 17 run. 15 Pass, 2 Fail (both are gaps in the typecheck set-up, not in the developer's code), 0 Blocked. 3 commands Not run (the two e2e suites and `export:check`, which need the owner's servers).

What stops an Approve:
- **F-1 (Major; architect, then developer):** the Node workspaces use `moduleResolution: "bundler"` and no `verbatimModuleSyntax`. So the typecheck passes two kinds of import that crash the API under Node: a relative import with no `.ts` extension, and a type imported without `type`. Refactor plan §1.1 says the typecheck exists so that "a broken import path fails the typecheck straight away" during stage 2's file moves; for these two cases it does not. Today's code already passes the Node-accurate settings with zero errors, so the fix is three lines of config. The brief prescribed `bundler`, so this is a design point first.
- **F-2 (Major as the skill is written; owner to weigh):** all six changed source files were already well over 300 lines, and T-1 made four of them longer by 81 lines in total (scenarios.ts +21, server.ts +12, sim.ts +47, sim-results.ts +1). The brief forbade splitting files, and stages 2 and 3 of the plan split all of them, so the developer had no in-scope way to comply.
- **F-3 (Major as the skill is written; a one-line fix):** `scenario_head!` at `sim.ts:1236` has no comment saying why it cannot be null. It is in fact safe (section 5).

Smaller findings: a vague comment on a new `as never[]` cast (F-4), a misleading parameter type in `server.ts` (F-5), loose `string` types where the database allows a few fixed values (F-6), and a stale doc (F-7). Unused code: none introduced.

## 2. Charter and coverage

A small, low-risk ticket, but it claims "no behaviour change" over about 50 type fixes and it is the safety net for the whole refactor. So the effort went on:

1. **Does the safety net work?** The root typecheck covers all four workspaces; it fails on a planted error in each; it catches the kinds of breakage stage 2's file moves cause (missing file, missing extension, type-only import).
2. **No behaviour change.** Compare the JavaScript Node actually runs, before and after; check every `!`, cast and `await` against the schema and the library; load the changed modules under Node.
3. **The pin.** package.json, lockfile, installed version, `npm install --dry-run`.
4. **Config.** Web's effective config unchanged; Node types only where wanted; which `.ts` files are not covered.
5. **Standards.** File length, typing searches, unused code with tsc's `noUnusedLocals`/`noUnusedParameters` and oxlint.
6. **Regression.** Unit tests, lint, format.

Skipped on purpose: negative input, security, accessibility and UI testing (the ticket changes no input handling, no endpoints and no UI) and performance (only types changed). The e2e suites need the owner's API and router (section 9).

## 3. Test log

All evidence is in `docs/reviews/T-1/evidence/`. Scratch files were made in the reviewer worktree and deleted; `git status` was clean afterwards.

| ID | Category | What and why | Command / input | Expected | Actual | Outcome | Evidence |
|---|---|---|---|---|---|---|---|
| PR-T-01 | Acceptance (AC1) | The root typecheck covers all four workspaces and passes on a clean checkout | `npm run typecheck` | api, web, core, gtfs each run `tsc --noEmit`; exit 0 | All four ran; exit 0 | Pass | `01-typecheck.txt` |
| PR-T-02 | Acceptance (AC1), test quality | A type error in any workspace fails the root typecheck (proves each workspace is really checked and the exit code reaches the top) | Added `zz-review-scratch.ts` containing `export const reviewScratch: number = 'not a number';` to each of the four `src` folders, ran `npm run typecheck`, deleted them | TS2322 in all four; non-zero exit | TS2322 in api, web (plus core through web), core and gtfs; npm carried on through all four and exited 1 | Pass | `02-typecheck-fails-all.txt` |
| PR-T-03 | Beyond spec (plan §1.1) | A broken import path fails the typecheck | Scratch file in api importing `./does-not-exist.ts` | Error | TS2307; exit 1 | Pass | `03-import-paths.txt` |
| PR-T-04 | Beyond spec (plan §1.1) | An import with no extension, the likeliest slip during a file move | Scratch file in api: `import { visible } from './scenarios'`; typecheck, then `node` it | Typecheck fails, as Node will | **Typecheck exit 0; Node crashes with ERR_MODULE_NOT_FOUND** | **Fail** (F-1) | `03-import-paths.txt` |
| PR-T-05 | Beyond spec | A type imported without `type` (Node strips types but keeps the import, so it fails at load) | Scratch file in api: `import { Described } from './schedule.ts'`; typecheck, `node`, oxlint | Typecheck fails | **Typecheck exit 0; Node: "does not provide an export named 'Described'"; oxlint only warns (exit 0)** | **Fail** (F-1) | `16-type-import.txt` |
| PR-T-06 | Beyond spec | Would Node-accurate settings work on today's code, and catch PR-T-04 and 05? | Scratch tsconfigs extending each Node workspace's config with `module`/`moduleResolution: nodenext`, then also `verbatimModuleSyntax: true` | Both caught; real code passes | Both caught (TS2835, TS1484). Real code in api, core and gtfs: 0 errors | Pass (shows F-1's fix is cheap) | `05-nodenext-trial.txt`, `17-node-config-trial.txt` |
| PR-T-07 | Acceptance (AC5) | No behaviour change: the JavaScript Node runs is the same | `node strip-compare.mjs pre t1files <six files>`: strips types with `stripTypeScriptTypes` from `node:module` on the `34fd027` and `2f92076` copies and lists lines that differ (whitespace ignored) | Only comments, line breaks and erased type syntax differ | Only those, plus one real change: `(await (await db.run(sql)).getRowObjectsJson())` in export-check | Pass | `12-stripped-js-diff.txt`, `strip-compare.mjs` |
| PR-T-08 | Acceptance (AC5) | The added `await` in export-check's `q()` gives the same rows. (`getRowObjectsJson()` returns a Promise in 2.0.0-r.1; an async function returning a Promise already unwrapped it.) | `node duckdb-q.mjs` from the repo root: old and new `q()` on an in-memory DuckDB. Also checks that a tag and template split over two lines (what stripping a multi-line `sql<...>` leaves) is still a tagged template | Same rows; still tagged | Same rows, both arrays; still tagged. The first attempt failed on a Windows import path in my script; fixed and re-run (both kept in the log) | Pass | `13-duckdb-q.txt`, `duckdb-q.mjs` |
| PR-T-09 | Regression | The changed files still parse under Node | `node --check` on the six files | exit 0 each | exit 0 each | Pass | `14-node-check.txt` |
| PR-T-10 | Regression | The changed route modules load under Node (would catch `Described` imported as a value) | `node --input-type=module -e` importing scenarios, schedule, sim, sim-results | All load | All four load and list their exports | Pass | `15-module-load.txt` |
| PR-T-11 | Acceptance (AC3) | duckdb pinned exactly, matches what is installed, lockfile agrees | grep package.json and the lockfile, `npm ls`, `npm install --dry-run`, `git status` after `npm install` | 2.0.0-r.1 throughout; no drift | `"@duckdb/node-api": "2.0.0-r.1"`; lockfile root and workspace entries 2.0.0-r.1; bindings 2.0.0-r.1; `npm ls` 2.0.0-r.1; install changed nothing | Pass | `11-duckdb-pin.txt` |
| PR-T-12 | Acceptance (AC4) | CLAUDE.md and `/verify` say to run the root typecheck | Read `git show 2f92076 -- CLAUDE.md .claude/skills/verify/SKILL.md` | Both updated | The CLAUDE.md Commands line and the verify table row ("any TS, or a `tsconfig*.json`") both updated | Pass | the commit itself |
| PR-T-13 | Acceptance (AC2), typing | No `any`, `@ts-ignore` or `@ts-expect-error` added | grep of the added lines in the T-1 diff | None | None. Added: one `as never[]` cast (commented) and five `!`. Removed: `rows as Record<string, any>[]` and `[] as unknown as typeof stops` | Pass (see F-3, F-4) | `09-typing-search.txt`, `t1-ts.diff` |
| PR-T-14 | Regression | Unit tests | `npm test` | Pass | 4 files, 61 tests passed | Pass | `06-npm-test.txt` |
| PR-T-15 | Regression | Lint | `npm run lint` | exit 0, nothing new in changed files | exit 0; 28 warnings, all in `apps/web` files T-1 did not touch; none in changed files | Pass | `07-lint.txt` |
| PR-T-16 | Regression | Format | `npm run format:check`; then with `--end-of-line auto`; then T-1's files alone | Pass | The plain check failed on 13 files T-1 did not touch. They are CRLF only in this reviewer worktree (index LF, working copy CRLF, left from checking out an older commit with autocrlf on). Ignoring line endings, everything passes; T-1's files pass outright | Pass | `08-format.txt` |
| PR-T-17 | Unused code | tsc with `noUnusedLocals` and `noUnusedParameters` on all four workspaces, plus a control file to prove the check bites | Scratch `tsconfig.review-unused.json` per workspace extending the real one; `npx tsc --noEmit -p ...` | 0 errors; control fails | 0 errors in all four; the control file gave two TS6133 | Pass | `04-tsc-unused.txt` |
| PR-T-18 | Regression (e2e) | Every edit kind and the simulator over HTTP | `npm run test:e2e`, `npm run test:sim` | n/a | n/a | Not run (needs owner) | section 9 |
| PR-T-19 | Regression | `export:check` is the only real caller of the changed `q()` | `npm run export:check` | n/a | n/a | Not run (needs owner); PR-T-08 covers the change itself | section 9 |

## 4. Code readability review

Read in full where changed, with the surrounding code: `apps/api/src/scenarios.ts` (imports, the new row types at 91-104, `describe` at 224-238, the playback stop times at 2091-2101), `schedule.ts` (`Described`, `ScheduleDeps`), `server.ts` (`tripsWhere` at 434-466, platform rows at 565, vehicle days at 616), `sim-results.ts` (`whoFragment` at 711-715), `sim.ts` (`SimRunRow` at 188-232, `runs()` at 1180-1268, `timetableKey`), `packages/gtfs/src/export-check.ts` (`q()` at 68-69), the five tsconfigs and four package.json files. Checked against `packages/gtfs/sql/schema.sql` and `packages/gtfs/src/db.ts`.

**Readable?** Yes. The row types are plain interfaces whose names say what they are (`PackStopRow`, `SimRunRow`, `DescribeRow`), each with a one-line comment. Removing `[] as unknown as typeof stops` and `rows as Record<string, any>[]` makes the code simpler and more honest. `DescribeRow = Omit<Described, 'label'> & {...}` neatly ties the row to the shape `describe` returns. Points:
- F-5: `server.ts:434` types the `which` parameter as `ReturnType<typeof visible>`, but the second caller (line 464) passes a condition that has nothing to do with `visible()`. A reader will think it must be a visibility rule. `sim.ts:1180` and `sim-results.ts:711` spell the same idea `ReturnType<typeof sql>`, so there are now two spellings of "a query fragment".
- `SimRunRow` (sim.ts:188-232) sits near the top of the file, about 950 lines from its only use in `runs()` (1181). It mixes camelCase and snake_case fields; that mirrors the SQL aliases (the snake_case ones are exactly those `runs()` takes out by destructuring), which is fine but not said. Note.

**Single purpose?** No new functions were written; the changed functions keep their one job. Nothing to flag.

**Well commented?** Mostly. The `!` on `run.baselineId` says why (`// not null: a run without one is gone`), and `SimRunRow` explains the box and the partly-named summary. Gaps:
- F-3: `scenario_head!` (sim.ts:1236) has no explanation.
- F-4: the comment on the new cast at `sim-results.ts:712` says "postgres.js checks them", which overstates what postgres.js does.
- `area_west!`, `area_north!`, `area_east!` (sim.ts:1255-1257) rely on the "all set or all null" comment on the type (sim.ts:216), not at the use. Acceptable; Note.

Lint and complexity: `npm run lint` exit 0, nothing in T-1's files (`07-lint.txt`). No complexity tool is configured.

## 5. Behaviour check of every assertion, cast and await

| Where (at 2f92076) | Change | Safe? | Why |
|---|---|---|---|
| sim.ts:1234 | `run.baselineId!` | Yes | Inside `if (!gone ...)`, and `gone` is true when `baselineId === null`. TypeScript cannot follow that through a variable for a non-readonly property, hence the `!`. Commented. |
| sim.ts:1236 | `run.baselineId!` | Yes | Same guard. |
| sim.ts:1236 | `scenario_head!` | Yes, but uncommented (F-3) | Only reached when `run.scenarioId` is truthy. `sim_runs.scenario_id` is a foreign key with `on delete set null`, so a non-null id means the scenario row exists and the left join matches; `scenarios.head` is `int not null default 0`. So `s.head` is never null here. |
| sim.ts:1255-1257 | `area_west!`, `area_north!`, `area_east!` | Yes by convention, not by constraint | Guarded by `area_south === null`. Every writer (sim.ts:1343, 1394, 1429) sets all four from one box or all to null. No check constraint in the schema enforces it. Note. |
| sim.ts:1210 | `rows as Record<string, any>[]` removed | Improvement | `out` is now typed from `SimRunRow`. Erased at run time. |
| sim.ts:1181 | `sql<SimRunRow[]>` | Matches the query | All 37 selected columns are in the interface with the right nullability. `result_rows` is `bigint` and `db.ts` parses int8 to a number, so `resultRows: number` is right. |
| scenarios.ts:225 | `tx<DescribeRow[]>` | Mostly | `stops.name` is `not null`, so `from` and `to: string` are right. `trips.start_secs` is nullable in the schema, but `Described.start_secs` (already in schedule.ts) says `number`. Not new; Note. |
| scenarios.ts:2092 | `sql<PackStopRow[]>` | Yes | `arr` and `dep` are `int not null`; `dist` is coalesced and cast to `float4`; `trip_id` is bigint, parsed to a number. |
| server.ts:565, 616 | Row types on platforms and vehicle days | Yes | Match the schema (`platform_code` nullable; the vehicle-day columns not null). |
| sim-results.ts:713-714 | `...values: unknown[]` and `values as never[]` | Run time unchanged (PR-T-07) | Loosens compile-time checking of what goes into the query (F-4). Before, `never[]` made every call site an error. |
| export-check.ts:69 | Added `await` | No-op (PR-T-08) | See PR-T-08. |

On the row types generally: postgres.js `sql<T>` is an unchecked assertion. Nothing checks the rows against `T` at run time, and every untyped query (about 280 in apps/api, against 7 typed ones) still returns rows whose fields are `any`, because postgres.js's `Row` is `{ [column: string]: any }`. So "strict passes" says little about database code. This is the approach the brief chose; a Note for the architect, not a T-1 defect.

## 6. Coding standards check

### File length

Line counts at `2f92076` (`wc -l`, `10-file-lengths.txt`); lines added and removed from `git show --numstat 2f92076`.

| File | Lines after T-1 | T-1 added / removed (net) | Over 300? | Planned split |
|---|---|---|---|---|
| apps/api/src/scenarios.ts | 2,152 | +26 / -5 (+21) | Yes, already was | Stage 3.1 (into `scenarios/`) |
| apps/api/src/sim.ts | 1,678 | +54 / -7 (+47) | Yes, already was | Stage 3.2 (into `sim/`) |
| apps/api/src/sim-results.ts | 1,138 | +3 / -2 (+1) | Yes, already was | Stages 2.4 and 3.2 (becomes `results-read.ts`) |
| apps/api/src/server.ts | 685 | +15 / -3 (+12) | Yes, already was | Stage 2.4 (routes move to `network/`) |
| apps/api/src/schedule.ts | 491 | +1 / -1 (0) | Yes, already was; not grown (Note) | Stage 3.1 (into `edits/`) |
| packages/gtfs/src/export-check.ts | 306 | +1 / -1 (0) | Yes, already was; not grown (Note) | Stage 2.5 (`cli/`) |
| tsconfig.base.json, four workspace tsconfigs, four package.json | under 50 each | new or small | No | n/a |

F-2: four files over the limit were made longer (81 lines net, most of them the 46-line `SimRunRow` interface). Under the skill's rules a file the ticket made longer that was already over the limit is Major. Against that, the brief put splitting and moving code out of scope, and stages 2 and 3 of the plan split every one of these files. Putting `SimRunRow` in a new `sim-types.ts` was the only way not to grow `sim.ts`, and that is arguably the "splitting" the brief forbade. The owner should decide whether to accept this until stage 3.

### Strong typing

- Type checker: `npm run typecheck`, strict in every workspace through `tsconfig.base.json` (`"strict": true`); exit 0 (`01-typecheck.txt`). Web's effective config (`tsc --showConfig`) is the same as before plus `erasableSyntaxOnly`. Node types are only in api, core and gtfs; web keeps `vite/client` and the DOM libraries.
- Searches of the added lines (`09-typing-search.txt`): no `any`, no `@ts-ignore` or `@ts-expect-error`. One new `as never[]` cast (F-4, commented). Five new `!` (one uncommented, F-3). `unknown` is used for `settings` and `progress` (as `Record<string, unknown>`) and for `summary.capacities` and `summary.people`; these go straight into the JSON reply and are never read, and the type's comment says only the parts read are named. Acceptable; Note.
- Loose types where the database allows a fixed set (F-6): `SimRunRow.kind: string` (schema: `'bau' | 'scenario'`), vehicle-day `source: string` (`'run_number' | 'inferred'`), `SimRunRow.state: string` (seven states, listed in a schema comment).
- Older escapes in the six files are unchanged, except that `sim.ts` lost one `any` and `sim-results.ts` gained the one `as never[]` (counts in `09-typing-search.txt`; the `any` count includes the English word in comments, so read it only as a before-and-after comparison).
- Not type-checked by any workspace: `apps/web/vite.config.ts` and the root `vitest.config.ts` (the first was not checked before T-1 either). Note.

## 7. Unused code check

- `npm run lint` (oxlint, correctness rules as errors): exit 0, nothing in T-1's files (`07-lint.txt`).
- tsc with `noUnusedLocals` and `noUnusedParameters` on all four workspaces, through scratch configs extending the real ones (the repo's config was not changed): 0 errors. A control file with an unused import and parameter gave two TS6133, so the check works (`04-tsc-unused.txt`).
- New names searched: `DescribeRow` (used at scenarios.ts:225), `PackStopRow` (2092, 2096), `SimRunRow` (sim.ts:1181), `export interface Described` (imported as a type at scenarios.ts:45). All used.
- New dependency `@types/yauzl`: used; `packages/gtfs/src/unzip.ts:5` imports `yauzl`.
- New scripts: every workspace `typecheck` script is reached from the root script.
- Not run: knip, ts-prune, depcheck (not installed; not needed for a change this small).

Result: no unused code introduced by T-1.

## 8. Findings

**F-1. Major. The typecheck passes imports that crash the API under Node.** Owner: architect (the brief chose `bundler`), then developer.
- Reproduce: in `apps/api/src`, add a file containing `import { visible } from './scenarios';`, run `npm run typecheck -w @gtfs-editor/api` (exit 0), then `node` the file (ERR_MODULE_NOT_FOUND). The same with `import { Described } from './schedule.ts';` (typecheck exit 0; Node: "does not provide an export named 'Described'"; oxlint only warns). Evidence: `03-import-paths.txt`, `16-type-import.txt`.
- Expected: refactor plan §1.1 says the typecheck makes stage 2 safe because "a broken import path fails the typecheck straight away". Actual: these two common slips during a file move pass the typecheck and only show when the API starts.
- Cause: `tsconfig.base.json` uses `moduleResolution: "bundler"` (right for Vite, not for Node) and has no `verbatimModuleSyntax`.
- Suggested fix: in the `apps/api`, `packages/core` and `packages/gtfs` tsconfigs set `"module": "nodenext", "moduleResolution": "nodenext", "verbatimModuleSyntax": true` (or put them in the base and override them for web). Trial: today's code passes with 0 errors in all three, and both slips are caught (`17-node-config-trial.txt`). A partial alternative is to make oxlint's `typescript/consistent-type-imports` an error, which covers only the second case.

**F-2. Major (as the skill is written). Four over-long files made longer.** Owner: the owner to weigh; project manager if a follow-up is wanted.
- `scenarios.ts` 2,152 lines (+21), `sim.ts` 1,678 (+47), `sim-results.ts` 1,138 (+1), `server.ts` 685 (+12). Details and planned splits in section 6. The brief forbade splitting, and stages 2.4, 3.1 and 3.2 split all of them. Suggest accepting it, with a note on the stage 3 tickets to move `SimRunRow`, `PackStopRow` and `DescribeRow` into the new type modules.

**F-3. Major (as the skill is written; a one-line fix). An uncommented non-null assertion.** Owner: developer.
- `apps/api/src/sim.ts:1236` at `2f92076`:
  ```ts
  ? { id: run.scenarioId, baselineId: run.baselineId!, head: scenario_head! }
  ```
- It is correct (foreign key `on delete set null`, and `scenarios.head int not null`; section 5), but nothing says so. Add a short comment, for example "a run's scenario id is cleared when the scenario is deleted, and head is never null".

**F-4. Minor. The new cast's comment overstates the safety.** Owner: developer (architect to note).
- `apps/api/src/sim-results.ts:712-714` at `2f92076`:
  ```ts
  // Values are anything a query takes (text, numbers, arrays, fragments); postgres.js checks them.
  const sqlOne = (strings: TemplateStringsArray, ...values: unknown[]) =>
    [sql(strings, ...(values as never[]))] as [ReturnType<typeof sql>];
  ```
- `unknown[]` plus `as never[]` lets any value through at compile time; postgres.js serialises values rather than checking them against the query. Run time is unchanged (PR-T-07). Suggest trying `...values: postgres.ParameterOrFragment<never>[]` (the type postgres.js's own template signature uses) and dropping the cast; if that does not type-check, reword the comment to say why the cast is needed.

**F-5. Minor. A misleading parameter type.** Owner: developer.
- `apps/api/src/server.ts:434`: `const tripsWhere = async (which: ReturnType<typeof visible>)`. Line 464 passes a "removed by this scenario" condition, not a visibility rule. Suggest one named alias for a query fragment (for example `type Fragment = postgres.PendingQuery<postgres.Row[]>` beside `Sql` in `db.ts`), used here and at `sim.ts:1180` and `sim-results.ts:711`.

**F-6. Minor. Strings where the database allows a fixed set.** Owner: developer.
- `sim.ts` `SimRunRow.kind: string` (schema check `'bau' | 'scenario'`), `server.ts:620` `source: string` (`'run_number' | 'inferred'`), `SimRunRow.state: string`. A union type would let the typecheck catch a misspelt comparison such as `run.kind === 'senario'`.

**F-7. Note. A doc still describes the old typecheck.** Owner: architect.
- `docs/codebase-map.md:17` still gives `npm run typecheck -w @gtfs-editor/web` as the typecheck. The ticket did not ask for this file to change, but it is now out of date.

**F-8. Note. Smaller observations.** Owner: architect.
- `npm run typecheck --workspaces --if-present` silently skips any future workspace with no `typecheck` script.
- `trips.start_secs` is nullable but `Described.start_secs` is `number` (older code).
- The four sides of a run's area are all-or-nothing by convention only; a check constraint would back the `!`s at sim.ts:1255-1257.
- The commit message does not list the `as never[]` cast or the `!`s. AC2 only asks for `any`, `@ts-ignore` and `@ts-expect-error` to be listed, so this is not a failure.

## 9. Not run

| What | Why | What the owner should run |
|---|---|---|
| `npm run test:e2e` | Needs the API on 3001 and the `gtfs_editor` database; the reviewer must not call the owner's servers or touch that database | With the dev servers up: `npm run test:e2e` |
| `npm run test:sim` | Needs the API and the Java router on 3001 and 3002 | `npm run router:dev`, then `npm run test:sim`. This exercises `runs()` in sim.ts and `whoFragment` in sim-results.ts. |
| `npm run export:check` | Needs the API; about 5 minutes; the only real caller of the changed `q()` | `npm run export:check` (don't edit files while it runs) |

PR-T-07 shows the JavaScript these suites would run is unchanged apart from the proven no-op `await`, so the risk is low.

## 10. Issues routed

None recorded in the tracker: the owner asked that the project manager route findings, so the spreadsheet and GitHub were not edited. For routing:
- Developer: F-3, F-4, F-5, F-6 (and F-1 once the architect decides).
- Architect: F-1 (config decision), F-7, F-8, and the note on unchecked row types in section 5.
- Owner or project manager: F-2 (accept until stage 3, or ask for type modules now).

## 11. Reviewer notes

- The strongest evidence for "no behaviour change" is `12-stripped-js-diff.txt`: it compares what Node actually runs, so it covers all 50 fixes at once rather than one at a time.
- The developer's reported checks (typecheck, 61 unit tests, lint, format with `--end-of-line auto`) all reproduced.
- The brief gave the Node workspaces the web app's `bundler` resolution. That is the root of F-1, and it is worth fixing before stage 2 starts, because stage 2 is what the typecheck is meant to protect.
- Clean-up: all scratch files and scratch tsconfigs were deleted from the reviewer worktree; `git status` was clean at the end. Nothing was committed.
