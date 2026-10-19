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
