// S1.14 "M1 PR CI db job" static half (AC-M1-53) plus the SQL conventions of the spec preamble, checked over the M1 migrations.
// Failing-first: the five M1 migrations do not exist yet. M1 files are matched by name suffix because their timestamps are
// placeholders ("use the next free timestamp at PR time").
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from './_testlib.mjs';

const DIR = join(REPO_ROOT, 'supabase', 'migrations');
const M1 = ['ingest_tables', 'ingest_rpcs', 'queue_admin', 'jobs', 'sources_terms_a2'];
const M0_NEWEST = '20261015000300';
const files = readdirSync(DIR).sort();
const fileFor = (n) => files.find((f) => f.endsWith(`_${n}.sql`));
const read = (n) => {
  const f = fileFor(n);
  if (!f) throw new Error(`missing migration *_${n}.sql`);
  return readFileSync(join(DIR, f), 'utf8');
};
const present = M1.filter((n) => fileFor(n));

describe('M1 migrations exist, in order', () => {
  for (const n of M1) it(`${n}`, () => expect(fileFor(n), `no migration named *_${n}.sql`).toBeTruthy());
  it('the five sort after the M0 migrations, in the S1 order', () => {
    const names = M1.map(fileFor);
    expect(names.every(Boolean)).toBe(true);
    expect(names.every((f) => f.slice(0, 14) > M0_NEWEST)).toBe(true);
    expect([...names].sort()).toEqual(names);
  });
});

describe('AC-M1-53 M1 ships without M3', () => {
  it('no M1 migration names lights_exports', () => {
    expect(present.length).toBe(M1.length);
    for (const n of M1) expect(read(n), n).not.toMatch(/lights_exports/i);
  });
  it('the M1 stubs are created with the signatures M3 will replace', () => {
    expect(present.length).toBe(M1.length);
    const rpcs = read('ingest_rpcs');
    expect(rpcs).toMatch(/function\s+private\.lights_pairs\s*\(\s*e\s+public\.events\s*\)\s+returns\s+jsonb/i);
    expect(rpcs).toMatch(/function\s+private\.event_is_exported\s*\(\s*p_event\s+uuid\s*\)\s+returns\s+boolean/i);
  });
  it('the stubs are created before recompute_event', () => {
    expect(present.length).toBe(M1.length);
    const rpcs = read('ingest_rpcs');
    const stub = rpcs.search(/function\s+private\.lights_pairs/i);
    const recompute = rpcs.search(/function\s+private\.recompute_event/i);
    expect(stub).toBeGreaterThan(-1);
    expect(recompute).toBeGreaterThan(stub);
  });
});

