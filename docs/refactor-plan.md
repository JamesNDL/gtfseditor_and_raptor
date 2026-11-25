# Refactor plan

Status: Draft, for the owner to approve. Written 23 November 2026 against commit c33fbef.

This plan makes the codebase easier and safer to change without changing what the app does. It follows the observations in `docs/architecture/system.md` (issues I1–I5, risks R1–R8). Read that first for how the system works.

## Decisions taken

| Decision | Choice | Date |
|---|---|---|
| CI and branch protection | Not now. Checks run locally through `/verify` | 23 Nov 2026 |
| How the web app and API share types | Shared types in `packages/core/src/api/` (option A below) | 23 Nov 2026 |
| Folder structure | Feature folders with agreed conventions (stage 2) | 23 Nov 2026 |

## Rules for the whole refactor

- **Nothing the user can see changes.** Every step keeps behaviour the same, unless the step says otherwise (only I1–I5 and the edit log do).
- **Small steps, one PR each.** Each step below is one branch and one PR, small enough to review in one sitting. If a step grows, split it.
- **Safety net first.** Stage 1 makes the later stages safe. Don't start moving code until it's done.
- **Move code, then improve it, never both at once.** A PR that moves or renames a file changes only the file's location and the import paths, so git sees a rename and `git blame` keeps the history. Rewrites go in a separate PR.
- **Run `/verify` before every PR.** Without CI, this is the check. For moves, also run `test:e2e` and `test:ui`.
- **Keep the docs current.** Each PR that moves code updates `docs/codebase-map.md` and any paths in CLAUDE.md in the same PR.

## What we're fixing, and why

| Problem | Evidence | Why it matters |
|---|---|---|
| Most of the Node code is never type-checked | Only `apps/web` has a tsconfig. A strict trial run on `apps/api` and `packages/gtfs` found 51 errors | Type errors reach runtime. Moving files without a typechecker means broken imports are only found when the code runs |
| `src` folders have no structure | `apps/web/src` has 26 files loose at the top level, mixing the app shell, map, editing tools, scenarios and helpers. `apps/api/src` is 14 flat files where edit kinds, routing and routes are mixed. File names mix `kebab-case` and `camelCase` | Hard to find things or tell what belongs together |
| Files import each other in circles | API: `scenarios.ts` imports `closures`, `reshape`, `schedule`, `stops` and `delete-stop`, and each of them imports `scenarios.ts` back. Web: `store.ts` ↔ `api.ts`, `store.ts` ↔ `scenario.ts` | Circles make it unclear what depends on what, and block splitting files cleanly |
| The best tests only run on one machine | `test:e2e`, `test:sim` and `test:ui` need the 4 GB feed, a running API and an imported day | Hard to run them often and quickly while refactoring |
| Three files do too much | `scenarios.ts` 2,131 lines (eleven edit kinds, the clash rules and 15 routes in one function); `MapView.tsx` 1,990 lines (one component, 20 hooks, 48 map sources and layers); `sim.ts` 1,631 lines (28 routes, timetable caching, result import and the run driver). `styles.css` is 3,072 lines | Hard to read and test in parts; every change risks something unrelated |
| Web and API agree only by hand | Response types are hand-copied in `apps/web/src/api.ts` and `sim/results.ts`. Request bodies are cast (`req.body as …`) 67 times with no checking. `fetch` is called directly from 11 web files | A change on one side breaks the other silently |
| Small things repeated | `fail()` is defined in 10 API files; number parsing is written several times | Drift, and noise in every file |
| Schema changes are ad hoc | `schema.sql` is rerun on every start and has 21 `alter table` lines added over time | No record of which database has which change; order-dependent |
| Lost work is possible | Re-import deletes scenarios (I1); no backup script; edits keep only a summary, so they can't be replayed | One mistake loses work that can't be rebuilt |

## Stage 1: Build the safety net (about 1 week)

