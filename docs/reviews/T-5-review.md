# Peer review: T-5, Folder structure and naming conventions written down

| | |
|---|---|
| Ticket | T-5 (EP-1), docs. Treated as In review (the spreadsheet copy at this commit still says Not started). |
| Reviewer | Peer reviewer agent (Claude) |
| Date | 23 Nov 2026, 09:04 to 09:20 AEDT |
| Requirements | No BRD, test plan or glossary exist for this refactor, by the owner's choice. Traced to `docs/refactor-plan.md` (decisions table, §2.1–2.6, stage 4) and the ticket's acceptance criteria AC1 to AC4. |
| Code reviewed | Commit `cba0c06` ("Write down where code goes; record decisions D8 and D9"), read at `61dde1f` (tip of `architecture-docs`, PR #1), detached. Changes `CLAUDE.md`, `docs/codebase-map.md`, `docs/architecture/system.md` only. |
| Environment | Windows 11 Pro, Node 24, Python 3 for the checks, Prettier. No servers, no database. |
| Verdict | **Approve with notes** |

## 1. Summary

All four acceptance criteria are met. The CLAUDE.md section is short (an intro and four bullets) and states every rule AC1 lists. The map's conventions match refactor plan §2.2 point for point. Its three "Planned layout" blocks are copied from §2.3–2.5 word for word (one line re-wrapped), and they are clearly marked planned. D8 matches §2.1. Every path the existing parts of the map name still exists. No source file changed. The markdown is sound: code fences closed, and every table row has as many cells as its header.

Tests run: 8 entries, all Pass. Nothing was Not run that applied.

Findings (no blockers or majors):
- F-1 **Minor**: D9 lists options "A, B, C", but the refactor plan has no such list. It says "option A below" and gives only the chosen approach. Option C ("a client generated from the API") is not in the plan at all, and B is listed both as a rejected option and as part of the choice. `docs/architecture/system.md:246`.
- F-2 **Minor**: the map was re-dated by this ticket but still lists I2, I3 and I4 as open (`docs/codebase-map.md:22,30,37,61`). T-4 had already resolved them. Also raised in the T-4 review.
- F-3 **Minor**, for the architect: the import rules are copied faithfully, but as written they leave two things open that a new session will trip on. "A feature's main file" is not defined. And the planned `shared/api-client.ts` (today's `useApi`) reads the app store, while `shared/` "imports nothing from a feature" and `app/`'s status is not stated.
- F-4 **Note**: two rules are hard to follow before their stage lands: "styles not in `styles.css`" before the CSS split, and "don't hand-copy a response type" before `packages/core/src/api/` exists.

The coding standards checks (file length, typing, unused code) do not apply to a docs-only change. That no source changed was confirmed (§5).

## 2. Charter and coverage

| Category | What I tried | Why |
|---|---|---|
| Agreement with the plan | Each CLAUDE.md and map rule against §2.1–2.6; D8 and D9 against the decisions table, §2.1 and stage 4 | The ticket says copy, don't redesign |
| Faithful copy | Machine diff of the layout blocks, plan against map | Hand copies drift |
| Agreement with the code | Every path in the existing parts of the map; the planned layout's "today" files; the import rules against today's imports | The ticket's own test, plus whether the rules can be followed |
| Usefulness to a new session | Read CLAUDE.md as a fresh session would | The brief: "every line must be something a session would get wrong without it" |
| Markdown | Fences, table columns, Prettier | Docs-only ticket |
| Skipped | Behaviour, security, performance: no code changed. File length, typing and unused code: not applicable to markdown (§5). | |

## 3. Test log

Evidence is in `docs/reviews/T-5/evidence/`. Shared runs at the same commit are in `docs/reviews/T-4/evidence/`.

| ID | Category | What and why | Steps / input | Expected | Actual | Outcome | Evidence, req |
|---|---|---|---|---|---|---|---|
| PR-T5-01 | Docs vs code | Every path in the existing parts of the map exists | `python check_map_paths.py docs/codebase-map.md` from the repo root, then each "MISSING" checked by hand | All exist | All exist. The "MISSING" lines are shorthand (`core/waits.test.ts` is `packages/core/src/waits.test.ts`), Java files under `services/router/*/src/main/java/...` (all 11 found with `find`), `data/` paths (gitignored, not in a worktree), things marked planned (`docs/glossary.md`, `docs/brd/`), or rule words in the new conventions (`shared/`, `kebab-case.ts`) | Pass | `map-paths.txt`, ticket "Tests" |
| PR-T5-02 | Faithful copy | Planned layout equals plan §2.3–2.5 | `python md_checks.py` (diffs the fenced blocks) | Same | Blocks 2 and 3 identical. Block 1 differs only by re-wrapping one over-long line of the `shared/` entry; the words are the same. | Pass | `md-checks.txt`, AC2 |
| PR-T5-03 | Markdown | Fences closed, tables even | same script | Even fences; no ragged rows | CLAUDE.md 0 fences, map 6, system.md 8 (all even). No table row with a different cell count from its header. | Pass | `md-checks.txt` |
| PR-T5-04 | Format | Prettier | `npx prettier --check CLAUDE.md docs/codebase-map.md docs/architecture/system.md` | Clean (`*.md` is in `.prettierignore` anyway) | "All matched files use Prettier code style!" | Pass | `changed-files.txt` |
| PR-T5-05 | Scope | No source files changed | `git show --stat cba0c06` | Three docs only | `CLAUDE.md`, `docs/architecture/system.md`, `docs/codebase-map.md` | Pass | `changed-files.txt`, AC4 |
| PR-T5-06 | Agreement | CLAUDE.md "Where code goes" against AC1 and plan §2.1–2.2 | Read side by side | Every AC1 rule present, nothing contradicts the plan | Feature folders, PascalCase/kebab-case, tests beside, styles beside, `shared/` imports no feature, no circles, no barrels except a package's entry: all present and in agreement. Five source lines, inside "about 8". Leaves out "one main thing per file", the glossary rule and "may import the app store", which AC1 does not ask for (the map has all three). | Pass | AC1 |
| PR-T5-07 | Agreement | Map conventions against §2.2 and 2.6 | Read side by side | Same rules, more detail | Same rules. The added detail is accurate: the `import/no-cycle` timing matches §2.6 step 5 (and `.oxlintrc.json` has no cycle rule yet); the camelCase rename timing matches §2.6. | Pass | AC2 |
| PR-T5-08 | Agreement | D8 and D9 against the plan | Read `system.md:245-246` against the plan's decisions table, §2.1, stage 4 | Match | D8 matches §2.1 (options, choice, reason, date, staging). D9's choice and reason match stage 4, but its option labels do not trace (F-1). | Pass with F-1 | AC3 |

The shared runs at `61dde1f` (`npm test` 61 passed, `npm run typecheck` clean in every workspace, `npm run lint` 0 errors) are recorded in the T-4 review, `docs/reviews/T-4/evidence/`. A docs-only change cannot affect them.

## 4. Readability review (of the docs)

- **CLAUDE.md:** short and useful. The opening line ("older files may not follow it yet. New code should.") is the most important sentence for a new session, and it is there. The bullets are long, but each holds rules a session would otherwise get wrong (camelCase is what it sees in `apps/web/src` today). Good.
- **Map:** the new conventions are clearly separate from the "as built" tables. The "Planned layout" heading carries a bold "Status: planned, not built" and says the tables above stay true until a file moves. The `→` rename marker is explained. Good.
- **system.md:** D8 and D9 use the existing table shape, and the change-log line names the ticket.
- Plain English and British spelling throughout. "Organise" is spelt with an s. No jargon beyond "barrel files", which is explained in brackets.

## 5. Coding standards and unused code

Not applicable: the ticket changes only markdown (PR-T5-05). There is no code to measure for length, typing or unused names. `docs/codebase-map.md` is now 231 lines, which is fine for a reference document.

## 6. Findings

**F-1 Minor, for the architect (and the owner to confirm).** `docs/architecture/system.md:246`:
> A: shared types; B: a schema library (such as Zod); C: a client generated from the API

The ticket asks for "options A/B/C from the refactor plan stage 4", but the plan does not list them. The decisions table says "Shared types in `packages/core/src/api/` (option A below)", and stage 4 gives only "Chosen approach…", the same at `7bcdc23`, where the plan was first written. So B and C were rebuilt by the developer, and C appears nowhere in the plan. B also appears in the "Chosen" cell ("with a schema library (B) for request bodies later"), so it reads as both rejected and chosen. Expected: options that trace to the plan. Needed back: either add the A/B/C options to plan stage 4 (where the "below" points), or the owner confirms that D9 has them right. Then make the Chosen cell say "A; B may be added later" so B is not both.

**F-2 Minor, for the developer (T-4 or T-5).** `docs/codebase-map.md:3` now says the map was updated on 23 Nov, but lines 22, 30, 37 and 61 still call I2, I3 and I4 open ("Open issues (I1 to I5)", "Issue **I3** is here" and so on). T-4 (`54b0064`, earlier on the same branch) moved them to the resolved table in `system.md`. Needed back: drop the three markers, and say "Open issues (I1 and I5)".

**F-3 Minor, for the architect.** The rules are copied faithfully from §2.2, but two things in them will be hard to apply in stage 2:
1. "A feature imports another feature only through its main file." No rule says which file that is, and there are no barrels. Today `inspector/RoutePanel.tsx` imports `../sim/SimFigures.tsx` and `../FleetPanel.tsx` (for `VehicleTypePicker`), and most panels import `applyEdit` from `scenario.ts`. Is the main file of `scenarios/` `scenario-client.ts` or `ScenarioPanel.tsx`? Is `sim/SimFigures.tsx` an internal?
2. "`shared/` imports nothing from a feature." The planned `shared/api-client.ts` takes `useApi()` from today's `api.ts`, which reads the store (`api.ts:2`, `:217-218`: `scenarioId`, `dataVersion`). The store moves to `app/`. The rules never say whether `app/` is a feature, so this planned file may break the rule it sits under.

Suggest a line in plan §2.2 and the map: what a feature's main file is (for example "the file named after the folder, or its top component"), and that `app/store.ts` may be imported by `shared/`, or that `useApi` belongs in `app/`.

**F-4 Note, for the architect.** Two "new code should" rules have no home until a later stage:
- CLAUDE.md "Styles go in the feature's own CSS file … not in `styles.css`". Before the CSS split (§2.6 step 4), a session changing an existing component's look will find its styles in `styles.css`. Should it edit them there, or move them out? The plan's "imported by that feature's top component" is also left out of CLAUDE.md.
- Map: "Don't hand-copy a response type into the web app", while `packages/core/src/api/` "is created in stage 4". Until then a new endpoint's type has nowhere to go but `api.ts`.
One clause each ("until stage N, keep using X") would stop a session guessing.

## 7. Not run

Nothing that applies. Browser and server checks do not apply to a docs change.

## 8. Issues routed

No tracker was edited (as the brief says). For the owner to raise:
- Architect or owner: F-1 (D9 options), F-3 (main file; `shared/` and `app/`), F-4 (interim homes).
- Developer: F-2 (stale issue markers in the map).

## 9. Reviewer notes

- CLAUDE.md in this commit is up to date on typecheck (`npm run typecheck` checks every workspace, line 35). No other contradiction between CLAUDE.md and the code was found.
- The planned layout places every file that exists today in `apps/web/src`, `apps/api/src` and the packages (`map-paths.txt`, second part). The only thing not given a place is the "new stops as GeoJSON" part of `apps/api/src/stops.ts`. Only `stopVisible`/`stopDeleted` and `addStop` are placed. This is the plan's gap, not the copy's.
- Process: `cba0c06` is on `architecture-docs` directly, not on `refactor/T-5-conventions` as the ticket names.
- Scripts: `evidence/check_map_paths.py` and `evidence/md_checks.py`. Run each from the repository root, for example `python "C:/Programming Projects/GTFS Editor/docs/reviews/T-5/evidence/md_checks.py"`.
