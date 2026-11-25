// Works out the path a train, tram or ferry takes between two stations, from where published
// services already run.
//
// For each mode the published stop patterns give a network: every pair of stations that some
// service runs between without calling anywhere else is a link, and its path is that stretch of the
// service's published path. A new line is then routed over those links by the shortest way, so it
// follows the track (or the ferry routes across the water) rather than cutting straight across.
import type { Sql } from '@gtfs-editor/gtfs/db';

type Coord = [number, number];

interface Link {
  to: number;
  coords: Coord[];
  metres: number;
}

type Network = Map<number, Link[]>;

// Baselines never change, so a network is worked out once per day and mode and kept.
const networks = new Map<string, Promise<Network>>();

async function build(sql: Sql, baselineId: number, modeId: string): Promise<Network> {
  // Up to three published patterns are tried for each pair of stations, because a path that loops
  // back on itself can place a station at the wrong point along it.
  const rows = await sql`
    with hops as (
      select p.id as pattern_id, p.shape_id, o.n, coalesce(s.parent_id, s.id) as station, s.geom
      from patterns p
      join routes r on r.id = p.route_id
      cross join unnest(p.stop_ids) with ordinality as o(stop_id, n)
      join stops s on s.id = o.stop_id
      where p.baseline_id = ${baselineId} and p.scenario_id is null and r.mode_id = ${modeId} and p.shape_id is not null),
    pairs as (
      select d.a, d.b, d.shape_id, d.ag, d.bg, row_number() over (partition by d.a, d.b order by d.shape_id) as pick
      from (
        select distinct on (a.station, b.station, a.shape_id)
               a.station as a, b.station as b, a.shape_id, a.geom as ag, b.geom as bg
        from hops a join hops b on b.pattern_id = a.pattern_id and b.n = a.n + 1
        where a.station <> b.station
        order by a.station, b.station, a.shape_id, a.pattern_id) d)
    select x.a, x.b, ST_AsGeoJSON(x.piece) as path, ST_Length(x.piece::geography) as metres,
           ST_Distance(x.ag::geography, x.bg::geography) as crow
    from (
      select p.a, p.b, p.ag, p.bg, ST_LineSubstring(sh.geom, f.fa, f.fb) as piece
      from pairs p
      join shapes sh on sh.id = p.shape_id
      cross join lateral (select ST_LineLocatePoint(sh.geom, p.ag) as fa, ST_LineLocatePoint(sh.geom, p.bg) as fb) f
      where p.pick <= 3 and f.fa < f.fb) x`;

  const best = new Map<string, { a: number; b: number; coords: Coord[]; metres: number }>();
  for (const r of rows) {
    const metres = Number(r.metres);
    // A stretch many times longer than the straight distance has gone round a loop the wrong way.
    if (!(metres > 0) || metres > Number(r.crow) * 4 + 1500) continue;
    const coords = (JSON.parse(r.path) as { coordinates: Coord[] }).coordinates;
    if (!coords || coords.length < 2) continue;
    const key = `${r.a}>${r.b}`;
    const seen = best.get(key);
    if (!seen || metres < seen.metres)
      best.set(key, { a: Number(r.a), b: Number(r.b), coords, metres });
  }
  const network: Network = new Map();
  const add = (from: number, link: Link) => {
    let list = network.get(from);
    if (!list) network.set(from, (list = []));
    list.push(link);
  };
  for (const link of best.values()) {
    add(link.a, { to: link.b, coords: link.coords, metres: link.metres });
    // Track and water can be used both ways, even where the timetable only runs one way.
    if (!best.has(`${link.b}>${link.a}`))
      add(link.b, { to: link.a, coords: [...link.coords].reverse(), metres: link.metres });
  }
  return network;
}

function network(sql: Sql, baselineId: number, modeId: string): Promise<Network> {
  const key = `${baselineId}|${modeId}`;
  let found = networks.get(key);
  if (!found) {
    found = build(sql, baselineId, modeId);
    networks.set(key, found);
    found.catch(() => networks.delete(key));
  }
  return found;
}

/** The shortest way over the network from one station to another, or null if they are not joined. */
function shortest(net: Network, from: number, to: number): Coord[] | null {
  if (!net.has(from) || !net.has(to)) return null;
  const dist = new Map<number, number>([[from, 0]]);
  const via = new Map<number, { from: number; link: Link }>();
  const done = new Set<number>();
  const open = new Set<number>([from]);
  while (open.size) {
    let here = -1;
    let least = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < least) {
        least = d;
        here = id;
      }
    }
    open.delete(here);
    if (here === to) break;
    done.add(here);
    for (const link of net.get(here) ?? []) {
      if (done.has(link.to)) continue;
      const d = least + link.metres;
      if (d < (dist.get(link.to) ?? Infinity)) {
        dist.set(link.to, d);
        via.set(link.to, { from: here, link });
        open.add(link.to);
      }
    }
  }
  if (!via.has(to)) return null;
  const pieces: Coord[][] = [];
  for (let at = to; at !== from; at = via.get(at)!.from) pieces.unshift(via.get(at)!.link.coords);
  const coords: Coord[] = [];
  for (const piece of pieces) coords.push(...(coords.length ? piece.slice(1) : piece));
  return coords;
}

export interface TrackStop {
  lon: number;
  lat: number;
  /** The station a platform belongs to, or the stop itself. */
  stationId: number;
}

export interface TrackPath {
  coords: Coord[];
  /** Which point of the path each stop sits at. */
  at: number[];
  /** How many of the stretches between consecutive stops follow the network; the rest are straight. */
  found: number;
  stretches: number;
}

/** The path through a list of stations: along the published network where it joins them, straight elsewhere. */
export async function trackPath(
  sql: Sql,
  baselineId: number,
  modeId: string,
  stops: TrackStop[],
): Promise<TrackPath> {
  const net = await network(sql, baselineId, modeId);
  const coords: Coord[] = [];
  const at: number[] = [];
  let found = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const piece = a.stationId === b.stationId ? null : shortest(net, a.stationId, b.stationId);
    if (piece) found++;
    const use: Coord[] = piece ?? [
      [a.lon, a.lat],
      [b.lon, b.lat],
    ];
    if (i === 1) at.push(0);
    coords.push(...use);
    at.push(coords.length - 1);
  }
  return { coords, at, found, stretches: stops.length - 1 };
}

/** Whether any published service of this mode runs through a station. */
export async function onNetwork(
  sql: Sql,
  baselineId: number,
  modeId: string,
  stationId: number,
): Promise<boolean> {
  return (await network(sql, baselineId, modeId)).has(stationId);
}
