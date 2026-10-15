// Concurrency tests against a running local Supabase stack (spec Amendment 5 / 5.1: AC-M1-64, 65, 68).
// Run with `npm run db:test:concurrency` (node:test). The `.dbtest.mjs` suffix keeps it out of vitest's `scripts/**/*.test.mjs` include.
// pgTAP cannot do this: separate sessions cannot see another session's uncommitted transaction, so the fixtures here are COMMITTED.
// Every slug, venue name and title carries a per-run random suffix, so reruns on one local DB never collide, and no test asserts
// a global count (only fixture-scoped ones). Contexts: `set local role service_role` for svc_*; an aal2 password+totp admin
// (fixture auth.users + public.admins row) for admin_*.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

export const DEFAULT_DB_URL = 'postgresql://postgres@127.0.0.1:55422/postgres';  // the local stack password is added in mk()
const DB_URL = process.env.DB_URL ?? DEFAULT_DB_URL;
const CLUSTER_LOCK_KEY = 7311046001;

const sfx = randomBytes(4).toString('hex');
const mk = () => {
  const u = new URL(DB_URL);
  return new pg.Client({
    host: u.hostname, port: Number(u.port), database: u.pathname.slice(1) || 'postgres',
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) || 'postgres', connectionTimeoutMillis: 5000,
  });
};
const A = mk();
const B = mk();
const obs = mk();
const clients = [A, B, obs];
const endpoint = () => {
  const u = new URL(DB_URL);
  return `${u.hostname}:${u.port}`;
};

before(async () => {
  for (const c of clients) {
    try {
      await c.connect();
      await c.query('select 1');
    } catch {
      throw new Error(`db_unreachable ${endpoint()}`);
    }
  }
});
after(async () => {
  for (const c of clients) await c.end().catch(() => {});
});

// ----------------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------------
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const DAY = 86_400_000;
const at = (days, hh = 18, mm = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hh, mm, 0, 0);
  return d;
};
/** A clean SourceEvent item (the camelCase shape of pg_temp.item in the pgTAP files). */
function item(key, title, { days = 30, hh = 18, mm = 0, ...over } = {}) {
  const s = at(days, hh, mm);
  return {
    externalKey: key, title, startsAt: iso(s), endsAt: iso(new Date(s.getTime() + 2 * 3_600_000)), allDay: false, timeKnown: true,
    venueName: 'Test Hall', address: '10 Main St', town: 'Truckee', lat: 39.328, lng: -120.1833,
    url: `https://example.test/e/${key}`, priceKind: 'free', age: 'unknown', categoriesHint: ['music'], ...over,
  };
}
const q = (c, text, params) => c.query(text, params);

async function mkSource(slug, cls, trust) {
  const { rows } = await q(obs, `insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust, enabled, cadence,
      ingest_disposition, allowed_methods, terms_url, terms_hash, terms_reviewed_by, terms_reviewed_at, terms_recheck_at)
    values ($1, $2, $3, array['example.test'], 'ics', $4::public.source_class, $5::public.source_trust, true, '24h',
      'permitted', array['feed'], 'https://example.test/terms', repeat('a', 64), 'test', now(), now() + interval '30 days') returning id`,
  [slug, `Conc ${slug}`, `https://example.test/${slug}`, cls, trust]);
  return rows[0].id;
}

/** A fresh grant for exactly this source (the other due sources are pushed out first, as pg_temp.run_batch does). */
async function grantFor(slug) {
  await q(obs, 'begin');
  try {
    await q(obs, `update public.sources set next_due_at = now() + interval '1 day' where slug <> $1 and next_due_at <= now()`, [slug]);
    await q(obs, `update public.sources set next_due_at = now() where slug = $1`, [slug]);
    await q(obs, 'set local role service_role');
    const { rows } = await q(obs, 'select public.svc_issue_run_grants() as r');
    await q(obs, 'commit');
    const g = rows[0].r.grants.find((x) => x.source.slug === slug);
    assert.ok(g, `no grant issued for ${slug}`);
    return g.grant;
  } catch (e) {
    await q(obs, 'rollback').catch(() => {});
    throw e;
  }
}
const runJson = () => JSON.stringify({ status: 'ok', started_at: iso(new Date()), http_status: 200, parser_version: 'test-1' });
const ingestSql = 'select public.svc_ingest_batch($1, $2::jsonb, $3::jsonb) as r';
/** Ingest in its own committed transaction. */
async function ingestCommitted(slug, items) {
  const tok = await grantFor(slug);
  await q(B, 'begin');
  try {
    await q(B, 'set local role service_role');
    const { rows } = await q(B, ingestSql, [tok, runJson(), JSON.stringify(items)]);
    await q(B, 'commit');
    return rows[0].r;
  } catch (e) {
    await q(B, 'rollback').catch(() => {});
    throw e;
  }
}

