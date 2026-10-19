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

// S1.13 step 3: alibi_auto promotes Alibi to trust auto and adds no grant.
describe('alibi_auto keeps the canonical block and the unchanged allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists, sorts after alibi_venue_fixup, and its allowlist is the 23 of alibi_venue_fixup', () => {
    const f = fileFor('alibi_auto');
    expect(f, 'no migration named *_alibi_auto.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('alibi_venue_fixup').slice(0, 14)).toBe(true);
    const cur = G('alibi_auto');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('alibi_venue_fixup')].sort());
    expect(createdFns(read('alibi_auto')).size).toBe(0);
  });
  it('sets trust to auto for alibi-truckee only, with no enabled/strict_auto change', () => {
    const sql = read('alibi_auto');
    expect(sql).toMatch(/set\s+trust\s*=\s*'auto'[^;]*alibi-truckee/i);
    expect(sql).not.toMatch(/\bstrict_auto\s*=\s*true\b/i);
    expect(sql).not.toMatch(/\benabled\s*=\s*true\b/i);
  });
});

// S1.13 step 3: enable_chamber enables Truckee Chamber only (trust stays review) and adds no grant.
describe('enable_chamber keeps the canonical block and the unchanged allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists, sorts after alibi_auto, and its allowlist is the 23 of alibi_auto', () => {
    const f = fileFor('enable_chamber');
    expect(f, 'no migration named *_enable_chamber.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('alibi_auto').slice(0, 14)).toBe(true);
    const cur = G('enable_chamber');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('alibi_auto')].sort());
    expect(createdFns(read('enable_chamber')).size).toBe(0);
  });
  it('enables truckee-chamber only, with no trust or strict_auto change', () => {
    const sql = read('enable_chamber');
    expect(sql).toMatch(/set\s+enabled\s*=\s*true[^;]*truckee-chamber/i);
    expect([...sql.matchAll(/update\s+public\.sources/gi)].length).toBe(1);
    expect(sql).not.toMatch(/\bstrict_auto\s*=\s*true\b/i);
    const upd = sql.match(/update\s+public\.sources[^;]*;/i)[0];
    expect(upd).not.toMatch(/\btrust\b/i);
    expect(upd).not.toMatch(/\bstrict_auto\b/i);
    expect(sql).not.toMatch(/(?:visit-lake-tahoe|tdrpd|tahoe-donner|arts-for-the-schools|diamond-peak|ivgid|truckee-roundhouse)/);
  });
});

// S1.13 step 3: enable_vlt enables Visit Lake Tahoe only (trust stays review, strict_auto stays false) and adds no grant.
describe('enable_vlt keeps the canonical block and the unchanged allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists, sorts after enable_chamber, and its allowlist is the 23 of enable_chamber', () => {
    const f = fileFor('enable_vlt');
    expect(f, 'no migration named *_enable_vlt.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('enable_chamber').slice(0, 14)).toBe(true);
    const cur = G('enable_vlt');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('enable_chamber')].sort());
    expect(createdFns(read('enable_vlt')).size).toBe(0);
  });
  it('enables visit-lake-tahoe only, with no trust or strict_auto change', () => {
    const sql = read('enable_vlt');
    expect(sql).toMatch(/set\s+enabled\s*=\s*true[^;]*visit-lake-tahoe/i);
    expect([...sql.matchAll(/update\s+public\.sources/gi)].length).toBe(1);
    expect(sql).not.toMatch(/\bstrict_auto\s*=\s*true\b/i);
    const upd = sql.match(/update\s+public\.sources[^;]*;/i)[0];
    expect(upd).not.toMatch(/\btrust\b/i);
    expect(upd).not.toMatch(/\bstrict_auto\b/i);
    expect(sql).not.toMatch(/(?:tdrpd|tahoe-donner|arts-for-the-schools|diamond-peak|ivgid|truckee-roundhouse)/);
  });
});

