// Line-based checks of .github/workflows/*.yml (spec S0.2; no YAML dependency).
// Usage: node scripts/check-workflows.mjs [rootDir]   (default: cwd). Exit 1 on any violation.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const dir = join(root, '.github', 'workflows');
const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

const stripComment = (l) => l.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');

/** Trigger names under the top-level `on:` key. */
function triggers(lines) {
  const i = lines.findIndex((l) => /^on:/.test(l));
  if (i < 0) return [];
  const inline = lines[i].replace(/^on:\s*/, '').trim();
  if (inline) return inline.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (let k = i + 1; k < lines.length; k++) {
    if (/^\S/.test(lines[k])) break;
    const m = /^ {2}([A-Za-z_]+):/.exec(lines[k]);
    if (m) out.push(m[1]);
  }
  return out;
}

const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  const lines = text.split('\n').map(stripComment);
  const code = lines.join('\n');

  if (/pull_request_target/.test(code)) err(f, 'pull_request_target is not allowed');

  for (const l of lines) {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(l);
    if (m && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1])) err(f, `uses: must be pinned to a 40-hex SHA (${m[1]})`);
  }

  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(code)) err(f, 'top-level permissions: contents: read is required');

  const trig = triggers(lines);
  if (f === 'ingest.yml' || f === 'sign-feed.yml') {
    for (const t of trig) if (t !== 'schedule' && t !== 'workflow_dispatch') err(f, `trigger ${t} is not allowed`);
  }
  if (f === 'sign-feed.yml') {
    if (!/environment:\s*feed-signing\s*$/m.test(code)) err(f, 'must contain environment: feed-signing');
    if (/\b(npm|npx|pnpm|yarn)\b/.test(code)) err(f, 'must not run npm/npx/pnpm/yarn');
    if (!/^\s*if:\s*["']?github\.ref == 'refs\/heads\/main'["']?\s*$/m.test(code)) err(f, "job needs if: github.ref == 'refs/heads/main'");
  }
  if (f === 'sign-gate-probe.yml') {
    for (const t of trig) if (t !== 'workflow_dispatch') err(f, `trigger ${t} is not allowed`);
    if (!/environment:\s*feed-signing\s*$/m.test(code)) err(f, 'must contain environment: feed-signing');
    if (lines.some((l) => /^\s*(?:-\s*)?uses:/.test(l))) err(f, 'must not contain uses:');
    const runs = lines.filter((l) => /^\s*(?:-\s*)?run:/.test(l)).length;
    if (runs !== 1) err(f, `must have exactly one run: step (found ${runs})`);
    for (const m of code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      if (m[1] !== 'FEED_SIGNING_KEY') err(f, `only secrets.FEED_SIGNING_KEY may be referenced (found ${m[1]})`);
    }
  }
  if (f !== 'sign-feed.yml' && f !== 'sign-gate-probe.yml' && /environment:\s*feed-signing/.test(code)) {
    err(f, 'environment: feed-signing is reserved for sign-feed.yml and sign-gate-probe.yml');
  }
}

for (const e of errors) console.error(e);
if (errors.length > 0) process.exit(1);
console.log(`check-workflows: ok (${files.length} files)`);
