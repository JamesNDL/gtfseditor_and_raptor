// FR-9 (AC-FR-9.1, AC-FR-9.2): the check export-check.ts runs on an export's vehicle files, tried
// on a good export and on bad ones. Each export is written as the folder export-check unzips to.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { vehicleFileProblems } from './export-vehicles.ts';

type ExportFiles = Record<string, string[]>;

const good: ExportFiles = {
  'trips.txt': [
    'route_id,service_id,trip_id',
    'R1,DAY,T1',
    'R1,DAY,T2',
    'R1,DAY,T1~4.2.1',
    'R1,DAY,NEW1',
  ],
  'editor_vehicle_types.txt': [
    'vehicle_type_id,name,mode,cars,seated,standing,fleet_size,capacity_is_placeholder',
    '1,Train,train,8,800,400,,1',
    '2,Bus,bus,1,40,25,,0',
  ],
  'editor_trip_vehicles.txt': [
    'trip_id,vehicle_id,vehicle_label,vehicle_source,vehicle_type_id,vehicle_type_assumed,origin_trip_id',
    'T1,5,train 1,feed,1,0,T1',
    // A changed trip names the published trip it came from; a brand-new one names none.
    'T1~4.2.1,6,train 2,feed,1,0,T1',
    'NEW1,,,,2,1,',
  ],
};

const folders: string[] = [];

/** Writes an export's files to a folder of their own, with `change` applied on top of `good`. */
async function exportFolder(change: Partial<Record<string, string[] | null>>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vehicle-files-'));
  folders.push(dir);
  for (const [name, lines] of Object.entries({ ...good, ...change })) {
    if (lines) await writeFile(path.join(dir, name), `${lines.join('\n')}\n`);
  }
  return dir;
}

afterEach(async () => {
  for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('vehicleFileProblems', () => {
  it('finds nothing wrong with a correct export', async () => {
    expect(await vehicleFileProblems(await exportFolder({}))).toEqual([]);
  });

  it('names a trip that is not in trips.txt', async () => {
    const dir = await exportFolder({
      'editor_trip_vehicles.txt': [
        ...good['editor_trip_vehicles.txt'],
        'GONE,7,bus 9,feed,2,0,GONE',
      ],
    });
    const problems = await vehicleFileProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/editor_trip_vehicles\.txt names 1 trip not in trips\.txt.*GONE/);
  });

  it('names a vehicle type that is not in editor_vehicle_types.txt', async () => {
    const dir = await exportFolder({
      'editor_trip_vehicles.txt': [...good['editor_trip_vehicles.txt'], 'T2,7,bus 9,feed,99,0,T2'],
    });
    const problems = await vehicleFileProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/1 vehicle type not in editor_vehicle_types\.txt.*99/);
  });

  it('says when a vehicle file is missing', async () => {
    const problems = await vehicleFileProblems(
      await exportFolder({ 'editor_trip_vehicles.txt': null }),
    );
    expect(problems).toEqual(['editor_trip_vehicles.txt is missing']);
  });

  it('needs the origin_trip_id column (AC-FR-9.2)', async () => {
    const dir = await exportFolder({
      'editor_trip_vehicles.txt': [
        'trip_id,vehicle_id,vehicle_label,vehicle_source,vehicle_type_id,vehicle_type_assumed',
        'T1,5,train 1,feed,1,0',
      ],
    });
    expect(await vehicleFileProblems(dir)).toEqual([
      'editor_trip_vehicles.txt has no origin_trip_id column',
    ]);
  });

  it('names a trip whose origin is not the published trip it was made from (AC-FR-9.2)', async () => {
    const dir = await exportFolder({
      'editor_trip_vehicles.txt': [...good['editor_trip_vehicles.txt'], 'T2,7,bus 9,feed,2,0,T1'],
    });
    const problems = await vehicleFileProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /1 trip whose origin_trip_id is not the published trip it was made from.*T2/,
    );
  });
});