// S1.13 step 3: enable_tdrpd enables TDRPD only (trust stays review) and adds no grant.
describe('enable_tdrpd keeps the canonical block and the unchanged allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists, sorts after enable_vlt, and its allowlist is the 23 of enable_vlt', () => {
    const f = fileFor('enable_tdrpd');
    expect(f, 'no migration named *_enable_tdrpd.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('enable_vlt').slice(0, 14)).toBe(true);
    const cur = G('enable_tdrpd');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('enable_vlt')].sort());
    expect(createdFns(read('enable_tdrpd')).size).toBe(0);
  });
  it('enables tdrpd only, with no trust or strict_auto change', () => {
    const sql = read('enable_tdrpd');
    expect(sql).toMatch(/set\s+enabled\s*=\s*true[^;]*tdrpd/i);
    expect([...sql.matchAll(/update\s+public\.sources/gi)].length).toBe(1);
    expect(sql).not.toMatch(/\bstrict_auto\s*=\s*true\b/i);
    const upd = sql.match(/update\s+public\.sources[^;]*;/i)[0];
    expect(upd).not.toMatch(/\btrust\b/i);
    expect(upd).not.toMatch(/\bstrict_auto\b/i);
    expect(upd).not.toMatch(/(?:tahoe-donner|arts-for-the-schools|diamond-peak|ivgid|truckee-roundhouse|visit-lake-tahoe)/);
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

// A8-2 step 6 / AC-M1-83 (e): alibi_venue_fixup adds no grant. A8.1-3 step 2 / AC-M1-85 (e): its clean_source_item is the
// ingest_rpcs original plus exactly one guard line.
describe('alibi_venue_fixup adds no grant', () => {
  const G = (n) => canonicalGrants(read(n));
  const ts = (x) => x.slice(0, 14);
  it('exists and sorts after owner_minutes', () => {
    const f = fileFor('alibi_venue_fixup');
    expect(f, 'no migration named *_alibi_venue_fixup.sql').toBeTruthy();
    expect(ts(f) > ts(fileFor('owner_minutes'))).toBe(true);
  });
  it('ends with the canonical block; its allowlist is owner_minutes\'s (23 grants)', () => {
    expect(() => G('alibi_venue_fixup')).not.toThrow();
    const cur = G('alibi_venue_fixup');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('owner_minutes')].sort());
    expect(cumulativeProblems(G('owner_minutes'), cur, createdFns(read('alibi_venue_fixup')))).toEqual([]);
  });
  it('creates no public function, and every function pins search_path', () => {
    const sql = read('alibi_venue_fixup');
    expect(createdFns(sql).size).toBe(0);
    const headers = sql.match(/create\s+(?:or\s+replace\s+)?function[\s\S]*?\bas\s+\$/gi) ?? [];
    expect(headers.length).toBe(5);
    for (const h of headers) expect(h, h.slice(0, 80)).toMatch(/set\s+search_path\s*=\s*''/i);
  });
  it('creates the five private functions of A8-2 / A8.1', () => {
    const sql = read('alibi_venue_fixup');
    for (const f of ['is_non_place', 'clean_source_item', 'venue_admin_fix', 'drop_non_place_venues', 'a8_alibi_venue_fixup']) {
      expect(sql, f).toMatch(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+private\\.${f}\\s*\\(`, 'i'));
    }
  });
});

describe('AC-M1-85 (e) clean_source_item is the original plus one guard line', () => {
  const body = (sql) => {
    const m = /create\s+(?:or\s+replace\s+)?function\s+private\.clean_source_item\b/i.exec(sql);
    if (!m) throw new Error('no clean_source_item definition');
    const end = sql.indexOf('end $$;', m.index);
    if (end < 0) throw new Error('clean_source_item has no end $$;');
    return sql.slice(m.index, end + 'end $$;'.length);
  };
  const lines = (t) => t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const original = () => body(read('ingest_rpcs'));
  const fixed = () => body(read('alibi_venue_fixup'));
  const GUARD = /private\.is_non_place\(v_vn\)/;
  it('exactly one marked line', () => {
    expect(lines(fixed()).filter((l) => GUARD.test(l))).toHaveLength(1);
  });
  it('with the marked line removed it equals the ingest_rpcs definition (create or replace aside)', () => {
    const strip = (t) => lines(t).filter((l) => !GUARD.test(l)).join('\n').replace(/^create (or replace )?function/i, 'create function');
    expect(strip(fixed())).toEqual(strip(original()));
  });
  it('the marked line sits after the last address reject and before the town block', () => {
    const f = fixed();
    const at = f.search(GUARD);
    const lastAddr = f.lastIndexOf("jsonb_build_object('reject', 'address')");
    const town = f.indexOf("jt(item, 'town')");
    expect(lastAddr).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(lastAddr);
    expect(town).toBeGreaterThan(at);
    expect(f).toMatch(/v_vn\s*:=\s*null\s*;\s*v_addr\s*:=\s*null/);
  });
  it('no migration between ingest_rpcs and alibi_venue_fixup redefines clean_source_item', () => {
    const lo = fileFor('ingest_rpcs'); const hi = fileFor('alibi_venue_fixup');
    for (const f of files) {
      if (f <= lo || f >= hi) continue;
      expect(readFileSync(join(DIR, f), 'utf8'), f).not.toMatch(/function\s+private\.clean_source_item\b/i);
    }
  });
});

// A9-5 / A9.1-1 step 5 / AC-M1-90 (b, c): chamber_fixes adds no grant, creates exactly four private functions, and its
// resolve_venue is the ingest_rpcs original plus one marked block.
describe('chamber_fixes adds no grant', () => {
  const G = (n) => canonicalGrants(read(n));
  const ts = (x) => x.slice(0, 14);
  it('exists, sorts after enable_chamber, and its allowlist is the 23 of enable_chamber', () => {
    const f = fileFor('chamber_fixes');
    expect(f, 'no migration named *_chamber_fixes.sql').toBeTruthy();
    expect(ts(f) > ts(fileFor('enable_chamber'))).toBe(true);
    const cur = G('chamber_fixes');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('enable_chamber')].sort());
  });
  it('creates no public function; exactly 4 function headers, each pinning search_path', () => {
    const sql = read('chamber_fixes');
    expect(createdFns(sql).size).toBe(0);
    const headers = sql.match(/create\s+(?:or\s+replace\s+)?function[\s\S]*?\bas\s+\$/gi) ?? [];
    expect(headers.length).toBe(4);
    for (const h of headers) expect(h, h.slice(0, 80)).toMatch(/set\s+search_path\s*=\s*''/i);
    for (const f of ['is_non_place', 'resolve_venue', 'take_geocode_budget', 'scrub_held_non_place']) {
      expect(sql, f).toMatch(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+private\\.${f}\\s*\\(`, 'i'));
    }
  });
  describe('(c) resolve_venue is the ingest_rpcs original plus the A9-3 block', () => {
    const body = (sql) => {
      const m = /create\s+(?:or\s+replace\s+)?function\s+private\.resolve_venue\b/i.exec(sql);
      if (!m) throw new Error('no resolve_venue definition');
      const end = sql.indexOf('end $$;', m.index);
      if (end < 0) throw new Error('resolve_venue has no end $$;');
      return sql.slice(m.index, end + 'end $$;'.length);
    };
    const lines = (t) => t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const original = () => lines(body(read('ingest_rpcs')));
    const fixed = () => lines(body(read('chamber_fixes')));
    const norm1 = (ls) => ls.join('\n').replace(/^create (or replace )?function/i, 'create function');
    it('with the block removed it equals the original', () => {
      const f = fixed();
      const b = f.findIndex((l) => /-- A9-3 begin/.test(l));
      const e = f.findIndex((l) => /-- A9-3 end/.test(l));
      expect(b).toBeGreaterThan(-1);
      expect(e).toBeGreaterThan(b);
      expect(norm1([...f.slice(0, b), ...f.slice(e + 1)])).toEqual(norm1(original()));
    });
    it('the block sits after the v_in_box update and directly before return v_id;', () => {
      const f = fixed();
      const b = f.findIndex((l) => /-- A9-3 begin/.test(l));
      const e = f.findIndex((l) => /-- A9-3 end/.test(l));
      expect(f[b - 1]).toBe('end if;');
      expect(f[b - 2]).toMatch(/where id = v_id and lat is null and not outside_region;/);
      expect(f[e + 1]).toBe('return v_id;');
    });
  });
  it('is the last migration but enable_vlt (which sorts after it)', () => {
    const sqls = files.filter((x) => x.endsWith('.sql'));
    expect(sqls.indexOf(fileFor('chamber_fixes'))).toBe(sqls.indexOf(fileFor('enable_chamber')) + 1);
  });
});

