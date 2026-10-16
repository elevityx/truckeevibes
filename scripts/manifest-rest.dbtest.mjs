// AC-R2a-20: list_event_pages() through PostgREST with more qualifying pages than max_rows (DR15 envelope, so the cap cannot cut it).
// Run with `npm run db:test:rest` (node:test) against the running local stack. Inputs from `supabase status -o env`:
// DB_URL, API_URL, and PUBLISHABLE_KEY or ANON_KEY (the local demo keys; public, never secrets).
// The fixtures are COMMITTED, every title carries a per-run random suffix, and nothing asserts a global count.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const DEFAULT_DB_URL = 'postgresql://postgres@127.0.0.1:55422/postgres';
const DB_URL = process.env.DB_URL ?? DEFAULT_DB_URL;
const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:55421').replace(/\/$/, '');
const KEY = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
const PAGES = 2101;
const sfx = randomBytes(4).toString('hex');

const maxRows = () => {
  const toml = readFileSync(fileURLToPath(new URL('../supabase/config.toml', import.meta.url)), 'utf8');
  const m = /^max_rows\s*=\s*(\d+)/m.exec(toml);
  if (!m) throw new Error('no max_rows in supabase/config.toml');
  return Number(m[1]);
};

const u = new URL(DB_URL);
const db = new pg.Client({
  host: u.hostname, port: Number(u.port), database: u.pathname.slice(1) || 'postgres',
  user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) || 'postgres', connectionTimeoutMillis: 5000,
});
let loser;
let survivor;

before(async () => {
  assert.ok(KEY, 'PUBLISHABLE_KEY or ANON_KEY is required (supabase status -o env)');
  try {
    await db.connect();
    await db.query('select 1');
  } catch {
    throw new Error(`db_unreachable ${u.hostname}:${u.port}`);
  }
  // 2,101 qualifying published events starting within the next 100 days (one per ~hour, so the order is stable).
  await db.query(
    `insert into public.events (region_id, title, summary, starts_at, time_known, status, published_at, organizer_url)
     select (select r.id from public.regions r order by r.slug limit 1),
            'Example Rest Page ' || n || ' ' || $1::text, 'Synthetic summary for the REST fixture',
            now() + interval '1 hour' * n, true, 'published', now() - interval '1 day', 'https://example.org/rest/' || n
       from generate_series(1, ${PAGES}) n`, [sfx]);
  // one formerly published loser merged into the first page, with the two journal rows of the redirect rule (same at and decided_by)
  const s = await db.query(`select id, slug from public.events where title = $1`, [`Example Rest Page 1 ${sfx}`]);
  survivor = s.rows[0];
  const l = await db.query(
    `insert into public.events (region_id, title, summary, starts_at, time_known, status, published_at)
     select region_id, $1, 'Synthetic summary for the REST loser', starts_at, true, 'published', now() - interval '1 day'
       from public.events where id = $2 returning id, slug`, [`Example Rest Loser ${sfx}`, survivor.id]);
  loser = l.rows[0];
  await db.query(`update public.events set merged_into = $2, status = 'hidden' where id = $1`, [loser.id, survivor.id]);
  const by = `admin:${randomUUID()}`;
  await db.query(
    `insert into public.event_changes (event_id, at, field, old_value, new_value, decided_by)
     values ($1, now(), 'status', '"published"', '"hidden"', $3), ($1, now(), 'merged_into', null, to_jsonb($2::uuid), $3)`,
    [loser.id, survivor.id, by]);
});

after(async () => {
  try {
    // the journal is append-only (guard trigger), so the fixture's rows are removed with triggers skipped, in one transaction
    await db.query('begin');
    await db.query('set local session_replication_role = replica');
    await db.query(`delete from public.event_changes where event_id in (select id from public.events where title like '%' || $1)`, [sfx]);
    await db.query(`delete from public.events where title like '%' || $1`, [sfx]);
    await db.query('commit');
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    await db.end().catch(() => {});
  }
});

test('config.toml max_rows is below the fixture size, so raising the cap forces a bigger fixture', () => {
  assert.ok(maxRows() < PAGES + 1, `max_rows ${maxRows()} must be < ${PAGES + 1}`);
});

test('AC-R2a-20 POST rpc/list_event_pages returns the whole envelope past max_rows', async () => {
  const res = await fetch(`${API_URL}/rest/v1/rpc/list_event_pages`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), 'the body is one JSON object');
  assert.equal(body.v, 1);
  const slugs = new Set(body.pages.map((p) => p.slug));
  const missing = [];
  const r = await db.query(`select slug from public.events where title like '%' || $1 and merged_into is null`, [sfx]);
  assert.equal(r.rowCount, PAGES);
  for (const { slug } of r.rows) if (!slugs.has(slug)) missing.push(slug);
  assert.deepEqual(missing, [], 'every fixture slug is in pages');
  assert.ok(body.redirects.some((x) => x.slug === loser.slug && x.redirectSlug === survivor.slug), 'the loser redirect is present');
  assert.ok(body.pageTotal >= PAGES);
  assert.equal(body.pages.length, Math.min(body.pageTotal, 3000));
  assert.equal(body.redirects.length, Math.min(body.redirectTotal, 1000));
});
