// YAML-parsed checks of .github/workflows/*.{yml,yaml} (spec S0.2 as amended by A4-1).
// Usage: node scripts/check-workflows.mjs [rootDir]   (default: cwd). Exit 1 on any violation.
// Prints "<file>: <rule-id> <detail>". Importing this module does not run the CLI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAllDocuments } from 'yaml';

/** Exact trigger set per workflow file. A file not listed here is `unknown_workflow`. */
export const ALLOWED_TRIGGERS = {
  'ci.yml': ['pull_request', 'push'],
  'ingest.yml': ['schedule', 'workflow_dispatch'],
  'rebuild.yml': ['schedule', 'workflow_dispatch'],
  'sign-feed.yml': ['schedule', 'workflow_dispatch'],
  'sign-gate-probe.yml': ['workflow_dispatch'],
};

const SHA_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const LOCAL_USES = /^\.\/[A-Za-z0-9_./-]+$/;
const SIGNER_REPOS = new Set(['actions/checkout', 'actions/setup-node']);
const PKG_RE = /\b(npm|npx|pnpm|yarn|bun|corepack)\b/;
const PROBE_SECRET = "${{ secrets.FEED_SIGNING_KEY != '' }}";

/** The one legal shape of rebuild.yml (spec Amendment R0-1). */
const REBUILD_RUN = `test -n "$HOOK" && curl -fsS -X POST --max-time 20 "$HOOK" -o /dev/null -w 'status=%{http_code}\\n'`;
const REBUILD_EXPECTED = {
  name: 'Daily rebuild',
  on: { schedule: [{ cron: '0 13 * * *' }], workflow_dispatch: {} },
  permissions: {},
  jobs: {
    rebuild: {
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 2,
      steps: [{ name: 'Call the Pages deploy hook', env: { HOOK: '${{ secrets.PAGES_DEPLOY_HOOK_URL }}' }, run: REBUILD_RUN }],
    },
  },
};