// S1.13 step 3 / Amendment 2 D13: tdrpd_auto promotes TDRPD to trust auto; vlt_strict_auto gives Visit Lake Tahoe the strict rule. Neither adds a grant.
describe('tdrpd_auto keeps the canonical block and the unchanged allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists, sorts after enable_tdrpd, and its allowlist is the 23 of enable_tdrpd', () => {
    const f = fileFor('tdrpd_auto');
    expect(f, 'no migration named *_tdrpd_auto.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('enable_tdrpd').slice(0, 14)).toBe(true);
    const cur = G('tdrpd_auto');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('enable_tdrpd')].sort());
    expect(createdFns(read('tdrpd_auto')).size).toBe(0);
  });
  it('is one update that sets trust to auto for tdrpd only', () => {
    const sql = read('tdrpd_auto');
    expect([...sql.matchAll(/update\s+public\.sources/gi)].length).toBe(1);
    const upd = sql.match(/update\s+public\.sources[^;]*;/i)[0];
    expect(upd).toMatch(/set\s+trust\s*=\s*'auto'\s+where\s+slug\s*=\s*'tdrpd'/i);
    expect(upd).not.toMatch(/\bstrict_auto\b|\benabled\b/i);
    expect(sql).not.toMatch(/\bstrict_auto\s*=\s*true\b/i);
  });
});