const adminId = randomUUID();
let adminReady = false;
async function ensureAdmin() {
  if (adminReady) return;
  await q(obs, `insert into auth.users (id, aud, role, email) values ($1, 'authenticated', 'authenticated', $2) on conflict do nothing`, [adminId, `conc-${sfx}@example.test`]);
  await q(obs, `insert into public.admins (user_id, note) values ($1, 'concurrency test') on conflict do nothing`, [adminId]);
  adminReady = true;
}
const nowS = () => Math.floor(Date.now() / 1000);
const claims = () => JSON.stringify({
  sub: adminId, role: 'authenticated', is_anonymous: false, aal: 'aal2',
  amr: [{ method: 'totp', timestamp: nowS() }, { method: 'password', timestamp: nowS() - 1 }],
});
const beginAdmin = async (c) => {
  await ensureAdmin();
  await q(c, 'begin');
  await q(c, `select set_config('request.jwt.claims', $1, true)`, [claims()]);
  await q(c, 'set local role authenticated');
};
const beginService = async (c) => {
  await q(c, 'begin');
  await q(c, 'set local role service_role');
};
const pidOf = async (c) => (await q(c, 'select pg_backend_pid() as pid')).rows[0].pid;

/** Poll the observer until `pid` is blocked on a lock (and on an advisory lock for kind = 'advisory'). */
async function waitsOn(pid, kind = 'lock') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await q(obs, 'select wait_event_type, wait_event from pg_stat_activity where pid = $1', [pid]);
    const r = rows[0];
    if (r && r.wait_event_type === 'Lock' && (kind !== 'advisory' || r.wait_event === 'advisory')) return;
    await sleep(50);
  }
  assert.fail('session did not block');
}
/** Start a query without awaiting it; the promise settles to { ok, rows } or { err }, never rejects. */
const start = (c, text, params) => c.query(text, params).then((r) => ({ ok: true, rows: r.rows }), (err) => ({ err }));
/** Release everything a failed test may hold, in an order that cannot deadlock the cleanup. */
async function cleanup(pending = []) {
  await q(A, 'rollback').catch(() => {});
  await Promise.allSettled(pending);
  await q(B, 'rollback').catch(() => {});
}

/** Drain the cluster outbox so a test starts with no stale needs_cluster rows. */
async function drain() {
  for (let i = 0; i < 20; i++) {
    await beginService(B);
    try {
      const { rows } = await q(B, 'select public.svc_cluster_and_publish(500) as r');
      await q(B, 'commit');
      if (Number(rows[0].r.remaining) === 0) return;
    } catch (e) {
      await q(B, 'rollback').catch(() => {});
      throw e;
    }
  }
  assert.fail('could not drain the cluster outbox');
}

/** A committed same-venue pair: an `auto` organizer occurrence and a `review` DMO occurrence, 10 minutes apart. */
async function mkPairs(tag, n, { org, dmo }) {
  const venue = `Conc Hall ${tag} ${sfx}`;
  const base = 12 + Math.floor(Math.random() * 60); // other runs' leftovers share coordinates, so vary the day and use unrelated words
  const a = []; const b = [];
  for (let i = 0; i < n; i++) {
    const days = base + i;
    const w1 = randomBytes(5).toString('hex'); const w2 = randomBytes(5).toString('hex');
    a.push(item(`${tag}-o${i}-${sfx}`, `${w1} ${w2} Oktoberfest`, { days, hh: 18, mm: 0, venueName: venue }));
    b.push(item(`${tag}-d${i}-${sfx}`, `${w2} ${w1} Oktoberfest`, { days, hh: 18, mm: 10, venueName: venue }));
  }
  await ingestCommitted(org, a);
  await ingestCommitted(dmo, b);
  return { keys: [...a, ...b].map((x) => x.externalKey) };
}
async function pairState(keys) {
  const { rows } = await q(obs, `select se.cluster_id, count(*) over (partition by se.cluster_id) as contributors, se.needs_cluster, e.merged_into
      from public.source_events se left join public.events e on e.id = se.cluster_id where se.external_key = any($1)`, [keys]);
  return rows;
}
const fixtureSources = async (tag) => {
  const org = `conc-${tag}-org-${sfx}`; const dmo = `conc-${tag}-dmo-${sfx}`;
  await mkSource(org, 'organizer', 'auto');
  await mkSource(dmo, 'dmo', 'review');
  return { org, dmo };
};

