import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

/** Extracts every file in a zip into `dir` (flat GTFS bundles; nested paths are kept but must stay inside `dir`). */
export function unzip(zipPath: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const target = path.resolve(dir, entry.fileName);
        if (!target.startsWith(path.resolve(dir) + path.sep)) {
          return reject(new Error(`Zip entry escapes target folder: ${entry.fileName}`));
        }
        if (entry.fileName.endsWith('/')) {
          mkdir(target, { recursive: true }).then(() => zip.readEntry(), reject);
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr);
          mkdir(path.dirname(target), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(target)))
            .then(() => zip.readEntry(), reject);
        });
      });
      zip.readEntry();
    });
  });
}