describe('vlt_strict_auto keeps the canonical block and the unchanged allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  it('exists, sorts directly after tdrpd_auto, and its allowlist is the 23 of tdrpd_auto', () => {
    const f = fileFor('vlt_strict_auto');
    expect(f, 'no migration named *_vlt_strict_auto.sql').toBeTruthy();
    const sqlFiles = files.filter((x) => x.endsWith('.sql'));
    expect(sqlFiles[sqlFiles.indexOf(f) - 1]).toBe(fileFor('tdrpd_auto'));
    expect(f.slice(0, 14) > fileFor('tdrpd_auto').slice(0, 14)).toBe(true);
    const cur = G('vlt_strict_auto');
    expect(cur.size).toBe(23);
    expect([...cur].sort()).toEqual([...G('tdrpd_auto')].sort());
    expect(createdFns(read('vlt_strict_auto')).size).toBe(0);
  });
  it('is one update that touches only strict_auto, for visit-lake-tahoe, citing Amendment 2 D13', () => {
    const sql = read('vlt_strict_auto');
    expect([...sql.matchAll(/update\s+public\.sources/gi)].length).toBe(1);
    const upd = sql.match(/update\s+public\.sources[^;]*;/i)[0];
    expect(upd).toMatch(/set\s+strict_auto\s*=\s*true\s+where\s+slug\s*=\s*'visit-lake-tahoe'/i);
    expect(upd).not.toMatch(/\btrust\b|\benabled\b/i);
    expect(sql).toMatch(/Amendment 2/);
    expect(sql).toMatch(/D13/);
  });
});

