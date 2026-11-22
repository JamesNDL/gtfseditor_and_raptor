#!/usr/bin/env bash
# Peer review T-2: backup and restore against throwaway databases only (gtfs_review_*).
# Run from Git Bash:  bash t2-backup.sh <repo-root> <scratch-dir>
# The worktree's folder name differs from the main checkout's, so COMPOSE_PROJECT_NAME is set to
# reach the existing container. Nothing here names gtfs_editor as a target.
set -u
ROOT="$1"
SCRATCH="$2"
CLI="$ROOT/packages/gtfs/src/backup-cli.ts"
FEED="$ROOT/packages/gtfs/test/fixtures/mini-feed"
export COMPOSE_PROJECT_NAME=gtfseditor
BASE=postgres://gtfs:gtfs@localhost:5433
q() { docker exec -i gtfseditor-db-1 psql -U gtfs -d "$1" -tAc "$2"; }
dbs() { echo "  databases: $(q postgres "select string_agg(datname, ' ' order by datname) from pg_database where datname like 'gtfs_review%' or datname ilike 'GTFS_REVIEW%'")"; }
run() { echo; echo "### $1"; shift; ( cd "$ROOT" && "$@" 2>&1 | tail -6; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"; }

echo "== $(date) setup"
rm -rf "$SCRATCH" "$ROOT/data"; mkdir -p "$SCRATCH"
q postgres "drop database if exists gtfs_review_bk with (force)"; q postgres "create database gtfs_review_bk"
( cd "$ROOT" && DATABASE_URL=$BASE/gtfs_review_bk PACKS_DIR="$SCRATCH/packs" FEED_PATH="$FEED" node packages/gtfs/src/import-cli.ts > /dev/null )
q gtfs_review_bk "insert into scenarios (baseline_id, name) select min(id), 'review scenario ü 🚆' from baselines"
echo "  source: $(q gtfs_review_bk "select count(*) from scenarios") scenario(s), $(q gtfs_review_bk "select count(*) from trips") trips"

run "T2-B01 backup a throwaway database" env DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" backup
ls -la "$ROOT/data/backups"
DUMP=$(ls "$ROOT"/data/backups/gtfs_review_bk-*.dump | head -1)

run "T2-B02 restore into a new database" env DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" restore "$DUMP" --db gtfs_review_rs
echo "  restored: $(q gtfs_review_rs "select string_agg(name, ',') from scenarios"), $(q gtfs_review_rs "select count(*) from trips") trips"

q gtfs_review_rs "insert into scenarios (baseline_id, name) select min(id), 'added after the backup' from baselines"
run "T2-B03 restore again over the now-populated database (should replace it)" env DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" restore "$DUMP" --db gtfs_review_rs
echo "  after: $(q gtfs_review_rs "select string_agg(name, ',') from scenarios"), $(q gtfs_review_rs "select count(*) from trips") trips"

run "T2-B04 restore into the DATABASE_URL database without --yes (expect refusal)" env DATABASE_URL=$BASE/gtfs_review_rs node "$CLI" restore "$DUMP"
run "T2-B05 same, but naming it with --db (expect refusal)" env DATABASE_URL=$BASE/gtfs_review_rs node "$CLI" restore "$DUMP" --db gtfs_review_rs
run "T2-B06 same with --yes (expect restore)" env DATABASE_URL=$BASE/gtfs_review_rs node "$CLI" restore "$DUMP" --yes
run "T2-B07 --db naming a protected-looking database while DATABASE_URL names another, missing file (is a name other than DATABASE_URL's protected?)" env DATABASE_URL=$BASE/gtfs_review_rs node "$CLI" restore "$SCRATCH/missing.dump" --db gtfs_review_bk
run "T2-B08 missing file" env DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" restore "$SCRATCH/missing.dump" --db gtfs_review_rs
run "T2-B09 odd database name" node "$CLI" restore "$DUMP" --db "x; drop database gtfs_review_bk"
run "T2-B10 empty --db" node "$CLI" backup --db ""
run "T2-B11 --db with no value" node "$CLI" backup --db
run "T2-B12 unknown command" node "$CLI" bakcup
run "T2-B13 backup of a database that does not exist (is a partial file left?)" node "$CLI" backup --db gtfs_review_nope
ls -la "$ROOT/data/backups"
echo "not a dump" > "$SCRATCH/bad.dump"
run "T2-B14 restore a file that is not a dump" node "$CLI" restore "$SCRATCH/bad.dump" --db gtfs_review_bad
dbs
run "T2-B15 two backups in the same minute" env DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" backup
ls -la --time-style=full-iso "$ROOT/data/backups"
echo; echo "### T2-B16 container not reachable (compose project with no db running)"
( cd "$ROOT" && COMPOSE_PROJECT_NAME=gtfs_review_none DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" backup 2>&1 | tail -4; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"
ls -la "$ROOT/data/backups"
echo; echo "### T2-B17 docker not on PATH"
( cd "$ROOT" && PATH="$(dirname "$(command -v node)")" DATABASE_URL=$BASE/gtfs_review_bk node "$CLI" backup 2>&1 | tail -4; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"
ls -la "$ROOT/data/backups"
run "T2-B18 the npm script form (as documented), against a throwaway database" env DATABASE_URL=$BASE/gtfs_review_bk npm run db:backup

echo; echo "== $(date) teardown"
for d in gtfs_review_bk gtfs_review_rs gtfs_review_bad gtfs_review_nope; do q postgres "drop database if exists $d with (force)"; done
dbs
rm -rf "$ROOT/data" "$SCRATCH"
ls "$ROOT"
