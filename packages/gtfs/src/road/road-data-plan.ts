// The pure plan behind `npm run road:data` (FR-3, architecture §3.5, D18): reads the arguments,
// chooses the extract, and lists the steps to get it, cut it to the Opal area and build the road
// graph. It runs nothing and reads no files; cli/road-data.ts gathers the facts and runs the plan.
import path from 'node:path';

/** The path functions of one platform (path.win32 or path.posix). */
type PlatformPath = typeof path.posix;

export const GEOFABRIK_URL =
  'https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf';
/** The "Opal area" row of sim_areas (0001_initial.sql) as west,south,east,north for osmium. */
export const OPAL_BOX = '150.10,-34.75,151.85,-32.70';
export const OSMIUM_IMAGE = 'gtfs-editor-osmium';
export const EXTRACT_NAME = 'australia-latest.osm.pbf';
const CUT_NAME = 'opal.osm.pbf';

export interface RoadDataOptions {
  /** The data folder; null means the repository's own data/. */
  readonly data: string | null;
  /** An extract to use instead of the one in <data>/osm. */
  readonly pbf: string | null;
  /** False with --no-cut: the extract is already cut to the area. */
  readonly cut: boolean;
  readonly dryRun: boolean;
}

/** What the CLI found out before planning. */
export interface RoadDataFacts {
  readonly platform: 'win32' | 'posix';
  readonly repoRoot: string;
  /** Where npm was run from: relative --data and --pbf paths start here. */
  readonly cwd: string;
  /** Whether <data>/osm/australia-latest.osm.pbf is there. */
  readonly extractExists: boolean;
  /** Whether Docker already has the gtfs-editor-osmium image. */
  readonly imageExists: boolean;
}

export interface CommandStep {
  readonly kind: 'docker-build' | 'cut' | 'build-graph';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** True when the command is a .bat file, which only runs through cmd.exe. */
  readonly shell: boolean;
  readonly from: string;
  readonly to: string;
}

export type RoadDataStep =
  | { readonly kind: 'download'; readonly url: string; readonly to: string; readonly part: string }
  | CommandStep
  | { readonly kind: 'swap'; readonly from: string; readonly to: string };

export interface RoadDataPlan {
  readonly data: string;
  readonly extract: string;
  readonly extractSource: 'given' | 'found' | 'download';
  readonly cut: boolean;
  readonly steps: readonly RoadDataStep[];
}

const VALUE_OPTIONS = new Set(['--data', '--pbf']);

/** Reads the command's arguments. Throws on an unknown option or a missing value. */
export function parseRoadDataArgs(argv: readonly string[]): RoadDataOptions {
  let data: string | null = null;
  let pbf: string | null = null;
  let cut = true;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--data') data = value;
      else pbf = value;
      i++;
    } else if (arg === '--no-cut') cut = false;
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return { data, pbf, cut, dryRun };
}