// AC-R2a-12 (Amendment 10, R2a-db): the manifest RPC migration adds exactly one grant and one public function.
describe('event_pages_read keeps the canonical block and adds exactly list_event_pages()', () => {
  const G = (n) => canonicalGrants(read(n));
  const sqlFiles = () => files.filter((x) => x.endsWith('.sql'));
  it('exists and sorts directly after vlt_strict_auto', () => {
    const f = fileFor('event_pages_read');
    expect(f, 'no migration named *_event_pages_read.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('vlt_strict_auto').slice(0, 14)).toBe(true);
    expect(sqlFiles()[sqlFiles().indexOf(f) - 1]).toBe(fileFor('vlt_strict_auto'));
  });
  it('ends with the canonical block; its grants are the predecessor set plus list_event_pages()->anon,authenticated (24)', () => {
    const prev = G('vlt_strict_auto');
    const cur = G('event_pages_read');
    expect(prev.size).toBe(23);
    expect(cur.size).toBe(24);
    expect([...cur].filter((x) => !prev.has(x))).toEqual(['public.list_event_pages()->anon,authenticated']);
    expect([...prev].filter((x) => !cur.has(x))).toEqual([]);
    expect(createdFns(read('event_pages_read'))).toEqual(new Set(['list_event_pages']));
    expect(cumulativeProblems(prev, cur, createdFns(read('event_pages_read')))).toEqual([]);
  });
  it('event_pages_read grants exactly 24 functions (W1 grows the newest allowlist; see the W1 block)', () => {
    expect(canonicalGrants(read('event_pages_read')).size).toBe(24);
  });
  it('replaces private.events_before_write as a verbatim copy plus one marked R2a block', () => {
    const fnBody = (sql) => {
      const m = /create (?:or replace )?function private\.events_before_write\(\)[\s\S]*?\nend \$\$;/.exec(sql);
      if (!m) throw new Error('events_before_write not found');
      return m[0];
    };
    const base = norm(fnBody(readFileSync(join(DIR, fileFor('ingest_tables')), 'utf8'))).replace('create function', 'create or replace function');
    const sql = read('event_pages_read');
    expect(sql).toMatch(/-- R2a begin/);
    expect(sql).toMatch(/-- R2a end/);
    const cur = fnBody(sql);
    const stripped = norm(cur.replace(/-- R2a begin[\s\S]*?-- R2a end/, ''));
    expect(stripped).toBe(base);
    expect(cur).toContain("raise exception 'published_at_immutable' using errcode = '22023', detail = 'published_at'");
    expect(cur.indexOf('-- R2a end')).toBeLessThan(cur.indexOf('return new;'));
  });
  it('the suppression helper has no grant and the RPC pins search_path', () => {
    const sql = stripComments(read('event_pages_read'));
    expect(sql).toMatch(/create function private\.event_matches_suppression\(e public\.events\)/);
    expect(sql).not.toMatch(/grant execute on function private\./i);
    expect(sql).toMatch(/create function public\.list_event_pages\(\)\s+returns jsonb\s+language sql stable security definer set search_path = ''/i);
  });
});

// AC-R2a-20 wiring: the REST-level test is a script, a CI step after the concurrency run, and kept out of vitest.
describe('db:test:rest wiring (R2a-db)', () => {
  it('package.json pins db:test:rest by string equality', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['db:test:rest']).toBe('node --test scripts/manifest-rest.dbtest.mjs scripts/api-rest.dbtest.mjs');   // W1.2
  });
  it('ci.yml db job exports the local API URL and keys, then runs db:test:rest after db:test:concurrency', () => {
    const ci = parseYaml(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    const steps = ci.jobs.db.steps;
    const at = (re) => steps.findIndex((st) => typeof st.run === 'string' && re.test(st.run));
    const keys = at(/supabase status -o env \| grep -E '\^\(API_URL\|ANON_KEY\|PUBLISHABLE_KEY\)='/);
    const conc = at(/npm run db:test:concurrency/);
    const rest = at(/npm run db:test:rest/);
    const dbUrl = at(/supabase status -o env \| grep '\^DB_URL='/);
    expect(keys, 'no API_URL/ANON_KEY/PUBLISHABLE_KEY export step').toBeGreaterThan(-1);
    expect(steps[keys].run).toContain("tr -d '\"'");
    expect(steps[keys].run).toContain('>> "$GITHUB_ENV"');
    expect(keys).toBeGreaterThan(dbUrl);
    expect(keys).toBeLessThan(rest);
    expect(rest).toBeGreaterThan(conc);
    expect(JSON.stringify(steps)).not.toMatch(/secrets\./);
  });
  it('the REST test file exists, is a .dbtest.mjs (outside vitest), and reads max_rows from config.toml', () => {
    const f = join(REPO_ROOT, 'scripts', 'manifest-rest.dbtest.mjs');
    const src = readFileSync(f, 'utf8');
    expect(src).toContain('max_rows');
    expect(src).toContain('/rest/v1/rpc/list_event_pages');
    expect(src).toMatch(/PUBLISHABLE_KEY \?\? [A-Za-z_.]*ANON_KEY|PUBLISHABLE_KEY \|\| /);
  });
});

