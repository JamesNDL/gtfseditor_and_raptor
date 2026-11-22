#!/usr/bin/env bash
# Peer review T-3: runner refusals and broken dependencies.
# Run in Git Bash:  bash t3-negative.sh <repo-root> <evidence-dir>
ROOT="$1"; E="$2"
cd "$ROOT" || exit 1
R=apps/api/test/run-e2e-fixture.mjs
run() { echo; echo "### $1 ($(date +%T))"; shift; ( env "$@" node "$R" 2>&1 | tail -5; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"; }

run "T3-N01 E2E_DB names the owner's database (expect refusal before connecting)" E2E_DB=gtfs_editor
run "T3-N02 E2E_DB with SQL in it" "E2E_DB=gtfs_e2e; drop database x"
run "T3-N03 E2E_DB upper case" E2E_DB=GTFS_E2E

echo; echo "### T3-N04 an HTTP server already on port 3110 (expect refusal, and nothing created)"
node -e "require('http').createServer((q,s)=>s.end('[]')).listen(3110)" &
HP=$!; sleep 1
( E2E_PORT=3110 node "$R" 2>&1 | tail -3; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"
kill $HP
bash "$E/t3-state.sh"

echo; echo "### T3-N05 a non-HTTP listener on port 3111 (the busy check cannot see it)"
node -e "require('net').createServer(c=>c.destroy()).listen(3111)" &
TP=$!; sleep 1
( E2E_PORT=3111 node "$R" 2>&1 | grep -E "fixture|EADDRINUSE|listen" | tail -6; exit "${PIPESTATUS[0]}" ); echo "  exit=$?"
kill $TP
bash "$E/t3-state.sh"

run "T3-N06 the database cannot be reached (wrong port)" E2E_ADMIN_URL=postgres://gtfs:gtfs@localhost:5999/postgres
bash "$E/t3-state.sh"