/** Plans the run. Throws when the options cannot work (see the messages). */
export function planRoadData(options: RoadDataOptions, facts: RoadDataFacts): RoadDataPlan {
  const p = facts.platform === 'win32' ? path.win32 : path.posix;
  const data = p.resolve(facts.cwd, options.data ?? p.join(facts.repoRoot, 'data'));
  const osmDir = p.join(data, 'osm');
  const cutFile = p.join(osmDir, CUT_NAME);
  const roadDir = p.join(data, 'router', 'road');
  const graph = p.join(roadDir, 'opal');
  const graphNew = p.join(roadDir, 'opal.new');

  const extract = options.pbf ? p.resolve(facts.cwd, options.pbf) : p.join(osmDir, EXTRACT_NAME);
  const extractSource = options.pbf ? 'given' : facts.extractExists ? 'found' : 'download';
  const steps: RoadDataStep[] = [];
  if (extractSource === 'download') {
    steps.push({ kind: 'download', url: GEOFABRIK_URL, to: extract, part: `${extract}.part` });
  }

  if (options.cut) {
    if (samePath(p, extract, cutFile, facts.platform)) {
      throw new Error(`${extract} is where the cut goes. If it is already cut, add --no-cut.`);
    }
    if (!facts.imageExists) {
      const dockerfileDir = p.join(facts.repoRoot, 'services', 'router', 'tools', 'osmium');
      const buildArgs = ['build', '-t', OSMIUM_IMAGE, dockerfileDir];
      steps.push(docker('docker-build', buildArgs, dockerfileDir, OSMIUM_IMAGE));
    }
    // osmium sees <data>/osm as /osm; an extract elsewhere gets its own folder mounted as /in.
    const inOsmDir = samePath(p, p.dirname(extract), osmDir, facts.platform);
    const mounts = ['-v', `${osmDir}:/osm`];
    if (!inOsmDir) mounts.push('-v', `${p.dirname(extract)}:/in`);
    const input = `${inOsmDir ? '/osm' : '/in'}/${p.basename(extract)}`;
    const extractArgs = ['extract', '-b', OPAL_BOX, input, '-o', `/osm/${CUT_NAME}`, '--overwrite'];
    const cutArgs = ['run', '--rm', ...mounts, OSMIUM_IMAGE, 'osmium', ...extractArgs];
    steps.push(docker('cut', cutArgs, extract, cutFile));
  }

  const graphFrom = options.cut ? cutFile : extract;
  const roadArgs = [graphFrom, graphNew].map((f) => fromRepoRoot(p, facts.repoRoot, f)).join(' ');
  steps.push({
    kind: 'build-graph',
    // .\ as cmd.exe may be set not to look in the current folder for commands.
    command: facts.platform === 'win32' ? '.\\gradlew.bat' : './gradlew',
    args: [':router-road:roadImport', `-ProadArgs=${roadArgs}`],
    cwd: p.join(facts.repoRoot, 'services', 'router'),
    shell: facts.platform === 'win32',
    from: graphFrom,
    to: graphNew,
  });
  steps.push({ kind: 'swap', from: graphNew, to: graph });
  return { data, extract, extractSource, cut: options.cut, steps };

  function docker(
    kind: 'docker-build' | 'cut',
    args: string[],
    from: string,
    to: string,
  ): CommandStep {
    return { kind, command: 'docker', args, cwd: facts.repoRoot, shell: false, from, to };
  }
}

function samePath(p: PlatformPath, a: string, b: string, platform: string): boolean {
  const norm = (f: string): string => {
    const resolved = p.resolve(f);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * The roadImport task runs from the repository root and splits roadArgs on spaces, so each path
 * goes in relative to the root with forward slashes, and must not contain a space.
 */
function fromRepoRoot(p: PlatformPath, repoRoot: string, file: string): string {
  const relative = p.relative(repoRoot, file).split(p.sep).join('/');
  if (relative.includes(' ')) {
    throw new Error(
      `The road graph build cannot take a path with a space in it: ${relative} ` +
        '(from the repository root). Choose a data folder without one.',
    );
  }
  return relative;
}

/** A step's command as one line, quoted for a shell (and for cmd.exe when step.shell is set). */
export function commandLine(step: Pick<CommandStep, 'command' | 'args'>): string {
  return [step.command, ...step.args].map(quote).join(' ');
}

function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** The plan as printed by --dry-run: the three steps with their exact commands. */
export function describePlan(plan: RoadDataPlan): string[] {
  const lines = [`Data folder: ${plan.data}`, '', '1. Get the extract'];
  const download = plan.steps.find((s) => s.kind === 'download');
  if (download) {
    lines.push(`   Download ${download.url}`, `   to ${download.part}, then rename it to`);
    lines.push(`   ${download.to} (progress every 50 MB)`);
  } else {
    const why = plan.extractSource === 'given' ? 'given with --pbf' : 'already there';
    lines.push(`   Use ${plan.extract} (${why})`);
  }
  lines.push('', `2. Cut it to the Opal area (${OPAL_BOX})`);
  if (!plan.cut) lines.push('   skipped (--no-cut)');
  for (const step of plan.steps) {
    if (step.kind === 'docker-build') lines.push('   The osmium image is missing, so first:');
    if (step.kind === 'docker-build' || step.kind === 'cut') lines.push(`   ${commandLine(step)}`);
  }
  lines.push('', '3. Build the road graph');
  for (const step of plan.steps) {
    if (step.kind === 'build-graph') lines.push(`   In ${step.cwd}:`, `   ${commandLine(step)}`);
    if (step.kind === 'swap') {
      lines.push(`   Then replace ${step.to}`, `   with ${step.from} (only if the build worked)`);
    }
  }
  return lines;
}
