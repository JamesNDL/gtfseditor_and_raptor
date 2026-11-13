# GTFS Editor

A visual editor for NSW public transport timetables. See `PLAN.md` for the roadmap and `docs/phase-0-findings.md` for what the TfNSW feed does and does not contain.

## Running it

Requirements: Node 24 or later, Docker Desktop, and a TfNSW Open Data API key in `.env` (see `.env.example`).

```
npm install
npm run db:up        # PostgreSQL + PostGIS on port 5433
npm run import       # download the feed (once) and import the first Tuesday it covers
npm run dev          # API on :3001, web app on http://localhost:5173
```

`npm run import -- 20261121` imports a specific service day (YYYYMMDD). Each imported day appears in the day picker. A day takes about two minutes.

## Commands

| Command | What it does |
|---|---|
| `npm run feed:fetch` | Download the TfNSW feed, or reuse the saved copy if it has not changed |
| `npm run feed:audit` | Repeat the Phase 0 data audit |
| `npm run import [-- dates]` | Import service days as baselines |
| `npm run packs` | Rebuild the vehicle animation files for existing baselines |
| `npm test` | Unit tests for the core logic |
| `npm run export:check [-- scenarioId]` | Export the first day (or a scenario) as GTFS through the running API and check it; for the published day, compare it with the original feed |
| `npm run test:e2e` | End-to-end test of scenario editing against the running API (creates and deletes its own scenario) |
| `npm run dev` | Start the API and web app |

## Layout

- `apps/web`: React app (MapLibre map, deck.gl vehicles, inspector).
- `apps/api`: Fastify server (map tiles, vehicle data, inspector queries).
- `packages/core`: shared logic (vehicle-day chaining, animation file format, time formatting).
- `packages/gtfs`: feed download, database schema and import.
- `data/`: downloaded feeds and generated files. Not in git.

## Links

The address bar tracks what is open, so links can be shared: `#route=<id>`, `#trip=<id>`, `#vehicleDay=<id>`, optionally with `&t=<seconds since midnight>`. Timeline extras: `&tl=stringline|platforms|vehicles`, `&station=<id>`, `&view=<start>-<end>` in seconds.
