// Tracked-file secret scanner (spec S0.2). Scans `git ls-files` of the cwd and prints "<file>:<line> <rule-id>" per hit,
// never the match. It scans its own source and test too, so any rule whose pattern text could match itself is built
// from fragments. Importing this module does not run the CLI.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The only tracked file the scanner skips (besides binary files). */
export const EXCLUDED_FILES = ['package-lock.json'];

const j = (...parts) => parts.join('');

export const RULES = [
  { id: 'sb-secret', re: new RegExp(['sb', 'secret', ''].join('_')) },
  { id: 'sb-publishable', re: /sb_publishable_[A-Za-z0-9]{10}/ },
  { id: 'jwt', re: new RegExp(j('ey', 'J[A-Za-z0-9_-]{10,}\\.', 'ey', 'J[A-Za-z0-9_-]{10,}\\.')) },
  { id: 'private-key', re: new RegExp(j('-----BEGIN ', '[A-Z ]*', 'PRIVATE', ' KEY-----')) },
  { id: 'db-url', re: new RegExp(j('postgres', '(ql)?', ':\\/\\/[^:/\\s]+:[^@\\s]+@')) },
  { id: 'google-key', re: new RegExp(j('AI', 'za', '[0-9A-Za-z_-]{30,}')) },
  { id: 'resend-key', re: /re_[A-Za-z0-9]{16,}_/ },
  { id: 'deploy-hook', re: /api\.cloudflare\.com\/client\/v4\/pages\/webhooks\/deploy_hooks\/[0-9a-f-]{20,}/ },
  { id: 'personal-email', re: new RegExp(j('[A-Za-z0-9._%+-]+@', '(gmail|yahoo|outlook|icloud)', '\\.com')) },
];

function isTrackedEnv(file) {
  const b = basename(file);
  return (b === '.env' || b.startsWith('.env.')) && b !== '.env.example';
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Returns [{ file, line, rule }] for the git repo at cwd. */
export function scan(cwd = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const hits = [];
  for (const file of files) {
    if (EXCLUDED_FILES.includes(file)) continue;
    if (isTrackedEnv(file)) hits.push({ file, line: 1, rule: 'tracked-env' });
    let buf;
    try {
      buf = readFileSync(`${cwd}/${file}`);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((text, i) => {
      for (const r of RULES) if (r.re.test(text)) hits.push({ file, line: i + 1, rule: r.id });
    });
  }
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = scan();
  for (const h of hits) console.error(`${h.file}:${h.line} ${h.rule}`);
  if (hits.length > 0) {
    console.error(`secret-scan: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log('secret-scan: clean');
}
