// V10: fixtures stay small and synthetic. ingest/fixtures/**: each file <= 64 KB, total <= 2 MB, no image files.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = join(process.cwd(), 'ingest', 'fixtures');
const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;
const BAD_EXT = new Set(['.jpg', '.png', '.gif', '.webp']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let total = 0;
const errors = [];
if (existsSync(ROOT)) {
  for (const f of walk(ROOT)) {
    const rel = f.slice(process.cwd().length + 1);
    const size = statSync(f).size;
    total += size;
    if (size > MAX_FILE) errors.push(`${rel}: larger than 64 KB`);
    if (BAD_EXT.has(extname(f).toLowerCase())) errors.push(`${rel}: image files are not allowed`);
  }
}
if (total > MAX_TOTAL) errors.push(`fixtures total ${total} bytes exceeds 2 MB`);
for (const e of errors) console.error(e);
if (errors.length > 0) process.exit(1);
console.log(`check-fixtures: ok (${total} bytes)`);
