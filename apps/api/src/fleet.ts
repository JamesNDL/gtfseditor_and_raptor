// The vehicle catalogue: vehicle types, their capacities and how many the fleet has.
// The catalogue is shared reference data, not part of any one day or scenario.
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@gtfs-editor/gtfs/db';
import { scenarioOf, visible } from './scenarios/scenarios.ts';
import { fail } from './http.ts';

interface TypeBody {
  name?: string;
  modeId?: string;
  cars?: number | null;
  seated?: number;
  standing?: number;
  fleetSize?: number | null;
  capacityIsPlaceholder?: boolean;
}

const wholeNumber = (
  value: unknown,
  label: string,
  max: number,
  allowNull = false,
): number | null => {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw fail(400, `${label} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max)
    throw fail(400, `${label} must be a whole number from 0 to ${max}`);
  return n;
};

export function registerFleetRoutes(app: FastifyInstance, sql: Sql) {
  /** Every vehicle type, with how many vehicles and trips use it on the given day (or scenario). */
  app.get('/api/vehicle-types', async (req) => {
    const baseline = Number((req.query as Record<string, string>).baseline);
    if (!Number.isInteger(baseline)) throw fail(400, 'baseline is required');
    const sc = await scenarioOf(req, sql);
    return sql`
      select v.id, v.name, v.mode_id as "modeId", m.name as "modeName", v.cars, v.seated, v.standing,
             v.fleet_size as "fleetSize", v.capacity_is_placeholder as "capacityIsPlaceholder",
             coalesce(u.vehicles, 0) as vehicles, coalesce(u.trips, 0) as trips,
             exists (select 1 from mode_default_vehicle d where d.vehicle_type_id = v.id) as "isModeDefault"
      from vehicle_types v
      join modes m on m.id = v.mode_id
      left join (
        select tv.vehicle_type_id, count(distinct t.vehicle_day_id)::int as vehicles, count(*)::int as trips
        from trips t join trip_vehicle tv on tv.trip_id = t.id
        where t.baseline_id = ${baseline} and ${visible(sql, 't', sc)}
        group by 1) u on u.vehicle_type_id = v.id
      order by m.sort, v.name`;
  });

  app.post('/api/vehicle-types', async (req) => {
    const body = req.body as TypeBody;
    const name = (body.name ?? '').trim().slice(0, 80);
    if (!name) throw fail(400, 'Give the vehicle type a name');
    const [mode] = await sql`select id from modes where id = ${body.modeId ?? ''}`;
    if (!mode) throw fail(400, 'Choose a mode');
    const code = `CUSTOM-${Date.now().toString(36).toUpperCase()}`;
    const [row] = await sql`
      insert into vehicle_types (code, name, mode_id, cars, seated, standing, fleet_size, capacity_is_placeholder)
      values (${code}, ${name}, ${mode.id}, ${wholeNumber(body.cars, 'Cars', 20, true)},
              ${wholeNumber(body.seated, 'Seated', 5000)}, ${wholeNumber(body.standing, 'Standing', 5000)},
              ${wholeNumber(body.fleetSize, 'Fleet size', 100000, true)}, false)
      returning id`;
    return row;
  });

  app.patch('/api/vehicle-types/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as TypeBody;
    const [current] = await sql`select * from vehicle_types where id = ${id}`;
    if (!current) throw fail(404, 'Vehicle type not found');
    const name = body.name !== undefined ? body.name.trim().slice(0, 80) : current.name;
    if (!name) throw fail(400, 'Give the vehicle type a name');
    const seated =
      body.seated !== undefined ? wholeNumber(body.seated, 'Seated', 5000) : current.seated;
    const standing =
      body.standing !== undefined ? wholeNumber(body.standing, 'Standing', 5000) : current.standing;
    // Typing in a capacity means someone has sourced it, unless they say otherwise.
    const capacityChanged = seated !== current.seated || standing !== current.standing;
    const placeholder =
      body.capacityIsPlaceholder ?? (capacityChanged ? false : current.capacity_is_placeholder);
    await sql`
      update vehicle_types set
        name = ${name},
        cars = ${body.cars !== undefined ? wholeNumber(body.cars, 'Cars', 20, true) : current.cars},
        seated = ${seated}, standing = ${standing},
        fleet_size = ${body.fleetSize !== undefined ? wholeNumber(body.fleetSize, 'Fleet size', 100000, true) : current.fleet_size},
        capacity_is_placeholder = ${placeholder}
      where id = ${id}`;
    return { ok: true };
  });

  /**
   * Sets the fleet size of every vehicle type that has none to the number of vehicles of that type
   * the published timetable of a day uses. With no fleet sizes, nothing can warn that a scenario
   * needs more vehicles than exist. The figures are the editor's own count of vehicle chains, so
   * they are a starting point to correct, not sourced fleet numbers.
   */
  app.post('/api/vehicle-types/limits-from-day', async (req) => {
    const baseline = Number((req.query as Record<string, string>).baseline);
    if (!Number.isInteger(baseline)) throw fail(400, 'baseline is required');
    const rows = await sql`
      update vehicle_types v set fleet_size = u.vehicles
      from (
        select tv.vehicle_type_id, count(distinct t.vehicle_day_id)::int as vehicles
        from trips t join trip_vehicle tv on tv.trip_id = t.id
        where t.baseline_id = ${baseline} and t.scenario_id is null
        group by 1) u
      where u.vehicle_type_id = v.id and v.fleet_size is null and u.vehicles > 0
      returning v.id`;
    return { set: rows.length };
  });

  app.delete('/api/vehicle-types/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const [used] = await sql`
      select (exists (select 1 from trips where vehicle_type_id = ${id})
           or exists (select 1 from vehicle_days where vehicle_type_id = ${id})
           or exists (select 1 from routes where vehicle_type_id = ${id})
           or exists (select 1 from mode_default_vehicle where vehicle_type_id = ${id})) as used`;
    if (used.used) throw fail(400, 'This vehicle type is in use, so it cannot be deleted');
    await sql`delete from vehicle_types where id = ${id}`;
    return { ok: true };
  });
}
