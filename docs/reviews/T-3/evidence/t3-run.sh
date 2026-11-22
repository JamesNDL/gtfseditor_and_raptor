#!/usr/bin/env bash
# Peer review T-3: one timed run of npm run test:e2e:fixture with the state before and after.
# Run in Git Bash:  bash t3-run.sh <repo-root> <evidence-dir> [extra env assignments...]
ROOT="$1"; E="$2"; shift 2
cd "$ROOT" || exit 1
bash "$E/t3-state.sh"
echo "== start $(date +%T) env: $*"
start=$(date +%s)
env "$@" npm run test:e2e:fixture 2>&1
code=$?
echo "== exit=$code end $(date +%T) took $(( $(date +%s) - start ))s"
bash "$E/t3-state.sh"
