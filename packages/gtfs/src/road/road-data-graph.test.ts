// FR-3 (AA-5): the graph build and swap in `npm run road:data`'s plan, the Gradle quoting
// (gradlew.bat on Windows, gradlew elsewhere) and the dry-run printout.
import { describe, expect, it } from 'vitest';
import {
  commandLine,
  describePlan,
  parseRoadDataArgs,
  planRoadData,
  type CommandStep,
  type RoadDataFacts,
  type RoadDataStep,
} from './road-data-plan.ts';

const WIN_ROOT = 'C:\\Programming Projects\\GTFS Editor';
const WIN_DATA = `${WIN_ROOT}\\data`;
const noArgs = parseRoadDataArgs([]);

function win(over: Partial<RoadDataFacts> = {}): RoadDataFacts {
  return {
    platform: 'win32',
    repoRoot: WIN_ROOT,
    cwd: WIN_ROOT,
    extractExists: true,
    imageExists: true,
    ...over,
  };
}

function posix(over: Partial<RoadDataFacts> = {}): RoadDataFacts {
  return {
    ...win(),
    platform: 'posix',
    repoRoot: '/home/me/gtfs editor',
    cwd: '/home/me',
    ...over,
  };
}

function step(steps: readonly RoadDataStep[], kind: RoadDataStep['kind']): RoadDataStep {
  const found = steps.find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} step`);
  return found;
}

function commandStep(steps: readonly RoadDataStep[], kind: CommandStep['kind']): CommandStep {
  const found = step(steps, kind);
  if (!('command' in found)) throw new Error(`${kind} step has no command`);
  return found;
}

describe('planRoadData: the graph', () => {
  it('builds into opal.new with gradlew.bat on Windows, from services/router', () => {
    const graph = step(planRoadData(noArgs, win()).steps, 'build-graph');
    expect(graph).toMatchObject({
      command: 'gradlew.bat',
      cwd: `${WIN_ROOT}\\services\\router`,
      shell: true,
      from: `${WIN_DATA}\\osm\\opal.osm.pbf`,
      to: `${WIN_DATA}\\router\\road\\opal.new`,
    });
    // The roadImport task splits roadArgs on spaces and runs from the repository root, so the
    // paths go in relative to it, with forward slashes.
    expect(graph.kind === 'build-graph' && graph.args).toEqual([
      ':router-road:roadImport',
      '-ProadArgs=data/osm/opal.osm.pbf data/router/road/opal.new',
    ]);
  });

  it('uses ./gradlew elsewhere, with no shell', () => {
    const graph = step(planRoadData(noArgs, posix()).steps, 'build-graph');
    expect(graph).toMatchObject({
      command: './gradlew',
      cwd: '/home/me/gtfs editor/services/router',
      shell: false,
    });
    expect(graph.kind === 'build-graph' && graph.args[1]).toBe(
      '-ProadArgs=data/osm/opal.osm.pbf data/router/road/opal.new',
    );
  });

  it('reaches a data folder outside the repository (a worktree) by a relative path', () => {
    const worktree = `${WIN_ROOT}\\.claude\\worktrees\\agent-1`;
    const args = parseRoadDataArgs(['--data', WIN_DATA]);
    const graph = step(planRoadData(args, win({ repoRoot: worktree })).steps, 'build-graph');
    expect(graph.kind === 'build-graph' && graph.args[1]).toBe(
      '-ProadArgs=../../../data/osm/opal.osm.pbf ../../../data/router/road/opal.new',
    );
  });

  it('refuses a data folder whose path from the repository has a space in it', () => {
    const args = parseRoadDataArgs(['--data', `${WIN_ROOT}\\road data`]);
    expect(() => planRoadData(args, win())).toThrow(/space/);
  });

  it('swaps opal.new in for opal last, so a failed build leaves the old graph', () => {
    const steps = planRoadData(noArgs, win()).steps;
    expect(steps.at(-1)).toEqual({
      kind: 'swap',
      from: `${WIN_DATA}\\router\\road\\opal.new`,
      to: `${WIN_DATA}\\router\\road\\opal`,
    });
  });
});

describe('commandLine', () => {
  it('quotes the Gradle property as one argument for cmd.exe', () => {
    const graph = commandStep(planRoadData(noArgs, win()).steps, 'build-graph');
    expect(commandLine(graph)).toBe(
      'gradlew.bat :router-road:roadImport "-ProadArgs=data/osm/opal.osm.pbf data/router/road/opal.new"',
    );
  });

  it('quotes paths with spaces in the docker command', () => {
    const cut = commandStep(planRoadData(noArgs, win()).steps, 'cut');
    expect(commandLine(cut)).toBe(
      `docker run --rm -v "${WIN_DATA}\\osm:/osm" gtfs-editor-osmium osmium extract ` +
        '-b 150.10,-34.75,151.85,-32.70 /osm/australia-latest.osm.pbf -o /osm/opal.osm.pbf --overwrite',
    );
  });
});

describe('describePlan', () => {
  it('prints the three steps with their exact commands', () => {
    const plan = planRoadData(noArgs, win({ extractExists: false, imageExists: false }));
    const text = describePlan(plan).join('\n');
    expect(text).toMatch(/1\. Get the extract/);
    expect(text).toMatch(/2\. Cut it to the Opal area/);
    expect(text).toMatch(/3\. Build the road graph/);
    expect(text).toContain(
      'https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf',
    );
    for (const s of plan.steps) {
      if (s.kind === 'docker-build' || s.kind === 'cut' || s.kind === 'build-graph') {
        expect(text).toContain(commandLine(s));
      }
    }
    expect(text).toContain(`${WIN_DATA}\\router\\road\\opal.new`);
  });

  it('says the cut is skipped with --no-cut, and which extract is used', () => {
    const args = parseRoadDataArgs(['--pbf', 'D:\\maps\\opal.osm.pbf', '--no-cut']);
    const text = describePlan(planRoadData(args, win())).join('\n');
    expect(text).toMatch(/2\. Cut it to the Opal area.*\n.*skipped \(--no-cut\)/);
    expect(text).toContain('D:\\maps\\opal.osm.pbf');
  });
});
