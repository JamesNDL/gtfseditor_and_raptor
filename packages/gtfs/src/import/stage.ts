// Loads the raw GTFS text files into all-text tables in the `staging` schema, once per feed version.
import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FeedVersion } from '../feed-cache.ts';
import type { Sql } from '../db.ts';

const REQUIRED = [
  'agency',
  'calendar',
  'calendar_dates',
  'routes',
  'stops',
  'trips',
  'stop_times',
  'shapes',
];

async function readHeader(file: string): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
    const firstLine = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^﻿/, '')
      .split(/\r?\n/)[0];
    const columns = firstLine.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    for (const c of columns) {
      if (!/^[a-z_][a-z0-9_]*$/.test(c))
        throw new Error(`Unexpected column name "${c}" in ${path.basename(file)}`);
    }
    return columns;
  } finally {
    await handle.close();
  }
}

export async function stageFeed(
  sql: Sql,
  feed: FeedVersion,
  log: (m: string) => void,
): Promise<void> {
  const [current] = await sql`select feed_id from staged_feed`;
  if (current?.feed_id === feed.id) {
    log(`Raw feed ${feed.id} is already staged`);
    return;
  }

  const files = (await readdir(feed.dir)).filter((f) => f.endsWith('.txt'));
  const tables = files.map((f) => f.replace('.txt', ''));
  for (const required of REQUIRED) {
    if (!tables.includes(required)) throw new Error(`Feed is missing ${required}.txt`);
  }

  await sql`delete from staged_feed`;
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`Unexpected file name ${table}.txt`);
    const file = path.join(feed.dir, `${table}.txt`);
    const columns = await readHeader(file);
    const started = Date.now();
    await sql.unsafe(`drop table if exists staging.${table}`);
    await sql.unsafe(
      `create unlogged table staging.${table} (${columns.map((c) => `${c} text`).join(', ')})`,
    );
    const writable = await sql
      .unsafe(
        `copy staging.${table} (${columns.join(', ')}) from stdin with (format csv, header true)`,
      )
      .writable();
    await pipeline(createReadStream(file), writable);
    const [{ n }] = await sql.unsafe(`select count(*)::int n from staging.${table}`);
    log(
      `Staged ${table}: ${n.toLocaleString()} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }
  await sql.unsafe(
    `analyze staging.trips; analyze staging.stop_times; analyze staging.shapes; analyze staging.stops`,
  );
  await sql`insert into staged_feed (feed_id) values (${feed.id})`;
}
