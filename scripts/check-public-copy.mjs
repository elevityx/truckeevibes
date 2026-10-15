// Bans cost/price wording in public copy under src/app/** (spec A4-4).
// Usage: node scripts/check-public-copy.mjs   (run from the repo root). Prints "file:line rule-id"; exit 1 on a hit.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const EXT = new Set(['.ts', '.tsx', '.md', '.mdx']);
const RULES = [
  { id: 'dollar-amount', re: /\$\s?\d/i },
  { id: 'cost', re: /\bcost(s|ing|ly)?\b/i },
  { id: 'price', re: /\bpric(e|es|ed|ing)\b/i },
  { id: 'per-mo', re: /\/mo\b/i },
  { id: 'per-month', re: /\bper month\b/i },
  { id: 'budget', re: /\bbudget(s)?\b/i },
];

try {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'src/app/**'], { maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter((f) => f && EXT.has(extname(f)));
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const r of RULES) if (r.re.test(line)) hits.push(`${f}:${i + 1} ${r.id}`);
    });
  }
  for (const h of hits) console.error(h);
  if (hits.length > 0) {
    console.error(`check-public-copy: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log(`check-public-copy: ok (${files.length} files)`);
} catch (e) {
  console.error(`check-public-copy: error ${e?.code ?? e?.message ?? 'unknown'}`);
  process.exit(2);
}
