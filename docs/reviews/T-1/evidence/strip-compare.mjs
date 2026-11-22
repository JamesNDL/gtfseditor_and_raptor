// Strips the TypeScript types from the before and after copy of each file, the same way Node
// does when it runs the API, and prints every line of JavaScript that differs.
// Usage: node strip-compare.mjs <beforeDir> <afterDir> <file>...
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const [beforeDir, afterDir, ...files] = process.argv.slice(2);
const js = (dir, file) =>
  stripTypeScriptTypes(readFileSync(join(dir, file), "utf8"))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");

for (const file of files) {
  const a = js(beforeDir, file).split("\n");
  const b = js(afterDir, file).split("\n");
  const onlyBefore = a.filter((l) => !b.includes(l));
  const onlyAfter = b.filter((l) => !a.includes(l));
  console.log(
    `== ${file}: ${onlyBefore.length} JS lines only before, ${onlyAfter.length} only after`,
  );
  for (const l of onlyBefore) console.log(`  - ${l}`);
  for (const l of onlyAfter) console.log(`  + ${l}`);
}
