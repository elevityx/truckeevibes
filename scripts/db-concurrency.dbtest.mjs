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
/** An enabled, permitted `review` source (A10: auto sources apply surges, so the hold needs review) with a pending held run, its open card, and two baseline occurrences. */
async function mkHeld(tag) {
  const slug = `conc-${tag}-${sfx}`;
  const sid = await mkSource(slug, 'organizer', 'review');
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

// ----------------------------------------------------------------------------------------------------------------------
// Spec_Sources_V2 §5 / AC-SV2-19: Run now and Read request stamps vs the grant paths, Cancel and batch completion.
// Committed fixtures, separate sessions. Each timestamp-inversion case first asserts its precondition (the inversion really
// happened, so a timestamp rule would have failed): that precondition is the case's control.
// ----------------------------------------------------------------------------------------------------------------------
/** Fail with a plain message when the Sources V2 migration is not applied (TDD: the right reason, not a lock timeout). */
async function needSourcesV2() {
  const { rows } = await q(obs, `select
      to_regprocedure('public.admin_set_force_due(text, boolean)') is not null as fd,
      to_regprocedure('public.admin_set_read_request(text, boolean)') is not null as rr,
      to_regprocedure('public.svc_manual_grant_requested(text)') is not null as mg,
      (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'sources'
          and column_name in ('force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at', 'force_due_gen', 'read_request_gen')) as cols,
      (select count(*)::int from information_schema.columns where table_schema = 'private' and table_name = 'ingest_grants'
          and column_name in ('force_due_gen', 'read_request_gen')) as gcols`);
  const r = rows[0];
  assert.ok(r.fd && r.rr && r.mg && r.cols === 6 && r.gcols === 2,
    `Sources V2 migration not applied: admin_set_force_due=${r.fd} admin_set_read_request=${r.rr} svc_manual_grant_requested=${r.mg} source columns=${r.cols}/6 grant columns=${r.gcols}/2`);
}
/** A committed fixture source, not cadence-due; `manual` makes it manual-only; `due` makes it cadence-due. Other due sources are pushed out. */
async function mkSv2(tag, { manual = false, due = false } = {}) {
  const slug = `conc-sv2-${tag}-${sfx}`;
  await mkSource(slug, 'organizer', 'review');
  if (manual) await q(obs, 'update public.sources set manual_only = true where slug = $1', [slug]);
  await q(obs, `update public.sources set next_due_at = now() + interval '1 day' where next_due_at <= now() and slug <> $1`, [slug]);
  await q(obs, `update public.sources set next_due_at = now() + (case when $2 then interval '-1 minute' else interval '1 day' end) where slug = $1`, [slug, due]);
  return slug;
}
// timestamps come back as text: a JS Date keeps only milliseconds, and the comparisons below need the exact microseconds
const svState = async (slug) => (await q(obs, `select force_due_at::text, force_due_served_at::text, read_requested_at::text,
    read_request_served_at::text, force_due_gen::int as fd_gen, read_request_gen::int as rr_gen, next_due_at::text from public.sources where slug = $1`, [slug])).rows[0];
const svGrants = async (slug) => (await q(obs, `select g.run_id, g.issued_at::text, g.used_at::text, g.force_due_gen::int as fd_gen, g.read_request_gen::int as rr_gen
    from private.ingest_grants g join public.sources s on s.id = g.source_id where s.slug = $1 order by g.issued_at`, [slug])).rows;
/** Run one admin RPC in its own committed transaction. */
async function adminCommitted(text, params) {
  await beginAdmin(obs);
  try {
    const { rows } = await q(obs, text, params);
    await q(obs, 'commit');
    return rows[0].r;
  } catch (e) {
    await q(obs, 'rollback').catch(() => {});
    throw e;
  }
}
/** Run one service call in its own committed transaction. */
async function serviceCommitted(text, params) {
  await beginService(obs);
  try {
    const { rows } = await q(obs, text, params);
    await q(obs, 'commit');
    return rows[0].r;
  } catch (e) {
    await q(obs, 'rollback').catch(() => {});
    throw e;
  }
}
const FORCE = 'select public.admin_set_force_due($1, $2) as r';
const READ_REQ = 'select public.admin_set_read_request($1, $2) as r';
const ISSUE = 'select public.svc_issue_run_grants() as r';
const MANUAL_REQ = 'select public.svc_manual_grant_requested($1) as r';
const MANUAL = 'select public.svc_manual_grant($1) as r';
const tokenFor = (r, slug) => r.grants.find((x) => x.source.slug === slug)?.grant;
/** REQUESTS_SQL's predicate (ingest/tools/requests.ts), inlined for one slug. */
const pendingRequest = async (slug) => (await q(obs, `select count(*)::int as n from public.sources
    where enabled and manual_only and read_requested_at > now() - interval '7 days' and slug = $1`, [slug])).rows[0].n === 1;
const sameTime = async (a, b) => (await q(obs, 'select $1::timestamptz = $2::timestamptz as eq', [a, b])).rows[0].eq;
const lt = async (a, b) => (await q(obs, 'select $1::timestamptz < $2::timestamptz as lt', [a, b])).rows[0].lt;
/** Resolve to the promise's value, or fail after ms (the call must not block). */
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => assert.fail(`${what} blocked for ${ms} ms`))]);