// AC-R4a-09 (Amendment 10, R4a): the tags/notices migration keeps the predecessor's 24 grants and creates no public function.
describe('tags_notices keeps the canonical block and the unchanged 24-grant allowlist', () => {
  const G = (n) => canonicalGrants(read(n));
  const sqlFiles = () => files.filter((x) => x.endsWith('.sql'));
  it('exists and sorts directly after event_pages_read', () => {
    const f = fileFor('tags_notices');
    expect(f, 'no migration named *_tags_notices.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('event_pages_read').slice(0, 14)).toBe(true);
    expect(sqlFiles()[sqlFiles().indexOf(f) - 1]).toBe(fileFor('event_pages_read'));
  });
  it('its grants equal event_pages_read (24) and it creates no public function', () => {
    const prev = G('event_pages_read');
    const cur = G('tags_notices');
    expect(prev.size).toBe(24);
    expect(cur.size).toBe(24);
    expect([...cur].sort()).toEqual([...prev].sort());
    expect(createdFns(read('tags_notices')).size).toBe(0);
    expect(cumulativeProblems(prev, cur, createdFns(read('tags_notices')))).toEqual([]);
  });
  it('tags_notices grants exactly 24 functions (W1 grows the newest allowlist; see the W1 block)', () => {
    expect(canonicalGrants(read('tags_notices')).size).toBe(24);
  });
  it('no helper or hide function is granted', () => {
    const sql = stripComments(read('tags_notices'));
    expect(sql).not.toMatch(/grant execute on function private\./i);
    for (const fn of ['notice_rest', 'notice_sibling_exists', 'is_notice_title', 'valid_reason_code', 'hide_notice_events']) {
      expect(sql).toMatch(new RegExp(`create function private\\.${fn}\\(`));
    }
  });
  const body = (sql, name, re) => {
    const m = re.exec(sql);
    if (!m) throw new Error(`${name} not found`);
    return m[0];
  };
  it('replaces private.clean_source_item as a verbatim copy of the alibi version plus marked R4a blocks', () => {
    const re = /create (?:or replace )?function private\.clean_source_item[\s\S]*?\nend \$\$;/;
    const base = norm(body(read('alibi_venue_fixup'), 'base', re));
    const cur = body(read('tags_notices'), 'cur', re);
    const stripped = norm(cur.replace(/-- R4a begin[\s\S]*?-- R4a end/g, ''));
    expect(stripped).toBe(base);
    expect(cur.match(/-- R4a begin/g).length).toBe(cur.match(/-- R4a end/g).length);
    expect(cur).toContain("return jsonb_build_object('reject', 'notice')");
    expect(cur).toContain("'tag_reasons', to_jsonb(v_reasons)");
    expect(cur.indexOf("reject', 'notice'")).toBeGreaterThan(cur.indexOf("'reject', 'window'"));
    expect(cur.indexOf("reject', 'notice'")).toBeLessThan(cur.indexOf("'reject', 'url'"));
    expect(cur).toContain("array_remove(array_remove(v_cats, 'kids'), 'family')");   // DR12 mirror (R4a-1)
    expect(cur.indexOf('private.valid_reason_code')).toBeLessThan(cur.indexOf('from public.suppressions'));
  });
  it('replaces private.apply_items as a verbatim copy of the ingest_rpcs version plus marked R4a lines', () => {
    const re = /create (?:or replace )?function private\.apply_items[\s\S]*?\nend \$\$;/;
    const base = norm(body(read('ingest_rpcs'), 'base', re)).replace('create function', 'create or replace function');
    const cur = body(read('tags_notices'), 'cur', re);
    // lines that exist only for R4a, then the inline R4a additions are undone
    const undone = cur
      .replace(/-- R4a begin[\s\S]*?-- R4a end/g, '')
      .replace(/\n\s*tag_reasons = v_reasons,\s+-- R4a\n/, '\n')
      .replace(/, tag_reasons\)\s+-- R4a\n/, ')\n')
      .replace(/, v_reasons\)\s+-- R4a\n/, ')\n')
      .replace(/, tag_reasons = v_reasons\s+-- R4a\n/, '\n')
      .replace(/, parser_version, tag_reasons\)\s+-- R4a\n/, ', parser_version)\n')
      .replace(/v_parser, v_reasons\);\s+-- R4a/, 'v_parser);');
    expect(norm(undone)).toBe(base);
    expect((cur.match(/-- R4a/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(cur).toContain("v_reasons := array(select jsonb_array_elements_text(coalesce(rec -> 'tag_reasons', '[]'::jsonb)));");
  });
});

