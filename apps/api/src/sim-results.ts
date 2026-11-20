// The results view of the passenger simulator (docs/simulator-plan.md, section 18): one run set
// against another made on the same people. Everything here reads the result tables that sim.ts
// fills; nothing is written.
//
// Two runs cannot be compared trip by trip, because an edited trip is a new trip and a line cut by
// a closure becomes new lines. So figures are compared by person (the same journey_id in both
// runs), by line with the parts of a split line counted under the line they came from, by station
// (a platform counts as its station), and by the stretch between two consecutive calls.
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/**
 * Where the change in arrival time is cut into groups, in seconds later than the other run. Under
 * a minute either way is "the same", as in the simulator's own summary.
 */
const EDGES = [-1799, -899, -299, -59, 60, 300, 900, 1800];
export const CHANGE_GROUPS = EDGES.length + 1;
/** Journey times are counted in ten-minute steps, the last one open-ended. */
const TIME_STEPS = 13;
/** Journey length on the run compared with: under 15 minutes, to 30, to 60, longer. */
const LENGTH_EDGES = [900, 1800, 3600];

interface RunRow {
  id: number;
  name: string;
  kind: string;
  state: string;
  archived: boolean;
  bau_run_id: number | null;
  plans_run_id: number | null;
  finished_at: Date | null;
  /** Seconds later than the BAU run at which people gave up in this run; null if the run had no limit. */
  give_up_secs: number | null;
  /** How many of the run's trips there are, and how many have a placeholder or assumed capacity. */
  capacity_trips: number | null;
  capacity_placeholders: number | null;
}

const RUN_COLUMNS = `id, name, kind, state, archived, bau_run_id, plans_run_id, finished_at,
  nullif(summary->'settings'->>'giveUpSecs', '-1')::int as give_up_secs,
  (summary->'capacities'->>'trips')::int as capacity_trips,
  (summary->'capacities'->>'placeholderOrAssumed')::int as capacity_placeholders`;

/**
 * What to say about a run's capacities wherever crowding is shown: every capacity in the editor is
 * a placeholder for now, and a figure for how full a vehicle is means nothing until that changes.
 */
const capacityOf = (run: RunRow) =>
  run.capacity_trips === null ? null : { trips: run.capacity_trips, placeholder: run.capacity_placeholders ?? 0 };

/** The BAU run a run's people come from. Two runs can be compared when this is the same. */
const rootOf = (run: RunRow) => run.bau_run_id ?? run.plans_run_id ?? run.id;

type Band = [number, number];

/**
 * Works out a run's passengers on each stretch between two consecutive calls, by half hour, and
 * keeps them in sim_link_loads. It takes several seconds for a big run, so it is done when a run's
 * results are copied in; a run made before this existed gets it the first time its flows are asked for.
 */
