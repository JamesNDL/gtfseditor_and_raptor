// The closure's routes: the preview, and the closures a scenario has made, for the map.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { scenarioOf, type Scenario } from '../../engine.ts';
import { fail } from '../../../http.ts';
import { planClosure } from './plan.ts';
import type { Action, CloseBody, ClosureDeps, Item } from './types.ts';
import { SIDE_NAME } from './wording.ts';

/** The preview, and the closures a scenario has made, for the map. */
export function closureRoutes(
  app: FastifyInstance,
  sql: Sql,
  ctx: {
    loadScenario: (sql: Sql, id: number) => Promise<Scenario>;
    idParam: (req: FastifyRequest) => number;
    deps: ClosureDeps;
  },
) {
  /** What a closure would do. Changes nothing. */
  app.post('/api/close-preview', async (req) => {
    const body = req.body as CloseBody;
    const sc = await scenarioOf(req, sql);
    const baselineId = sc ? sc.baselineId : Number(body.baselineId);
    if (!Number.isInteger(baselineId)) throw fail(400, 'Unknown day');
    const plan = await planClosure(sql, sc, baselineId, body, ctx.deps, 'roads');
    // One row per line, however many stop patterns it has.
    interface Line {
      routeId: number;
      name: string;
      color: string;
      modeId: string;
      road: boolean;
      how: Item['how'];
      keep: string;
      trips: number;
      patterns: number;
      actions: Set<Action>;
      /** The parts the line is split into: where each turns back, and whether it is kept. */
      parts: Map<
        string,
        { side: string; trips: number; kept: boolean; turns: Map<string, number> }
      >;
    }
    const byLine = new Map<number, Line>();
    for (const item of plan.items) {
      let line = byLine.get(item.routeId);
      if (!line) {
        line = {
          routeId: item.routeId,
          name: item.name,
          color: item.color,
          modeId: item.modeId,
          road: item.road,
          how: item.how,
          keep: item.keep,
          trips: 0,
          patterns: 0,
          actions: new Set(),
          parts: new Map(),
        };
        byLine.set(item.routeId, line);
      }
      line.trips += item.trips;
      line.patterns++;
      line.actions.add(item.action);
      for (const piece of item.pieces) {
        let part = line.parts.get(piece.side);
        if (!part)
          line.parts.set(
            piece.side,
            (part = { side: piece.side, trips: 0, kept: piece.kept, turns: new Map() }),
          );
        part.trips += item.trips;
        part.turns.set(piece.turnsAt.name, (part.turns.get(piece.turnsAt.name) ?? 0) + item.trips);
      }
    }
    const tripsWith = (...actions: Action[]) =>
      plan.items.filter((i) => actions.includes(i.action)).reduce((sum, i) => sum + i.trips, 0);
    const detours = plan.items.filter((i) => i.action === 'detour' && i.plans.length);

    // For the map: the stretch of each published path that every part keeps or loses, and where it turns back.
    const drawn = plan.items.filter((i) => i.pieces.length).slice(0, 400);
    const want = drawn.flatMap((item) =>
      item.pieces.flatMap((piece) =>
        piece.ranges
          .filter(([a, b]) => b > a)
          .map(([a, b]) => ({
            id: item.patternId,
            a,
            b,
            side: piece.side,
            kept: piece.kept,
            routeId: item.routeId,
          })),
      ),
    );
    const stretches = want.length
      ? await sql`
          select u.n::int as n, ST_AsGeoJSON(ST_Simplify(ST_LineSubstring(sh.geom, u.a, u.b), 0.00003), 6) as g
          from unnest(${want.map((w) => w.id)}::bigint[], ${want.map((w) => w.a)}::float8[], ${want.map((w) => w.b)}::float8[]) with ordinality as u(pid, a, b, n)
          join patterns p on p.id = u.pid join shapes sh on sh.id = p.shape_id`
      : [];
    // Many stop patterns, and many lines, share a path: each stretch is sent once, with the lines that use it.
    const seen = new Map<
      string,
      { side: string; kept: boolean; coords: [number, number][]; routeIds: number[] }
    >();
    for (const row of stretches) {
      const w = want[row.n - 1];
      const key = `${w.side}${w.kept}${row.g}`;
      let part = seen.get(key);
      if (!part) {
        const geometry = JSON.parse(row.g) as { type: string; coordinates: [number, number][] };
        if (geometry.type !== 'LineString') continue;
        seen.set(
          key,
          (part = { side: w.side, kept: w.kept, coords: geometry.coordinates, routeIds: [] }),
        );
      }
      if (!part.routeIds.includes(w.routeId)) part.routeIds.push(w.routeId);
    }
    const parts = [...seen.values()];
    const turns = new Map<
      string,
      { name: string; lon: number; lat: number; side: string; kept: boolean }
    >();
    for (const item of drawn) {
      for (const piece of item.pieces) {
        const key = `${piece.turnsAt.name}${piece.side}`;
        const known = turns.get(key);
        if (!known) turns.set(key, { ...piece.turnsAt, side: piece.side, kept: piece.kept });
        else if (piece.kept) known.kept = true;
      }
    }
    return {
      label: plan.label,
      zone: plan.zone,
      window: plan.window,
      modes: plan.modes,
      sides: plan.sides ? plan.sides.map((code) => ({ code, name: SIDE_NAME[code] })) : null,
      lines: [...byLine.values()]
        .map((l) => ({
          ...l,
          actions: [...l.actions],
          parts: [...l.parts.values()].map((p) => ({
            side: p.side,
            trips: p.trips,
            kept: p.kept,
            turnsAt: [...p.turns.entries()].sort((a, b) => b[1] - a[1])[0][0],
            turnPlaces: p.turns.size,
          })),
        }))
        .sort((a, b) => b.trips - a.trips),
      trips: {
        detour: tripsWith('detour'),
        split: tripsWith('split'),
        shortened: tripsWith('shortened'),
        joined: tripsWith('joined'),
        removed: tripsWith('removed'),
        blocked: tripsWith('blocked', 'failed'),
        left: tripsWith('left'),
      },
      closedStops: [
        ...new Set(
          plan.items
            .filter((i) => i.action !== 'blocked' && i.action !== 'failed')
            .flatMap((i) => i.closedStops),
        ),
      ],
      skipped: plan.skipped,
      // The new paths, for the map. A handful is enough to show where the traffic goes.
      paths: detours.slice(0, 25).map((i) => i.plans[0].coords),
      parts,
      turns: [...turns.values()],
    };
  });

  /** Closures this scenario has made, as GeoJSON for the map. */
  app.get('/api/scenarios/:id/closures', async (req) => {
    const sc = await ctx.loadScenario(sql, ctx.idParam(req));
    const rows = await sql`
      select c.id, c.kind, c.label, c.from_secs, c.to_secs, ST_AsGeoJSON(c.geom) as geometry from scenario_closures c
      where c.scenario_id = ${sc.id} and c.created_edit <= ${sc.head}`;
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r.geometry),
        properties: {
          id: r.id,
          kind: r.kind,
          label: r.label,
          fromSecs: r.from_secs,
          toSecs: r.to_secs,
        },
      })),
    };
  });
}
