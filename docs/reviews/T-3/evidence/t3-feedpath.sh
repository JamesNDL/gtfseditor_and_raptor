#!/usr/bin/env bash
# Peer review T-3: FEED_PATH (folder, zip, bad paths) and PACKS_DIR, against gtfs_review_t3 only.
# Run in Git Bash:  bash t3-feedpath.sh <repo-root> <scratch-dir>
set -u
ROOT="$1"; SCRATCH="$2"
DB=gtfs_review_t3
export DATABASE_URL="postgres://gtfs:gtfs@localhost:5433/$DB"
FEED="$ROOT/packages/gtfs/test/fixtures/mini-feed"
CLI="$ROOT/packages/gtfs/src/import-cli.ts"
q() { docker exec -i gtfseditor-db-1 psql -U gtfs -d "$DB" -tAc "$1"; }
state() { echo "  baselines=[$(q "select string_agg(id||':'||service_date||':'||feed_id, ' ' order by id) from baselines")] staged=[$(q "select feed_id from staged_feed")]"; }
run() { echo; echo "### $1"; shift; ( "$@" 2>&1 | grep -vE '^\s+("|\{|\}|[a-z ,-]+:)' | tail -5; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"; }

echo "== $(date) setup"
docker exec -i gtfseditor-db-1 psql -U gtfs -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/zip" "$SCRATCH/elsewhere" "$SCRATCH/partial"
( cd "$FEED" && python -c "import zipfile,os,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); [z.write(f) for f in sorted(os.listdir('.'))]; z.close()" "$SCRATCH/zip/mini feed.zip" )
ls -la "$SCRATCH/zip"
echo "  temp feeds before: $(ls "$TEMP/gtfs-editor-feeds" 2>/dev/null)"

run "T3-F01 FEED_PATH is a zip (name with a space), no API_KEY, PACKS_DIR set" env -u API_KEY FEED_PATH="$SCRATCH/zip/mini feed.zip" PACKS_DIR="$SCRATCH/packs" node "$CLI"
state; echo "  packs: $(ls "$SCRATCH/packs")"; echo "  temp feeds after: $(ls "$TEMP/gtfs-editor-feeds" 2>/dev/null)"
run "T3-F02 the same zip again (cached extraction, already staged)" env -u API_KEY FEED_PATH="$SCRATCH/zip/mini feed.zip" PACKS_DIR="$SCRATCH/packs" node "$CLI" 20260707
state
run "T3-F03 FEED_PATH does not exist" env -u API_KEY FEED_PATH="$SCRATCH/nope" node "$CLI"
echo "hello" > "$SCRATCH/not-a-zip.zip"
run "T3-F04 FEED_PATH is a file that is not a zip" env -u API_KEY FEED_PATH="$SCRATCH/not-a-zip.zip" node "$CLI"
echo "  temp feeds now: $(ls "$TEMP/gtfs-editor-feeds" 2>/dev/null)"
cp "$FEED/agency.txt" "$FEED/stops.txt" "$SCRATCH/partial/"
run "T3-F05 FEED_PATH folder missing most files" env -u API_KEY FEED_PATH="$SCRATCH/partial" node "$CLI"
run "T3-F06 FEED_PATH is an empty string and no API_KEY" env -u API_KEY FEED_PATH= node "$CLI"
run "T3-F07 no FEED_PATH and no API_KEY" env -u API_KEY -u FEED_PATH node "$CLI"
cp -r "$FEED" "$SCRATCH/copy-of-mini-feed"
run "T3-F08 a copy of the same feed (new file times): same day again" env -u API_KEY FEED_PATH="$SCRATCH/copy-of-mini-feed" PACKS_DIR="$SCRATCH/packs" node "$CLI" 20260707
state
echo; echo "### T3-F09 no PACKS_DIR, started from another folder: packs should go to <repo>/data/packs"
( cd "$SCRATCH/elsewhere" && env -u API_KEY -u PACKS_DIR FEED_PATH="$FEED" node "$CLI" 20260708 > /dev/null 2>&1; echo "  exit=$?" )
echo "  repo data/packs: $(ls "$ROOT/data/packs" 2>&1)"; echo "  elsewhere: $(ls -A "$SCRATCH/elsewhere")"

echo; echo "== $(date) teardown"
docker exec -i gtfseditor-db-1 psql -U gtfs -d postgres -c "drop database if exists $DB with (force)"
rm -rf "$SCRATCH" "$ROOT/data"
echo "  temp feeds left behind by the importer (not removed by it): $(ls "$TEMP/gtfs-editor-feeds" 2>/dev/null)"