export async function buildLinkLoads(sql: Sql, run: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from sim_link_loads where run_id = ${run}`;
    await tx`
      insert into sim_link_loads (run_id, from_stop, to_stop, half_hour, mode_id, passengers, places)
      select ${run}, stop, next, (depart / 1800)::smallint, min(mode_id), sum(load)::int, sum(capacity)::int
      from (
        select l.depart, l.load, l.capacity, coalesce(s.parent_id, s.id) as stop, r.mode_id,
               lead(coalesce(s.parent_id, s.id)) over (partition by l.trip_gtfs_id order by l.position) as next
        from sim_trip_loads l join stops s on s.id = l.stop_id
        left join trips t on t.id = l.trip_id left join routes r on r.id = t.route_id
        where l.run_id = ${run}) calls
      where next is not null and next <> stop and load > 0
      group by 2, 3, 4`;
  });
}

export function registerSimResultRoutes(app: FastifyInstance, sql: Sql) {
  // A finished run never changes, so an answer is good until the run is removed or made again.
  const cache = new Map<string, unknown>();
  const cached = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    if (cache.has(key)) return cache.get(key) as T;
    const value = await work();
    if (cache.size >= 60) cache.delete(cache.keys().next().value as string);
    cache.set(key, value);
    return value;
  };

  const whole = (value: unknown, label: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw fail(400, `${label} must be a whole number`);
    return n;
  };

  /**
   * The run asked for and the run it is set against: ?vs=, or else the run whose plans a capacity
   * run replays (whether those are a BAU run's or a scenario run's), or the BAU run a scenario run
   * was made against. A plain BAU run has nothing to be set against unless ?vs= names something.
   */
  async function pair(req: { params: unknown; query: unknown; url: string }, needsJourneys: boolean) {
    const id = whole((req.params as { id: string }).id, 'id');
    const query = req.query as Record<string, string | undefined>;
    const [run] = await sql<RunRow[]>`select ${sql.unsafe(RUN_COLUMNS)} from sim_runs where id = ${id}`;
    if (!run) throw fail(404, 'Run not found');
    if (run.state !== 'done') throw fail(409, 'The run has not finished');
    const vsId = query.vs === 'none' ? null
      : query.vs ? whole(query.vs, 'vs')
      : run.plans_run_id ?? (run.kind === 'scenario' ? run.bau_run_id : null);
    let vs: RunRow | null = null;
    if (vsId !== null && vsId !== undefined) {
      [vs] = await sql<RunRow[]>`select ${sql.unsafe(RUN_COLUMNS)} from sim_runs where id = ${vsId}`;
      if (!vs || vs.state !== 'done') {
        if (query.vs) throw fail(404, 'The run to compare with was not found, or has not finished');
        vs = null;
      } else if (vs.id === run.id || rootOf(vs) !== rootOf(run)) {
        throw fail(400, 'Two runs can be compared only when they were made on the same people: the same BAU run');
      }
    }
    if (needsJourneys && (run.archived || vs?.archived)) {
      throw fail(409, `${run.archived ? 'This run' : `"${vs!.name}"`} is archived. Restore it in the library to see figures about people.`);
    }
    const from = query.from ? whole(query.from, 'from') : 0;
    const to = query.to ? whole(query.to, 'to') : 400_000;
    const band: Band = [from, to];
    const key = `${req.url}|${run.finished_at?.getTime()}|${vs?.id}|${vs?.finished_at?.getTime()}`;
    return { run, vs, a: run.id, b: vs?.id ?? -1, band, key, query };
  }

  /** The line a route counts under: a part made by a closure counts under the line it was cut from. */
  const lineOf = (alias: string) => sql`coalesce((${sql(alias)}.extra->>'variantOf')::bigint, ${sql(alias)}.id)`;

  /**
   * One row per journey of a run. A journey is usually one row already; with capacity on, a row
   * that a full vehicle split has several, and they are put back together here.
   */
  const perJourney = (run: number, band: Band) => {
    const ok = sql`filter (where status = 'ok')`;
    const mean = (column: string) => sql`(sum(${sql(column)}::bigint * people) ${ok} / nullif(sum(people) ${ok}, 0))::int`;
    return sql`
      select journey_id, min(start_secs) as start_secs, min(user_id) as user_id, sum(people)::int as people_all,
             case when coalesce(sum(people) ${ok}, 0) > 0 then 'ok'
                  when coalesce(sum(people) filter (where status = 'gaveUp'), 0) > 0 then 'gaveUp'
                  when coalesce(sum(people) filter (where status = 'stranded'), 0) > 0 then 'stranded'
                  else 'noJourney' end as status,
             coalesce(sum(people) ${ok}, 0)::int as ok,
             coalesce(sum(people) filter (where status = 'gaveUp'), 0)::int as gave_up,
             coalesce(sum(people) filter (where status = 'stranded'), 0)::int as stranded,
             ${mean('arrive')} as arrive, ${mean('journey_secs')} as journey_secs, ${mean('wait_secs')} as wait_secs,
             ${mean('walk_secs')} as walk_secs,
             (sum(boardings * people) ${ok})::float8 / nullif(sum(people) ${ok}, 0) as vehicles,
             min(origin_stop_id) ${ok} as origin, min(destination_stop_id) ${ok} as destination,
             coalesce(bool_or(stops = 'near') ${ok}, false) as near, max(margin_secs) as margin,
             min(later_secs) filter (where status = 'gaveUp') as gave_up_later
      from sim_journeys
      where run_id = ${run} and start_secs >= ${band[0]} and start_secs < ${band[1]}
      group by journey_id`;
  };

  /**
   * The same journey in both runs, side by side. `both_ok` people travel in both and can be compared.
   *
   * `nearby` marks someone who arrives sooner only in a way the published timetable already
   * offered: in this run they use a stop near their own (and in the other run they did not), and
   * on the published timetable a stop nearby was already the better choice for them, which is what
   * a margin above nothing means. A simulator that lets people change stop will always "find" that
   * gain; it is not something the scenario gave them. With real journey data the margin is how
   * strongly a person prefers their own stop; with made-up journeys it is an accident of the draw.
   *
   * `gave_up_later` is how much later than on the published timetable the journey would have been
   * that someone gave up rather than make; null for a run made before that was recorded.
   */
  const sideBySide = (a: number, b: number, band: Band) => sql`
    select journey_id, coalesce(a.user_id, b.user_id) as user_id, coalesce(a.people_all, b.people_all) as people,
           coalesce(a.start_secs, b.start_secs) as start_secs,
           a.status as a_status, b.status as b_status, a.arrive as a_arrive, b.arrive as b_arrive,
           a.origin as a_origin, b.origin as b_origin, a.destination as a_destination, b.destination as b_destination,
           coalesce(a.ok, 0) as a_ok, coalesce(b.ok, 0) as b_ok,
           least(coalesce(a.ok, 0), coalesce(b.ok, 0)) as both_ok,
           greatest(coalesce(b.ok, 0) - coalesce(a.ok, 0), 0) as lost,
           greatest(coalesce(a.ok, 0) - coalesce(b.ok, 0), 0) as gained,
           coalesce(a.gave_up, 0) as gave_up, coalesce(a.stranded, 0) as stranded,
           a.arrive - b.arrive as later,
           (least(coalesce(a.ok, 0), coalesce(b.ok, 0)) > 0 and a.arrive - b.arrive <= -60
             and coalesce(a.near, false) and not coalesce(b.near, false) and coalesce(b.margin, a.margin, 0) > 0) as nearby,
           a.gave_up_later,
           a.journey_secs as a_journey, a.wait_secs as a_wait, a.walk_secs as a_walk, a.vehicles as a_vehicles,
           b.journey_secs as b_journey, b.wait_secs as b_wait, b.walk_secs as b_walk, b.vehicles as b_vehicles,
           coalesce(b.origin, a.origin) as origin, coalesce(b.destination, a.destination) as destination
    from (${perJourney(a, band)}) a full join (${perJourney(b, band)}) b using (journey_id)`;

  const changeGroup = sql`case when both_ok > 0 then width_bucket(later, ${EDGES}::int[]) end`;

  /**
   * Who gains and who loses: people by how much sooner or later they arrive, the same by hour of
   * day and by length of journey, what the change is made of (waiting, walking, riding, vehicles
   * boarded), and journey times in each run.
   */
  app.get('/api/sim-runs/:id/results/overview', async (req) => {
    const p = await pair(req, true);
    return cached(p.key, async () => {
      const others = await sql`
        select id, name, kind, capacity from sim_runs
        where state = 'done' and id <> ${p.a} and coalesce(bau_run_id, plans_run_id, id) = ${rootOf(p.run)}
        order by kind, created_at`;
      const times = await sql`
        select run_id, least(journey_secs / 600, ${TIME_STEPS - 1})::int as step, sum(people)::int as people,
               sum(journey_secs::bigint * people)::float8 as secs
        from sim_journeys
        where run_id in (${p.a}, ${p.b}) and status = 'ok' and start_secs >= ${p.band[0]} and start_secs < ${p.band[1]}
        group by 1, 2`;
      const journeyTimes = (run: number) => {
        const steps = new Array<number>(TIME_STEPS).fill(0);
        let people = 0;
        let secs = 0;
        for (const row of times) {
          if (row.run_id !== run) continue;
          steps[row.step] = row.people;
          people += row.people;
          secs += row.secs;
        }
        return { steps, people, meanMinutes: people ? secs / people / 60 : 0 };
      };
      // Whether the journeys are made up, by the set's own flag or by the look of its user ids.
      const root = rootOf(p.run);
      const [demand] = await sql`
        select d.made_up or coalesce((d.report->>'madeUpIds')::boolean, false) as made_up
        from sim_runs r join demand_sets d on d.id = r.demand_set_id where r.id = ${root}`;
      // On the published timetable (the BAU run), how many travellers a nearby stop already beat.
      const [beaten] = await sql`
        select coalesce(sum(people), 0)::float8 as people,
               coalesce(sum(people) filter (where margin_secs > 0), 0)::float8 as beaten,
               coalesce(sum(margin_secs::bigint * people) filter (where margin_secs > 0), 0)::float8 as secs
        from sim_journeys
        where run_id = ${root} and status = 'ok' and start_secs >= ${p.band[0]} and start_secs < ${p.band[1]}`;
      const base = {
        run: { id: p.run.id, name: p.run.name, kind: p.run.kind },
        vs: p.vs ? { id: p.vs.id, name: p.vs.name, kind: p.vs.kind } : null,
        others,
        times: { a: journeyTimes(p.a), b: p.vs ? journeyTimes(p.b) : null },
        // null: the demand set has been removed, so it is not known.
        madeUp: demand ? (demand.made_up as boolean) : null,
        margin: beaten.people > 0
          ? { people: beaten.people, beaten: beaten.beaten, meanMinutes: beaten.beaten ? beaten.secs / beaten.beaten / 60 : 0 }
          : null,
        capacity: capacityOf(p.run),
      };
      if (!p.vs) return base;

      const rows = await sql`
        select (start_secs / 3600)::int as hour,
               case when b_journey is null then null else width_bucket(b_journey, ${LENGTH_EDGES}::int[]) end as length,
               ${changeGroup} as grp, nearby,
               sum(both_ok)::float8 as people, sum(later::bigint * both_ok)::float8 as later_secs,
               sum(a_wait::bigint * both_ok)::float8 as a_wait, sum(b_wait::bigint * both_ok)::float8 as b_wait,
               sum(a_walk::bigint * both_ok)::float8 as a_walk, sum(b_walk::bigint * both_ok)::float8 as b_walk,
               sum(a_journey::bigint * both_ok)::float8 as a_journey, sum(b_journey::bigint * both_ok)::float8 as b_journey,
               sum(a_vehicles * both_ok)::float8 as a_vehicles, sum(b_vehicles * both_ok)::float8 as b_vehicles,
               sum(lost)::float8 as lost, sum(least(gave_up, lost))::float8 as lost_gave_up,
               sum(least(stranded, greatest(lost - gave_up, 0)))::float8 as lost_stranded, sum(gained)::float8 as gained
        from (${sideBySide(p.a, p.b, p.band)}) j
        group by 1, 2, 3, 4`;
      // People who gave up, by how much later the journey they turned down would have got them
      // there. A run made before that was recorded says only that it was more than the limit, so
      // they are counted at the limit itself: the least it can have been.
      const limit = p.run.give_up_secs ?? 3600;
      const gaveUpRows = await sql`
        select (start_secs / 3600)::int as hour, width_bucket(coalesce(gave_up_later, ${limit}), ${EDGES}::int[]) as grp,
               sum(least(gave_up, lost))::float8 as people,
               sum(coalesce(gave_up_later, ${limit})::bigint * least(gave_up, lost))::float8 as secs,
               coalesce(sum(least(gave_up, lost)) filter (where gave_up_later is null), 0)::float8 as at_least
        from (${sideBySide(p.a, p.b, p.band)}) j
        where gave_up > 0 and lost > 0
        group by 1, 2`;

      const groups = () => new Array<number>(CHANGE_GROUPS).fill(0);
      const SAME = EDGES.length / 2;
      const emptyParts = () => ({ people: 0, a: { wait: 0, walk: 0, journey: 0, vehicles: 0 }, b: { wait: 0, walk: 0, journey: 0, vehicles: 0 } });
      const total = {
        compared: 0, groups: groups(), nearbyGroups: groups(), lost: 0, lostGaveUp: 0, lostStranded: 0, gained: 0,
        soonerSecs: 0, laterSecs: 0, nearby: 0, nearbySecs: 0,
      };
      const gaveUp = { people: 0, secs: 0, atLeast: 0, groups: groups() };
      const parts = { all: emptyParts(), changed: emptyParts() };
      const byHour = new Map<number, { hour: number; groups: number[]; lost: number; gained: number; nearby: number; gaveUp: number }>();
      const hourOf = (h: number) => {
        let hour = byHour.get(h);
        if (!hour) byHour.set(h, (hour = { hour: h, groups: groups(), lost: 0, gained: 0, nearby: 0, gaveUp: 0 }));
        return hour;
      };
      for (const row of gaveUpRows) {
        gaveUp.people += row.people;
        gaveUp.secs += row.secs;
        gaveUp.atLeast += row.at_least;
        gaveUp.groups[row.grp] += row.people;
        hourOf(row.hour).gaveUp += row.people;
      }
      const byLength = LENGTH_EDGES.concat(0).map((_, length) => ({ length, people: 0, groups: groups(), laterSecs: 0 }));
      for (const row of rows) {
        const n = Number(row.people ?? 0);
        const hour = hourOf(row.hour);
        hour.lost += row.lost;
        hour.gained += row.gained;
        total.lost += row.lost;
        total.lostGaveUp += row.lost_gave_up;
        total.lostStranded += row.lost_stranded;
        total.gained += row.gained;
        if (row.grp === null || !n) continue;
        total.compared += n;
        total.groups[row.grp] += n;
        hour.groups[row.grp] += n;
        if (row.grp < SAME) total.soonerSecs -= row.later_secs;
        if (row.nearby) {
          total.nearby += n;
          total.nearbySecs -= row.later_secs;
          total.nearbyGroups[row.grp] += n;
          hour.nearby += n;
        }
        if (row.grp > SAME) total.laterSecs += row.later_secs;
        if (row.length !== null) {
          byLength[row.length].people += n;
          byLength[row.length].groups[row.grp] += n;
          byLength[row.length].laterSecs += row.later_secs;
        }
        for (const set of row.grp === SAME ? [parts.all] : [parts.all, parts.changed]) {
          set.people += n;
          for (const side of ['a', 'b'] as const) {
            set[side].wait += Number(row[`${side}_wait`] ?? 0);
            set[side].walk += Number(row[`${side}_walk`] ?? 0);
            set[side].journey += Number(row[`${side}_journey`] ?? 0);
            set[side].vehicles += Number(row[`${side}_vehicles`] ?? 0);
          }
        }
      }
      // Sums become averages: minutes waiting, walking and riding, and vehicles boarded.
      const averages = (set: ReturnType<typeof emptyParts>) => {
        const of = (s: { wait: number; walk: number; journey: number; vehicles: number }) => {
          const n = set.people || 1;
          return {
            waitMinutes: s.wait / n / 60, walkMinutes: s.walk / n / 60, rideMinutes: (s.journey - s.wait - s.walk) / n / 60,
            journeyMinutes: s.journey / n / 60, vehicles: s.vehicles / n,
          };
        };
        return { people: set.people, a: of(set.a), b: of(set.b) };
      };
      const sooner = total.groups.slice(0, SAME).reduce((x, y) => x + y, 0);
      const later = total.groups.slice(SAME + 1).reduce((x, y) => x + y, 0);
      const figure = (people: number, secs: number) => ({ people, hours: secs / 3600, meanMinutes: people ? secs / people / 60 : 0 });
      const truly = figure(sooner - total.nearby, total.soonerSecs - total.nearbySecs);
      const hoursLost = (total.laterSecs + gaveUp.secs) / 3600;
      return {
        ...base,
        compared: total.compared,
        groups: total.groups,
        // Of each group, the people who arrive sooner only by a nearby stop that was already better.
        nearbyGroups: total.nearbyGroups,
        sooner: { ...figure(sooner, total.soonerSecs), truly, nearby: figure(total.nearby, total.nearbySecs) },
        later: figure(later, total.laterSecs),
        // Counted by how much later than on the published timetable the journey they turned down
        // would have been. `atLeast` of them are from a run that did not record it and are counted
        // at the limit, so the hours are then a least figure.
        gaveUp: { ...figure(gaveUp.people, gaveUp.secs), groups: gaveUp.groups, atLeast: gaveUp.atLeast, limitMinutes: limit / 60 },
        // The time lost by those who arrive later or gave up, against the time gained by those who
        // truly arrive sooner. The gain that a nearby stop already offered is left out, and so are
        // people with no journey at all, whose loss has no length.
        net: { hoursLost, hoursGained: truly.hours, hours: hoursLost - truly.hours, atLeast: gaveUp.atLeast > 0 },
        lost: { people: total.lost, gaveUp: total.lostGaveUp, stranded: total.lostStranded },
        gained: total.gained,
        parts: { all: averages(parts.all), changed: averages(parts.changed) },
        byHour: [...byHour.values()].sort((x, y) => x.hour - y.hour),
        byLength: byLength.map((l) => ({ ...l, meanLaterMinutes: l.people ? l.laterSecs / l.people / 60 : 0 })),
      };
    });
  });

  /** One row per trip of each run, for the part of the day asked for. */
  const perTrip = (a: number, b: number, band: Band) => sql`
    select l.run_id, max(l.trip_id) as trip_id, sum(l.boardings)::int as boardings, max(l.load) as peak,
           max(l.capacity) as capacity, sum(l.left_behind)::int as left_behind
    from sim_trip_loads l
    where l.run_id in (${a}, ${b}) and l.depart >= ${band[0]} and l.depart < ${band[1]}
    group by l.run_id, l.trip_gtfs_id`;

  /** Every line that carries anyone in either run: passengers, and how full its fullest trip gets. */
  app.get('/api/sim-runs/:id/results/lines', async (req) => {
    const p = await pair(req, false);
    return cached(p.key, async () => {
      const rows = await sql`
        with per_line as (
          select x.run_id, ${lineOf('r')} as line, sum(x.boardings)::int as boardings,
                 count(*) filter (where x.boardings > 0)::int as trips,
                 max(case when x.capacity > 0 then x.peak::float8 / x.capacity end) as peak_share,
                 count(*) filter (where x.capacity > 0 and x.peak >= x.capacity)::int as trips_full,
                 sum(x.left_behind)::int as left_behind, count(distinct r.id)::int as parts
          from (${perTrip(p.a, p.b, p.band)}) x join trips t on t.id = x.trip_id join routes r on r.id = t.route_id
          group by 1, 2)
        select r.id, r.short_name as "shortName", r.long_name as "longName", r.mode_id as "modeId", r.color,
               r.scenario_id is not null as "isNew",
               coalesce(a.boardings, 0) as a, coalesce(b.boardings, 0) as b,
               coalesce(a.trips, 0) as "aTrips", coalesce(b.trips, 0) as "bTrips",
               a.peak_share as "aPeak", b.peak_share as "bPeak",
               coalesce(a.trips_full, 0) as "aFull", coalesce(b.trips_full, 0) as "bFull",
               coalesce(a.left_behind, 0) as "aLeftBehind", coalesce(b.left_behind, 0) as "bLeftBehind",
               greatest(coalesce(a.parts, 1), 1) as parts
        from (select distinct line from per_line) x
        join routes r on r.id = x.line
        left join per_line a on a.line = x.line and a.run_id = ${p.a}
        left join per_line b on b.line = x.line and b.run_id = ${p.b}
        where coalesce(a.boardings, 0) + coalesce(b.boardings, 0) > 0
        order by abs(coalesce(a.boardings, 0) - coalesce(b.boardings, 0)) desc, coalesce(a.boardings, 0) desc`;
      return { run: p.run.id, vs: p.vs?.id ?? null, capacity: capacityOf(p.run), lines: rows };
    });
  });

  /**
   * One line in both runs: passengers boarding by hour, each station along it, and where its
   * passengers went. "went": of the people who rode it in the run compared with, what they ride in
   * this run. "cameFrom": of the people who ride it in this run, what they rode in the other.
   */
  app.get('/api/sim-runs/:id/results/lines/:line', async (req) => {
    const p = await pair(req, false);
    const line = whole((req.params as { line: string }).line, 'line');
    return cached(p.key, async () => {
      const onLine = sql`${lineOf('r')} = ${line}`;
      const hourly = await sql`
        select l.run_id = ${p.a} as "isA", (l.depart / 3600)::int as hour, sum(l.boardings)::int as boardings
        from sim_trip_loads l join trips t on t.id = l.trip_id join routes r on r.id = t.route_id
        where l.run_id in (${p.a}, ${p.b}) and ${onLine} group by 1, 2 order by 2`;
      const stops = await sql`
        select x.stop as id, s.name,
               coalesce(sum(x.boardings) filter (where x.is_a), 0)::int as "aOn",
               coalesce(sum(x.alightings) filter (where x.is_a), 0)::int as "aOff",
               coalesce(sum(x.boardings) filter (where not x.is_a), 0)::int as "bOn",
               coalesce(sum(x.alightings) filter (where not x.is_a), 0)::int as "bOff",
               coalesce(avg(x.position) filter (where x.direction = 0), avg(x.position))::float8 as at
        from (
          select coalesce(s.parent_id, s.id) as stop, l.run_id = ${p.a} as is_a, l.boardings, l.alightings, l.position,
                 coalesce(t.direction_id, 0) as direction
          from sim_trip_loads l join trips t on t.id = l.trip_id join routes r on r.id = t.route_id
          join stops s on s.id = l.stop_id
          where l.run_id in (${p.a}, ${p.b}) and ${onLine}) x
        join stops s on s.id = x.stop
        group by x.stop, s.name
        having sum(x.boardings) + sum(x.alightings) > 0
        order by at`;

      // The people who ride this line in one run and not in the other, and the lines they ride
      // in the other that they did not ride in the first: where they went, or came from.
      const shift = async (from: number, to: number) => {
        if (from < 0 || to < 0) return null;
        const riders = (run: number) => sql`
          select x.journey_id, sum(x.people)::int as people from (
            select distinct l.journey_id, l.part, l.people
            from sim_legs l join routes r on r.id = l.route_id
            where l.run_id = ${run} and l.kind = 'ride' and ${onLine}) x
          group by x.journey_id`;
        const moved = sql`
          select f.journey_id, f.people from (${riders(from)}) f
          where not exists (select 1 from (${riders(to)}) t where t.journey_id = f.journey_id)`;
        const [{ riders: all }] = await sql`select coalesce(sum(people), 0)::int as riders from (${riders(from)}) x`;
        const [{ people }] = await sql`select coalesce(sum(people), 0)::int as people from (${moved}) x`;
        const lines = people
          ? await sql`
              select x.line as id, r.short_name as "shortName", r.long_name as "longName", r.color, sum(x.people)::int as people
              from (
                select distinct l.journey_id, ${lineOf('r')} as line, m.people
                from (${moved}) m join sim_legs l on l.journey_id = m.journey_id join routes r on r.id = l.route_id
                where l.run_id = ${to} and l.kind = 'ride'
                  and not exists (
                    select 1 from sim_legs o join routes r2 on r2.id = o.route_id
                    where o.run_id = ${from} and o.journey_id = l.journey_id and o.kind = 'ride'
                      and ${lineOf('r2')} = ${lineOf('r')})) x
              join routes r on r.id = x.line
              group by 1, 2, 3, 4 order by people desc limit 10`
          : [];
        const [{ none }] = people
          ? await sql`
              select coalesce(sum(m.people), 0)::int as none from (${moved}) m
              where not exists (select 1 from sim_journeys j where j.run_id = ${to} and j.journey_id = m.journey_id and j.status = 'ok')`
          : [{ none: 0 }];
        return { riders: all, people, lines, notTravelling: none };
      };
      const archived = p.run.archived || !!p.vs?.archived;
      return {
        line,
        hourly,
        stops,
        went: archived ? null : await shift(p.b, p.a),
        cameFrom: archived ? null : await shift(p.a, p.b),
      };
    });
  });

  // A run whose stretch loads are being worked out, so that two requests do not both do it.
  const linking = new Map<number, Promise<void>>();
  /** Fills sim_link_loads for a run, unless it is there already. */
  function ensureLinks(run: number): Promise<void> {
    const going = linking.get(run);
    if (going) return going;
    const work = (async () => {
      if ((await sql`select 1 from sim_link_loads where run_id = ${run} limit 1`).length) return;
      await buildLinkLoads(sql, run);
    })().finally(() => linking.delete(run));
    linking.set(run, work);
    return work;
  }

  /**
   * Passengers on each stretch between two consecutive calls, in both runs, for the map. A
   * platform counts as its station, so a change of platform is not a change of flow. A stretch is
   * what a vehicle runs without calling: an express and an all-stops train on the same track are
   * different stretches.
   */
  app.get('/api/sim-runs/:id/results/flows', async (req) => {
    const p = await pair(req, false);
    return cached(p.key, async () => {
      await ensureLinks(p.a);
      if (p.vs) await ensureLinks(p.b);
      const links = await sql`
        select from_stop as "from", to_stop as "to", min(mode_id) as mode,
               coalesce(sum(passengers) filter (where run_id = ${p.a}), 0)::int as a,
               coalesce(sum(passengers) filter (where run_id = ${p.b}), 0)::int as b,
               coalesce(sum(places) filter (where run_id = ${p.a}), 0)::int as "aPlaces"
        from sim_link_loads
        where run_id in (${p.a}, ${p.b}) and half_hour >= ${Math.floor(p.band[0] / 1800)} and half_hour < ${Math.ceil(p.band[1] / 1800)}
        group by 1, 2`;
      const ids = [...new Set(links.flatMap((l) => [l.from, l.to]))];
      const stops = ids.length
        ? await sql`select id, name, ST_X(geom) as lon, ST_Y(geom) as lat from stops where id = any(${ids})`
        : [];
      return {
        run: p.run.id,
        vs: p.vs?.id ?? null,
        capacity: capacityOf(p.run),
        stops: stops.map((s) => [Number(s.id), s.lon, s.lat, s.name]),
        links: links.map((l) => [Number(l.from), Number(l.to), l.a, l.b, l.aPlaces, l.mode]),
      };
    });
  });

  /**
   * Where the people who gain or lose are: by the stop they start from (or are going to), or
   * gathered into squares. ?by=stop or a square's side in metres; ?end=origin or destination.
   * A person is placed by their stop in the run compared with, which for a BAU run is their own.
   */
  app.get('/api/sim-runs/:id/results/places', async (req) => {
    const p = await pair(req, true);
    if (!p.vs) throw fail(400, 'Nothing to compare this run with: name a run with ?vs=');
    const end = p.query.end === 'destination' ? 'destination' : 'origin';
    const cell = p.query.by && p.query.by !== 'stop' ? whole(p.query.by, 'by') : 0;
    if (cell && (cell < 100 || cell > 20_000)) throw fail(400, 'A square is between 100 m and 20 km across');
    return cached(p.key, async () => {
      // A square of `cell` metres, in degrees. The network is all near 33 degrees south, so one
      // width in degrees of longitude serves the whole of it.
      const dLat = cell / 111_320;
      const dLon = cell / (111_320 * Math.cos((33.5 * Math.PI) / 180));
      const place = cell
        ? sql`floor(ST_X(s.geom) / ${dLon})::int as px, floor(ST_Y(s.geom) / ${dLat})::int as py, null::text as name`
        : sql`coalesce(s.parent_id, s.id) as px, 0 as py, null::text as name`;
      const rows = await sql`
        select px, py,
               sum(both_ok)::int as people, coalesce(sum(later::bigint * both_ok), 0)::float8 as later_secs,
               coalesce(sum(both_ok) filter (where later >= 300), 0)::int as later,
               coalesce(sum(both_ok) filter (where later <= -300), 0)::int as sooner,
               sum(lost)::int as lost, sum(gained)::int as gained
        from (
          select j.*, ${place}
          from (${sideBySide(p.a, p.b, p.band)}) j join stops s on s.id = j.${sql(end)}) x
        group by px, py`;
      let names = new Map<number, { name: string; lon: number; lat: number }>();
      if (!cell && rows.length) {
        const found = await sql`select id, name, ST_X(geom) as lon, ST_Y(geom) as lat from stops where id = any(${rows.map((r) => r.px)})`;
        names = new Map(found.map((s) => [Number(s.id), { name: s.name, lon: s.lon, lat: s.lat }]));
      }
      return {
        run: p.run.id,
        vs: p.vs!.id,
        end,
        cell: cell ? { metres: cell, dLon, dLat } : null,
        // Each place: where, its name if it is a stop, people compared, their average minutes later
        // (negative for sooner), how many are 5 minutes or more later and sooner, and how many can
        // no longer travel or now can.
        places: rows.map((r) => {
          const stop = cell ? null : names.get(Number(r.px));
          return [
            cell ? (r.px + 0.5) * dLon : (stop?.lon ?? 0),
            cell ? (r.py + 0.5) * dLat : (stop?.lat ?? 0),
            stop?.name ?? null,
            r.people,
            r.people ? r.later_secs / r.people / 60 : 0,
            r.later, r.sooner, r.lost, r.gained,
          ];
        }).filter((r) => r[0] !== 0),
      };
    });
  });

  // ---- people picked out, listed and followed ---------------------------------

  /** A station's own row and its platforms, from the id of any of them. */
  const members = (stop: number) => sql`
    select s.id from stops s, stops x
    where x.id = ${stop} and (s.id = coalesce(x.parent_id, x.id) or s.parent_id = coalesce(x.parent_id, x.id))`;

  type Pair = Awaited<ReturnType<typeof pair>>;

  /**
   * The people ?who= picks out, as a condition on the rows of sideBySide (alias j):
   *   all, changed, later, sooner, soonerTruly, soonerNearby, lost, gaveUp, noJourney, gained,
   *   group:<0 to 8>, user:<user_id>,
   *   line:<id>:<a|b>, stop:<id>:<a|b>, link:<from>-<to>:<a|b>.
   * The last three are the people who use something, in this run (a) or the one compared with (b).
   */
  async function whoCondition(p: Pair, text: string | undefined) {
    // Wrapped, because a query fragment handed back from an async function would be run as a query.
    const made = await whoFragment(p, text);
    return { condition: made[0] };
  }
  async function whoFragment(p: Pair, text: string | undefined): Promise<[ReturnType<typeof sql>]> {
    const sqlOne = (strings: TemplateStringsArray, ...values: never[]) => [sql(strings, ...values)] as [ReturnType<typeof sql>];
    const who = text ?? (p.vs ? 'changed' : 'all');
    if (who.startsWith('user:')) return sqlOne`j.user_id = ${who.slice(5)}`;
    const [kind, value = '', side] = who.split(':');
    const run = side === 'b' && p.vs ? p.b : p.a;
    const needsOther = () => {
      if (!p.vs) throw fail(400, 'Nothing to compare this run with, so nobody arrives sooner or later');
    };
    switch (kind) {
      case 'all':
        return sqlOne`true`;
      case 'changed':
        needsOther();
        return sqlOne`(j.lost > 0 or j.gained > 0 or (j.both_ok > 0 and abs(j.later) >= 60))`;
      case 'later':
        needsOther();
        return sqlOne`(j.both_ok > 0 and j.later >= 60)`;
      case 'sooner':
        needsOther();
        return sqlOne`(j.both_ok > 0 and j.later <= -60)`;
      case 'soonerTruly':
        needsOther();
        return sqlOne`(j.both_ok > 0 and j.later <= -60 and not j.nearby)`;
      case 'soonerNearby':
        needsOther();
        return sqlOne`j.nearby`;
      case 'lost':
        needsOther();
        return sqlOne`j.lost > 0`;
      case 'gaveUp':
        needsOther();
        return sqlOne`(j.lost > 0 and j.gave_up > 0)`;
      case 'noJourney':
        needsOther();
        return sqlOne`(j.lost > 0 and j.gave_up = 0)`;
      case 'gained':
        needsOther();
        return sqlOne`j.gained > 0`;
      case 'group': {
        needsOther();
        const group = whole(value, 'group');
        if (group >= CHANGE_GROUPS) throw fail(400, `group is 0 to ${CHANGE_GROUPS - 1}`);
        return sqlOne`(j.both_ok > 0 and width_bucket(j.later, ${EDGES}::int[]) = ${group})`;
      }
      case 'line':
        return sqlOne`j.journey_id in (
          select l.journey_id from sim_legs l join routes r on r.id = l.route_id
          where l.run_id = ${run} and l.kind = 'ride' and ${lineOf('r')} = ${whole(value, 'line')})`;
      case 'stop': {
        const stop = whole(value, 'stop');
        return sqlOne`j.journey_id in (
          select l.journey_id from sim_legs l
          where l.run_id = ${run} and l.kind = 'ride'
            and (l.from_stop_id in (${members(stop)}) or l.to_stop_id in (${members(stop)})))`;
      }
      case 'link': {
        const [from, to] = value.split('-').map((id) => whole(id, 'link'));
        if (to === undefined) throw fail(400, 'A stretch is link:<from stop>-<to stop>');
        // Every trip that calls at the first stop, call by call; then the rides on the trips that
        // run from it straight to the second, kept where the ride is aboard over that stretch.
        // Positions are compared, not times: a bus timetable gives several stops the same minute.
        const calls = await sql`
          select l.trip_id, l.stop_id, coalesce(s.parent_id, s.id) as station, l.arrive, l.depart
          from sim_trip_loads l join stops s on s.id = l.stop_id
          where l.run_id = ${run} and l.trip_id in (
            select trip_id from sim_trip_loads where run_id = ${run} and stop_id in (${members(from)}))
          order by l.trip_id, l.position`;
        const ofTrip = new Map<string, typeof calls[number][]>();
        for (const call of calls) {
          const key = String(call.trip_id);
          let list = ofTrip.get(key);
          if (!list) ofTrip.set(key, (list = []));
          list.push(call);
        }
        const stretchAt = new Map<string, number[]>();
        for (const [trip, list] of ofTrip) {
          const at = list.flatMap((c, i) => (Number(c.station) === from && i + 1 < list.length && Number(list[i + 1].station) === to ? [i] : []));
          if (at.length) stretchAt.set(trip, at);
        }
        const rides = stretchAt.size
          ? await sql`
              select journey_id, trip_id, from_stop_id, to_stop_id, depart, arrive from sim_legs
              where run_id = ${run} and kind = 'ride' and trip_id = any(${[...stretchAt.keys()]})`
          : [];
        const through = new Set<string>();
        for (const ride of rides) {
          const list = ofTrip.get(String(ride.trip_id))!;
          const boards = list.findIndex((c) => c.stop_id === ride.from_stop_id && c.depart === ride.depart);
          if (boards < 0) continue;
          let alights = -1;
          for (let i = boards + 1; i < list.length && alights < 0; i++) if (list[i].stop_id === ride.to_stop_id && list[i].arrive === ride.arrive) alights = i;
          if (stretchAt.get(String(ride.trip_id))!.some((i) => i >= boards && i < alights)) through.add(ride.journey_id);
        }
        return sqlOne`j.journey_id = any(${[...through]})`;
      }
      default:
        throw fail(400, `Unknown ?who=${who}`);
    }
  }

  /**
   * The people picked out, one row a journey, worst affected first (?order=best for the other
   * way): who can no longer travel, then by how much later they arrive. ?limit= and ?offset=.
   */
  app.get('/api/sim-runs/:id/results/people', async (req) => {
    const p = await pair(req, true);
    const limit = Math.min(500, p.query.limit ? whole(p.query.limit, 'limit') : 100);
    const offset = p.query.offset ? whole(p.query.offset, 'offset') : 0;
    const { condition } = await whoCondition(p, p.query.who);
    return cached(p.key, async () => {
      const chosen = sql`select j.* from (${sideBySide(p.a, p.b, p.band)}) j where ${condition}`;
      const [{ journeys, people }] = await sql`select count(*)::int as journeys, coalesce(sum(people), 0)::int as people from (${chosen}) c`;
      const later = sql`case when both_ok > 0 then later end`;
      const order = !p.vs ? sql`a_journey desc nulls last`
        : p.query.order === 'best' ? sql`${later} asc nulls last, (gained > 0) desc`
        : sql`(lost > 0) desc, ${later} desc nulls last`;
      const rows = await sql`
        select journey_id as "journeyId", user_id as "user", people, start_secs as "start",
               a_status as "aStatus", b_status as "bStatus", a_arrive as "aArrive", b_arrive as "bArrive",
               a_journey as "aJourney", b_journey as "bJourney", ${later} as later,
               a_vehicles as "aVehicles", b_vehicles as "bVehicles"
        from (${chosen}) c order by ${order}, start_secs, journey_id limit ${limit} offset ${offset}`;
      return { run: p.run.id, vs: p.vs?.id ?? null, journeys, people, rows };
    });
  });

  /** One journey of a run with its legs, each leg with where it starts and ends. */
  async function journeyOf(run: number, journey: string) {
    const parts = await sql`
      select j.journey_id as "journeyId", j.part, j.people, j.status, j.start_secs as "start", j.depart, j.arrive,
             j.journey_secs as "journeySecs", j.rides, j.boardings, j.walk_secs as "walkSecs", j.wait_secs as "waitSecs",
             j.left_behind as "leftBehind", j.later_secs as "laterSecs", j.origin_changed as "originChanged",
             j.destination_changed as "destinationChanged", j.change_reason as "changeReason",
             j.no_journey_reason as "noJourneyReason", j.stranded_time as "strandedTime"
      from sim_journeys j where j.run_id = ${run} and j.journey_id = ${journey} order by j.part`;
    const legs = await sql`
      select l.part, l.leg, l.kind, l.trip_id as "tripId", l.route_id as "routeId", r.short_name as "routeName",
             f.name as "fromStop", o.name as "toStop", l.depart, l.arrive, l.metres, l.stay_aboard as "stayAboard",
             ST_X(f.geom) as "fromLon", ST_Y(f.geom) as "fromLat", ST_X(o.geom) as "toLon", ST_Y(o.geom) as "toLat"
      from sim_legs l
      left join routes r on r.id = l.route_id left join stops f on f.id = l.from_stop_id left join stops o on o.id = l.to_stop_id
      where l.run_id = ${run} and l.journey_id = ${journey} order by l.part, l.leg`;
    return parts.map((j) => ({ ...j, legs: legs.filter((l) => l.part === j.part) }));
  }

  /** One journey in both runs, leg by leg: `a` in this run, `b` in the one compared with. */
  app.get('/api/sim-runs/:id/results/people/:journey', async (req) => {
    const p = await pair(req, true);
    const journey = (req.params as { journey: string }).journey;
    const a = await journeyOf(p.a, journey);
    const b = p.vs ? await journeyOf(p.b, journey) : null;
    if (!a.length && !b?.length) throw fail(404, 'No such journey in this run');
    return { journeyId: journey, a, b };
  });

  /** More people than this are not followed on the map: every stretch of every ride is looked up. */
  const TRACE_LIMIT = 30_000;

  /**
   * The people picked out, for the map: the stretches they ride in each run, and where they start
   * from and are going. The answer has the shape of the flows, so that it is drawn the same way.
   */
  app.get('/api/sim-runs/:id/results/trace', async (req) => {
    const p = await pair(req, true);
    const { condition } = await whoCondition(p, p.query.who);
    return cached(p.key, async () => {
      // The people are fetched first and named outright in what follows: asked for as a subquery,
      // the planner reads every ride of the run to find theirs.
      const chosen = await sql`
        select j.journey_id, j.people, coalesce(j.b_origin, j.a_origin) as origin, coalesce(j.b_destination, j.a_destination) as destination
        from (${sideBySide(p.a, p.b, p.band)}) j where ${condition} limit ${TRACE_LIMIT + 1}`;
      if (chosen.length > TRACE_LIMIT) {
        throw fail(400, `More than ${TRACE_LIMIT.toLocaleString('en-AU')} journeys are too many to follow on the map. Pick a smaller group, or use "Passenger flow" for everyone.`);
      }
      const journeys = chosen.length;
      const people = chosen.reduce((sum, c) => sum + c.people, 0);
      const journeyIds = chosen.map((c) => c.journey_id as string);
      // Each ride is walked along its trip here, not in the database: the trips these people ride
      // are read once, where a query would look each ride's calls up one ride at a time.
      const byLink = new Map<string, { from: number; to: number; a: number; b: number; mode: string | null }>();
      const walk = async (run: number, side: 'a' | 'b') => {
        const rides = await sql`
          select trip_id, from_stop_id, to_stop_id, depart, arrive, people from sim_legs
          where run_id = ${run} and kind = 'ride' and trip_id is not null and journey_id = any(${journeyIds})`;
        const tripIds = [...new Set(rides.map((r) => String(r.trip_id)))];
        if (!tripIds.length) return;
        const calls = await sql`
          select l.trip_id, l.stop_id, coalesce(s.parent_id, s.id) as station, l.arrive, l.depart, r.mode_id
          from sim_trip_loads l join stops s on s.id = l.stop_id
          left join trips t on t.id = l.trip_id left join routes r on r.id = t.route_id
          where l.run_id = ${run} and l.trip_id = any(${tripIds}) order by l.trip_id, l.position`;
        const ofTrip = new Map<string, typeof calls[number][]>();
        for (const call of calls) {
          const key = String(call.trip_id);
          let list = ofTrip.get(key);
          if (!list) ofTrip.set(key, (list = []));
          list.push(call);
        }
        for (const ride of rides) {
          const list = ofTrip.get(String(ride.trip_id)) ?? [];
          const from = list.findIndex((c) => c.stop_id === ride.from_stop_id && c.depart === ride.depart);
          if (from < 0) continue;
          let to = -1;
          for (let i = from + 1; i < list.length && to < 0; i++) if (list[i].stop_id === ride.to_stop_id && list[i].arrive === ride.arrive) to = i;
          for (let i = from; i < to; i++) {
            const [here, next] = [Number(list[i].station), Number(list[i + 1].station)];
            if (here === next) continue;
            const key = `${here}>${next}`;
            let link = byLink.get(key);
            if (!link) byLink.set(key, (link = { from: here, to: next, a: 0, b: 0, mode: list[i].mode_id }));
            link[side] += ride.people;
          }
        }
      };
      await walk(p.a, 'a');
      if (p.vs) await walk(p.b, 'b');
      const links = [...byLink.values()];
      // Where they start and end, a platform counted as its station.
      const endIds = [...new Set(chosen.flatMap((c) => [c.origin, c.destination]).filter((id) => id !== null))];
      const stationOf = new Map(
        (endIds.length ? await sql`select id, coalesce(parent_id, id) as station from stops where id = any(${endIds})` : [])
          .map((s) => [String(s.id), Number(s.station)]));
      const ends = (end: 'origin' | 'destination') => {
        const counts = new Map<number, number>();
        for (const c of chosen) {
          const station = stationOf.get(String(c[end]));
          if (station !== undefined) counts.set(station, (counts.get(station) ?? 0) + c.people);
        }
        return [...counts].map(([id, n]) => ({ id, people: n }));
      };
      const origins = ends('origin');
      const destinations = ends('destination');
      const ids =[...new Set([...links.flatMap((l) => [l.from, l.to]), ...origins.map((o) => o.id), ...destinations.map((d) => d.id)])];
      const stops = ids.length
        ? await sql`select id, name, ST_X(geom) as lon, ST_Y(geom) as lat from stops where id = any(${ids})`
        : [];
      const at = new Map(stops.map((s) => [Number(s.id), s]));
      const placed = (rows: readonly Record<string, any>[]) =>
        rows.filter((r) => at.has(Number(r.id))).map((r) => {
          const stop = at.get(Number(r.id))!;
          return [stop.lon, stop.lat, stop.name, r.people];
        });
      return {
        run: p.run.id,
        vs: p.vs?.id ?? null,
        journeys,
        people,
        stops: stops.map((s) => [Number(s.id), s.lon, s.lat, s.name]),
        links: links.map((l) => [Number(l.from), Number(l.to), l.a, l.b, 0, l.mode]),
        origins: placed(origins),
        destinations: placed(destinations),
      };
    });
  });

  /**
   * How people travel: passengers boarding by mode, people by the number of vehicles they board,
   * who uses another stop than in the run compared with, and the stations where the most changed.
   */
  app.get('/api/sim-runs/:id/results/patterns', async (req) => {
    const p = await pair(req, false);
    return cached(p.key, async () => {
      const archived = p.run.archived || !!p.vs?.archived;
      const byMode = await sql`
        select r.mode_id as "modeId",
               coalesce(sum(l.boardings) filter (where l.run_id = ${p.a}), 0)::int as a,
               coalesce(sum(l.boardings) filter (where l.run_id = ${p.b}), 0)::int as b
        from sim_trip_loads l join trips t on t.id = l.trip_id join routes r on r.id = t.route_id
        where l.run_id in (${p.a}, ${p.b}) and l.depart >= ${p.band[0]} and l.depart < ${p.band[1]}
        group by 1 having sum(l.boardings) > 0 order by 2 desc`;
      const use = (isA: boolean) => sql`coalesce(sum(x.boardings + x.alightings) filter (where x.is_a = ${isA}), 0)`;
      const stations = await sql`
        select x.stop as id, s.name,
               coalesce(sum(x.boardings) filter (where x.is_a), 0)::int as "aOn",
               coalesce(sum(x.alightings) filter (where x.is_a), 0)::int as "aOff",
               coalesce(sum(x.changes) filter (where x.is_a), 0)::int as "aChanges",
               coalesce(sum(x.boardings) filter (where not x.is_a), 0)::int as "bOn",
               coalesce(sum(x.alightings) filter (where not x.is_a), 0)::int as "bOff",
               coalesce(sum(x.changes) filter (where not x.is_a), 0)::int as "bChanges"
        from (
          select coalesce(s.parent_id, s.id) as stop, v.run_id = ${p.a} as is_a, v.boardings, v.alightings, v.changes
          from sim_stop_activity v join stops s on s.id = v.stop_id
          where v.run_id in (${p.a}, ${p.b}) and v.quarter_start >= ${Math.floor(p.band[0] / 900) * 900} and v.quarter_start < ${p.band[1]}) x
        join stops s on s.id = x.stop
        group by x.stop, s.name
        order by ${p.vs ? sql`abs(${use(true)} - ${use(false)})` : use(true)} desc, ${use(true)} desc, s.name
        limit 20`;
      if (archived) return { run: p.run.id, vs: p.vs?.id ?? null, byMode, stations, vehicles: null, stopChange: null };

      const boarded = await sql`
        select run_id, least(boardings, 4) as n, sum(people)::int as people from sim_journeys
        where run_id in (${p.a}, ${p.b}) and status = 'ok' and start_secs >= ${p.band[0]} and start_secs < ${p.band[1]}
        group by 1, 2`;
      const vehiclesOf = (run: number) => {
        const counts = new Array<number>(5).fill(0);
        for (const row of boarded) if (row.run_id === run) counts[row.n] = row.people;
        return counts;
      };
      let stopChange = null;
      if (p.vs) {
        const moved = (end: 'origin' | 'destination') => sql`
          select coalesce(sa.parent_id, sa.id) as "toId", coalesce(sb.parent_id, sb.id) as "fromId", sum(j.both_ok)::int as people
          from (${sideBySide(p.a, p.b, p.band)}) j
          join stops sa on sa.id = j.${sql(`a_${end}`)} join stops sb on sb.id = j.${sql(`b_${end}`)}
          where j.both_ok > 0 and coalesce(sa.parent_id, sa.id) <> coalesce(sb.parent_id, sb.id)
          group by 1, 2 order by 3 desc`;
        // This counts by the stops the two runs' journeys use, so it includes people whose own stop
        // was removed, whom the simulator's own "changed stop" flag missed in runs made before
        // 20 Nov 2026.
        const [origin, destination] = [await moved('origin'), await moved('destination')];
        const [{ compared }] = await sql`select coalesce(sum(both_ok), 0)::int as compared from (${sideBySide(p.a, p.b, p.band)}) j`;
        const top = [...origin.slice(0, 6).map((m) => ({ ...m, end: 'origin' })), ...destination.slice(0, 6).map((m) => ({ ...m, end: 'destination' }))]
          .sort((x: any, y: any) => y.people - x.people).slice(0, 8) as Record<string, any>[];
        const ids = top.flatMap((m) => [m.fromId, m.toId]);
        const names = new Map((ids.length ? await sql`select id, name from stops where id = any(${ids})` : []).map((s) => [Number(s.id), s.name]));
        stopChange = {
          compared,
          origin: origin.reduce((sum, m) => sum + m.people, 0),
          destination: destination.reduce((sum, m) => sum + m.people, 0),
          moves: top.map((m) => ({
            end: m.end, people: m.people, fromId: Number(m.fromId), toId: Number(m.toId),
            from: names.get(Number(m.fromId)) ?? '?', to: names.get(Number(m.toId)) ?? '?',
          })),
        };
      }
      return {
        run: p.run.id,
        vs: p.vs?.id ?? null,
        byMode,
        stations,
        vehicles: { a: vehiclesOf(p.a), b: p.vs ? vehiclesOf(p.b) : null },
        stopChange,
      };
    });
  });

  /**
   * How full each vehicle is through the day, for colouring vehicles on the map and trips in the
   * timelines. Only trips that carry someone are answered. Fullness is in steps (0 empty, 1 under
   * half the places, 2 under 80%, 3 under all of them, 4 full or over) and only the calls where
   * the step changes are sent: [trip, places, most aboard, time, step, time, step, ...].
   */
  app.get('/api/sim-runs/:id/results/vehicle-loads', async (req) => {
    const p = await pair(req, false);
    return cached(`loads|${p.a}|${p.run.finished_at?.getTime()}`, async () => {
      const rows = await sql`
        select trip_id, max(capacity) as places, max(load) as peak,
               array_agg(depart order by position) filter (where changed) as times,
               array_agg(step order by position) filter (where changed) as steps
        from (
          select q.*, q.step is distinct from lag(q.step) over (partition by q.trip_id order by q.position) as changed
          from (
            select trip_id, position, depart, load, capacity,
                   case when load <= 0 then 0 when capacity <= 0 or load < 0.5 * capacity then 1
                        when load < 0.8 * capacity then 2 when load < capacity then 3 else 4 end as step
            from sim_trip_loads where run_id = ${p.a} and trip_id is not null) q) c
        group by trip_id`;
      return {
        run: p.a,
        trips: rows.map((r) => {
          const out = [Number(r.trip_id), r.places, r.peak];
          for (let i = 0; i < r.times.length; i++) out.push(r.times[i], r.steps[i]);
          return out;
        }),
      };
    });
  });
}
