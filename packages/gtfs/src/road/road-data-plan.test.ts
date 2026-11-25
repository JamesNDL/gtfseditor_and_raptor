// FR-3 (AA-5): the pure plan behind `npm run road:data`: reading its arguments, choosing the
// extract, the Opal area box, the exact commands and the swap of the new graph into place.
import { describe, expect, it } from 'vitest';
import {
  GEOFABRIK_URL,
  OPAL_BOX,
  parseRoadDataArgs,
  planRoadData,
  type RoadDataFacts,
  type RoadDataStep,
} from './road-data-plan.ts';

const ROOT = 'C:\\Programming Projects\\GTFS Editor';
const DATA = `${ROOT}\\data`;

function facts(over: Partial<RoadDataFacts> = {}): RoadDataFacts {
  return {
    platform: 'win32',
    repoRoot: ROOT,
    cwd: ROOT,
    extractExists: true,
    imageExists: true,
    ...over,
  };
}

const noArgs = parseRoadDataArgs([]);

function step(steps: readonly RoadDataStep[], kind: RoadDataStep['kind']): RoadDataStep {
  const found = steps.find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} step`);
  return found;
}

describe('parseRoadDataArgs', () => {
  it('has the defaults: no data folder, no pbf, cut, run for real', () => {
    expect(noArgs).toEqual({ data: null, pbf: null, cut: true, dryRun: false });
  });

  it('reads every option', () => {
    expect(
      parseRoadDataArgs(['--data', 'D:\\x', '--pbf', 'a.osm.pbf', '--no-cut', '--dry-run']),
    ).toEqual({ data: 'D:\\x', pbf: 'a.osm.pbf', cut: false, dryRun: true });
  });

  it('refuses an unknown option and an option missing its value', () => {
    expect(() => parseRoadDataArgs(['--cut'])).toThrow(/--cut/);
    expect(() => parseRoadDataArgs(['--data'])).toThrow(/--data/);
    expect(() => parseRoadDataArgs(['--pbf', '--dry-run'])).toThrow(/--pbf/);
  });
});

describe('planRoadData: the extract', () => {
  it('uses the extract already in <data>/osm when there is one', () => {
    const plan = planRoadData(noArgs, facts());
    expect(plan.data).toBe(DATA);
    expect(plan.extract).toBe(`${DATA}\\osm\\australia-latest.osm.pbf`);
    expect(plan.extractSource).toBe('found');
    expect(plan.steps.some((s) => s.kind === 'download')).toBe(false);
  });

  it('downloads from Geofabrik into a .part file when there is none', () => {
    const plan = planRoadData(noArgs, facts({ extractExists: false }));
    expect(plan.extractSource).toBe('download');
    expect(plan.steps[0]).toEqual({
      kind: 'download',
      url: GEOFABRIK_URL,
      to: `${DATA}\\osm\\australia-latest.osm.pbf`,
      part: `${DATA}\\osm\\australia-latest.osm.pbf.part`,
    });
    expect(GEOFABRIK_URL).toBe(
      'https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf',
    );
  });

  it('uses --pbf when given, whatever is in <data>/osm, resolved from where npm was run', () => {
    const args = parseRoadDataArgs(['--pbf', 'maps\\nsw.osm.pbf']);
    const plan = planRoadData(args, facts({ extractExists: false, cwd: 'D:\\work' }));
    expect(plan.extract).toBe('D:\\work\\maps\\nsw.osm.pbf');
    expect(plan.extractSource).toBe('given');
    expect(plan.steps.some((s) => s.kind === 'download')).toBe(false);
  });

  it('takes --data relative to where npm was run', () => {
    const args = parseRoadDataArgs(['--data', '..\\other data']);
    expect(planRoadData(args, facts({ cwd: 'D:\\work\\here' })).data).toBe('D:\\work\\other data');
  });
});

describe('planRoadData: the cut', () => {
  it('uses the Opal area box from sim_areas', () => {
    expect(OPAL_BOX).toBe('150.10,-34.75,151.85,-32.70');
  });

  it('cuts with osmium in Docker, mounting <data>/osm', () => {
    const cut = step(planRoadData(noArgs, facts()).steps, 'cut');
    expect(cut).toMatchObject({
      command: 'docker',
      from: `${DATA}\\osm\\australia-latest.osm.pbf`,
    });
    expect(cut).toMatchObject({ to: `${DATA}\\osm\\opal.osm.pbf` });
    expect(cut.kind === 'cut' && cut.args).toEqual([
      'run',
      '--rm',
      '-v',
      `${DATA}\\osm:/osm`,
      'gtfs-editor-osmium',
      'osmium',
      'extract',
      '-b',
      '150.10,-34.75,151.85,-32.70',
      '/osm/australia-latest.osm.pbf',
      '-o',
      '/osm/opal.osm.pbf',
      '--overwrite',
    ]);
  });

  it('mounts the folder of a --pbf file that is outside <data>/osm', () => {
    const args = parseRoadDataArgs(['--pbf', 'D:\\maps\\nsw.osm.pbf']);
    const cut = step(planRoadData(args, facts()).steps, 'cut');
    expect(cut.kind === 'cut' && cut.args.slice(0, 7)).toEqual([
      'run',
      '--rm',
      '-v',
      `${DATA}\\osm:/osm`,
      '-v',
      'D:\\maps:/in',
      'gtfs-editor-osmium',
    ]);
    expect(cut.kind === 'cut' && cut.args).toContain('/in/nsw.osm.pbf');
  });

  it('builds the osmium image first only when it is missing', () => {
    expect(planRoadData(noArgs, facts()).steps.map((s) => s.kind)).toEqual([
      'cut',
      'build-graph',
      'swap',
    ]);
    const steps = planRoadData(noArgs, facts({ imageExists: false })).steps;
    expect(steps.map((s) => s.kind)).toEqual(['docker-build', 'cut', 'build-graph', 'swap']);
    const build = step(steps, 'docker-build');
    expect(build.kind === 'docker-build' && build.args).toEqual([
      'build',
      '-t',
      'gtfs-editor-osmium',
      `${ROOT}\\services\\router\\tools\\osmium`,
    ]);
  });

  it('skips the cut with --no-cut, building the graph from the extract itself', () => {
    const args = parseRoadDataArgs(['--pbf', 'D:\\maps\\opal.osm.pbf', '--no-cut']);
    const plan = planRoadData(args, facts({ imageExists: false }));
    expect(plan.steps.map((s) => s.kind)).toEqual(['build-graph', 'swap']);
    expect(step(plan.steps, 'build-graph')).toMatchObject({ from: 'D:\\maps\\opal.osm.pbf' });
  });

  it('refuses to cut the cut file onto itself', () => {
    const args = parseRoadDataArgs(['--pbf', `${DATA}\\osm\\opal.osm.pbf`]);
    expect(() => planRoadData(args, facts())).toThrow(/--no-cut/);
  });
});