// ----------------------------------------------------------------------------------------------------------------------
// AC-M1-64 (A5-2): serialized cluster drains
// ----------------------------------------------------------------------------------------------------------------------
test('AC-M1-64(a) a second drain waits on the advisory lock, then merges the pair into one event', { timeout: 30_000 }, async () => {
  await drain();
  const src = await fixtureSources('64a');
  const { keys } = await mkPairs('64a', 1, src);
  const pidB = await pidOf(B);
  let pB;
  try {
    await beginService(A);
    await q(A, 'select public.svc_cluster_and_publish(1)');
    await beginService(B);
    pB = start(B, 'select public.svc_cluster_and_publish(500) as r');
    await waitsOn(pidB, 'advisory');
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `second drain failed: ${res.err?.message}`);
    assert.equal(Number(res.rows[0].r.processed), 1);
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const rows = await pairState(keys);
  assert.equal(new Set(rows.map((r) => r.cluster_id)).size, 1, 'both occurrences share one event');
  assert.ok(rows.every((r) => Number(r.contributors) === 2 && r.merged_into === null && r.needs_cluster === false));
  const dup = await q(obs, `select count(*)::int as n from public.review_cards where kind = 'possible_duplicate'
      and (event_id = $1 or other_event_id = $1)`, [rows[0].cluster_id]);
  assert.equal(dup.rows[0].n, 0, 'no possible_duplicate card');
});

test('AC-M1-64(b) 20 pairs, two drains started together: exactly 20 events with 2 contributors each', { timeout: 30_000 }, async () => {
  await drain();
  const src = await fixtureSources('64b');
  const { keys } = await mkPairs('64b', 20, src);
  const run = async (c) => {
    await beginService(c);
    try {
      const { rows } = await q(c, 'select public.svc_cluster_and_publish(500) as r');
      await q(c, 'commit');
      return rows[0].r;
    } catch (e) {
      await q(c, 'rollback').catch(() => {});
      throw e;
    }
  };
  const [ra, rb] = await Promise.all([run(A), run(B)]);
  assert.equal(Number(ra.remaining), 0);
  assert.equal(Number(rb.remaining), 0);
  const rows = await pairState(keys);
  assert.equal(rows.length, 40);
  assert.equal(new Set(rows.map((r) => r.cluster_id)).size, 20, 'exactly 20 events');
  assert.ok(rows.every((r) => Number(r.contributors) === 2 && r.merged_into === null && r.needs_cluster === false), 'every event has 2 contributors');
});