### 1.1 Type-check everything
- Add a `tsconfig.json` to `apps/api`, `packages/core` and `packages/gtfs`, sharing a `tsconfig.base.json` at the root. Use the same settings as web: strict, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`.
- Add a root `npm run typecheck` that checks every workspace.
- Fix the 51 errors. Most are untyped database rows (`TS2339`, "property does not exist"). Fix them with row types on the `sql<…>` calls, not with `any`.
- **Done when:** `npm run typecheck` passes, and CLAUDE.md and `/verify` use it. This is what makes stage 2 safe: a broken import path fails the typecheck straight away.

### 1.2 Pin dependencies
- Pin `@duckdb/node-api` to the exact version installed now (it's on `"latest"`).

### 1.3 Protect data
- **I1:** the importer refuses to replace a day that has scenarios unless given `--replace`, and then says how many scenarios it will delete.
- Add `npm run db:backup` and `db:restore` (`pg_dump`/`pg_restore` of the scenario and simulator tables, into `data/backups/` with a date in the name).

### 1.4 A small test feed (two to four days)
- Build a fixture GTFS feed of a few kilobytes and check it into `packages/gtfs/test/fixtures/`. It needs one train line, one bus line, a ferry, a shared platform, a depot run and an after-midnight trip: enough to exercise every edit kind and clash rule.
- Teach `test:e2e` to run against a throwaway database seeded from the fixture, starting its own API on a spare port, so it doesn't need your dev servers or the 4 GB feed.
- Rewrite the assertions in `scenarios.e2e.mjs` that depend on real Sydney ids to use the fixture's ids. Keep a `--real` mode for the current behaviour.
- **Done when:** `test:e2e` runs in a minute or two from a clean checkout, so it's cheap to run after every move.

## Stage 2: Folder structure (about 1 week)

The aim is that anyone can guess where a file lives from what it does. Stage 2 only moves and renames files and breaks the import circles. Splitting the big files comes in stages 3 and 5, into these folders.

### 2.1 How to organise: the decision

| Option | What it is | For | Against |
|---|---|---|---|
| By kind | `components/`, `hooks/`, `lib/`, `routes/`, `services/` | Familiar | One feature is spread over five folders; `components/` becomes the new mess at 60 files |
| **By feature (recommended)** | One folder per part of the product (`scenarios/`, `map/`, `sim/`, `timeline/`…), each holding its own components, logic, styles and types, plus `shared/` for what everything uses | What changes together lives together; matches how the app is already thought about (`sim/`, `timeline/` and `inspector/` already work this way); a folder can grow without spilling | Needs a rule for what goes in `shared/` |

Within a feature folder that grows past about 10 files, use subfolders by sub-feature (e.g. `sim/results/`), not by kind.

### 2.2 Conventions (go in CLAUDE.md and the codebase map)

- **File names:** React components `PascalCase.tsx`. Everything else `kebab-case.ts` (`live-stats.ts`, `sim-api.ts`), matching the API and packages. Unit tests sit beside the file as `name.test.ts`; end-to-end tests and fixtures live in the package's `test/` folder.
- **One main thing per file.** A component file exports one component, with small private helpers beside it.
- **Styles live beside their component.** `styles.css` is split into `app/base.css` (variables, themes, resets) and one CSS file per feature, imported by that feature's top component.
- **What may import what:**
  - `shared/` imports nothing from features. `app/` (the shell) is not a feature, and `shared/` may read the app store (`app/store.ts`) but nothing else in `app/`.
  - Features may import `shared/` and the app store. A feature imports another feature only through files at the top of that feature's folder, never from its subfolders.
  - In the API, `scenarios/engine.ts` imports no edit kinds. Edit kinds import the engine; the registry imports the edit kinds.
  - No import circles, enforced by oxlint's `import/no-cycle` rule once stage 3 has broken the API circles.
- **No barrel files** (`index.ts` that only re-exports), except each package's public entry. Barrels hide circles and slow Vite's reload.
- **Feature folder names use the glossary terms** once `docs/glossary.md` exists.

### 2.3 Target layout: `apps/web/src`

```
apps/web/src/
  main.tsx
  app/              the shell: App.tsx, TopBar.tsx, LeftRail.tsx, TimeBar.tsx, store.ts, theme.ts, base.css
  shared/           used everywhere, owns nothing: api-client.ts (the one fetch wrapper: useApi()
                    and getJson() from today's api.ts, and send() from scenario.ts; the response types go to packages/core/src/api/
                    in stage 4), clock.ts,
                    live-stats.ts, ui/ (today's inspector/parts.tsx and other small pieces)
  map/              MapView.tsx (later split into hooks here, stage 5), ModePanel.tsx (show or hide
                    each mode's lines), map.css
  vehicles/         vehicles.ts (animation packs and vehicle positions)
  scenarios/        scenario.ts → scenario-client.ts, ScenarioPanel.tsx, ScenarioManager.tsx, EditConfirm.tsx
  editing/          the tools that change the network
    builder.ts      picking stops (shared by new-line and reshape)
    NewStopTool.tsx
    new-line/       NewLinePanel.tsx
    reshape/        ReshapePanel.tsx
    closures/       ClosurePanel.tsx
  inspector/        as now: RoutePanel, TripPanel, StationPanel, DeleteStop, TripEditTools…
  catalogue/        FleetPanel.tsx → CataloguePanel.tsx (the vehicle catalogue)
  timeline/         as now
  sim/
    sim-api.ts, SimPanel.tsx
    wizard/         SimWizard.tsx
    library/        SimLibrary.tsx
    results/        SimResults.tsx, SimResultsPeople.tsx, SimFigures.tsx, SimMapKey.tsx, results.ts, loads.ts
```

The web import circles break here: `store.ts` imports only types, and those types move to `packages/core/src/api/` (stage 4) or into the feature folder that owns them.

### 2.4 Target layout: `apps/api/src`

```
apps/api/src/
  server.ts         start-up and plugin wiring only
  http.ts           fail(), the small number and id parsers (replaces ten copies)
  network/          routes for the baseline: lines, stops, shapes (moved out of server.ts)
  routing/          finding paths and run times: roads.ts, tracks.ts, timings.ts
  scenarios/
    routes.ts       list, create, rename, delete, undo, redo, the edits endpoint, pack
    engine.ts       visible(), scenarioOf(), applyEdit(), cloning and removing trips
    clashes.ts      the clash rules
    vehicles.ts     assigning vehicles to trips, fleet and day figures
    stops-visible.ts  stopVisible(), stopDeleted() (from stops.ts)
    edits/
      registry.ts   edit kind → its function
      create-line.ts, line-frequency.ts, reshape.ts, set-vehicle.ts, set-vehicle-type.ts,
      shift.ts, delete.ts, delete-line.ts, duplicate.ts, skip-stop.ts, headway.ts,
      add-stop.ts (from stops.ts), delete-stop.ts, closure.ts (from closures.ts),
      and one file per kind now in schedule.ts
  catalogue/        the vehicle catalogue routes (today's fleet.ts)
  export/           export.ts
  sim/              routes.ts, timetables.ts, runner.ts, router-client.ts, results-import.ts,
                    results-read.ts (today's sim-results.ts)
```

The API import circles break when `engine.ts` comes out of `scenarios.ts`. That happens in stage 3, so 2.4 moves only the files that aren't inside the circle, plus `http.ts`, `network/`, `routing/`, `catalogue/` and `export/`.

### 2.5 Packages

```
packages/core/src/
  index.ts          public entry
  api/              the shared request and response types (stage 4)
  time.ts, limits.ts, simplify.ts, pack.ts, waits.ts, vehicle-days.ts
  edits/            reshape.ts, delete-stop.ts (the pure parts of edit kinds), with tests
  core.test.ts      split into a test beside each file it covers

packages/gtfs/
  sql/migrations/   0001_initial.sql, then one numbered file per schema change (stage 6)
  src/
    db.ts
    feed/           feed-cache.ts, unzip.ts, audit.ts, audit-db.ts
    import/         as now
    cli/            fetch.ts, import.ts, packs.ts, export-check.ts (the npm scripts point here)
  test/fixtures/    the small test feed (stage 1.4)
```

### 2.6 Order of PRs
1. Write the conventions into CLAUDE.md and the codebase map.
2. Packages (small, and they test the approach).
3. API: `http.ts`, then `network/`, `routing/`, `catalogue/` and `export/`.
4. Web: one PR per folder (`shared/` and `app/` first, as everything else depends on them), then the CSS split.
5. Turn on `import/no-cycle` once stage 3 has broken the API circles.

Each PR: `git mv`, fix the imports, run typecheck, unit tests, `test:e2e` and `test:ui`, and update the map.

## Stage 3: Split the big API files (about 1 week)

### 3.1 `scenarios.ts` into `scenarios/`
The seams already exist: every edit is an `editX(tx, sc, seq, body)` function inside `registerScenarioRoutes`.
- First PR: pull the inner functions out of `registerScenarioRoutes` so they take `sql` as a parameter instead of capturing it. Nothing else changes.
- Then one PR each for `engine.ts` (this breaks the circles), `clashes.ts`, `vehicles.ts`, and `edits/` with its registry.
- The registry replaces the lookup table inside `POST /api/scenarios/:id/edits`, and gives each kind its own body type instead of `Record<string, unknown>`. Adding a new edit kind becomes "add one file, add one line".
- `closures.ts` (1,144 lines) and `schedule.ts` (several kinds in one file) move into `edits/`. Split them if they're still too big.

### 3.2 `sim.ts` into `sim/`
Split as in 2.4. Fix I2 (the `sim-results.ts` header says it writes nothing) during the move.

## Stage 4: Shared types between web and API (3–5 days)

Options considered (decision D9 in `docs/architecture/system.md`): A, shared types in `packages/core/src/api/`; B, a schema library such as Zod, giving types and checks when the app runs; C, a client generated from an OpenAPI description, which adds a build step.

Chosen approach: A, request and response types written once in `packages/core/src/api/` and imported by both sides. There's no new library and no build step. Checking request bodies when the app runs (a schema library such as Zod) can be added route by route before hosting.

- 4.1 Create `packages/core/src/api/` with the scenario and edit types first, then the simulator, the catalogue and the network. Point the API routes and the web client at them; delete the hand-copied types.
- 4.2 Route every web request through `shared/api-client.ts` and each feature's own small API file (e.g. `sim/sim-api.ts`). Today 11 files call `fetch` directly.
- 4.3 Store each edit's request as JSON: add `body jsonb` to `scenario_edits` and write it in `applyEdit()`. It's never read yet; it's what makes rebasing possible later (decision D3).

## Stage 5: Split the big web files (spread out, as each is next touched)

### 5.1 `MapView.tsx`
One component with 20 hooks, each effect owning one drawing. Turn each into a hook in `map/`, called from a slim `MapView`:

```
map/
  MapView.tsx             wires the hooks together
  use-map.ts              create the map, style.load handling, the layer order list
  use-network-layers.ts   baseline lines and stops, mode visibility, selection highlight
  use-scenario-layers.ts  touched, created and deleted lines
  use-builder-layers.ts   the line being drawn
  use-closure-layers.ts   closure area and diversions, the faded background
  use-sim-layers.ts       run area, box drag, results, followed people
  use-vehicles.ts         the animation loop and deck.gl overlay
```
One hook per PR. Check each by eye with `npm run dev`, and run `test:ui`.

### 5.2 `SimResults.tsx` (1,406 lines)
Split by tab inside `sim/results/` when the simulator is next worked on.

### 5.3 Web unit tests
Add Vitest tests for the pure web logic: the scenario client (stale-edit and confirm handling), `clock.ts`, `vehicles.ts`, `sim/results/results.ts`. Pure logic found during 5.1 moves to `packages/core`.

## Stage 6: Database changes as numbered migrations (1 day)

- Freeze today's `schema.sql` as `packages/gtfs/sql/migrations/0001_initial.sql`, and record which migrations have run in a `schema_migrations` table. A database with nothing recorded runs 0001 once (it is idempotent), so an existing database is brought level with a fresh one.
- Each later change is a new numbered file that runs once. Do this before the next schema change; note that 4.3 is a schema change, so it can be migration 0002.

## Stage 7: Docs and way of working (1–2 days)

- Slim `PLAN.md` to status, the next feature and the roadmap (aim for under 10 KB). Design moves to `docs/architecture/`, decisions to the decision log, and the history lives in git.
- Fix the 18 stale doc lines listed in `system.md`.
- For new features, use a one-page BRD, then failing tests, then code, using the skills already set up.

## The small fixes (I2–I5)

Fold each into the stage that touches the file:
- I2: the wrong header in `sim-results.ts` (stage 3.2).
- I3: undo and redo should wait while an edit is in flight (`apps/web/src/scenario.ts:244-261`; stage 2.3 when it moves).
- I4: the stale "while editing a scenario" text in `TripEditTools.tsx:11` and `FleetPanel.tsx:283` (stage 2.3).
- I5: the importer ignores `PACKS_DIR` (stage 2.5).

## Order and size

| Stage | Rough size | Can feature work carry on? |
|---|---|---|
| 1 Safety net | about 1 week | Better not; everything after depends on it |
| 2 Folder structure | about 1 week | Not during the web moves: open branches will clash with the renames. Finish stage 2 in one go |
| 3 API splits | about 1 week | Yes, between PRs |
| 4 Shared types | 3–5 days | Yes |
| 5 Web splits | about 1 week, spread out | Yes; do it as files are touched |
| 6 Migrations | 1 day | Yes; before the next schema change |
| 7 Docs | 1–2 days | Yes |

Stages 1–4 bring most of the benefit. Stages 5–7 can be spread over normal feature work.

## Not in this plan

- CI and branch protection (decided against for now).
- Security and hosting: logins, upload limits, our own road router, and moving sim jobs out of the API. That's a separate design for when hosting is planned (risk R1).
- The Java router: it's already well separated and tested. Leave it alone.
- Rewriting anything in a new framework or library, or changing the copy-on-write design. The design is sound; the problems are structure, size and missing checks.

## Risks

- **Fixing the 51 type errors may find real bugs.** Any fix that changes behaviour gets its own PR with a test, not one buried in the typecheck PR.
- **Moves break in ways the typecheck can't see.** Path strings built at runtime (for example `new URL('../sql/schema.sql', import.meta.url)`), npm scripts and test files that point at source paths. Search for each moved file's name before each move PR.
- **Renames collide with work in progress.** Merge or park open branches before stage 2.
- **Splitting `styles.css` can change which rule wins.** Keep `base.css` loaded first, and check both themes by eye.
- **The fixture feed may miss cases the real feed has.** Keep `test:e2e --real` and run it after big changes.
- **MapView splits can break drawing order.** MapLibre draws layers in the order they're added. Keep the order list in `use-map.ts`, and check by eye.
- **The refactor could drag on.** Stop after stage 4 if feature work matters more.
