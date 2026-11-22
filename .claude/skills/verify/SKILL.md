---
name: verify
description: Run the checks that match what changed (unit tests, typecheck, router tests, e2e suites) and report what passed, failed or was skipped. Use before calling a change done or before committing.
---

Work out what changed: `git status --short` and `git diff --name-only master...HEAD` (plus uncommitted changes). Then run only the checks that apply, one at a time, since the machine is short on memory.

| Changed | Run |
|---|---|
| any TS/JS/CSS/JSON | `npm run lint` and `npm run format:check` (lint warnings are not failures, but mention new ones in changed files) |
| `packages/**` or `apps/api/**` | `npm test` |
| any TS, or a `tsconfig*.json` | `npm run typecheck` (checks every workspace) |
| `services/router/**` | `npm run router:test` (javac warnings fail the build, so read them) |
| `apps/api/**` or `packages/gtfs/**` | `npm run test:e2e` if the API answers on http://localhost:3001 |
| `apps/api/src/sim/**`, `services/router/router-sim/**` or `router-server/**` | `npm run test:sim` if both the API (3001) and the router (3002) answer |
| `packages/gtfs/src/export*` | Mention `npm run export:check` (about 5 min). Run it only if asked, and don't edit files while it runs. |

- Check whether the servers are up with a quick request (e.g. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/...`). Don't start the dev servers yourself. If one is down, say which suite was skipped and the command the owner should start.
- Don't run `test:ui` unless asked, because it needs `npm run dev` and a browser.
- If `$ARGUMENTS` names a suite (e.g. `unit`, `router`, `e2e`, `all`), run just that.

Report in plain English:
- Each suite run, with pass/fail counts.
- Each suite skipped, and why.
- For a failure, the first failing test and its error, with a one-line guess at the cause.

Finish with a one-line `Tests:` summary that can go straight into a commit message.
