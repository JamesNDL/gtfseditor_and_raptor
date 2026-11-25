// Prepares the road router's data (FR-3, architecture §3.5): gets the Australia OpenStreetMap
// extract, cuts it to the Opal area with osmium in Docker, and builds the road graph into
// <data>/router/road/opal. The plan itself is in road/road-data-plan.ts.
// Usage:
//   npm run road:data [-- --data <folder>] [--pbf <file>] [--no-cut] [--dry-run]
// A worktree passes --data "C:\Programming Projects\GTFS Editor\data".
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  EXTRACT_NAME,
  OSMIUM_IMAGE,
  commandLine,
  describePlan,
  parseRoadDataArgs,
  planRoadData,
  type CommandStep,
  type RoadDataOptions,
  type RoadDataStep,
} from '../road/road-data-plan.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const PROGRESS_BYTES = 50 * 1024 * 1024;

function usage(message: string): never {
  console.error(message);
  console.error(
    'Usage: npm run road:data [-- --data <folder>] [--pbf <file>] [--no-cut] [--dry-run]',
  );
  process.exit(1);
}

type Runnable = Pick<CommandStep, 'command' | 'args' | 'cwd' | 'shell'>;

/** Runs a command, showing its output unless quiet; resolves with its exit code (-1 if it would not start). */
function run(cmd: Runnable, quiet = false): Promise<number> {
  const stdio = quiet ? 'ignore' : 'inherit';
  return new Promise((resolve) => {
    // A .bat file only runs through cmd.exe, so it goes in as one line quoted by commandLine.
    const child = cmd.shell
      ? spawn(commandLine(cmd), { cwd: cmd.cwd, stdio, shell: true })
      : spawn(cmd.command, cmd.args, { cwd: cmd.cwd, stdio });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

async function runStep(step: CommandStep): Promise<void> {
  console.log(`\n> ${commandLine(step)}`);
  const code = await run(step);
  if (code !== 0) throw new Error(`${step.kind} failed (exit code ${code}): ${commandLine(step)}`);
}

/** Streams the extract into a .part file, renamed when complete, so a cut-off download is never used. */
async function download(url: string, part: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const handle = await open(part, 'w');
  let done = 0;
  let next = PROGRESS_BYTES;
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk);
      done += chunk.length;
      if (done >= next) {
        const of = total ? ` of ${mb(total)}` : '';
        console.log(`  ${mb(done)}${of}`);
        next += PROGRESS_BYTES;
      }
    }
    await handle.close();
  } catch (err) {
    await handle.close();
    await rm(part, { force: true });
    throw err;
  }
  await rename(part, to);
  console.log(`Saved ${to} (${mb(done)})`);
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function runPlanStep(step: RoadDataStep): Promise<void> {
  switch (step.kind) {
    case 'download':
      return download(step.url, step.part, step.to);
    case 'docker-build':
      return runStep(step);
    case 'cut':
      await mkdir(path.dirname(step.to), { recursive: true });
      return runStep(step);
    case 'build-graph':
      // Start clean: a folder left by an earlier failed build is not reused.
      await rm(step.to, { recursive: true, force: true });
      await mkdir(path.dirname(step.to), { recursive: true });
      return runStep(step);
    case 'swap':
      await rm(step.to, { recursive: true, force: true });
      await rename(step.from, step.to);
      console.log(`\nThe road graph is in ${step.to}`);
  }
}

async function main(options: RoadDataOptions): Promise<void> {
  // npm runs scripts from the repository root; INIT_CWD is where it was started from.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const data = path.resolve(cwd, options.data ?? path.join(REPO_ROOT, 'data'));
  if (options.pbf && !existsSync(path.resolve(cwd, options.pbf))) {
    usage(`No such file: ${path.resolve(cwd, options.pbf)}`);
  }
  // Only looks: `docker image inspect` changes nothing, so it runs on a dry run too.
  const imageExists =
    options.cut &&
    (await run(
      { command: 'docker', args: ['image', 'inspect', OSMIUM_IMAGE], cwd: REPO_ROOT, shell: false },
      true,
    )) === 0;
  const plan = planRoadData(options, {
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    repoRoot: REPO_ROOT,
    cwd,
    extractExists: existsSync(path.join(data, 'osm', EXTRACT_NAME)),
    imageExists,
  });
  if (options.dryRun) {
    console.log('Road data plan (dry run: nothing is run)\n');
    for (const line of describePlan(plan)) console.log(line);
    return;
  }
  for (const step of plan.steps) await runPlanStep(step);
}

let options: RoadDataOptions;
try {
  options = parseRoadDataArgs(process.argv.slice(2));
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}
main(options).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
