#!/usr/bin/env bash
# Peer review T-3: prints what the fixture runner could leave behind.
# Run from the repo root in Git Bash:  bash t3-state.sh
echo "== $(date) state"
echo "  e2e databases: [$(docker exec -i gtfseditor-db-1 psql -U gtfs -d postgres -tAc "select string_agg(datname,' ') from pg_database where datname like 'gtfs_e2e%' or datname like 'gtfs_t3%'")]"
echo "  listening on 3101: $(netstat -ano | grep -E ':3101 .*LISTEN' | wc -l)"
echo "  temp packs folders: $(ls -d "$TEMP"/gtfs-e2e-packs-* 2>/dev/null | wc -l)"
echo "  temp extracted feeds: $(ls "$TEMP"/gtfs-editor-feeds 2>/dev/null | wc -l)"
echo "  data/ in checkout: $(ls -d data 2>/dev/null || echo none)"
echo "  node processes: $(tasklist //FI "IMAGENAME eq node.exe" 2>/dev/null | grep -c node.exe)"
