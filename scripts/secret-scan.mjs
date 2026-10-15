// Tracked-file secret scanner (spec S0.2, A4-2, A4.1). Scans the git INDEX blobs of the cwd (not the working tree),
// optionally the commit metadata and every blob added in a revision range, and prints "<file>:<line> <rule-id>" per hit,
// never the match. Fails closed: any thrown error exits 2. It scans its own source and test too, so any rule whose pattern text could match itself is built
// from fragments. Importing this module does not run the CLI.
import { execFileSync, spawnSync } from 'node:child_process';
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
  { id: 'personal-email', re: new RegExp(j('[A-Za-z0-9._%+-]+@', '(gmail|yahoo|outlook|icloud)', '\\.com'), 'i') },
];

/** Author/committer emails must match one of these (GitHub no-reply, or GitHub's own web-flow committer). */
export const IDENTITY_ALLOW = [
  /^\d+\+[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})@users\.noreply\.github\.com$/i,
  /^noreply@github\.com$/i,
];

const git = (cwd, args, opts = {}) =>
  execFileSync('git', args, { cwd, maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function isTrackedEnv(file) {
  const b = basename(file);
  return (b === '.env' || b.startsWith('.env.')) && b !== '.env.example';
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Read blobs through one `git cat-file --batch` process. Returns an array parallel to oids:
 * a Buffer, or null when the object is missing, not a blob, or its size does not match.
 */
function readBlobs(cwd, oids) {
  if (oids.length === 0) return [];
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    input: oids.map((o) => `${o}\n`).join(''),
    maxBuffer: 1 << 30,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Object.assign(new Error('cat-file failed'), { code: `cat-file-${r.status}` });
  const buf = r.stdout;
  const res = [];
  let pos = 0;
  for (let i = 0; i < oids.length; i++) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw Object.assign(new Error('truncated cat-file output'), { code: 'cat-file-truncated' });
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) {
      res.push(null); // "<oid> missing" or "<oid> ambiguous"
      continue;
    }
    const size = Number(m[3]);
    if (m[2] !== 'blob' || pos + size > buf.length || m[1] !== oids[i]) {
      res.push(null);
    } else {
      res.push(buf.subarray(pos, pos + size));
    }
    pos += size + 1;
  }
  return res;
}

function lineHits(buf, file, hits) {
  buf.toString('utf8').split('\n').forEach((text, i) => {
    for (const r of RULES) if (r.re.test(text)) hits.push({ file, line: i + 1, rule: r.id });
  });
}

/** Returns [{ file, line, rule }] for the INDEX of the git repo at cwd. */
export function scan(cwd = process.cwd()) {
  const raw = git(cwd, ['ls-files', '-s', '-z']).toString('utf8').split('\0').filter(Boolean);
  const hits = [];
  const queue = [];
  for (const rec of raw) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec);
    if (!m) throw Object.assign(new Error('unparseable ls-files entry'), { code: 'ls-files-parse' });
    const [, mode, oid, stage, file] = m;
    if (stage !== '0') { hits.push({ file, line: 0, rule: 'unmerged' }); continue; }
    if (mode === '120000') { hits.push({ file, line: 0, rule: 'tracked-symlink' }); continue; }
    if (mode === '160000') { hits.push({ file, line: 0, rule: 'tracked-submodule' }); continue; }
    if (EXCLUDED_FILES.includes(file)) continue;
    if (isTrackedEnv(file)) hits.push({ file, line: 1, rule: 'tracked-env' });
    queue.push({ file, oid });
  }
  const blobs = readBlobs(cwd, queue.map((q) => q.oid));
  queue.forEach((q, i) => {
    const b = blobs[i];
    if (b === null) return hits.push({ file: q.file, line: 0, rule: 'unreadable' });
    if (isBinary(b)) return;
    lineHits(b, q.file, hits);
  });
  return hits;
}