// AC-R4c-01 (Amendment R4b-1 r2): the re-tag activation migration.
describe('retag_activate: series rule, hide re-run, sources reset, unchanged 24 grants', () => {
  const G = (n) => canonicalGrants(read(n));
  const sqlFiles = () => files.filter((x) => x.endsWith('.sql'));
  const re = /create (?:or replace )?function private\.notice_sibling_exists[\s\S]*?\n\$\$;/;
  const fnBody = (sql) => {
    const m = re.exec(sql);
    if (!m) throw new Error('notice_sibling_exists not found');
    return m[0];
  };
  it('exists, sorts after tags_notices, and no two files share a version', () => {
    const f = fileFor('retag_activate');
    expect(f, 'no migration named *_retag_activate.sql').toBeTruthy();
    expect(f.slice(0, 14) > fileFor('tags_notices').slice(0, 14)).toBe(true);
    expect(sqlFiles()[sqlFiles().indexOf(f) - 1]).toBe(fileFor('tags_notices'));
    const versions = sqlFiles().map((x) => x.slice(0, 14));
    expect(new Set(versions).size).toBe(versions.length);
  });
  it('replaces private.notice_sibling_exists as a verbatim copy plus one R4c block and one R4c line', () => {
    const base = norm(fnBody(read('tags_notices'))).replace('create function', 'create or replace function');
    const sql = read('retag_activate');
    const cur = fnBody(sql);
    expect((cur.match(/-- R4c begin/g) ?? []).length).toBe(1);
    expect((cur.match(/-- R4c end/g) ?? []).length).toBe(1);
    const block = /-- R4c begin[\s\S]*?-- R4c end/.exec(cur)[0];
    expect(block).toContain('>= 2');
    expect(block).toContain('p_day - 14 and p_day + 14');
    expect(block).toContain('lower(se.title)');
    const lines = cur.split('\n').filter((l) => /-- R4c\s*$/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('lower(se.title)');
    const undone = cur.replace(/-- R4c begin[\s\S]*?-- R4c end\n?/, '').replace(/lower\(se\.title\)([^\n]*?)\s*-- R4c/, 'lower(e.title)$1');
    expect(norm(undone)).toBe(base);
    expect(cur.indexOf('-- R4c begin')).toBeGreaterThan(cur.indexOf('private.notice_rest(p_title))'));
    expect(cur.indexOf('-- R4c end')).toBeLessThan(cur.lastIndexOf('$$;'));
  });
  it('re-runs the hide once and resets the sources cache columns only', () => {
    const sql = stripComments(read('retag_activate'));
    expect((sql.match(/select private\.hide_notice_events\(\);/g) ?? []).length).toBe(1);
    expect(sql).not.toMatch(/create (or replace )?function private\.hide_notice_events/);
    const ups = [...sql.matchAll(/update public\.sources\s+set([\s\S]*?);/gi)].map((m) => m[1]);
    expect(ups.length).toBe(1);
    expect(norm(ups[0])).toBe('etag = null, last_modified = null, content_hash = null, next_due_at = now() where enabled');
  });
  it('ends with the canonical block; grants equal tags_notices (24); no public function; no private grant', () => {
    const prev = G('tags_notices');
    const cur = G('retag_activate');
    expect(prev.size).toBe(24);
    expect(cur.size).toBe(24);
    expect([...cur].sort()).toEqual([...prev].sort());
    expect(createdFns(read('retag_activate')).size).toBe(0);
    expect(cumulativeProblems(prev, cur, createdFns(read('retag_activate')))).toEqual([]);
    expect(stripComments(read('retag_activate'))).not.toMatch(/grant execute on function private\./i);
  });
  it('retag_activate grants exactly 24 functions (W1 grows the newest allowlist; see the W1 block)', () => {
    expect(canonicalGrants(read('retag_activate')).size).toBe(24);
  });
});

describe('W1 api_events_v1 migration: canonical block, cumulative allowlist + api_events_v1 (25)', () => {
  const sqlFiles = () => files.filter((x) => x.endsWith('.sql'));
  it('is the newest migration and sorts after 20261023000300_ttusd_schools.sql', () => {
    expect(sqlFiles().pop()).toBe('20261024000100_api_events_v1.sql');
    expect('20261024000100_api_events_v1.sql' > '20261023000300_ttusd_schools.sql').toBe(true);
  });
  it('its grants are the ttusd_schools set plus api_events_v1(...)->anon,authenticated', () => {
    const prev = canonicalGrants(readFileSync(join(DIR, '20261023000300_ttusd_schools.sql'), 'utf8'));
    const sql = read('api_events_v1');
    const cur = canonicalGrants(sql);
    expect(prev.size).toBe(24);
    expect(cur.size).toBe(25);
    expect([...cur].filter((x) => !prev.has(x))).toEqual(['public.api_events_v1(text,text,integer,date,date,text[],text[],integer,text)->anon,authenticated']);
    expect(cumulativeProblems(prev, cur, createdFns(sql))).toEqual([]);
  });
  it('grants nothing in private and pins search_path on every function', () => {
    const sql = read('api_events_v1');
    expect(stripComments(sql)).not.toMatch(/grant execute on function private\./i);
    const headers = sql.match(/create\s+(?:or\s+replace\s+)?function[\s\S]*?\bas\s+\$/gi) ?? [];
    expect(headers.length).toBeGreaterThanOrEqual(10);
    for (const h of headers) expect(h, h.slice(0, 80)).toMatch(/set\s+search_path\s*=\s*''/i);
  });
});

// A13 r7 (AC-M1-143, AC-M1-148): the Tahoe Donner migration ships at trust review and its self-check is scoped to its own rows.
describe('tahoe_donner (A13 r7)', () => {
  const sql = () => read('tahoe_donner');
  it('is idempotent in text: on conflict do nothing, drop constraint if exists', () => {
    expect(sql()).toContain('on conflict (slug) do nothing');
    expect(sql()).toContain('drop constraint if exists sources_family_check');
  });
  it("ships at trust 'review' and never sets trust = 'auto' (AC-M1-143)", () => {
    expect(sql()).toContain("trust = 'review'");
    expect(sql()).not.toMatch(/trust\s*=\s*'auto'/);
  });
  it('the self-check has no global source or category count (AC-M1-148)', () => {
    expect(sql()).not.toMatch(/count\(\*\)\s+from\s+public\.sources\s+where\s+enabled/i);
    expect(sql()).not.toMatch(/count\(\*\)\s+from\s+public\.categories\s*\)/i);
    expect(sql()).toContain('tahoe_donner_state');
  });
});