test('AC-SV2-19(a) a grant holds the row: the Run now stamp waits, then gets rate_limited/too_soon', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19a', { due: true });
  const pidB = await pidOf(B);
  let pB;
  try {
    await beginService(A);
    const g = await q(A, ISSUE);
    assert.ok(tokenFor(g.rows[0].r, slug), 'fixture: the cadence-due source is granted');
    await beginAdmin(B);
    pB = start(B, FORCE, [slug, true]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.err, 'the stamp must be refused');
    assert.equal(res.err.message, 'rate_limited');
    assert.equal(res.err.code, 'P0001');
    assert.equal(res.err.detail, 'too_soon');
  } finally {
    await cleanup([pB]);
  }
  assert.equal((await svGrants(slug)).length, 1, 'exactly one grant row');
  assert.equal((await svState(slug)).force_due_at, null, 'no stamp');
});

test('AC-SV2-19(b) a stamp holds the row: the grant skips it without blocking; the next call grants once with the generation', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19b');
  try {
    await beginAdmin(B);
    await q(B, FORCE, [slug, true]);
    await beginService(A);
    const g = await within(q(A, ISSUE), 3000, 'svc_issue_run_grants');
    assert.equal(tokenFor(g.rows[0].r, slug), undefined, 'no grant while the stamp is uncommitted');
    await q(A, 'commit');
    await q(B, 'commit');
  } finally {
    await cleanup();
  }
  const r = await serviceCommitted(ISSUE);
  assert.equal(r.grants.filter((x) => x.source.slug === slug).length, 1, 'the next call grants it once');
  const [gr] = await svGrants(slug);
  const s = await svState(slug);
  assert.ok(s.fd_gen >= 1);
  assert.equal(gr.fd_gen, s.fd_gen, 'the grant carries the source generation');
  assert.notEqual(s.force_due_at, null, 'the grant does not clear the stamp');
});

test('AC-SV2-19(c) two stamps: the second waits, returns already true, and its time wins; still no grant', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19c');
  const pidB = await pidOf(B);
  let pB; let second;
  try {
    await beginAdmin(A);
    const first = await q(A, FORCE, [slug, true]);
    assert.equal(first.rows[0].r.already, false);
    await beginAdmin(B);
    pB = start(B, FORCE, [slug, true]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `the second stamp failed: ${res.err?.message}`);
    second = res.rows[0].r;
    assert.equal(second.already, true);
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const s = await svState(slug);
  assert.ok(await sameTime(s.force_due_at, second.force_due_at), 'DB force_due_at is the second stamp\'s time');
  assert.equal(s.fd_gen, 2, 'two stamps, two generations');
  assert.equal((await svGrants(slug)).length, 0, 'no grant');
});

test('AC-SV2-19(d) Cancel first: the requested grant waits, then fails manual_request_withdrawn; no grant', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19d', { manual: true, due: true });
  await adminCommitted(READ_REQ, [slug, true]);
  const pidB = await pidOf(B);
  let pB;
  try {
    await beginAdmin(A);
    await q(A, READ_REQ, [slug, false]);
    await beginService(B);
    pB = start(B, MANUAL_REQ, [slug]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.err, 'the requested grant must fail');
    assert.equal(res.err.message, 'manual_request_withdrawn');
    assert.equal(res.err.code, 'P0001');
  } finally {
    await cleanup([pB]);
  }
  assert.equal((await svGrants(slug)).length, 0, 'no grant row');
});

