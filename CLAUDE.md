# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

`PLAN.md` is the living status and handover document. Read its "Where we are" and "Things a new session needs to know" sections (top ~60 lines) before starting work, and update them when you finish something.

- The next feature is agreed with the owner before building. A "next step" line in PLAN.md is not a request to build it.
- Do not add game features (goals, scores and the like). The project is an editor and a simulator, not a game.

## Layout and runtime

- npm workspaces: `apps/web` (React 19 + Vite + MapLibre/deck.gl), `apps/api` (Fastify), `packages/core` (pure logic, unit-tested), `packages/gtfs` (import, export, DB schema, CLIs). `services/router` is a separate Java 25 / Gradle project (RAPTOR journey router + passenger simulator).
- There is no TS build step on the Node side. The API and CLIs run `.ts` directly with Node's type stripping. Import with explicit `.ts` extensions, and use only erasable syntax (no `enum`, no `namespace`, no parameter properties).
- Ports: web 5173 (proxies `/api`), API 3001, router 3002, Postgres **5433** (not 5432).
- `ROUTER_URL` is the OSRM road router. `ROUTER_SERVICE_URL` is our Java journey router. They are different things.
- Times are seconds since the start of the service day and can go past 24:00.
- Put logic that needs no database in `packages/core`, with unit tests beside it (`*.test.ts`).

## Where code goes

The code is moving to this layout in stages (`docs/refactor-plan.md` stage 2), so older files may not follow it yet. New code should. Details and the target folders are in `docs/codebase-map.md`.

- One folder per part of the product (`scenarios/`, `map/`, `sim/`…), each holding its own components, logic, styles and types, plus `shared/` for what everything uses. Not `components/`, `hooks/` or `lib/`.
- File names: React components `PascalCase.tsx`; everything else `kebab-case.ts` (not camelCase). Unit tests beside the file as `name.test.ts`; end-to-end tests and fixtures in the package's `test/` folder. Styles go in the feature's own CSS file beside its components, not in `styles.css`.
- `shared/` imports nothing from a feature. A feature imports another feature only through its main file, never its internals. No import circles.
- No barrel files (an `index.ts` that only re-exports), except a package's public entry.

## Commands

- Start: `npm run db:up`, then `npm run dev` (API + web). The router is separate: `npm run router:dev`.
- The dev machine is short on memory. Start the dev servers in their own terminal, and don't run several heavy jobs (Gradle, export, dev servers) at once.
- Unit tests: `npm test`. Single file: `npx vitest run packages/core/src/reshape.test.ts`, and add `-t "name"` for a single test.
- Typecheck: `npm run typecheck` checks every workspace (web, API, core, gtfs). One workspace: `npm run typecheck -w @gtfs-editor/api`. Shared settings are in `tsconfig.base.json`; the API, core and gtfs also use `tsconfig.node.json`, which fails on imports Node can't run (a missing `.ts` extension, or a type imported without `type`).
- Lint: `npm run lint` (oxlint, not ESLint: typescript-eslint doesn't support TypeScript 7). Format: `npm run format` / `npm run format:check` (Prettier). A hook formats each file Claude edits. Markdown, SQL and `services/` aren't formatted.
- Need running servers: `npm run test:e2e` (API), `npm run test:sim` (API + router), `npm run test:ui` (`npm run dev`, headless Edge/Chrome over CDP), `npm run export:check` (API; about 5 min).
- The dev API restarts on any source change, which kills an export in progress. Don't edit files while `export:check` runs.
- Router scripts call `.\gradlew` in `services/router` (Windows). Arguments go in as Gradle properties, e.g. `npm run router:demand -- "-PsimArgs=check ..."`. Single Java test: `cd services/router; .\gradlew :router-core:test --tests gtfseditor.router.core.CapacityTest`.
- Java compiles with `-Xlint:all -Werror`: any javac warning fails the build.
- Router test journeys stay inside the Opal area (Newcastle, Sydney, Wollongong), not statewide.

## Data

`data/` is gitignored and about 4 GB (feeds, exports, router snapshots). Don't scan or list it recursively. The router's default timetable is `data/exports/check/export.zip`, written by `export:check`.

## Git

- Work on a feature branch and open a PR with `gh`. Don't commit to `master` directly.
- Commit subject: a plain-English sentence fragment, capitalised, no `feat:`-style prefix, no full stop. Separate several items with semicolons.
- Body: short prose and grouped bullets, wrapped at ~72 characters, ending with a `Tests:` line saying which suites ran and passed.

## Writing style

Docs, commit messages and UI text use plain English: short words, no jargon, British spelling ("metres", "colour"). Match it.