test('AC-M1-64(c) a drain that cannot get the lock within its timeout returns busy and changes nothing', { timeout: 30_000 }, async () => {
  await drain();
  const src = await fixtureSources('64c');
  const { keys } = await mkPairs('64c', 1, src);
  const pidB = await pidOf(B);
  let pB;
  try {
    await q(A, 'begin');
    await q(A, 'select pg_advisory_xact_lock($1)', [CLUSTER_LOCK_KEY]);
    await beginService(B);
    pB = start(B, 'select public.svc_cluster_and_publish(500) as r');
    await waitsOn(pidB, 'advisory');
    const res = await pB;
    assert.ok(res.ok, `drain errored instead of returning busy: ${res.err?.message}`);
    const r = res.rows[0].r;
    assert.equal(r.busy, true);
    assert.equal(Number(r.processed), 0);
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const rows = await pairState(keys);
  assert.ok(rows.every((x) => x.needs_cluster === true), 'the occurrences are still queued');
  assert.ok(rows.every((x) => x.cluster_id === null), 'no event was created');
});

// ----------------------------------------------------------------------------------------------------------------------
// AC-M1-65 (A5-3): held-run accept under the source lock
// ----------------------------------------------------------------------------------------------------------------------
/** An enabled, permitted `auto` source with a pending held run, its open card, and two baseline occurrences. */
async function mkHeld(tag) {
  const slug = `conc-${tag}-${sfx}`;
  const sid = await mkSource(slug, 'organizer', 'auto');
  const ka = `${tag}-a-${sfx}`; const kb = `${tag}-b-${sfx}`;
  const baseTitle = `Held Base Alpha ${tag}${sfx}`;
  await ingestCommitted(slug, [item(ka, baseTitle, { days: 15 }), item(kb, `Held Base Bravo ${tag}${sfx}`, { days: 16 })]);
  await q(obs, `insert into public.source_runs (id, source_id, started_at, finished_at, status, items_found, items_new)
      select gen_random_uuid(), $1, now() - make_interval(hours => 24 + n * 6), now() - make_interval(hours => 24 + n * 6), 'ok', 2, 2
        from generate_series(1, 6) n`, [sid]);
  const heldTitle = `Held Alpha Changed ${tag}${sfx}`;
  const many = Array.from({ length: 25 }, (_, n) => item(`${tag}-n${n}-${sfx}`, `Held New ${tag}${n} ${randomBytes(5).toString('hex')}`, { days: 20 + (n % 40), hh: 9 + (n % 10) }));
  const res = await ingestCommitted(slug, [item(ka, heldTitle, { days: 15 }), ...many]);
  assert.equal(res.status, 'anomaly', 'fixture: the 25 new items hold the run');
  const card = (await q(obs, `select id from public.review_cards where kind = 'held_run' and held_run_id = $1`, [res.run_id])).rows[0]?.id;
  assert.ok(card, 'fixture: the held-run card exists');
  return { slug, sid, ka, kb, baseTitle, heldTitle, runId: res.run_id, card };
}
const newerItems = (h) => [item(h.ka, `Newer Alpha ${h.slug}`, { days: 15 }), item(h.kb, `Held Base Bravo ${h.slug}`, { days: 16 })];
const accept = (c, h) => start(c, `select public.admin_decide_card($1::uuid, 'accept', null, 40)`, [h.card]);
const heldState = async (h) => {
  const t = await q(obs, `select title from public.source_events where source_id = $1 and external_key = $2`, [h.sid, h.ka]);
  const n = await q(obs, `select count(*)::int as n from public.source_events where source_id = $1`, [h.sid]);
  const st = await q(obs, `select status from public.held_runs where run_id = $1`, [h.runId]);
  const ch = await q(obs, `select count(*)::int as n from public.event_changes ec join public.source_events se on se.cluster_id = ec.event_id
      where se.source_id = $1 and ec.new_value::text like '%Held Alpha Changed%'`, [h.sid]);
  return { title: t.rows[0]?.title, count: n.rows[0].n, held: st.rows[0]?.status, changes: ch.rows[0].n };
};

test('AC-M1-65(a) ingest first: the accept waits, then fails stale and applies nothing', { timeout: 30_000 }, async () => {
  const h = await mkHeld('65a');
  const tok = await grantFor(h.slug);
  const pidA = await pidOf(A);
  let pA;
  try {
    await beginService(B);
    const nb = await q(B, ingestSql, [tok, runJson(), JSON.stringify(newerItems(h))]);
    assert.equal(nb.rows[0].r.status, 'ok');
    await beginAdmin(A);
    pA = accept(A, h);
    await waitsOn(pidA);
    await q(B, 'commit');
    const res = await pA;
    assert.ok(res.err, 'the accept must fail');
    assert.equal(res.err.message, 'stale');
    assert.equal(res.err.code, 'P0001');
    assert.equal(res.err.detail, 'newer_run');
  } finally {
    await cleanup([pA]);
  }
  const s = await heldState(h);
  assert.equal(s.title, `Newer Alpha ${h.slug}`, 'the occurrence keeps the newer run\'s facts');
  assert.equal(s.held, 'pending');
  assert.equal(s.count, 2, 'no held occurrence was stored');
  assert.equal(s.changes, 0, 'no event_changes row carries the held facts');
});

test('AC-M1-65(b) revocation first: disabling the source makes the accept fail source_not_permitted', { timeout: 30_000 }, async () => {
  const h = await mkHeld('65b');
  const pidA = await pidOf(A);
  let pA;
  try {
    await beginAdmin(B);
    await q(B, 'select public.admin_set_source_enabled($1, false)', [h.slug]);
    await beginAdmin(A);
    pA = accept(A, h);
    await waitsOn(pidA);
    await q(B, 'commit');
    const res = await pA;
    assert.ok(res.err, 'the accept must fail');
    assert.equal(res.err.message, 'source_not_permitted');
    assert.equal(res.err.code, '23514');
  } finally {
    await cleanup([pA]);
  }
  const s = await heldState(h);
  assert.equal(s.title, h.baseTitle);
  assert.equal(s.held, 'pending');
  assert.equal(s.count, 2);
});

test('AC-M1-65(b) revocation first, via record_source_terms permission_required', { timeout: 30_000 }, async () => {
  const h = await mkHeld('65t');
  const pidA = await pidOf(A);
  let pA;
  try {
    await q(B, 'begin'); // as postgres: terms evidence lands through a reviewed migration, never an API role
    await q(B, `update public.sources set enabled = false where slug = $1`, [h.slug]);
    await q(B, `select private.record_source_terms($1, 'permission_required', array[]::text[], 'https://example.test/terms', repeat('b', 64),
        'test', now(), now() + interval '30 days', 'Terms review 2026-10-15: permission_required.')`, [h.slug]);
    await beginAdmin(A);
    pA = accept(A, h);
    await waitsOn(pidA);
    await q(B, 'commit');
    const res = await pA;
    assert.ok(res.err, 'the accept must fail');
    assert.equal(res.err.message, 'source_not_permitted');
    assert.equal(res.err.code, '23514');
  } finally {
    await cleanup([pA]);
  }
  const s = await heldState(h);
  assert.equal(s.title, h.baseTitle);
  assert.equal(s.held, 'pending');
  assert.equal(s.count, 2);
});

test('AC-M1-65(c) accept first: the newer ingest waits, then its facts are final', { timeout: 30_000 }, async () => {
  const h = await mkHeld('65c');
  const tok = await grantFor(h.slug); // issued before the accept takes the source row
  const pidB = await pidOf(B);
  let pB;
  try {
    await beginAdmin(A);
    const ok = await accept(A, h);
    assert.ok(ok.ok, `the accept failed: ${ok.err?.message}`);
    await beginService(B);
    pB = start(B, ingestSql, [tok, runJson(), JSON.stringify(newerItems(h))]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `the newer ingest failed: ${res.err?.message}`);
    assert.equal(res.rows[0].r.status, 'ok');
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const s = await heldState(h);
  assert.equal(s.title, `Newer Alpha ${h.slug}`, 'the newer run\'s facts are the final occurrence facts');
  assert.equal(s.held, 'accepted');
});

// ----------------------------------------------------------------------------------------------------------------------
// AC-M1-68 (A5-6), concurrency half: townless venues are unique
// ----------------------------------------------------------------------------------------------------------------------
test('AC-M1-68 two sessions ingesting the same townless venue end up on one venues row', { timeout: 30_000 }, async () => {
  const s1 = `conc-v1-${sfx}`; const s2 = `conc-v2-${sfx}`;
  await mkSource(s1, 'organizer', 'review');
  await mkSource(s2, 'organizer', 'review');
  const venue = `Pop-up Hall ${sfx}`;
  const i1 = [item(`v1-${sfx}`, `Pop Up Night One ${sfx}`, { days: 14, venueName: venue, town: null })];
  const i2 = [item(`v2-${sfx}`, `Pop Up Night Two ${sfx}`, { days: 15, venueName: venue, town: null })];
  const t1 = await grantFor(s1);
  const t2 = await grantFor(s2);
  const pidB = await pidOf(B);
  let pB;
  try {
    await beginService(A);
    await q(A, ingestSql, [t1, runJson(), JSON.stringify(i1)]);
    await beginService(B);
    pB = start(B, ingestSql, [t2, runJson(), JSON.stringify(i2)]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `the second ingest failed: ${res.err?.message}`);
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const v = await q(obs, `select count(*)::int as n from public.venues where name = $1`, [venue]);
  assert.equal(v.rows[0].n, 1, 'exactly one venues row');
  const ids = await q(obs, `select distinct venue_id from public.source_events where external_key = any($1)`, [[`v1-${sfx}`, `v2-${sfx}`]]);
  assert.equal(ids.rows.length, 1, 'both occurrences share its id');
});