test('AC-SV2-19(e) grant first: Cancel waits; one grant; the request is withdrawn and nothing is served', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19e', { manual: true, due: true });
  await adminCommitted(READ_REQ, [slug, true]);
  const pidA = await pidOf(A);
  let pA;
  try {
    await beginService(B);
    const g = await q(B, MANUAL_REQ, [slug]);
    assert.match(g.rows[0].r.grant, /^[0-9a-f]{64}$/);
    await beginAdmin(A);
    pA = start(A, READ_REQ, [slug, false]);
    await waitsOn(pidA);
    await q(B, 'commit');
    const res = await pA;
    assert.ok(res.ok, `Cancel failed: ${res.err?.message}`);
    assert.equal(res.rows[0].r.read_requested_at, null);
    await q(A, 'commit');
  } finally {
    await q(B, 'rollback').catch(() => {});
    await Promise.allSettled([pA]);
    await q(A, 'rollback').catch(() => {});
  }
  assert.equal((await svGrants(slug)).length, 1, 'one grant row');
  const s = await svState(slug);
  assert.equal(s.read_requested_at, null);
  assert.equal(s.read_request_served_at, null, 'withdrawn before any result: nothing served');
});

test('AC-SV2-19(f) inversion 1: a grant whose transaction began before the stamp still consumes it on completion', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19f');
  let tok;
  try {
    await beginService(A);
    await q(A, 'select now() as t0');
    await sleep(50);
    await adminCommitted(FORCE, [slug, true]);
    const g = await q(A, ISSUE);
    tok = tokenFor(g.rows[0].r, slug);
    assert.ok(tok, 'A\'s statement sees the committed stamp and grants the source');
    await q(A, 'commit');
  } finally {
    await cleanup();
  }
  const [gr] = await svGrants(slug);
  const before = await svState(slug);
  assert.ok(await lt(gr.issued_at, before.force_due_at), 'precondition (control): the grant\'s issued_at is earlier than the stamp');
  await serviceCommitted(ingestSql, [tok, runJson(), '[]']);
  const s = await svState(slug);
  assert.equal(s.force_due_at, null, 'the request it observed was consumed');
  assert.notEqual(s.force_due_served_at, null, 'served is set');
});

test('AC-SV2-19(g) inversion 2: a request written after a manual grant by an earlier-started transaction survives completion', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const slug = await mkSv2('19g', { manual: true, due: true });
  const pidB = await pidOf(B);
  let pB; let tok;
  try {
    await beginAdmin(B);
    await q(B, 'select now() as t1');
    await sleep(50);
    await beginService(A);
    const g = await q(A, MANUAL, [slug]);
    tok = g.rows[0].r.grant;
    pB = start(B, READ_REQ, [slug, true]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `the request failed: ${res.err?.message}`);
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const [gr] = await svGrants(slug);
  assert.equal(gr.rr_gen, null, 'the grant saw no request');
  const before = await svState(slug);
  assert.ok(await lt(before.read_requested_at, gr.issued_at), 'precondition (control): read_requested_at is earlier than the grant\'s issued_at');
  await serviceCommitted(ingestSql, [tok, runJson(), '[]']);
  const s = await svState(slug);
  assert.ok(await sameTime(s.read_requested_at, before.read_requested_at), 'the later request is still pending');
  assert.equal(s.read_request_served_at, null);
  assert.equal(await pendingRequest(slug), true, 'REQUESTS_SQL still lists it');
});

/** A manual fixture with a committed request (generation g) and a committed request-bound grant. */
async function mkRequestedGrant(tag) {
  const slug = await mkSv2(tag, { manual: true, due: true });
  await adminCommitted(READ_REQ, [slug, true]);
  const g = (await svState(slug)).rr_gen;
  const tok = (await serviceCommitted(MANUAL_REQ, [slug])).grant;
  assert.match(tok, /^[0-9a-f]{64}$/);
  return { slug, g, tok };
}

test('AC-SV2-19(h) completion first, then re-stamp: the new request stays pending; served is the completion time', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const { slug, g, tok } = await mkRequestedGrant('19h');
  const pidB = await pidOf(B);
  let pB; let tA; let restamp;
  try {
    await beginService(A);
    tA = (await q(A, 'select now()::text as t')).rows[0].t;
    await q(A, ingestSql, [tok, runJson(), '[]']);
    await beginAdmin(B);
    pB = start(B, READ_REQ, [slug, true]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `the re-stamp failed: ${res.err?.message}`);
    restamp = res.rows[0].r;
    assert.equal(restamp.already, false, 'the request was already consumed');
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const s = await svState(slug);
  assert.equal(s.rr_gen, g + 1, 'the clear does not bump the generation; the re-stamp bumps it once');
  assert.ok(await sameTime(s.read_requested_at, restamp.read_requested_at), 'the new request is pending');
  assert.ok(await sameTime(s.read_request_served_at, tA), 'served = the completing batch\'s time');
});

