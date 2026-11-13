import { ensureFeed } from './feed-cache.ts';

const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}
const feed = await ensureFeed({ apiKey, log: console.log });
console.log(feed.dir);
