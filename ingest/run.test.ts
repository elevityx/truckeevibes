/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and adapter ctx are loosely typed in the mocked endpoint */
// Runner orchestration against a mocked ingest endpoint: AC-M1-45, 46, 62 and the S1.8 `run.ts` / S1.6 client rules
// (grants, HMAC signing, nonce, batch caps, non-ok -> items: [], concurrency 3 across hosts, logs).
// Contract assumed: `main(deps): Promise<number>` (the exit code), deps = { env, fetch, adapters?, now?, sleep?, log? }.
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { main } from './run';
import { FetchError } from './core/politeFetch';
import type { AdapterResult, GrantOut } from './types';
import { fakeNet, fixture, makeClock, source, text, T0 } from './testing/fakes';

const INGEST_URL = 'https://ref.example.test/functions/v1/ingest';
const HOOK = 'https://hook.example.test/deploy/abc';
const KEY = ['sentinel', 'hmac', 'key', '9f3a'].join('-');
const TITLE_SENTINEL = 'SYNTHETIC-TITLE-SENTINEL';

const grant = (slug: string, over: Partial<GrantOut['source']> = {}, token = `grant-${slug}`): GrantOut => ({
  grant: token, run_id: `run-${slug}`, source: source({ slug, family: slug, allowed_hosts: [`${slug}.example.test`], ...over }),
});
const ev = (n: number) => ({
  externalKey: `k${n}`, title: `Sample Event ${n}`, startsAt: '2026-10-20T19:00:00Z', allDay: false, timeKnown: true, tz: 'America/Los_Angeles',
  url: 'https://x.example.test/e', categoriesHint: [] as string[], rawSummaryLength: 0,
});
const okResult = (n = 2, extra: Partial<AdapterResult> = {}): AdapterResult => ({ items: Array.from({ length: n }, (_, i) => ev(i + 1)), status: 'ok', httpStatus: 200, ...extra });

