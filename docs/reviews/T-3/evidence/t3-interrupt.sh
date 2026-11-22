#!/usr/bin/env bash
# Peer review T-3: stop the fixture runner part way (as a closed terminal or Ctrl+C would) and see
# what is left behind, then check that the next run recovers.
# Run in Git Bash:  bash t3-interrupt.sh <repo-root> <evidence-dir>
ROOT="$1"; E="$2"
cd "$ROOT" || exit 1
bash "$E/t3-state.sh"
echo "== $(date +%T) start the runner in the background"
node apps/api/test/run-e2e-fixture.mjs > "$E/interrupt-runner-log.txt" 2>&1 &
PID=$!
WINPID=$(cat /proc/$PID/winpid 2>/dev/null)
for i in $(seq 1 60); do grep -q "running the scenario checks" "$E/interrupt-runner-log.txt" && break; sleep 1; done
sleep 3
echo "== $(date +%T) the runner is running the checks; stopping it (taskkill, Windows pid $WINPID)"
taskkill //PID "$WINPID" //F
sleep 3
tail -3 "$E/interrupt-runner-log.txt"
bash "$E/t3-state.sh"
echo "  what holds 3101:"; netstat -ano | grep -E ':3101 .*LISTEN'
echo "== $(date +%T) run again straight after"
node apps/api/test/run-e2e-fixture.mjs 2>&1 | tail -4
echo "  exit=${PIPESTATUS[0]}"
bash "$E/t3-state.sh"
