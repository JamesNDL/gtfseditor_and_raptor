// Downloads the TfNSW complete GTFS bundle once and reuses it until TfNSW publishes a new one.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzip } from './unzip.ts';

const FEED_URL = 'https://api.transport.nsw.gov.au/v1/publictransport/timetables/complete/gtfs';

export interface FeedVersion {
  /** Folder-safe id built from the feed's publish time, e.g. nsw-complete-20261112-1750 */
  id: string;
  etag: string;
  lastModified: string;
  downloadedAt: string;
  bytes: number;
  zipPath: string;
  /** Folder holding the extracted .txt files */
  dir: string;
}

interface Manifest {
  versions: FeedVersion[];
}

export interface EnsureFeedOptions {
  apiKey: string;
  /** Defaults to <cwd>/data/feeds */
  feedsDir?: string;
  log?: (message: string) => void;
}

function versionId(lastModified: string): string {
  const d = new Date(lastModified);
  const p = (n: number) => String(n).padStart(2, '0');
  return `nsw-complete-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function readManifest(file: string): Promise<Manifest> {
  if (!(await exists(file))) return { versions: [] };
  return JSON.parse(await readFile(file, 'utf8')) as Manifest;
}

/** Returns the current feed, downloading and extracting it only if it is not already cached. */
export async function ensureFeed(options: EnsureFeedOptions): Promise<FeedVersion> {
  const log = options.log ?? (() => {});
  const feedsDir = path.resolve(options.feedsDir ?? 'data/feeds');
  const manifestPath = path.join(feedsDir, 'manifest.json');
  await mkdir(feedsDir, { recursive: true });
  const manifest = await readManifest(manifestPath);
  const latestCached = manifest.versions.at(-1);
  const headers = { Authorization: `apikey ${options.apiKey}` };

  let etag: string;
  let lastModified: string;
  try {
    const head = await fetch(FEED_URL, { method: 'HEAD', headers });
    if (!head.ok) throw new Error(`TfNSW responded ${head.status}`);
    etag = head.headers.get('etag') ?? '';
    lastModified = head.headers.get('last-modified') ?? '';
    if (!etag || !lastModified) throw new Error('TfNSW response had no etag/last-modified');
  } catch (err) {
    // Offline or TfNSW down: fall back to whatever we already have.
    if (latestCached && (await exists(latestCached.dir))) {
      log(
        `Could not check TfNSW for a newer feed (${(err as Error).message}); using cached ${latestCached.id}`,
      );
      return latestCached;
    }
    throw err;
  }

  const cached = manifest.versions.find((v) => v.etag === etag);
  if (cached && (await exists(cached.zipPath)) && (await exists(cached.dir))) {
    log(`Feed unchanged since ${cached.lastModified}; using cached ${cached.id}`);
    return cached;
  }

  const id = versionId(lastModified);
  const zipPath = path.join(feedsDir, `${id}.zip`);
  const dir = path.join(feedsDir, id);
  const partPath = `${zipPath}.part`;

  // Downloads go to a .part file and are renamed when complete, so an existing zip is always whole.
  if (await exists(zipPath)) {
    log(`Found downloaded ${id}.zip; skipping download`);
  } else {
    log(`Downloading feed published ${lastModified} ...`);
    const res = await fetch(FEED_URL, { headers });
    if (!res.ok || !res.body)
      throw new Error(`Feed download failed: TfNSW responded ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(partPath));
    await rename(partPath, zipPath);
  }
  const bytes = (await stat(zipPath)).size;
  log(`Extracting ${(bytes / 1e6).toFixed(0)} MB zip ...`);

  await rm(dir, { recursive: true, force: true });
  await unzip(zipPath, dir);

  const version: FeedVersion = {
    id,
    etag,
    lastModified,
    downloadedAt: new Date().toISOString(),
    bytes,
    zipPath,
    dir,
  };
  manifest.versions = [...manifest.versions.filter((v) => v.id !== id), version];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  log(`Feed ready: ${id}`);
  return version;
}