interface Opts {
  grants?: GrantOut[];
  due?: () => Response;
  finish?: () => Response;
  batch?: (grant: string, body: Record<string, unknown>) => Response;
  adapters?: Record<string, { family: string; version: string; fetch: (ctx: never) => Promise<AdapterResult> }>;
  env?: Record<string, string | undefined>;
  other?: (u: URL, init: RequestInit) => Response | Promise<Response>;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function harness(o: Opts = {}) {
  const clock = makeClock();
  const logs: string[] = [];
  const ops: { op: string; body: Record<string, any>; headers: Headers; raw: string }[] = [];
  const nonces = new Set<string>();
  let badSig = 0;
  let replay = 0;
  const hookCalls: RequestInit[] = [];
  const net = fakeNet(async (u, init, call) => {
    if (u.href === INGEST_URL) {
      const raw = String(init.body);
      const ts = call.headers.get('x-tv-ts') ?? '';
      const nonce = call.headers.get('x-tv-nonce') ?? '';
      const sha = createHash('sha256').update(raw).digest('hex');
      const want = createHmac('sha256', KEY).update(`${ts}\n${nonce}\n${sha}`).digest('hex');
      if (call.headers.get('x-tv-sig') !== want) { badSig++; return json({ error: 'unauthorized' }, 401); }
      if (nonces.has(nonce)) { replay++; return json({ error: 'replay' }, 409); }
      nonces.add(nonce);
      const body = JSON.parse(raw);
      ops.push({ op: body.op, body, headers: call.headers, raw });
      if (body.op === 'due_sources') return o.due ? o.due() : json({ grants: o.grants ?? [] });
      if (body.op === 'finish') return o.finish ? o.finish() : json({ public_changed: false, processed: 0, remaining: 0 });
      if (body.op === 'submit_batch') {
        if (o.batch) return o.batch(body.grant, body);
        return json({ run_id: 'r', status: body.run.status, new: body.items.length, changed: 0, gone: 0, geocode: [] });
      }
      return json({ error: 'bad_op' }, 400);
    }
    if (u.href === HOOK) { hookCalls.push(init); return json({ ok: true }); }
    if (o.other) return o.other(u, init);
    return u.pathname === '/robots.txt' ? text('nf', 404) : text('', 404);
  }, clock.now);
  const env = { INGEST_URL, INGEST_HMAC_KEY: KEY, PAGES_DEPLOY_HOOK_URL: HOOK, ...o.env };
  const run = () => main({ env, fetch: net.fetch, adapters: o.adapters as never, now: () => new Date(clock.now()), sleep: clock.sleep, log: (l: string) => logs.push(l) });
  const submits = () => ops.filter((x) => x.op === 'submit_batch');
  return { run, logs, ops, submits, net, clock, hookCalls, stats: () => ({ badSig, replay }) };
}
const fake = (family: string, fn: (ctx: any) => Promise<AdapterResult>) => ({ family, version: '1', fetch: fn });

describe('exit codes and infrastructure failures (AC-M1-45)', () => {
  it('due_sources 401 -> exit 1, nothing submitted', async () => {
    const h = harness({ due: () => json({ error: 'unauthorized' }, 401) });
    expect(await h.run()).toBe(1);
    expect(h.submits()).toHaveLength(0);
  });
  it('finish failing -> exit 1', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => okResult()) }, finish: () => json({ error: 'unavailable' }, 500) });
    expect(await h.run()).toBe(1);
  });
  it('HMAC rejected on submit_batch (401) -> exit 1', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => okResult()) }, batch: () => json({ error: 'unauthorized' }, 401) });
    expect(await h.run()).toBe(1);
  });
  it('a 403 grant_rejected for one source is a per-source failure: the others still run, exit 0', async () => {
    const h = harness({
      grants: [grant('a'), grant('b')],
      adapters: { a: fake('a', async () => okResult()), b: fake('b', async () => okResult()) },
      batch: (g) => (g === 'grant-a' ? json({ error: 'grant_rejected' }, 403) : json({ run_id: 'r', status: 'ok', new: 2, changed: 0, gone: 0, geocode: [] })),
    });
    expect(await h.run()).toBe(0);
    expect(h.submits().map((s) => s.body.grant).sort()).toEqual(['grant-a', 'grant-b']);
  });
  it('missing INGEST_URL or INGEST_HMAC_KEY -> exit 1 and no request at all', async () => {
    for (const env of [{ INGEST_URL: undefined }, { INGEST_HMAC_KEY: undefined }]) {
      const h = harness({ env });
      expect(await h.run()).toBe(1);
      expect(h.net.calls).toHaveLength(0);
    }
  });
  it('no grants due: due_sources then finish, exit 0', async () => {
    const h = harness({ grants: [] });
    expect(await h.run()).toBe(0);
    expect(h.ops.map((o) => o.op)).toEqual(['due_sources', 'finish']);
  });
});

