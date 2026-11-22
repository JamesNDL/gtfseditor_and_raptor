// Runs export-check's q() helper before and after T-1 against an in-memory DuckDB and shows the
// callers get the same rows. Also checks a tag and its template on separate lines (what type
// stripping leaves of sql<...>`...` split over lines) is still a tagged template.
// Run from the repo root so @duckdb/node-api resolves:
//   node <evidence>/duckdb-q.mjs
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/packages/gtfs/package.json");
const { DuckDBInstance } = await import((await import("node:url")).pathToFileURL(require.resolve("@duckdb/node-api")).href);

const db = await (await DuckDBInstance.create(":memory:")).connect();
const qBefore = async (sql) => (await db.run(sql)).getRowObjectsJson();
const qAfter = async (sql) => await (await db.run(sql)).getRowObjectsJson();
const query = `select * from (values (1, 'a'), (2, null)) t(n, s) order by n`;
const before = await qBefore(query);
const after = await qAfter(query);
console.log(
  "before:",
  JSON.stringify(before),
  "isArray",
  Array.isArray(before),
);
console.log("after: ", JSON.stringify(after), "isArray", Array.isArray(after));
console.log("same rows:", JSON.stringify(before) === JSON.stringify(after));

const tag = (strings, ...values) => ({
  tagged: true,
  strings: [...strings],
  values,
});
// prettier-ignore
const split = tag
`x = ${42}`;
console.log("tag on its own line still tags:", JSON.stringify(split));
