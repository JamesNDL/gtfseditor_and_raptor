---
name: pr
description: Put the current work on a feature branch, verify it, commit in the repo's style and open a GitHub pull request.
disable-model-invocation: true
---

`$ARGUMENTS` may hold a branch name or a note on what the change is.

1. If on `master`, create a branch with a short kebab-case name describing the change (or the one in `$ARGUMENTS`). If already on a feature branch, stay on it.
2. Run `/verify` and keep its `Tests:` line. If anything fails, stop and report. Don't commit failing work unless the owner says to.
3. Review `git status` and `git diff`. Stage the relevant files by name, never `data/`, `.env` or `CLAUDE.local.md`.
4. Commit in the house style (see `git log -5` for examples):
   - Subject: a plain-English sentence fragment, capitalised, no prefix, no full stop. Separate several items with semicolons.
   - Body: short prose, then bullets grouped under plain headings, wrapped at ~72 characters, British spelling.
   - End with the `Tests:` line, then the Co-Authored-By trailer.
   - The message contains backslashes or special characters? Write it to a file in the scratchpad and run `git commit -F <file>`.
5. If `PLAN.md`'s "Where we are" section no longer matches what is built, update it in the same commit.
6. `git push -u origin <branch>`, then `gh pr create --base master` with:
   - The commit subject as the title.
   - A body that sums up the change in plain English and gives the `Tests:` line.
7. Reply with the PR link.