describe('spec SQL conventions over the M1 migrations', () => {
  it('every function pins search_path', () => {
    expect(present.length).toBe(M1.length);
    for (const n of M1) {
      const sql = read(n);
      const headers = sql.match(/create\s+(?:or\s+replace\s+)?function[\s\S]*?\bas\s+\$/gi) ?? [];
      for (const h of headers) expect(h, `${n}: ${h.slice(0, 80)}`).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });
  it('every migration that creates a table revokes service_role on tables and sequences', () => {
    expect(present.length).toBe(M1.length);
    const sql = read('ingest_tables');
    expect(sql).toMatch(/create\s+table/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s*,\s*private\s+from\s+service_role/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+all\s+sequences\s+in\s+schema\s+public\s*,\s*private\s+from\s+service_role/i);
  });
  it('every table is created with RLS enabled and forced', () => {
    expect(present.length).toBe(M1.length);
    const sql = read('ingest_tables');
    const created = [...sql.matchAll(/create\s+table\s+((?:public|private)\.\w+)/gi)].map((m) => m[1]);
    expect(created.length).toBe(16);
    for (const t of created) {
      expect(sql, t).toMatch(new RegExp(`alter\\s+table\\s+${t.replace('.', '\\.')}\\s+enable\\s+row\\s+level\\s+security`, 'i'));
      expect(sql, t).toMatch(new RegExp(`alter\\s+table\\s+${t.replace('.', '\\.')}\\s+force\\s+row\\s+level\\s+security`, 'i'));
    }
  });
  it('no table privilege is granted to anon, authenticated or service_role', () => {
    expect(present.length).toBe(M1.length);
    for (const n of M1) expect(read(n), n).not.toMatch(/grant\s+(?:select|insert|update|delete|truncate|references|trigger|all)[^;]*\bon\s+(?:table\s+)?(?:public|private)\./i);
  });
});

describe('S1.13a sources terms migration', () => {
  it('records the nine sources and enables none of them (enabling is rollout, S1.13 step 3)', () => {
    expect(present.length).toBe(M1.length);
    const sql = read('sources_terms_a2');
    for (const slug of ['alibi-truckee', 'truckee-chamber', 'visit-lake-tahoe', 'tdrpd', 'tahoe-donner', 'arts-for-the-schools', 'diamond-peak', 'ivgid', 'truckee-roundhouse']) {
      expect(sql, slug).toContain(slug);
    }
    expect(sql).not.toMatch(/\benabled\s*=\s*true\b/i);
    expect(sql).not.toMatch(/\bstrict_auto\s*=\s*true\b/i);
    expect(sql).toMatch(/seed_state/);
    expect(sql).toMatch(/record_source_terms/);
  });
  it('terms evidence carries hashes and the conductor as reviewer, and no personal address', () => {
    expect(present.length).toBe(M1.length);
    const sql = read('sources_terms_a2');
    expect(sql.match(/\b[0-9a-f]{64}\b/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
    expect(sql).toMatch(/'conductor'/);
    expect(sql).not.toMatch(/@(?:gmail|yahoo|outlook|icloud)\./i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A5-8 / AC-M1-70: every M1 migration ends with the canonical revoke block and a cumulative EXECUTE allowlist.
// ---------------------------------------------------------------------------------------------------------------------
const TABLES_REVOKE = /revoke all on all tables in schema public, private from service_role/gi;
const CANON = [
  'revoke all on all sequences in schema public, private from service_role',
  'revoke execute on all functions in schema public from public, anon, authenticated, service_role',
  'revoke execute on all functions in schema private from public, anon, authenticated, service_role',
];
const norm = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const GRANT = /^grant execute on function public\.(\w+)\s*\(([^)]*)\) to ([a-z_, ]+)$/;

/** Statements after the last tables revoke (the revoke itself excluded), whitespace-normalized. */
function tailStatements(sql) {
  const text = norm(stripComments(sql));
  let last = -1;
  for (const m of text.matchAll(TABLES_REVOKE)) last = m.index + m[0].length;
  if (last < 0) throw new Error('no canonical block: no "revoke all on all tables in schema public, private from service_role"');
  const rest = text.slice(last).replace(/^\s*;/, '');
  return rest.split(';').map((x) => x.trim()).filter(Boolean);
}
/** G(f): the set of normalized `public.<name>(<types>)->roles` grants in the tail. Throws unless the tail is canonical. */
function canonicalGrants(sql) {
  const st = tailStatements(sql);
  CANON.forEach((c, i) => { if (st[i] !== c) throw new Error(`canonical block: statement ${i + 1} is ${JSON.stringify(st[i])}, expected ${JSON.stringify(c)}`); });
  return grantSet(st.slice(CANON.length), true);
}
function grantSet(statements, strict) {
  const g = new Set();
  for (const x of statements) {
    const m = GRANT.exec(x);
    if (!m) { if (strict) throw new Error(`statement after the block that is not a function grant: ${x.slice(0, 80)}`); continue; }
    const args = m[2].split(',').map((a) => a.trim()).filter(Boolean).join(',');
    const roles = m[3].split(',').map((r) => r.trim()).sort().join(',');
    g.add(`public.${m[1]}(${args})->${roles}`);
  }
  return g;
}
/** M0 core: only the grants are read (its revoke lines predate the canonical form). */
const coreGrants = (sql) => grantSet(tailStatements(sql), false);
const createdFns = (sql) => new Set([...stripComments(sql).matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi)].map((m) => m[1].toLowerCase()));
/** Cumulative rule: G(n) is a superset of G(prev); every new element names a public function file n creates. */
function cumulativeProblems(prev, cur, created) {
  const out = [];
  for (const x of prev) if (!cur.has(x)) out.push(`dropped grant ${x}`);
  for (const x of cur) {
    if (prev.has(x)) continue;
    const name = /^public\.(\w+)\(/.exec(x)[1].toLowerCase();
    if (!created.has(name)) out.push(`new grant for a function this file does not create: ${x}`);
  }
  return out;
}

describe('AC-M1-70 every M1 migration ends with the canonical block and a cumulative allowlist', () => {
  const core = files.find((f) => f.endsWith('_core.sql'));
  it('M0 core is readable and carries the five grants', () => {
    expect(core).toBeTruthy();
    expect(coreGrants(readFileSync(join(DIR, core), 'utf8')).size).toBe(5);
  });
  for (const n of M1) {
    it(`${n} ends with the canonical block`, () => {
      expect(() => canonicalGrants(read(n))).not.toThrow();
    });
  }
  it('the allowlist is cumulative from core through jobs, and ingest_tables / sources_terms_a2 grant exactly their predecessor set', () => {
    expect(present.length).toBe(M1.length);
    let prev = coreGrants(readFileSync(join(DIR, core), 'utf8'));
    for (const n of M1) {
      const cur = canonicalGrants(read(n));
      expect(cumulativeProblems(prev, cur, createdFns(read(n))), n).toEqual([]);
      if (n === 'ingest_tables' || n === 'sources_terms_a2') expect([...cur].sort(), n).toEqual([...prev].sort());
      prev = cur;
    }
  });
  describe('negative fixtures through the same parser', () => {
    const block = `${CANON.map((c) => c + ';').join('\n')}`;
    const head = 'revoke all on all tables in schema public, private from service_role;\n';
    const g1 = 'grant execute on function public.a_fn(uuid) to authenticated;\n';
    const g2 = 'grant execute on function public.b_fn(text, integer) to service_role;\n';
    it('a tail with no block fails', () => {
      expect(() => canonicalGrants('create table t (a int);\n-- nothing else\n')).toThrow(/no canonical block/);
      expect(() => canonicalGrants(`${head}${g1}`)).toThrow(/canonical block: statement 1/);
    });
    it('a statement after the grants fails', () => {
      expect(() => canonicalGrants(`${head}${block}\n${g1}select 1;\n`)).toThrow(/not a function grant/);
    });
    it('a grant dropped versus the predecessor fails', () => {
      const prev = canonicalGrants(`${head}${block}\n${g1}${g2}`);
      const cur = canonicalGrants(`${head}${block}\n${g1}`);
      expect(cumulativeProblems(prev, cur, new Set(['b_fn']))).toEqual([expect.stringMatching(/^dropped grant public\.b_fn/)]);
    });
    it('a new grant for a function the file does not create fails', () => {
      const prev = canonicalGrants(`${head}${block}\n${g1}`);
      const cur = canonicalGrants(`${head}${block}\n${g1}${g2}`);
      expect(cumulativeProblems(prev, cur, new Set())).toEqual([expect.stringMatching(/does not create: public\.b_fn/)]);
      expect(cumulativeProblems(prev, cur, new Set(['b_fn']))).toEqual([]);
    });
    it('the parser accepts a well-formed tail', () => {
      expect([...canonicalGrants(`/* x */\n${head}${block}\n-- note\n${g1}${g2}`)].sort())
        .toEqual(['public.a_fn(uuid)->authenticated', 'public.b_fn(text,integer)->service_role']);
    });
  });
});

describe('A5-1 / A5-10 / AC-M1-71 sources terms migration, Amendment 5 rows', () => {
  it('Visit Lake Tahoe carries the exact exclusion array and not the empty one', () => {
    const sql = read('sources_terms_a2');
    expect(sql).toContain('"excludeCategorySlugs":["attractions-events","wellness","tahoe-blue-event-center"]');
    expect(sql).not.toContain('"excludeCategorySlugs":[]');
  });
  it('AC-M1-71: all 9 record_source_terms calls end with a neutral note, and no legal reasoning is in the file', () => {
    const sql = read('sources_terms_a2');
    const notes = [...sql.matchAll(/record_source_terms\([\s\S]*?'((?:[^']|'')*)'\s*\)\s*;/g)].map((m) => m[1]);
    expect(notes.length).toBe(9);
    for (const note of notes) expect(note).toMatch(/^Terms review \d{4}-\d{2}-\d{2}: (permitted|permission_required|prohibited|official_api_only|unknown)\.$/);
    expect(sql).not.toMatch(/\b(written permission|personal or educational|republish|replicate|scraping clause|crawlers)\b/i);
  });
});

// A5.1-1: the concurrency harness must target this repo's database port, and CI must hand it the running stack's URL.
describe('concurrency harness targets the configured DB port', () => {
  const harness = () => readFileSync(join(REPO_ROOT, 'scripts', 'db-concurrency.dbtest.mjs'), 'utf8');
  const dbPort = () => {
    let inDb = false;
    for (const line of readFileSync(join(REPO_ROOT, 'supabase', 'config.toml'), 'utf8').split('\n')) {
      const t = line.trim();
      if (/^\[.*\]$/.test(t)) inDb = t === '[db]';
      else if (inDb) { const m = /^port\s*=\s*(\d+)/.exec(t); if (m) return Number(m[1]); }
    }
    throw new Error('no [db] port in supabase/config.toml');
  };
  it('config.toml [db] port is 55422', () => expect(dbPort()).toBe(55422));
  it('the harness exports DEFAULT_DB_URL on that port', () => {
    const m = /export const DEFAULT_DB_URL\s*=\s*['"]([^'"]+)['"]/.exec(harness());
    expect(m, 'scripts/db-concurrency.dbtest.mjs must export const DEFAULT_DB_URL').toBeTruthy();
    expect(new URL(m[1]).port).toBe(String(dbPort()));
  });
  it('the harness reads DB_URL, probes with select 1 and reports db_unreachable', () => {
    const h = harness();
    expect(h).toMatch(/process\.env\.DB_URL\s*\?\?\s*DEFAULT_DB_URL/);
    expect(h).toMatch(/select 1/i);
    expect(h).toContain('db_unreachable');
  });
  it('ci.yml db job: supabase status -> GITHUB_ENV, then the DB_URL guard, then the concurrency run, after db:test', () => {
    const ci = parseYaml(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    const steps = ci.jobs.db.steps;
    const at = (re) => steps.findIndex((st) => typeof st.run === 'string' && re.test(st.run));
    const status = at(/supabase status -o env/);
    const guard = at(/test -n "\$DB_URL"/);
    const run = at(/npm run db:test:concurrency/);
    const dbtest = at(/npm run db:test(?!:)/);
    expect(status, 'no "supabase status -o env" step').toBeGreaterThan(-1);
    expect(steps[status].run).toMatch(/grep '\^DB_URL='/);
    expect(steps[status].run).toContain("tr -d '\"'");
    expect(steps[status].run).toContain('>> "$GITHUB_ENV"');
    expect(run, 'no db:test:concurrency step').toBeGreaterThan(-1);
    expect(dbtest).toBeGreaterThan(-1);
    expect(dbtest).toBeLessThan(run);
    expect(status).toBeLessThan(run);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThanOrEqual(run);
    expect(guard).toBeGreaterThan(status);
    expect(steps.some((st) => /setup-node@/.test(st.uses ?? '')), 'db job needs setup-node').toBe(true);
    expect(steps.some((st) => st.run === 'npm ci'), 'db job needs npm ci').toBe(true);
  });
  it('no workflow and not the harness mentions :54322', () => {
    const wf = join(REPO_ROOT, '.github', 'workflows');
    for (const f of readdirSync(wf)) expect(readFileSync(join(wf, f), 'utf8'), f).not.toContain(':54322');
    expect(harness()).not.toContain(':54322');
  });
  it('package.json wires db:test:concurrency and pins pg exactly', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['db:test:concurrency']).toBe('node --test scripts/db-concurrency.dbtest.mjs');
    expect(pkg.devDependencies.pg).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('rollout migrations keep the canonical block and the unchanged allowlist', () => {
  it('enable_alibi ends with the canonical block and grants exactly the sources_terms_a2 set', () => {
    expect(fileFor('enable_alibi'), 'no migration named *_enable_alibi.sql').toBeTruthy();
    const cur = canonicalGrants(read('enable_alibi'));
    expect([...cur].sort()).toEqual([...canonicalGrants(read('sources_terms_a2'))].sort());
    expect(fileFor('enable_alibi').slice(0, 14) > fileFor('sources_terms_a2').slice(0, 14)).toBe(true);
  });
});

// A7-2 / AC-M1-76 (e): owner_minutes adds exactly admin_owner_minutes_7d to the cumulative allowlist.
describe('owner_minutes adds exactly admin_owner_minutes_7d', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists and sorts after sources_terms_a2 and (when present) enable_alibi', () => {
    const f = fileFor('owner_minutes');
    expect(f, 'no migration named *_owner_minutes.sql').toBeTruthy();
    const ts = (x) => x.slice(0, 14);
    expect(ts(f) > ts(fileFor('sources_terms_a2'))).toBe(true);
    if (fileFor('enable_alibi')) expect(ts(f) > ts(fileFor('enable_alibi'))).toBe(true);
  });
  it('ends with the canonical block and is cumulative', () => {
    expect(() => G('owner_minutes')).not.toThrow();
    expect(cumulativeProblems(G('sources_terms_a2'), G('owner_minutes'), createdFns(read('owner_minutes')))).toEqual([]);
  });
  it('the only new grant is admin_owner_minutes_7d() to authenticated', () => {
    const prev = G('sources_terms_a2');
    const added = [...G('owner_minutes')].filter((x) => !prev.has(x));
    expect(added).toEqual(['public.admin_owner_minutes_7d()->authenticated']);
  });
  it('the function is security definer with a pinned search_path', () => {
    const sql = read('owner_minutes');
    expect(sql).toMatch(/security\s+definer/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*''/i);
  });
});