describe('mixed statuses and the deploy hook (AC-M1-45)', () => {
  const two = () => ({
    grants: [grant('bad'), grant('good')],
    adapters: {
      bad: fake('bad', async () => ({ items: [], status: 'http_error' as const, httpStatus: 503 })),
      good: fake('good', async () => okResult(2)),
    },
  });
  it('one http_error and one ok -> exit 0, both submitted with their statuses', async () => {
    const h = harness(two());
    expect(await h.run()).toBe(0);
    const by = Object.fromEntries(h.submits().map((s) => [s.body.grant, s.body]));
    expect(by['grant-bad'].run.status).toBe('http_error');
    expect(by['grant-bad'].run.http_status).toBe(503);
    expect(by['grant-bad'].items).toEqual([]);
    expect(by['grant-good'].run.status).toBe('ok');
    expect(by['grant-good'].items).toHaveLength(2);
  });
  it('the deploy hook is POSTed (10 s timeout) only when finish returns public_changed: true', async () => {
    const yes = harness({ ...two(), finish: () => json({ public_changed: true, processed: 5, remaining: 0 }) });
    await yes.run();
    expect(yes.hookCalls).toHaveLength(1);
    expect(yes.hookCalls[0].method).toBe('POST');
    expect(yes.hookCalls[0].signal).toBeInstanceOf(AbortSignal);
    const no = harness({ ...two(), finish: () => json({ public_changed: false, processed: 5, remaining: 0 }) });
    await no.run();
    expect(no.hookCalls).toHaveLength(0);
    const unset = harness({ ...two(), env: { PAGES_DEPLOY_HOOK_URL: undefined }, finish: () => json({ public_changed: true, processed: 1, remaining: 0 }) });
    expect(await unset.run()).toBe(0);
    expect(unset.net.urls().includes(HOOK)).toBe(false);
  });
  it('a failing hook does not change the exit code', async () => {
    const h = harness({ ...two(), finish: () => json({ public_changed: true, processed: 1, remaining: 0 }), other: () => text('', 500) });
    h.net.calls.length = 0;
    expect(await h.run()).toBe(0);
  });
});

describe('every non-ok status is submitted with items: [] (S1.2 step 4)', () => {
  it.each(['http_error', 'not_modified', 'robots_blocked', 'parse_error', 'skipped'] as const)('adapter status %s with 5 items -> items: []', async (status) => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => okResult(5, { status })) } });
    expect(await h.run()).toBe(0);
    expect(h.submits()[0].body.run.status).toBe(status);
    expect(h.submits()[0].body.items).toEqual([]);
  });
  it('FetchError robots_blocked -> status robots_blocked; other codes -> skipped with error_code = the code', async () => {
    const mk = (code: string) => harness({ grants: [grant('a')], adapters: { a: fake('a', async () => { throw new FetchError(code as never); }) } });
    const rb = mk('robots_blocked');
    await rb.run();
    expect(rb.submits()[0].body.run).toMatchObject({ status: 'robots_blocked' });
    expect(rb.submits()[0].body.items).toEqual([]);
    for (const code of ['crawl_delay', 'terms_gate', 'method_gate', 'host_not_allowed', 'page_cap', 'redirect_blocked']) {
      const h = mk(code);
      expect(await h.run()).toBe(0);
      expect(h.submits()[0].body.run).toMatchObject({ status: 'skipped', error_code: code });
      expect(h.submits()[0].body.items).toEqual([]);
    }
  });
  it('a parse exception -> parse_error, error_code parse, error_detail = the exception class name only', async () => {
    class WeirdFeedError extends Error {}
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => { throw new WeirdFeedError(`bad row ${TITLE_SENTINEL} ${KEY}`); }) } });
    expect(await h.run()).toBe(0);
    const { run, items } = h.submits()[0].body;
    expect(run).toMatchObject({ status: 'parse_error', error_code: 'parse', error_detail: 'WeirdFeedError' });
    expect(items).toEqual([]);
    expect(h.submits()[0].raw).not.toContain(TITLE_SENTINEL);
  });
  it('> 1,000 items -> parse_error/too_many_items with items: []; exactly 1,000 is submitted whole under 2 MB', async () => {
    const over = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => okResult(1001)) } });
    expect(await over.run()).toBe(0);
    expect(over.submits()[0].body.run).toMatchObject({ status: 'parse_error', error_code: 'too_many_items' });
    expect(over.submits()[0].body.items).toEqual([]);
    const exact = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => okResult(1000)) } });
    await exact.run();
    expect(exact.submits()[0].body.items).toHaveLength(1000);
    expect(Buffer.byteLength(exact.submits()[0].raw)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
  it('items that fail validation are dropped (counted as invalid), valid ones are submitted', async () => {
    const bad = { ...ev(9), externalKey: '' };
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => ({ items: [ev(1), bad as never], status: 'ok' as const })) } });
    await h.run();
    expect(h.submits()[0].body.items).toHaveLength(1);
    expect(h.logs.find((l) => l.startsWith('source=a '))).toMatch(/ invalid=1\b/);
  });
});