test('AC-SV2-19(i) re-stamp first, then completion: the batch waits; the new request stays pending; nothing served', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const { slug, tok } = await mkRequestedGrant('19i');
  const pidA = await pidOf(A);
  let pA; let restamp;
  try {
    await beginAdmin(B);
    restamp = (await q(B, READ_REQ, [slug, true])).rows[0].r;
    await beginService(A);
    pA = start(A, ingestSql, [tok, runJson(), '[]']);
    await waitsOn(pidA);
    await q(B, 'commit');
    const res = await pA;
    assert.ok(res.ok, `the batch failed: ${res.err?.message}`);
    await q(A, 'commit');
  } finally {
    await q(B, 'rollback').catch(() => {});
    await Promise.allSettled([pA]);
    await q(A, 'rollback').catch(() => {});
  }
  const s = await svState(slug);
  assert.ok(await sameTime(s.read_requested_at, restamp.read_requested_at), 'the newer request is pending');
  assert.equal(s.read_request_served_at, null, 'served only when the completion came first');
  const [gr] = await svGrants(slug);
  const run = await q(obs, 'select count(*)::int as n from public.source_runs where id = $1', [gr.run_id]);
  assert.equal(run.rows[0].n, 1, 'the run row exists');
});

/** A Run-now fixture: stamped and granted, both committed. */
async function mkStampedGrant(tag) {
  const slug = await mkSv2(tag);
  await adminCommitted(FORCE, [slug, true]);
  const tok = tokenFor(await serviceCommitted(ISSUE), slug);
  assert.ok(tok, 'fixture: the stamped source is granted');
  return { slug, tok, g: (await svState(slug)).fd_gen };
}

test('AC-SV2-19(j) completion first, then Cancel: Cancel waits and changes nothing; served is set', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const { slug, tok, g } = await mkStampedGrant('19j');
  const pidB = await pidOf(B);
  let pB;
  try {
    await beginService(A);
    await q(A, ingestSql, [tok, runJson(), '[]']);
    await beginAdmin(B);
    pB = start(B, FORCE, [slug, false]);
    await waitsOn(pidB);
    await q(A, 'commit');
    const res = await pB;
    assert.ok(res.ok, `Cancel failed: ${res.err?.message}`);
    assert.equal(res.rows[0].r.force_due_at, null);
    await q(B, 'commit');
  } finally {
    await cleanup([pB]);
  }
  const s = await svState(slug);
  assert.equal(s.force_due_at, null);
  assert.notEqual(s.force_due_served_at, null, 'served is set (the completion came first)');
  assert.equal(s.fd_gen, g, 'no stamp was left, so Cancel did not bump the generation');
});

test('AC-SV2-19(k) Cancel first, then completion: the batch waits and is recorded; nothing is served', { timeout: 30_000 }, async () => {
  await needSourcesV2();
  const { slug, tok, g } = await mkStampedGrant('19k');
  const pidA = await pidOf(A);
  let pA;
  try {
    await beginAdmin(B);
    await q(B, FORCE, [slug, false]);
    await beginService(A);
    pA = start(A, ingestSql, [tok, runJson(), '[]']);
    await waitsOn(pidA);
    await q(B, 'commit');
    const res = await pA;
    assert.ok(res.ok, `the batch failed: ${res.err?.message}`);
    await q(A, 'commit');
  } finally {
    await q(B, 'rollback').catch(() => {});
    await Promise.allSettled([pA]);
    await q(A, 'rollback').catch(() => {});
  }
  const s = await svState(slug);
  assert.equal(s.force_due_at, null);
  assert.equal(s.force_due_served_at, null, 'served only when the completion came first');
  assert.equal(s.fd_gen, g + 1, 'Cancel bumped the generation');
  const [gr] = await svGrants(slug);
  const run = await q(obs, 'select count(*)::int as n from public.source_runs where id = $1', [gr.run_id]);
  assert.equal(run.rows[0].n, 1, 'the batch is recorded');
});
