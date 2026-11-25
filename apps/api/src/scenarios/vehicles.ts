// Assigning vehicles to trips: which vehicle runs each new trip a scenario makes.
import { DEFAULT_CHAIN_RULES, distanceM, type RuleSet } from '@gtfs-editor/core';
import { visible, type Scenario, type Tx } from './engine.ts';

interface FleetTrip {
  id: number;
  vd: number | null;
  s: number;
  e: number;
  partition: string;
  /** A group the trip must stay within, on top of its partition: the side of a closure. */
  group?: string;
  modeId: string;
  vt: number | null;
  ruleSet: RuleSet;
  fx: number;
  fy: number;
  lx: number;
  ly: number;
}

/**
 * Gives each new trip a vehicle. A vehicle already working the line takes the trip if it is free,
 * in the right place before it and (when it has a later trip) in the right place afterwards.
 * Otherwise a new vehicle is added. Vehicles added here can pick up further new trips, so a
 * there-and-back pair shares one. `forceNew` true puts every trip on its own new vehicle; 'fresh'
 * ignores the vehicles already working the line and chains the trips onto new ones.
 */
export async function assignVehicles(
  tx: Tx,
  sc: Scenario,
  seq: number,
  tripIds: number[],
  forceNew: boolean | 'fresh' = false,
  /**
   * For a closure. `groupOf` gives the side each trip is on: a vehicle takes trips of one side only.
   * `crosses` says whether going straight from one place to another runs through the closure: such
   * a link is never made. `alsoDays` are more vehicles that may take the trips (the ones that ran
   * them before they were split).
   */
  extra: {
    groupOf?: Map<number, string>;
    crosses?: (ax: number, ay: number, bx: number, by: number) => boolean;
    alsoDays?: number[];
  } = {},
) {
  if (!tripIds.length) return { reused: 0, added: 0 };
  const now = { ...sc, head: seq };
  const load = async (where: ReturnType<Tx>): Promise<FleetTrip[]> => {
    const rows = await tx`
      select t.id, t.vehicle_day_id as vd, t.start_secs as s, t.end_secs as e, r.mode_id, r.agency_gtfs_id, m.rule_set,
             t.vehicle_type_id as vt,
             ST_X(coalesce(fp.geom, f.geom)) as fx, ST_Y(coalesce(fp.geom, f.geom)) as fy,
             ST_X(coalesce(lp.geom, l.geom)) as lx, ST_Y(coalesce(lp.geom, l.geom)) as ly
      from trips t
      join routes r on r.id = t.route_id
      join modes m on m.id = r.mode_id
      join stops f on f.id = t.first_stop_id
      join stops l on l.id = t.last_stop_id
      left join stops fp on fp.id = f.parent_id and m.rule_set <> 'road'
      left join stops lp on lp.id = l.parent_id and m.rule_set <> 'road'
      where ${where}`;
    return rows.map((r) => ({
      id: r.id,
      vd: r.vd,
      s: r.s,
      e: r.e,
      modeId: r.mode_id,
      vt: r.vt,
      ruleSet: r.rule_set as RuleSet,
      partition: `${r.mode_id}|${r.agency_gtfs_id ?? ''}|${r.vt ?? ''}`,
      fx: r.fx,
      fy: r.fy,
      lx: r.lx,
      ly: r.ly,
    }));
  };
  const fresh = (await load(tx`t.id = any(${tripIds})`)).sort((a, b) => a.s - b.s || a.id - b.id);
  if (extra.groupOf) for (const t of fresh) t.group = extra.groupOf.get(t.id);
  const crosses = extra.crosses ?? (() => false);
  // Candidates: every vehicle that already runs a trip on one of these lines.
  const working = forceNew
    ? []
    : await load(tx`
        (t.vehicle_day_id in (
          select t2.vehicle_day_id from trips t2
          where t2.route_id in (select route_id from trips where id = any(${tripIds}))
            and t2.vehicle_day_id is not null and ${visible(tx, 't2', now)})
         or t.vehicle_day_id = any(${extra.alsoDays ?? []}::bigint[]))
        and ${visible(tx, 't', now)} and not (t.id = any(${tripIds}))`);

  interface Vehicle {
    id: number | null;
    partition: string;
    /** The side of a closure it works, once it has taken a trip that has one. */
    group?: string;
    trips: FleetTrip[];
    modeId: string;
    vt: number | null;
  }
  const vehicles = new Map<number, Vehicle>();
  for (const t of working) {
    let v = vehicles.get(t.vd!);
    if (!v)
      vehicles.set(
        t.vd!,
        (v = { id: t.vd, partition: t.partition, trips: [], modeId: t.modeId, vt: t.vt }),
      );
    v.trips.push(t);
  }
  const pool = [...vehicles.values()];
  for (const v of pool) v.trips.sort((a, b) => a.s - b.s);
  const added: Vehicle[] = [];
  const chosen = new Map<number, Vehicle>();
  let reused = 0;

  for (const trip of fresh) {
    const rules = DEFAULT_CHAIN_RULES[trip.ruleSet];
    let best: { v: Vehicle; wait: number } | null = null;
    for (const v of forceNew === true ? [] : [...pool, ...added]) {
      if (v.partition !== trip.partition) continue;
      if (v.group !== undefined && trip.group !== undefined && v.group !== trip.group) continue;
      let prev: FleetTrip | null = null;
      let next: FleetTrip | null = null;
      for (const t of v.trips) {
        if (t.s <= trip.s) prev = t;
        else {
          next = t;
          break;
        }
      }
      if (
        prev &&
        (prev.e + rules.minLayoverSecs > trip.s ||
          distanceM(prev.lx, prev.ly, trip.fx, trip.fy) > rules.radiusM ||
          crosses(prev.lx, prev.ly, trip.fx, trip.fy))
      )
        continue;
      if (
        next &&
        (trip.e + rules.minLayoverSecs > next.s ||
          distanceM(trip.lx, trip.ly, next.fx, next.fy) > rules.radiusM ||
          crosses(trip.lx, trip.ly, next.fx, next.fy))
      )
        continue;
      const wait = prev ? trip.s - prev.e : next!.s - trip.e;
      // A vehicle idle for hours has most likely gone back to its depot.
      if (wait > 4 * 3600) continue;
      if (!best || wait < best.wait) best = { v, wait };
    }
    let v: Vehicle;
    if (best) {
      v = best.v;
      if (v.id !== null) reused++;
    } else {
      v = { id: null, partition: trip.partition, trips: [], modeId: trip.modeId, vt: trip.vt };
      added.push(v);
    }
    if (v.group === undefined) v.group = trip.group;
    v.trips.push(trip);
    v.trips.sort((a, b) => a.s - b.s);
    chosen.set(trip.id, v);
  }

  if (added.length) {
    const [{ n }] =
      await tx`select count(*)::int as n from vehicle_days where scenario_id = ${sc.id}`;
    const rows = added.map((v, i) => ({
      baseline_id: sc.baselineId,
      mode_id: v.modeId,
      label: `New vehicle ${n + i + 1}`,
      source: 'inferred',
      vehicle_type_id: v.vt,
      trip_count: v.trips.length,
      start_secs: v.trips[0].s,
      end_secs: Math.max(...v.trips.map((t) => t.e)),
      scenario_id: sc.id,
      created_edit: seq,
    }));
    const inserted = await tx`insert into vehicle_days ${tx(rows)} returning id`;
    added.forEach((v, i) => (v.id = inserted[i].id));
  }
  const ids = fresh.map((t) => t.id);
  const days = fresh.map((t) => chosen.get(t.id)!.id!);
  await tx`
    update trips t set vehicle_day_id = u.day_id
    from unnest(${ids}::bigint[], ${days}::bigint[]) as u(trip_id, day_id) where t.id = u.trip_id`;
  return { reused, added: added.length };
}