describe('no registered adapter (AC-M1-62)', () => {
  it('family squarespace -> skipped/no_adapter, items: [], zero source fetches, exit 0', async () => {
    const h = harness({ grants: [grant('sq', { family: 'squarespace', allowed_hosts: ['sq.example.test'] })] });
    expect(await h.run()).toBe(0);
    expect(h.submits()).toHaveLength(1);
    expect(h.submits()[0].body.run).toMatchObject({ status: 'skipped', error_code: 'no_adapter' });
    expect(h.submits()[0].body.items).toEqual([]);
    expect(h.net.calls.filter((c) => c.url !== INGEST_URL)).toHaveLength(0);
  });
});

describe('request signing and run metadata', () => {
  it('every ingest request is signed per S1.6 with a fresh 32-hex nonce, ts = now; the mock saw no bad signature or replay', async () => {
    const h = harness({ grants: [grant('a'), grant('b')], adapters: { a: fake('a', async () => okResult()), b: fake('b', async () => okResult()) } });
    expect(await h.run()).toBe(0);
    expect(h.ops.map((o) => o.op)).toEqual(['due_sources', 'submit_batch', 'submit_batch', 'finish']);
    const n = h.ops.map((o) => o.headers.get('x-tv-nonce')!);
    expect(new Set(n).size).toBe(n.length);
    for (const x of n) expect(x).toMatch(/^[0-9a-f]{32}$/);
    expect(h.stats()).toEqual({ badSig: 0, replay: 0 });
    for (const o of h.ops) expect(Math.abs(Number(o.headers.get('x-tv-ts')) - T0 / 1000)).toBeLessThan(120);
  });
  it('submit_batch carries the grant token, a started_at within [now-2h, now] and snake_case robots/validators', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => okResult(1, {
      httpStatus: 200, etag: 'W/"e"', lastModified: 'Wed, 14 Oct 2026 10:00:00 GMT', contentHash: 'c'.repeat(64), robots: { hash: 'd'.repeat(64), aiBotsBlocked: true },
    })) } });
    await h.run();
    const { grant: g, run } = h.submits()[0].body;
    expect(g).toBe('grant-a');
    expect(Date.parse(run.started_at)).toBeLessThanOrEqual(h.clock.now());
    expect(Date.parse(run.started_at)).toBeGreaterThanOrEqual(T0 - 2 * 3600_000);
    expect(run).toMatchObject({ status: 'ok', http_status: 200, etag: 'W/"e"', last_modified: 'Wed, 14 Oct 2026 10:00:00 GMT', content_hash: 'c'.repeat(64), robots: { hash: 'd'.repeat(64), ai_bots_blocked: true } });
    expect(Object.keys(run).some((k) => k.startsWith('items_'))).toBe(false); // counters are server-computed
  });
  it('the adapter gets a politeFetch bound to its grant: a host outside allowed_hosts is refused and never requested', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async (ctx) => { await ctx.fetch('https://evil.example.test/x', { kind: 'feed' }); return okResult(); }) } });
    expect(await h.run()).toBe(0);
    expect(h.submits()[0].body.run).toMatchObject({ status: 'skipped', error_code: 'host_not_allowed' });
    expect(h.net.urls().some((u) => u.includes('evil.example.test'))).toBe(false);
  });
});