/** Commit metadata scan for a rev range. Hits print as "commit:<sha7>:<part> <rule>"; never the address. */
export function scanCommits(cwd, range) {
  const toks = git(cwd, ['log', '-z', '--format=%H%x00%ae%x00%ce%x00%B', range]).toString('utf8').split('\0');
  const hits = [];
  for (let i = 0; i + 3 < toks.length + 0 && toks[i] !== ''; i += 4) {
    const [sha, ae, ce, msg] = [toks[i], toks[i + 1], toks[i + 2], toks[i + 3] ?? ''];
    const s7 = sha.slice(0, 7);
    if (!IDENTITY_ALLOW.some((re) => re.test(ae))) hits.push({ file: `commit:${s7}:author`, line: null, rule: 'commit-identity' });
    if (!IDENTITY_ALLOW.some((re) => re.test(ce))) hits.push({ file: `commit:${s7}:committer`, line: null, rule: 'commit-identity' });
    for (const r of RULES) if (r.re.test(msg)) hits.push({ file: `commit:${s7}:message`, line: null, rule: r.id });
  }
  return hits;
}

/** Every blob added/modified by any commit in the range, scanned with the same rules (A4.1). */
export function scanRangeBlobs(cwd, range) {
  const commits = git(cwd, ['rev-list', '--reverse', range]).toString('utf8').split('\n').filter(Boolean);
  const hits = [];
  const seenHit = new Set();
  const addHit = (h) => {
    const k = `${h.file}:${h.line}:${h.rule}`;
    if (!seenHit.has(k)) { seenHit.add(k); hits.push(h); }
  };
  const seenBlob = new Set();
  const queue = [];
  for (const c of commits) {
    const s7 = c.slice(0, 7);
    const toks = git(cwd, ['diff-tree', '-r', '-m', '--root', '--no-commit-id', '--no-renames', '--raw', '-z', '--diff-filter=AMT', c])
      .toString('utf8').split('\0');
    for (let i = 0; i + 1 < toks.length; i += 2) {
      const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)$/.exec(toks[i]);
      if (!m) {
        if (toks[i] === '') break;
        throw Object.assign(new Error('unparseable diff-tree record'), { code: 'diff-tree-parse' });
      }
      const [, , newMode, , newSha] = m;
      const path = toks[i + 1];
      const file = `${s7}:${path}`;
      if (newMode === '120000') { addHit({ file, line: 0, rule: 'tracked-symlink' }); continue; }
      if (newMode === '160000') { addHit({ file, line: 0, rule: 'tracked-submodule' }); continue; }
      if (EXCLUDED_FILES.includes(basename(path))) continue;
      if (isTrackedEnv(path)) addHit({ file, line: 1, rule: 'tracked-env' });
      if (seenBlob.has(newSha)) continue;
      seenBlob.add(newSha);
      queue.push({ file, oid: newSha });
    }
  }
  const blobs = readBlobs(cwd, queue.map((q) => q.oid));
  queue.forEach((q, i) => {
    const b = blobs[i];
    if (b === null) return addHit({ file: q.file, line: 0, rule: 'unreadable' });
    if (isBinary(b)) return;
    const hs = [];
    lineHits(b, q.file, hs);
    hs.forEach(addHit);
  });
  return hits;
}

function resolves(cwd, rev) {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function rangeResolves(cwd, range) {
  const ends = range.includes('..') ? range.split(/\.{2,3}/) : [range];
  return ends.every((e) => e !== '' && resolves(cwd, e));
}

function main(argv) {
  let range = null;
  let noFiles = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--range') range = argv[++i] ?? '';
    else if (argv[i] === '--no-files') noFiles = true;
    else throw Object.assign(new Error('unknown argument'), { code: 'usage' });
  }
  const cwd = process.cwd();
  const hits = [];
  if (!noFiles) hits.push(...scan(cwd));
  if (range === null && resolves(cwd, 'origin/main')) range = 'origin/main..HEAD';
  if (range === null) {
    console.log('secret-scan: commit metadata skipped (no origin/main)');
  } else {
    if (!range || !rangeResolves(cwd, range)) {
      console.error('secret-scan: range_unresolved');
      process.exit(1);
    }
    hits.push(...scanCommits(cwd, range), ...scanRangeBlobs(cwd, range));
  }
  for (const h of hits) console.error(h.line === null ? `${h.file} ${h.rule}` : `${h.file}:${h.line} ${h.rule}`);
  if (hits.length > 0) {
    console.error(`secret-scan: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log('secret-scan: clean');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`secret-scan: error ${e?.code ?? e?.status ?? 'unknown'}`);
    process.exit(2);
  }
}