/** Path of the first difference between two parsed values, or null when deep-equal. */
function firstDiff(want, have, path = '') {
  const at = path || '(root)';
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return at;
    for (let i = 0; i < want.length; i++) {
      const d = firstDiff(want[i], have[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (want !== null && typeof want === 'object') {
    if (have === null || typeof have !== 'object' || Array.isArray(have)) return at;
    for (const k of new Set([...Object.keys(want), ...Object.keys(have)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in want) || !(k in have)) return p;
      const d = firstDiff(want[k], have[k], p);
      if (d) return d;
    }
    return null;
  }
  return Object.is(want, have) ? null : at;
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameArr = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Yield [path, value] for every node; keys are reported as ['<key>'] strings via onKey. */
function walk(node, visit, path = [], seen = new Set()) {
  if (node === null || typeof node !== 'object') return visit(path, node, undefined);
  if (seen.has(node)) return;
  seen.add(node);
  visit(path, node, undefined);
  if (Array.isArray(node)) node.forEach((v, i) => walk(v, visit, [...path, i], seen));
  else for (const [k, v] of Object.entries(node)) {
    visit(path, undefined, k);
    walk(v, visit, [...path, k], seen);
  }
}

function permsViolation(p) {
  if (p === undefined) return false;
  if (!isMap(p)) return true;
  return Object.values(p).some((v) => v !== 'read' && v !== 'none');
}

const envName = (job) => {
  const e = job?.environment;
  if (typeof e === 'string') return e.trim();
  if (isMap(e) && typeof e.name === 'string') return e.name.trim();
  return null;
};

/** Returns an array of "<rule-id> <detail>" strings; empty means the workflow is clean. */
export function checkWorkflow(name, text) {
  const out = [];
  const add = (rule, detail = '') => out.push(detail ? `${rule} ${detail}` : rule);

  let docs;
  try {
    docs = parseAllDocuments(text, { version: '1.2', uniqueKeys: true, maxAliasCount: 100, prettyErrors: false });
  } catch {
    return ['yaml_invalid parse error'];
  }
  const list = Array.isArray(docs) ? docs : [docs];
  if (list.length > 1) return ['yaml_multi_doc more than one document'];
  const doc = list[0];
  if (!doc || doc.errors.length > 0 || doc.warnings.length > 0) return ['yaml_invalid'];
  let wf;
  try {
    wf = doc.toJS();
  } catch {
    return ['yaml_invalid toJS failed'];
  }

  let merge = false;
  walk(wf, (_p, _n, key) => { if (key === '<<') merge = true; });
  if (merge) return ['yaml_merge_key'];

  if (!isMap(wf) || !('on' in wf) || !isMap(wf.jobs)) return ['structure top level needs on and jobs mappings'];

  // Triggers
  let trig;
  const on = wf.on;
  if (typeof on === 'string') trig = { [on]: null };
  else if (Array.isArray(on) && on.every((s) => typeof s === 'string')) trig = Object.fromEntries(on.map((s) => [s, null]));
  else if (isMap(on)) trig = on;
  else return ['structure unsupported on: value'];

  const allowed = ALLOWED_TRIGGERS[name];
  if (!allowed) add('unknown_workflow', `${name} is not in ALLOWED_TRIGGERS`);
  else {
    const have = Object.keys(trig).sort();
    if (!sameArr(have, [...allowed].sort())) add('trigger_set', `have [${have.join(', ')}] want [${allowed.join(', ')}]`);
    if (name === 'ci.yml') {
      for (const t of ['pull_request', 'push']) {
        if (!sameArr(trig[t]?.branches, ['main'])) add('trigger_set', `${t}.branches must be [main]`);
      }
    }
  }
  const isPr = 'pull_request' in trig;

  const jobs = wf.jobs;
  const jobIds = Object.keys(jobs);

  // uses
  walk(wf, (path, _n, key) => {
    if (key !== 'uses') return;
    const v = (path.length ? path.reduce((a, k) => a?.[k], wf) : wf)?.uses;
    const legal = (path.length === 2 && path[0] === 'jobs') || (path.length === 4 && path[0] === 'jobs' && path[2] === 'steps' && typeof path[3] === 'number');
    const where = path.join('.') || '(root)';
    if (!legal) return add('uses_position', where);
    const ok = typeof v === 'string' && (SHA_USES.test(v) || (LOCAL_USES.test(v) && !v.split('/').includes('..')));
    if (!ok) add('uses_unpinned', `${where}: ${String(v)}`);
  });

  // permissions
  if (name === 'rebuild.yml') {
    // The rebuild workflow holds no token at all: `permissions: {}` (AC-R0-03).
    if (!(isMap(wf.permissions) && Object.keys(wf.permissions).length === 0)) add('rebuild_permissions', 'top-level permissions must be exactly {}');
  } else if (!(isMap(wf.permissions) && sameArr(Object.keys(wf.permissions), ['contents']) && wf.permissions.contents === 'read')) {
    add('permissions_top', 'top-level permissions must be exactly { contents: read }');
  }
  if (permsViolation(wf.permissions) && wf.permissions !== undefined) add('permissions_write', 'top-level');
  for (const id of jobIds) {
    if (isMap(jobs[id]) && permsViolation(jobs[id].permissions)) add('permissions_write', `job ${id}`);
  }

  // PR-triggered workflows
  if (isPr) {
    for (const id of jobIds) {
      const j = jobs[id];
      if (!isMap(j)) continue;
      if (j.environment !== undefined) add('pr_environment', `job ${id}`);
      if (typeof j.uses === 'string' && !j.uses.startsWith('./')) add('pr_reusable', `job ${id}`);
    }
    let secret = false;
    walk(wf, (_p, node, key) => {
      if (typeof node === 'string' && /\bsecrets\b/.test(node)) secret = true;
      if (typeof key === 'string' && /\bsecrets\b/.test(key)) secret = true;
    });
    if (secret) add('pr_secret_ref', 'a PR-triggered workflow must not reference secrets');
  }

  // Environment confinement
  const signerFile = name === 'sign-feed.yml' || name === 'sign-gate-probe.yml';
  if (!signerFile) {
    for (const id of jobIds) if (envName(jobs[id]) === 'feed-signing') add('env_reserved', `job ${id}`);
    if (text.includes('feed-signing')) add('env_reserved', 'raw text mentions feed-signing');
  }

  if (name === 'rebuild.yml') {
    const diff = firstDiff(REBUILD_EXPECTED, wf);
    if (diff) add('rebuild_shape', diff);
    let anyUses = false;
    walk(wf, (_p, _n, key) => { if (key === 'uses') anyUses = true; });
    if (anyUses || /(^|[\s{,-])uses\s*:/m.test(text)) add('rebuild_uses', 'uses is not allowed');
    if (PKG_RE.test(text)) add('rebuild_pkg', 'no package manager');
    if (/checkout/i.test(text)) add('rebuild_checkout', 'no checkout');
    const rest = text.replace(/\bsecrets\.PAGES_DEPLOY_HOOK_URL\b/g, '');
    if (/\bsecrets\b/.test(rest)) add('rebuild_secret', 'only secrets.PAGES_DEPLOY_HOOK_URL may be referenced');
  }

  if (name === 'sign-feed.yml') {
    if (jobIds.length !== 1) add('signer_jobs', `exactly one job required (found ${jobIds.length})`);
    for (const id of jobIds) {
      const j = jobs[id];
      if (!isMap(j)) { add('structure', `job ${id}`); continue; }
      if (envName(j) !== 'feed-signing') add('signer_env', `job ${id}`);
      const g = typeof j.if === 'string' ? j.if.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim() : null;
      if (g !== "github.ref == 'refs/heads/main'") add('signer_guard', `job ${id} needs a job-level if`);
      if (j.uses !== undefined) add('signer_uses', `job ${id} must not be a reusable workflow`);
      if (j.needs !== undefined) add('signer_needs', `job ${id}`);
      const steps = Array.isArray(j.steps) ? j.steps : [];
      for (const s of steps) {
        if (!isMap(s)) continue;
        if (typeof s.uses === 'string' && !SIGNER_REPOS.has(s.uses.split('@')[0])) add('signer_uses', s.uses);
        if (typeof s.run === 'string' && PKG_RE.test(s.run)) add('signer_pkg', 'package manager in run');
      }
    }
  }

  if (name === 'sign-gate-probe.yml') {
    if (jobIds.length !== 1) add('probe_jobs', `exactly one job required (found ${jobIds.length})`);
    for (const id of jobIds) {
      const j = jobs[id];
      if (!isMap(j)) { add('structure', `job ${id}`); continue; }
      if (envName(j) !== 'feed-signing') add('probe_env', `job ${id}`);
      if (j.if !== undefined) add('probe_if', `job ${id}`);
      const steps = Array.isArray(j.steps) ? j.steps : [];
      if (steps.length !== 1 || !isMap(steps[0]) || typeof steps[0].run !== 'string') add('probe_steps', 'exactly one run step required');
    }
    let anyUses = false;
    let badSecret = false;
    walk(wf, (_p, node, key) => {
      if (key === 'uses') anyUses = true;
      if (typeof key === 'string' && /secrets/.test(key)) badSecret = true;
      if (typeof node === 'string' && /secrets/.test(node) && node !== PROBE_SECRET) badSecret = true;
    });
    if (anyUses) add('probe_uses', 'uses is not allowed');
    if (badSecret) add('probe_secret', 'only the FEED_SIGNING_KEY presence check may mention secrets');
  }

  return out;
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  const dir = join(root, '.github', 'workflows');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const errors = [];
  for (const f of files) {
    for (const e of checkWorkflow(f, readFileSync(join(dir, f), 'utf8'))) errors.push(`${f}: ${e}`);
  }
  for (const e of errors) console.error(e);
  if (errors.length > 0) process.exit(1);
  console.log(`check-workflows: ok (${files.length} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
