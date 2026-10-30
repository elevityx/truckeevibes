// A13 r7-5 / r7-6 (AC-M1-147, AC-M1-148): the Tahoe Donner migration re-applies cleanly and its self-check is scoped.
// Run with `npm run db:test:reapply` (node:test) against a freshly reset local stack. Every case runs in a transaction that is rolled back.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { REPO_ROOT } from './_testlib.mjs';

const DB_URL = process.env.DB_URL ?? 'postgresql://postgres@127.0.0.1:55422/postgres';
const u = new URL(DB_URL);
const mk = () => new pg.Client({
  host: u.hostname, port: Number(u.port), database: u.pathname.slice(1) || 'postgres',
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) || 'postgres', connectionTimeoutMillis: 5000,
});
const dir = join(REPO_ROOT, 'supabase', 'migrations');
const file = readdirSync(dir).find((f) => f.endsWith('_tahoe_donner.sql'));
const SQL = file ? readFileSync(join(dir, file), 'utf8') : '';

// One client per case; begin ... rollback in finally.
async function inTx(fn) {
  const c = mk();
  await c.connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    try { await c.query('rollback'); } finally { await c.end(); }
  }
}
const rowChecks = async (c) => {
  const s = await c.query(`select count(*)::int n from public.sources where slug = 'tahoe-donner' and enabled and trust = 'review' and not strict_auto and cadence = '24h'
    and family = 'html_tahoedonner' and ingest_disposition = 'permitted' and allowed_methods = array['html']::text[] and page_cap = 45 and terms_recheck_at = '2027-10-17'::date
    and allowed_hosts = array['www.tahoedonner.com'] and class = 'organizer' and ai_bots_blocked = false`);
  assert.equal(s.rows[0].n, 1);
  const m = await c.query(`select label || '|' || sort || '|' || noun v from public.categories where slug = 'members-only'`);
  assert.deepEqual(m.rows.map((r) => r.v), ['Members only|15|members-only event']);
};

before(async () => {
  assert.ok(file, 'no migration named *_tahoe_donner.sql');
  const c = mk();
  try { await c.connect(); await c.query('select 1'); } catch { throw new Error(`db_unreachable ${u.hostname}:${u.port}`); }
  await c.end();
});
after(() => {});

test('(a) applying the migration body twice on the reset DB succeeds and leaves one members-only row', async () => {
  await inTx(async (c) => {
    // Precondition: 0 A14-family rows on the A13 branch, 2 once the A14 migration exists.
    const hasA14 = readdirSync(dir).some((f) => f.endsWith('_bars_aviation.sql'));
    const pre = await c.query(`select count(*)::int n from public.sources where family in ('wprest_crystalbay','curated_dates')`);
    assert.equal(pre.rows[0].n, hasA14 ? 2 : 0);
    await c.query(SQL);
    await c.query(SQL);
    await rowChecks(c);
    const n = await c.query(`select count(*)::int n from public.categories where slug = 'members-only'`);
    assert.equal(n.rows[0].n, 1);
  });
});

test('(b) a changed members-only label is rejected with tahoe_donner_state', async () => {
  await inTx(async (c) => {
    await c.query(`update public.categories set label = 'Members' where slug = 'members-only'`);
    await assert.rejects(() => c.query(SQL), /tahoe_donner_state/);
  });
});

test('(c) an unrelated source paused elsewhere does not break the self-check', async () => {
  await inTx(async (c) => {
    await c.query(`update public.sources set enabled = false where slug = 'alibi-truckee'`);
    await c.query(SQL);
    await rowChecks(c);
  });
});

const A13_FAMILIES = ['tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager','rss','squarespace','jsonld','html','llm','html_finalsite','html_tahoedonner'];
const setCheck = (c, fams) => c.query(`alter table public.sources drop constraint sources_family_check;
  alter table public.sources add constraint sources_family_check check (family in (${fams.map((f) => `'${f}'`).join(',')}))`);
const famDef = async (c) => (await c.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_family_check'`)).rows[0].d;

test('(d) reapplies over a post-A14 database (widen-only CHECK, A14 rows kept) (AC-M1-157)', async () => {
  await inTx(async (c) => {
    // On the A14 branch the reset DB already has the A14 families and rows; on A13 we simulate A14 here.
    await setCheck(c, [...A13_FAMILIES, 'wprest_crystalbay', 'curated_dates']);
    await c.query(`insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values
      ('r3-cbc', 'R3 CBC', 'https://example.test/', array['example.test'], 'wprest_crystalbay', 'venue'),
      ('r3-cur', 'R3 CUR', 'https://example.test/', array['example.test'], 'curated_dates', 'community')`);
    const before = await famDef(c);
    await c.query(SQL);
    await c.query(SQL);
    const fam = await c.query(`select slug, family from public.sources where slug in ('r3-cbc','r3-cur') order by slug`);
    assert.deepEqual(fam.rows, [{ slug: 'r3-cbc', family: 'wprest_crystalbay' }, { slug: 'r3-cur', family: 'curated_dates' }]);
    assert.equal(await famDef(c), before);
    await c.query('savepoint sp');
    await assert.rejects(() => c.query(`insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class)
      values ('r3-bogus', 'B', 'https://example.test/', array['example.test'], 'html_bogus', 'venue')`), (e) => e.code === '23514');
    await c.query('rollback to savepoint sp');
    await rowChecks(c);
  });
});

test('(e) widens a narrower CHECK to include html_tahoedonner (AC-M1-157)', async () => {
  await inTx(async (c) => {
    // This case's own setup: park the tahoe-donner row (and any later amendment's family rows) on 'html' so the narrower CHECK can be built.
    await c.query(`update public.sources set family = 'html' where slug = 'tahoe-donner' or family in ('wprest_crystalbay', 'curated_dates')`);
    await setCheck(c, A13_FAMILIES.filter((f) => f !== 'html_tahoedonner'));
    assert.ok(!(await famDef(c)).includes('html_tahoedonner'));
    await c.query(SQL);
    assert.ok((await famDef(c)).includes('html_tahoedonner'));
    await rowChecks(c);
  });
});
