// PostToolUse hook: run Prettier on the file Claude just wrote or edited.
// Skips files Prettier can't parse or that .prettierignore excludes.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prettier from 'prettier';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { tool_input: ti = {}, tool_response: tr = {} } = JSON.parse(input || '{}');
const file = tr.filePath ?? ti.file_path;
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const info = await prettier.getFileInfo(file, {
  ignorePath: path.join(root, '.prettierignore'),
  resolveConfig: true,
});
if (info.ignored || !info.inferredParser) process.exit(0);

const source = await readFile(file, 'utf8');
const options = (await prettier.resolveConfig(file)) ?? {};
const formatted = await prettier.format(source, { ...options, filepath: file });
if (formatted !== source) await writeFile(file, formatted);