describe('concurrency: 3 across different hosts, 1 per host', () => {
  const gate = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; };
  async function peak(grants: GrantOut[]) {
    let live = 0; let max = 0; const perHost = new Map<string, number>(); let maxHost = 0;
    const g = gate();
    const mk = (family: string) => fake(family, async (ctx) => {
      live++; max = Math.max(max, live);
      const host = ctx.source.allowed_hosts[0];
      perHost.set(host, (perHost.get(host) ?? 0) + 1); maxHost = Math.max(maxHost, perHost.get(host)!);
      await g.p;
      live--; perHost.set(host, perHost.get(host)! - 1);
      return okResult(1);
    });
    const families = [...new Set(grants.map((x) => x.source.family))];
    const h = harness({ grants, adapters: Object.fromEntries(families.map((f) => [f, mk(f)])) });
    const done = h.run();
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0)); // let the pool fill
    const sampled = { max, maxHost };
    g.release();
    expect(await done).toBe(0);
    return sampled;
  }
  it('five sources on five hosts run 3 at a time', async () => {
    const s = await peak(['a', 'b', 'c', 'd', 'e'].map((x) => grant(x)));
    expect(s.max).toBe(3);
  });
  it('two grants on one host never overlap', async () => {
    const s = await peak([grant('a', {}, 't1'), grant('a', {}, 't2'), grant('b'), grant('c')]);
    expect(s.maxHost).toBe(1);
  });
});

describe('logs (AC-M1-46)', () => {
  it('per-source line: source=<slug> status=<s> found=<n> new=<n> changed=<n> invalid=<n> (+ filtered=<n>)', async () => {
    const h = harness({ grants: [grant('a'), grant('b')], adapters: {
      a: fake('a', async () => okResult(2)),
      b: fake('b', async () => okResult(1, { filtered: 3 })),
    } });
    await h.run();
    expect(h.logs).toContain('source=a status=ok found=2 new=2 changed=0 invalid=0');
    const b = h.logs.find((l) => l.startsWith('source=b '))!;
    expect(b).toMatch(/^source=b status=ok found=1 new=1 changed=0 invalid=0\b/);
    expect(b).toMatch(/\bfiltered=3\b/);
  });
  it('a run over a fixture with a sentinel title and a sentinel key logs neither, nor a URL query string, nor a grant token', async () => {
    const ics = fixture('ics/eventsmanager_sitewide.ics').replace('Sample Taproom Night', TITLE_SENTINEL);
    const q = 'https://venue-one.example.test/events.ics?v=1&u=2';
    const h = harness({
      grants: [
        grant('em', { family: 'ics_eventsmanager', config: { icsUrl: q }, allowed_hosts: ['venue-one.example.test'], allowed_methods: ['feed'] }, 'tok-em'),
        grant('boom', { family: 'ics_civicplus', config: { base: 'https://broken.example.test', catIds: [1] }, allowed_hosts: ['broken.example.test'], allowed_methods: ['feed'] }, 'tok-boom'),
      ],
      other: (u) => {
        if (u.hostname === 'broken.example.test') throw new Error(`socket closed ${KEY} https://broken.example.test/p?secret=zzz ${TITLE_SENTINEL}`);
        if (u.pathname === '/robots.txt') return text('nf', 404);
        if (u.pathname === '/events.ics') return new Response(ics, { status: 200, headers: { 'content-type': 'text/calendar' } });
        return text('', 404);
      },
    });
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    try {
      expect(await h.run()).toBe(0);
    } finally { for (const s of spies) s.mockRestore(); }
    const consoleOut = spies.flatMap((s) => s.mock.calls.map((c) => c.join(' '))).join('\n');
    const all = `${h.logs.join('\n')}\n${consoleOut}`;
    expect(h.logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(TITLE_SENTINEL);
    expect(all).not.toContain(KEY);
    expect(all).not.toMatch(/\?\w+=/);
    expect(all).not.toContain('tok-em');
    expect(all).not.toContain('tok-boom');
    // and the happy source really did carry the sentinel title to the ingest endpoint, just not to the logs
    expect(h.submits().find((s) => s.body.grant === 'tok-em')!.raw).toContain(TITLE_SENTINEL);
  });
});
