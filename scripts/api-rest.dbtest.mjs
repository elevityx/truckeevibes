// AC-W1-18 / 18b: api_events_v1 through PostgREST as anon (latency with 5,000 published events, bounds as a 400) and the anon
// statement_timeout cancelling a deliberately slow call (57014). Run with `npm run db:test:rest` (node:test) against the running
// local stack. Inputs from `supabase status -o env`: DB_URL, API_URL, and PUBLISHABLE_KEY or ANON_KEY (local demo keys, public).
// Fixtures carry a per-run random suffix and are removed in `after`; the test-only RPC is dropped in a `finally`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DB_URL = process.env.DB_URL ?? 'postgresql://postgres@127.0.0.1:55422/postgres';
const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:55421').replace(/\/$/, '');
const KEY = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const EVENTS = 5000;
const sfx = randomBytes(4).toString('hex');
const ARGS = { p_scope: null, p_season: null, p_year: null, p_from: null, p_to: null, p_areas: null, p_categories: null, p_limit: null, p_cursor: null };

const u = new URL(DB_URL);
const db = new pg.Client({
  host: u.hostname, port: Number(u.port), database: u.pathname.slice(1) || 'postgres',
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) || 'postgres', connectionTimeoutMillis: 5000,
});

const rpc = (name, body, timeoutMs = 30_000) =>
  fetch(`${API_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

const reloadSchema = () => db.query(`notify pgrst, 'reload schema'`);
// poll PostgREST's OpenAPI root until the RPC is (or is no longer) in its schema cache, without calling it
async function waitForRpc(name, present, maxMs = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${API_URL}/rest/v1/`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(2_000) })
      .catch(() => null);
    const doc = res && res.ok ? await res.json().catch(() => null) : null;
    if (doc && Boolean(doc.paths?.[`/rpc/${name}`]) === present) return;
    if (Date.now() - t0 > maxMs) throw new Error(`rpc ${name} ${present ? 'never appeared' : 'never disappeared'} in the schema cache`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  assert.ok(KEY, 'PUBLISHABLE_KEY or ANON_KEY is required (supabase status -o env)');
  try {
    await db.connect();
    await db.query('select 1');
  } catch {
    throw new Error(`db_unreachable ${u.hostname}:${u.port}`);
  }
  await db.query(
    `with v as (
       insert into public.venues (name, normalized_name, address, town, area, lat, lng)
       values ('Rest Hall ' || $1::text, 'rest hall ' || $1::text, '10 Main St', 'Truckee', 'truckee', 39.328, -120.1833) returning id)
     insert into public.events (region_id, title, summary, starts_at, time_known, venue_id, area, status, published_at, organizer_url)
     select (select r.id from public.regions r order by r.slug limit 1), 'Example Api Event ' || n || ' ' || $1::text,
            'Synthetic summary for the API REST fixture', now() + interval '20 minutes' * n, true, v.id, 'truckee', 'published',
            now() - interval '1 day', 'https://example.org/api/' || n
       from v, generate_series(1, ${EVENTS}) n`, [sfx]);
  await db.query('analyze public.events');
});

after(async () => {
  try {
    await db.query('begin');
    await db.query("select set_config('tv.retention', 'on', true)");
    await db.query(`delete from public.event_changes where event_id in (select id from public.events where title like '%' || $1)`, [sfx]);
    await db.query(`delete from public.events where title like '%' || $1`, [sfx]);
    await db.query(`delete from public.venues where name = 'Rest Hall ' || $1::text`, [sfx]);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    await db.end().catch(() => {});
  }
});

test('AC-W1-18 POST rpc/api_events_v1 as anon (vibes, limit 500, default window) with 5,000 events: 200 in < 1,000 ms', async () => {
  await rpc('api_events_v1', { ...ARGS, p_scope: 'vibes', p_limit: 500 }).then((r) => r.arrayBuffer()); // warm the plan cache once
  const t0 = performance.now();
  const res = await rpc('api_events_v1', { ...ARGS, p_scope: 'vibes', p_limit: 500 });
  const body = await res.json();
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
  assert.equal(body.count, 500);
  assert.equal(body.events.length, 500);
  assert.equal(typeof body.nextCursor, 'string');
});

test('AC-W1-18 p_limit 501 -> 400 with PostgREST code 22023', async () => {
  const res = await rpc('api_events_v1', { ...ARGS, p_scope: 'vibes', p_limit: 501 });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, '22023');
  assert.equal(body.details, 'limit');
});

test('AC-W1-18b the anon statement_timeout cancels a slow RPC with 57014 in < 4,500 ms', async () => {
  try {
    await db.query(`create function public.tv_test_slow() returns int language sql as $$ select pg_sleep(5)::text::int $$`);
    await db.query('revoke execute on function public.tv_test_slow() from public, authenticated, service_role');
    await db.query('grant execute on function public.tv_test_slow() to anon');
    await reloadSchema();
    await waitForRpc('tv_test_slow', true);
    const t0 = performance.now();
    const res = await rpc('tv_test_slow', {}, 10_000);
    const body = await res.json().catch(() => ({}));
    const ms = performance.now() - t0;
    assert.ok(res.status >= 400, `status ${res.status}`);
    assert.equal(body.code, '57014');
    assert.ok(ms < 4500, `took ${Math.round(ms)} ms`);
  } finally {
    await db.query('drop function if exists public.tv_test_slow()');
    await reloadSchema();
  }
});

test('AC-W1-18b tv_test_slow no longer exists (01_acl stays exact)', async () => {
  const r = await db.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.proname = 'tv_test_slow'`);
  assert.equal(r.rows[0].n, 0);
  await waitForRpc('tv_test_slow', false);
});
