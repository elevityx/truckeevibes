// A14 r3-9 (AC-M1-159): the bars/aviation migration re-applies cleanly, widens the family CHECK only, and validates rows it didn't write.
// Run with `npm run db:test:reapply` (node:test) against a freshly reset local stack. Every case runs in a transaction that is rolled back. No parking.
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
const read = (suffix) => { const f = readdirSync(dir).find((n) => n.endsWith(suffix)); return f ? readFileSync(join(dir, f), 'utf8') : ''; };
const SQL = read('_bars_aviation.sql');
const A13_SQL = read('_tahoe_donner.sql');

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
// M1 manual (20261031000100_manual_sources.sql) makes bar-of-america and fiftyfifty-brewing manual-only; the A14 body's self-check
// still describes them as link-only manifest rows, so a re-apply case first puts them back to their A14 state (rolled back).
const toA14 = (c) => c.query(`update public.sources set enabled = false, manual_only = false, automation_restricted = false, family = 'html', trust = 'link_only',
    ingest_disposition = 'unknown', allowed_methods = '{}', allowed_hosts = array[case slug when 'bar-of-america' then 'www.barofamerica.com' else 'www.fiftyfiftybrewing.com' end]
  where slug in ('bar-of-america', 'fiftyfifty-brewing')`);
const famDef = async (c) => (await c.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_family_check'`)).rows[0].d;
const SLUGS = ['crystal-bay-casino', 'moodys-bistro', 'eaa-1073-breakfast', 'bar-of-america', 'rmu-truckee', 'tourist-club', 'cottonwood-truckee', 'fiftyfifty-brewing',
  'glasses-wine-bar', 'the-grid-kings-beach', 'gar-woods'];

before(async () => {
  assert.ok(SQL && A13_SQL, 'missing *_bars_aviation.sql or *_tahoe_donner.sql');
  const c = mk();
  try { await c.connect(); await c.query('select 1'); } catch { throw new Error(`db_unreachable ${u.hostname}:${u.port}`); }
  await c.end();
});
after(() => {});

test('(a) applying the body twice on the reset DB succeeds: 11 slugs once each, Crystal Bay at review, CHECK def unchanged (AC-M1-159)', async () => {
  await inTx(async (c) => {
    await toA14(c);
    const before = await famDef(c);
    await c.query(SQL);
    await c.query(SQL);
    const r = await c.query(`select slug, count(*)::int n from public.sources where slug = any($1) group by slug`, [SLUGS]);
    assert.equal(r.rows.length, 11);
    assert.ok(r.rows.every((x) => x.n === 1));
    const row = await c.query(`select string_agg(slug || ':' || enabled || ':' || trust, ';' order by slug) v from public.sources where slug in ('crystal-bay-casino','moodys-bistro','eaa-1073-breakfast')`);
    assert.equal(row.rows[0].v, 'crystal-bay-casino:true:review;eaa-1073-breakfast:true:auto;moodys-bistro:true:auto');
    assert.equal(await famDef(c), before);
  });
});

test('(b) the A13 body, then the A14 body, over the post-A14 DB succeeds and keeps both A14 families allowed', async () => {
  await inTx(async (c) => {
    await toA14(c);
    await c.query(A13_SQL);
    await c.query(SQL);
    const d = await famDef(c);
    assert.ok(d.includes('wprest_crystalbay') && d.includes('curated_dates') && d.includes('html_tahoedonner'));
    const n = await c.query(`select count(*)::int n from public.sources where family in ('wprest_crystalbay','curated_dates')`);
    assert.equal(n.rows[0].n, 2);
  });
});

test('(c) a changed Crystal Bay homepage_url is rejected with bars_aviation_state', async () => {
  await inTx(async (c) => {
    await toA14(c);
    await c.query(`update public.sources set homepage_url = 'https://example.test/' where slug = 'crystal-bay-casino'`);
    await assert.rejects(() => c.query(SQL), /bars_aviation_state/);
  });
});

test('(d) a changed manifest homepage_url (gar-woods) is rejected with bars_aviation_state', async () => {
  await inTx(async (c) => {
    await toA14(c);
    await c.query(`update public.sources set homepage_url = 'https://example.test/' where slug = 'gar-woods'`);
    await assert.rejects(() => c.query(SQL), /bars_aviation_state/);
  });
});

test('(e) an unrelated source paused elsewhere does not break the self-check', async () => {
  await inTx(async (c) => {
    await toA14(c);
    await c.query(`update public.sources set enabled = false where slug = 'alibi-truckee'`);
    await c.query(SQL);
  });
});
