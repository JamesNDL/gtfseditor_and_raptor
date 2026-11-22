# Peer review: T-2, re-importing a day can't silently delete its scenarios; backup and restore scripts

| | |
|---|---|
| Ticket | T-2 (EP-1), status In review, `docs/project/refactor-tickets.xlsx` |
| Reviewer | Peer reviewer agent (independent; has not seen the developer's reasoning) |
| Date | 23 Nov 2026, 08:45 to 09:05 (AEDT) |
| Requirements | No BRD, test plan or glossary for this refactor (the owner's choice). Traced to `docs/refactor-plan.md` §1.3, issue I1 and risk R2 in `docs/architecture/system.md`. |
| Code reviewed | Detached at `d3d7c0e` (tip of `refactor/T-2-T-3`, PR #2). T-2 is `9a49fef` plus `4b347a7` (typecheck fix to `backup-cli.ts`). `import-cli.ts` reviewed as merged with T-3 (`be813a0`). |
| Environment | Windows 11 Pro 10.0.26300, Git Bash; Node v26.13.0 (not 24); npm workspaces installed with `npm install`; Postgres/PostGIS `postgis/postgis:17-3.5` in the existing container `gtfseditor-db-1` on 5433. No `.env` and no `data/` in the review worktree. |
| Test data | The checked-in test feed `packages/gtfs/test/fixtures/mini-feed` (from T-3) imported with `FEED_PATH`, and scenario rows inserted by hand. Throwaway databases only: `gtfs_review_t2`, `gtfs_review_bk`, `gtfs_review_rs`, `gtfs_review_bad` (all dropped). `gtfs_editor` was never written to. |
| **Verdict** | **Changes requested** |

## 1. Summary

The guard does its job. In every case I tried, including the default day, named days, `--replace` before or after the dates, several days and `FEED_PATH` feeds, a day with scenarios was refused before anything was deleted. The backup and restore scripts work end to end: a dump restored into a new database and over a full one, with the scenario row intact (including non-ASCII names). All six acceptance criteria are met.

Changes are requested for one coding-standards breach: `packages/gtfs/src/import/baseline.ts` was already over the 300-line limit (311) and the ticket grew it to 348. There are also some minor findings that are quick to fix.

- Tests run: 35. Passed 28, failed 7 (all Minor or a test gap). Not run: 1.
- Top findings:
  - **Major** (standard): `baseline.ts` grown from 311 to 348 lines.
  - **Minor**: several days are not all-or-nothing when the up-front check can't run.
  - **Minor**: a bad date gives a raw stack trace.
  - **Minor**: two backups in the same minute overwrite each other without warning.
  - **Minor**: a failed restore leaves a half-made database behind.
  - **Minor** (owner question): `--db gtfs_editor` is not protected when `DATABASE_URL` names another database.
  - **Note** (QA): no automated test protects the guard.
- Not run: the default-day refusal against the real TfNSW feed (needs the owner's feed and API key).

## 2. Charter and coverage

| Area | What I tried, and why | Done |
|---|---|---|
| Guard bypass | The default day against named days; `--replace` placement; several days where only some have scenarios; `FEED_PATH` (no up-front check); malformed and impossible dates; a misspelt flag; whether anything is deleted before a refusal | Yes |
| Up-front check | Refuses before any fetch when days are named (a fake feed manifest whose id matches the baseline, a dummy key, no network reached) | Yes |
| Backup | Happy path; the npm script form; a database that doesn't exist (is a partial file left?); container not reachable; `docker` not on PATH; two backups in a minute | Yes |
| Restore | Into a new database; over a populated one; refusal for `DATABASE_URL`'s database without `--yes`; with `--yes`; missing file; not a dump; odd, empty and missing `--db` names | Yes |
| Restore into `gtfs_editor` | Read in the code only. A live test naming the owner's database was blocked by the safety rules, rightly. | By reading |
| Regression | `npm test`, lint, format check, typecheck of `@gtfs-editor/gtfs` | Yes |
| Test quality | Flipped the guard in a scratch copy and ran `npm test` | Yes |
| Skipped | UI, accessibility and performance: there is no UI, and the change is a CLI. Stopping Docker: that would stop the owner's database, so I simulated it (wrong compose project, and no `docker` on PATH). | n/a |

## 3. Test log

Evidence is in `docs/reviews/T-2/evidence/`. Scripts: `t2-guard.sh` and `t2-backup.sh` (run as `bash <script> <repo-root> <scratch-dir>`), with output in `t2-guard-output.txt` and `t2-backup-output.txt`.

| ID | Category | Test | Expected | Actual | Outcome |
|---|---|---|---|---|---|
| PR-T2-01 | usage | First import of the default day with `FEED_PATH` and no `API_KEY` | Imports | Baseline 1 (2026-01-06), exit 0 | Pass |
| PR-T2-02 | AC1 | 2 scenarios on the day; default day again, no `--replace` | Refused, nothing deleted | "2026-01-06 has 2 scenarios. Re-importing the day deletes them. Run `npm run db:backup` first, then add --replace.", exit 1; baseline 1 and both scenarios still there | Pass |
| PR-T2-03 | AC1 | Same, day named | Refused | Same message, exit 1, nothing deleted | Pass |
| PR-T2-04 | negative | `FEED_PATH`, two days: 20260707 (no scenarios), then the day with scenarios | All refused before any import (or at least nothing changed) | 20260707 **imported** (baseline 2), then the second day refused, exit 1. Nothing with scenarios deleted. | Fail (Minor, F-3) |
| PR-T2-05 | negative | `FEED_PATH`, malformed date `2026-01-06` | One-line error, nothing changed | Stack trace from `isoDate`, after staging; exit 1; nothing changed | Fail (Minor, F-2) |
| PR-T2-06 | negative | Misspelt flag `--Replace` | Not treated as `--replace` | Treated as a date (never reached), the day refused, exit 1 | Pass |
| PR-T2-07 | AC4 | Up-front check: day named, no `FEED_PATH`, fake manifest, dummy key | Refused before fetching | Refused at once; the log shows no feed check or staging | Pass |
| PR-T2-08 | AC4 | Up-front: three days, only the last has scenarios | Refused before anything | Refused, exit 1, nothing imported | Pass |
| PR-T2-09 | negative | Up-front: malformed date | One-line error | Stack trace from `countScenariosOnDay`; nothing changed | Fail (Minor, F-2) |
| PR-T2-10 | negative | Up-front: impossible date `20261340` | One-line error | postgres `DateTimeParseError` dump; nothing changed | Fail (Minor, F-2) |
| PR-T2-11 | AC2 | `--replace` placed first, day named | Re-imports, deletes the scenarios | Baseline 3 replaces 1, scenarios gone, exit 0 | Pass |
| PR-T2-12 | AC3 | The day with no scenarios (20260707 in PR-T2-04, and PR-T2-01) | Imports without the flag | Imported | Pass |
| PR-T2-B01 | AC5 | `backup` of `gtfs_review_bk` | `data/backups/<db>-<YYYYMMDD-HHMM>.dump`, path and size printed | `Wrote ...\data\backups\gtfs_review_bk-20261123-0849.dump (261 kB)` | Pass |
| PR-T2-B02 | AC6 | Restore into a new database | Created, data there | "Creating database gtfs_review_rs", the scenario `review scenario ü 🚆` and 491 trips present | Pass |
| PR-T2-B03 | usage | Restore again over the populated database (a scenario added after the backup) | Replaced by the backup | The added scenario gone; exactly the backup's contents | Pass |
| PR-T2-B04 | AC6 | Restore with no `--db` into `DATABASE_URL`'s database, no `--yes` | Refused | Refused with a clear message, exit 1 | Pass |
| PR-T2-B05 | AC6 | Same, naming it with `--db` | Refused | Refused, exit 1 | Pass |
| PR-T2-B06 | AC6 | Same with `--yes` | Restores | Restored, exit 0 | Pass |
| PR-T2-B07 | negative | `--db` naming a database other than `DATABASE_URL`'s (missing file, so nothing could happen) | Question: is that one protected? | Not refused: it went on to "No such file". So `gtfs_editor` is unprotected whenever `DATABASE_URL` names something else (see F-6, code at `backup-cli.ts:89`). | Pass as coded; question raised |
| PR-T2-B08 | negative | Missing file | Clear error | "No such file: ...", exit 1 | Pass |
| PR-T2-B09 | security | `--db "x; drop database gtfs_review_bk"` | Refused | "Database names may use only letters, digits and _", exit 1 | Pass |
| PR-T2-B10 | negative | `--db ""` | Refused | Refused, exit 1 | Pass |
| PR-T2-B11 | negative | `--db` with no value | Refused | "--db needs a database name", exit 1 | Pass |
| PR-T2-B12 | negative | Unknown command `bakcup` | Usage | "Unexpected arguments: bakcup", exit 1 | Pass |
| PR-T2-B13 | negative | Back up a database that doesn't exist | Error, no partial file | pg_dump error, exit 1, no file left | Pass |
| PR-T2-B14 | negative | Restore a file that isn't a dump into a new name | Error, nothing left | Error, exit 1, but **empty database `gtfs_review_bad` left behind** | Fail (Minor, F-5) |
| PR-T2-B15 / B18 | negative | Two backups of the same database in the same minute | Both kept, or a warning | Both wrote `gtfs_review_bk-20261123-0850.dump`; **the first was overwritten without a word** | Fail (Minor, F-4) |
| PR-T2-B16 | dependency | Container not reachable (a compose project with no db) | Clear error, no partial file | `service "db" is not running`, exit 1, no file | Pass |
| PR-T2-B17 | dependency | `docker` not on PATH | Clear error | `spawn docker ENOENT`, exit 1, no file | Pass |
| PR-T2-B18 | usage | `npm run db:backup` as documented | Works | Works | Pass |
| PR-T2-R1 | regression | `npm test` | Green | 4 files, 61 tests passed (`npm-test.txt`) | Pass |
| PR-T2-R2 | regression | `npm run lint` | No new warnings | Exit 0; 14 warnings, all in untouched `apps/web` files (`lint.txt`) | Pass |
| PR-T2-R3 | regression | `npm run format:check`, and `npx prettier --check` on the changed files | Clean | The changed files are clean. 13 untouched files are flagged only because this worktree checked them out with CRLF line endings (`git ls-files --eol`: `i/lf w/crlf`). That is a checkout artefact, not the ticket. (`format-check.txt`) | Pass (changed files) |
| PR-T2-R4 | standards | `npm run typecheck -w @gtfs-editor/gtfs` (strict) and `tsc --noUnusedLocals --noUnusedParameters` | Clean | Both exit 0 (`typecheck-gtfs.txt`, `tsc-unused.txt`) | Pass |
| PR-T2-Q1 | test quality | Guard changed to `scenarios < 0` (never refuses), then `npm test` | A test fails | 61/61 still pass (`mutation-guard-npm-test.txt`) | Fail (test gap, F-8) |
| PR-T2-N1 | AC1 | Default-day refusal end to end with the real TfNSW feed | | | Not run (needs owner) |

## 4. Code readability review

Files read in full: `import/baseline.ts` (new code and the delete it guards), `import-cli.ts` (merged), `backup-cli.ts`, and the `package.json`, CLAUDE.md and `system.md` changes.

**Readable?** Mostly yes. The guard is small and well named (`countScenariosOnDay`, `ReplaceRefusedError`, `replaceRefusal`). The count uses the same `feed_id` and `service_date` keys as the delete at `baseline.ts:91`, so it counts exactly what would be deleted. Good.
- Minor: `import-cli.ts:67`, `if (!process.exitCode) {`. Using the process exit code as the control flag for the rest of the script is indirect. An early `return` from a small `refuseUpFront()` function would read better.
- Minor: `backup-cli.ts:63-69`. `size()` is a nested ternary; an if/else ladder would read more easily.

**Single purpose?** `importBaseline` already did many jobs (pre-existing); the guard adds one more step at the top. Moving the guard into its own module also fixes F-1. In `import-cli.ts` the top-level script now does argument parsing, the up-front check, feed choice, the default day and the loop in one block, which is followable at 102 lines. `backup()` and `restore()` are each single-purpose.

**Comments?** The file headers are good and say why (for example "The whole database, because scenario rows refer to baseline rows"). The comment at `import-cli.ts:49-52` explaining why `FEED_PATH` skips the up-front check is accurate.
- Minor: `backup-cli.ts` has no doc comments on `usage`, `checkName`, `stamp`, `size`, `backup` or `restore`. `backup` and `restore` should at least say what they do on failure (`backup` removes the partial file; `restore` creates the database if missing).
- Note: `docs/codebase-map.md:73` still says "issue **I1** is at line 54", and `:21` says "Open issues (I1 to I4)". `system.md` now says there are none.

Lint: `npm run lint` exits 0 with nothing in the changed files. An extra run with stricter rules (`npx oxlint -D no-unused-vars -D typescript/no-explicit-any -D typescript/no-non-null-assertion` on the changed files) flags `backup-cli.ts:46` (see §5). The other hits are T-3's or pre-existing.

## 5. Coding standards check

| File | Lines | Limit | Result |
|---|---|---|---|
| `packages/gtfs/src/import/baseline.ts` | 348 (was 311 at `61dde1f`) | 300 | **Over, and grown by the ticket: Major (F-1)** |
| `packages/gtfs/src/backup-cli.ts` | 139 (new) | 300 | OK |
| `packages/gtfs/src/import-cli.ts` (merged) | 102 | 300 | OK |
| `package.json` | 51 | n/a | OK |

Type checker: `tsconfig.base.json` has `"strict": true`. `npm run typecheck -w @gtfs-editor/gtfs` exits 0.

Search of the added lines for `any`, casts and silencing (`git diff 61dde1f..d3d7c0e | grep` for `any`, `as`, `!`, `@ts-`):
- `backup-cli.ts:46`, `const stdout = child.stdout!;`. A non-null assertion, explained by the comment on line 45 (stdout is always piped). It is narrow and explained: Note for the architect. A typed alternative is to narrow with `if (!child.stdout) throw ...`.
- `backup-cli.ts:137`, `console.error((err as Error).message);`. A blanket cast of an unknown catch value. Minor: use `err instanceof Error ? err.message : String(err)`.
- `import-cli.ts:36-38`, `JSON.parse(...) as { versions: FeedVersion[] }`. File data cast, not validated. Minor; it mirrors the pre-existing `readManifest` in `feed-cache.ts`. Reusing `readManifest` (export it) would avoid a second unvalidated copy.
- No `any` in T-2's lines. All new functions have typed parameters and return types.

## 6. Unused code check

- `tsc --noEmit --noUnusedLocals --noUnusedParameters` in `packages/gtfs`: exit 0 (`tsc-unused.txt`).
- oxlint `no-unused-vars` on the changed files: no hits.
- Manual search: `countScenariosOnDay`, `replaceRefusal` and `ReplaceRefusedError` are each used in both `baseline.ts` and `import-cli.ts`. `ImportBaselineOptions` is the exported type of `importBaseline`'s parameter (cleared as intentional). `DEFAULT_DATABASE_URL` is now imported by `backup-cli.ts`. The `db:backup` and `db:restore` scripts call the new CLI.
- Nothing unused was introduced.

## 7. Findings

| # | Severity | Finding | Where | Owner |
|---|---|---|---|---|
| F-1 | **Major** (standard) | `baseline.ts` was already over 300 lines (311) and the ticket made it 348. Suggest moving `isoDate`, `countScenariosOnDay`, `ReplaceRefusedError` and `replaceRefusal` into `import/replace-guard.ts`, imported by both `baseline.ts` and `import-cli.ts`. | `packages/gtfs/src/import/baseline.ts:26-56` | developer |
| F-2 | Minor | A malformed or impossible date gives a raw stack trace (from `isoDate` or a postgres `DateTimeParseError`) rather than a one-line message. With `FEED_PATH` the whole feed is staged first. Validate the dates (format and a real calendar date) right after parsing `argv`. Repro: PR-T2-05, 09, 10. | `import-cli.ts:30-31`, `baseline.ts:31-33` | developer |
| F-3 | Minor | When the up-front check can't run (`FEED_PATH`, or TfNSW has published a newer feed than the cached one), several days are not all-or-nothing. Earlier days are imported (replacing their old baselines), then a later day is refused. Nothing with scenarios is lost, but the run half-happens and exits 1. Suggest counting every day against the feed actually used before importing any. Repro: PR-T2-04. | `import-cli.ts:83-94` | developer |
| F-4 | Minor | Backup file names have minute resolution, and `createWriteStream` overwrites, so a second backup in the same minute silently replaces the first. That is low risk, since it is the same database at nearly the same time, but surprising for a safety tool. Add seconds, or open with `flags: 'wx'` and refuse. Repro: PR-T2-B15/B18. | `backup-cli.ts:58-61, 76` | developer |
| F-5 | Minor | A failed restore into a new name leaves the newly created empty database (PR-T2-B14). Restoring over an existing database runs `pg_restore --clean --if-exists` without `--single-transaction` or `--exit-on-error`. By reading, a failure part way through leaves that database half-cleaned. Suggest `--single-transaction --exit-on-error`, and dropping a database the script created when the restore fails. | `backup-cli.ts:108-117` | developer |
| F-6 | Minor (question) | AC6 says "refuses to restore into gtfs_editor (or whatever DATABASE_URL names)". The code protects only `DATABASE_URL`'s database (`if (db === urlDb && !yes)`). If someone has `DATABASE_URL` set to a throwaway database in their shell and runs `--db gtfs_editor`, the owner's database is replaced without `--yes`. Shown with throwaway names in PR-T2-B07; not run against `gtfs_editor` by rule. Owner to decide whether `gtfs_editor` should always need `--yes`. | `backup-cli.ts:89` | owner / BA |
| F-7 | Note | The count (`baseline.ts:66`) and the delete (`:91`) are not in one transaction, with the route-type query between them. A scenario created through a running API in that window would be deleted. That is unlikely in a one-person tool. | `baseline.ts:66-91` | architect |
| F-8 | Note (QA) | No automated test covers the guard. Flipping it leaves `npm test` green (PR-T2-Q1). The ticket asked only for a manual run, so this is not a defect. Now that T-3's fixture runner exists, a cheap guard check could be added there (import, add a scenario, re-import, expect exit 1). | n/a | qa |
| F-9 | Note | `backup-cli` always uses the compose `db` container and user `gtfs`, whatever host, port or user `DATABASE_URL` names. From a folder with a different name (a git worktree), `docker compose` can't find the container unless `COMPOSE_PROJECT_NAME` is set, and fails with `service "db" is not running`. Worth a line in CLAUDE.md. | `backup-cli.ts:13-16, 35-41` | developer / architect |
| F-10 | Note | Stale map: `codebase-map.md:73` "issue **I1** is at line 54" and `:21` "Open issues (I1 to I4)". | `docs/codebase-map.md` | architect |
| F-11 | Note | Pre-existing: replacing a baseline leaves the old baseline id's packs folder on disk (seen in the scratch packs folder after PR-T2-11). Out of scope. | `packs.ts` | PM (later ticket) |

## 8. Not run

- The default-day refusal with the real TfNSW feed, and the up-front check with the real `data/feeds/manifest.json`. These need the owner's feed and API key. The owner should run: back up first, then make a scenario on the imported day in the app, and run `npm run import -- <that day>` (expect an immediate refusal) and `npm run import` (expect a refusal after staging).
- Restoring into `gtfs_editor` (to see the refusal live). Checked by reading `backup-cli.ts:89` and live with an equivalent throwaway `DATABASE_URL` (PR-T2-B04/B05).

## 9. Issues routed

The tracker is the spreadsheet, which I was told not to edit. Findings F-1 to F-11 are listed above for the project manager to record as issue-resolution rows against T-2, and the ticket should go back to In progress for F-1.

## 10. Reviewer notes

- The guard design is sound: it lives in `importBaseline`, so every caller is covered, and the error type lets the CLI print a clean message. The refusal wording matches AC1 exactly.
- The backup script handles failure well: a partial dump is removed, and names are checked before anything reaches a shell or SQL.
- Cleanup: all throwaway databases were dropped (final `pg_database` list: `postgres`, `gtfs_editor`, `template1`, `template0`, `template_postgis`). The dumps and the worktree's `data/` folder were deleted.
