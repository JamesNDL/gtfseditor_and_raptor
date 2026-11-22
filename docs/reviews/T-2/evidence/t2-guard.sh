#!/usr/bin/env bash
# Peer review T-2: drives the import guard end to end against a throwaway database.
# Run from Git Bash:  bash t2-guard.sh <repo-root> <scratch-dir>
# Uses only gtfs_review_t2 (created and dropped here) and the checked-in test feed (FEED_PATH).
set -u
ROOT="$1"
SCRATCH="$2"
DB=gtfs_review_t2
export DATABASE_URL="postgres://gtfs:gtfs@localhost:5433/$DB"
export PACKS_DIR="$SCRATCH/packs"
FEED="$ROOT/packages/gtfs/test/fixtures/mini-feed"
CLI="$ROOT/packages/gtfs/src/import-cli.ts"
psqlq() { docker exec -i gtfseditor-db-1 psql -U gtfs -d "$DB" -tAc "$1"; }
state() { echo "  state: baselines=[$(psqlq "select string_agg(id||':'||service_date||':'||feed_id, ' ' order by id) from baselines")] scenarios=[$(psqlq "select string_agg(id||'->b'||baseline_id, ' ' order by id) from scenarios")]"; }
imp() { # imp <label> env-and-command...
  echo; echo "### $1"; shift
  ( cd "$ROOT" && env -u API_KEY "$@" 2>&1 | grep -vE '^\s+("|\{|\}|[a-z ]+:)' | tail -5; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"; state
}

echo "== $(date) setup"
docker exec -i gtfseditor-db-1 psql -U gtfs -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"

imp "T2-01 first import of the default day from FEED_PATH" FEED_PATH="$FEED" node "$CLI"
psqlq "insert into scenarios (baseline_id, name) select min(id), 'review A' from baselines"
psqlq "insert into scenarios (baseline_id, name) select min(id), 'review B' from baselines"
state
DAY=$(psqlq "select to_char(service_date,'YYYYMMDD') from baselines order by id limit 1")
echo "  default day = $DAY"

imp "T2-02 default day again, no --replace (FEED_PATH)" FEED_PATH="$FEED" node "$CLI"
imp "T2-03 named day, no --replace (FEED_PATH)" FEED_PATH="$FEED" node "$CLI" "$DAY"
imp "T2-04 two days, the first without scenarios (20260707), the second with (FEED_PATH)" FEED_PATH="$FEED" node "$CLI" 20260707 "$DAY"
imp "T2-05 malformed date (FEED_PATH)" FEED_PATH="$FEED" node "$CLI" 2026-01-06
imp "T2-06 misspelt flag --Replace (FEED_PATH)" FEED_PATH="$FEED" node "$CLI" "$DAY" --Replace

# Up-front check (no FEED_PATH): a fake manifest in a scratch working folder whose newest id matches the baseline.
FID=$(psqlq "select feed_id from baselines order by id limit 1")
mkdir -p "$SCRATCH/cwd/data/feeds"
echo "{\"versions\":[{\"id\":\"$FID\",\"dir\":\"/nowhere\"}]}" > "$SCRATCH/cwd/data/feeds/manifest.json"
up() { echo; echo "### $1"; shift; ( cd "$SCRATCH/cwd" && env -u FEED_PATH API_KEY=not-a-real-key node "$CLI" "$@" 2>&1 | tail -4; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"; state; }
up "T2-07 up-front: named day with scenarios, no FEED_PATH (must not fetch)" "$DAY"
up "T2-08 up-front: several days, only the last has scenarios" 20260707 20260708 "$DAY"
up "T2-10 up-front: malformed date" 2026-01-06
up "T2-11 up-front: impossible date 20261340" 20261340

imp "T2-12 --replace first, named day (FEED_PATH)" FEED_PATH="$FEED" node "$CLI" --replace "$DAY"
echo; echo "== $(date) teardown"
docker exec -i gtfseditor-db-1 psql -U gtfs -d postgres -c "drop database if exists $DB with (force)"
ls "$PACKS_DIR"
rm -rf "$SCRATCH"
