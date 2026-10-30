/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and adapter ctx are loosely typed in the mocked endpoint */
// Runner orchestration against a mocked ingest endpoint: AC-M1-45, 46, 62 and the S1.8 `run.ts` / S1.6 client rules
// (grants, HMAC signing, nonce, batch caps, non-ok -> items: [], concurrency 3 across hosts, logs).
// Contract assumed: `main(deps): Promise<number>` (the exit code), deps = { env, fetch, adapters?, now?, sleep?, log? }.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main } from './run';
import { adapter as chamberAdapter } from './adapters/icsChambermaster';
import { adapter as tribeAdapter } from './adapters/tribe';
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
    expect(h.logs).toContain('source=a status=ok found=2 new=2 changed=0 invalid=0 tags=none age_ambiguous=0 conflicts=0 notices=0/0');
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

describe('one shared spacer per run (AC-M1-73 e, A6-2)', () => {
  it('run.ts builds one spacer with createSpacer( and passes it to createPoliteFetch; no per-run starts Map', () => {
    const src = readFileSync(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8');
    expect(src.match(/createSpacer\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/new Map<string, number>\(\)/);
    expect(src).toMatch(/createPoliteFetch\([^)]*\bspacer\b/);
  });
});

describe('ChamberMaster partial fetch is never submitted as ok (AC-M1-74 e, A6-4)', () => {
  const CHAMBER = 'https://chamber.example.test';
  const chamberGrant = () => ({
    grant: 'grant-chamber', run_id: 'run-chamber',
    source: source({ slug: 'chamber', family: 'ics_chambermaster', config: { listUrl: `${CHAMBER}/events` }, allowed_hosts: ['chamber.example.test'], page_cap: 10 }),
  }) as GrantOut;
  const other = (u: URL) => {
    if (u.pathname === '/robots.txt') return text('nf', 404);
    if (u.pathname === '/events') return text(fixture('chambermaster/events_list.html'));
    const m = /\/events\/ical\/(.*-(\d+))\.ics$/.exec(u.pathname);
    if (m && m[1] === 'sample-art-walk-2002') return text('busy', 503);
    if (m) return text(fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', m[2]));
    return text('', 404);
  };

  it('detail 2 returns 503, run 3 times -> 3 submit_batch with http_error/detail_http and items: [], never an ok', async () => {
    const h = harness({ grants: [chamberGrant()], adapters: { ics_chambermaster: chamberAdapter as never }, other });
    for (let i = 0; i < 3; i++) expect(await h.run()).toBe(0);
    const subs = h.submits();
    expect(subs).toHaveLength(3);
    for (const s of subs) {
      expect(s.body.run).toMatchObject({ status: 'http_error', error_code: 'detail_http', http_status: 503 });
      expect(s.body.items).toEqual([]);
    }
    expect(subs.some((s) => s.body.run.status === 'ok')).toBe(false);
  });

  it('detail 3 times out through the runner -> http_error/timeout with items: []', async () => {
    const h = harness({
      grants: [chamberGrant()], adapters: { ics_chambermaster: chamberAdapter as never },
      other: (u) => {
        const m = /\/events\/ical\/.*-(\d+)\.ics$/.exec(u.pathname);
        if (m && m[1] === '2003') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
        // details 1 and 2 succeed (AC-M1-74 c): the shared `other` answers 503 for 2002, which would end the run first
        if (m && m[1] === '2002') return text(fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', m[1]));
        return other(u);
      },
    });
    expect(await h.run()).toBe(0);
    expect(h.submits()[0].body.run).toMatchObject({ status: 'http_error', error_code: 'timeout' });
    expect(h.submits()[0].body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// R4b: classifier v2 and notices in the runner (AC-R4b-09, 13, 16; DR12)
// ---------------------------------------------------------------------------------------------------------------------
const at = (title: string, key: string, extra: Record<string, unknown> = {}) => ({ ...ev(1), externalKey: key, title, startsAt: '2026-10-31T02:00:00Z', ...extra });

describe('notices and tags in the runner (AC-R4b-09, AC-R4b-16)', () => {
  const sentinelTitle = 'NO Sentinel Fx Tonight';
  const items = () => [at(sentinelTitle, 'n'), at('Sentinel Fx', 's', { tagReasons: ['age:ambiguous', 'conflict:adult'], categoriesHint: ['music'], priceKind: 'free' }), at('Other Night', 'o', { categoriesHint: ['music', 'kids'] })];
  it('parser_version is <adapter.version>-c3 (tribe.1-c3)', async () => {
    const h = harness({ grants: [grant('tribe')], adapters: { tribe: { family: 'tribe', version: 'tribe.1', fetch: async () => okResult(1) } } });
    await h.run();
    expect(h.submits()[0].body.run.parser_version).toBe('tribe.1-c3');
    expect(h.submits()[0].body.run.parser_version).toMatch(/^[a-z0-9._-]{1,40}$/);
  });
  it('a notice is never submitted; its same-day first-ever sibling goes out cancelled; the log line ends with the counts and has no title', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => ({ items: [at('NO Fx Tonight', 'n'), at('Fx', 's')], status: 'ok' as const })) } });
    expect(await h.run()).toBe(0);
    const sent = h.submits()[0].body.items;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'Fx', cancelled: true });
    expect(sent[0].tagReasons).toContain('notice:cancel_sibling');
    const line = h.logs.find((l) => l.startsWith('source=a '))!;
    expect(line).toMatch(/ found=1 /);
    expect(line.endsWith(' notices=1/1')).toBe(true);
  });
  it('log line: tags by slug plus free, age_ambiguous, conflicts; no title, URL or reason text', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => ({ items: items(), status: 'ok' as const })) } });
    await h.run();
    const line = h.logs.find((l) => l.startsWith('source=a '))!;
    expect(line).toMatch(/ tags=kids:1,music:2,free:1 age_ambiguous=1 conflicts=1 notices=1\/1$/);
    expect(line).not.toContain('Sentinel');
    expect(line).not.toContain('http');
    expect(line).not.toContain('conflict:adult');
    expect(h.submits()[0].body.items.map((i: { title: string }) => i.title)).toEqual(['Sentinel Fx', 'Other Night']);
  });
  it('non-ok runs log zero counts', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => ({ items: [], status: 'http_error' as const, httpStatus: 503 })) } });
    await h.run();
    expect(h.logs.find((l) => l.startsWith('source=a '))).toMatch(/ tags=none age_ambiguous=0 conflicts=0 notices=0\/0$/);
  });
  it('invalid tagReasons are dropped from the item, never the item', async () => {
    const h = harness({ grants: [grant('a')], adapters: { a: fake('a', async () => ({ items: [at('Ok', 'k', { tagReasons: ['age:made_up'] }), at('Fine', 'k2', { tagReasons: ['age:ambiguous'] })], status: 'ok' as const })) } });
    await h.run();
    const sent = h.submits()[0].body.items;
    expect(sent).toHaveLength(2);
    expect('tagReasons' in sent[0]).toBe(false);
    expect(sent[1].tagReasons).toEqual(['age:ambiguous']);
  });
});

describe('source defaults (DR12)', () => {
  const run = async (config: Record<string, unknown>, item: Record<string, unknown>) => {
    const h = harness({ grants: [grant('a', { config })], adapters: { a: fake('a', async () => ({ items: [at('Sample', 'k', item)], status: 'ok' as const })) } });
    await h.run();
    return h.submits()[0].body.items[0];
  };
  it('empty hints + defaultCategories -> known slugs, cat:default added', async () => {
    const it = await run({ defaultCategories: ['community', 'bogus', 'kids'] }, {});
    expect(it.categoriesHint).toEqual(['community', 'kids']);
    expect(it.tagReasons).toContain('cat:default');
  });
  it.each(['age:21_admission', 'age:18_admission', 'age:adult_phrase', 'age:ambiguous', 'conflict:adult', 'conflict:adult_signal'])('kids/family are stripped when tagReasons has %s', async (code) => {
    const it = await run({ defaultCategories: ['community', 'kids', 'family'] }, { tagReasons: [code] });
    expect(it.categoriesHint).toEqual(['community']);
  });
  it('existing hints are never replaced; a non-array config is ignored', async () => {
    expect((await run({ defaultCategories: ['community'] }, { categoriesHint: ['music'] })).categoriesHint).toEqual(['music']);
    const none = await run({ defaultCategories: 'community' }, {});
    expect(none.categoriesHint).toEqual([]);
    expect(none.tagReasons ?? []).not.toContain('cat:default');
  });
  it('defaults that leave nothing add nothing', async () => {
    const it = await run({ defaultCategories: ['kids'] }, { tagReasons: ['conflict:adult'] });
    expect(it.categoriesHint).toEqual([]);
    expect(it.tagReasons).not.toContain('cat:default');
  });
});

describe('the Tribe fixture yields a real free event (AC-R4b-13, plan RG2)', () => {
  it('item 103 (organizer cost "Free") is free with price:text_free, and the runner submits it', async () => {
    const h = harness({
      grants: [grant('tribe', { family: 'tribe', config: { base: 'https://events.example.test', tz: 'America/Los_Angeles' }, allowed_hosts: ['events.example.test'], allowed_methods: ['api'], page_cap: 10 })],
      adapters: { tribe: tribeAdapter },
      other: (u) => {
        if (u.pathname === '/robots.txt') return text('nf', 404);
        if (u.pathname.startsWith('/wp-json/tribe/events/v1/events')) return new Response(fixture(u.searchParams.get('page') === '2' ? 'tribe/events_p2.json' : 'tribe/events_p1.json'), { status: 200, headers: { 'content-type': 'application/json' } });
        return text('', 404);
      },
    });
    expect(await h.run()).toBe(0);
    const sent = h.submits()[0].body.items as { externalKey: string; priceKind: string; tagReasons: string[] }[];
    const free = sent.find((i) => i.externalKey === '103')!;
    expect(free.priceKind).toBe('free');
    expect(free.tagReasons).toContain('price:text_free');
    expect(sent.filter((i) => i.priceKind === 'free').length).toBeGreaterThanOrEqual(1);
    expect(h.submits()[0].body.run.parser_version).toBe('tribe.1-c3');
  });
});

describe('A12 TTUSD sources through the runner (AC-M1-114 c/d/h, AC-M1-120)', () => {
  const TT_ROBOTS = 'User-agent: *\nCrawl-delay: 5\nDisallow: /fs/\nAllow: /fs/pages/\n';
  const ttGrant = (school: string, host: string, path = '/calendar') => grant(`ttusd-${school}`, {
    family: 'html_finalsite', allowed_hosts: [host], allowed_methods: ['html'], page_cap: 6,
    config: { calendarUrl: `https://${host}${path}`, school, allowlist: 'ttusd', tz: 'America/Los_Angeles' },
  });
  const htmlRes = (b: string) => new Response(b, { status: 200, headers: { 'content-type': 'text/html' } });

  it('ttusd-te logs counts only and submits the four listings', async () => {
    const h = harness({
      grants: [ttGrant('te', 'te.ttusd.org')],
      other: (u) => {
        if (u.pathname === '/robots.txt') return text(TT_ROBOTS);
        const m = u.searchParams.get('cal_date')?.slice(0, 7);
        return htmlRes(fixture(m === '2026-10' ? 'finalsite/te_2026-10.html' : m === '2026-11' ? 'finalsite/te_2026-11.html' : 'finalsite/empty_month.html'));
      },
    });
    expect(await h.run()).toBe(0);
    const line = h.logs.find((l) => l.startsWith('source=ttusd-te'))!;
    expect(line).toMatch(/^source=ttusd-te status=ok found=4 new=4 changed=0 invalid=0 filtered=6 /);
    expect(line).not.toMatch(/Pumpkin|Walk|Parade|Concert|https?:|calendar|cal_date/i);
    expect(h.submits()[0].body.run.parser_version).toBe('html_finalsite.1-c3');
    const cats = (h.submits()[0].body.items as { categoriesHint: string[] }[]).every((i) => i.categoriesHint.includes('schools'));
    expect(cats).toBe(true);
  });
  it('robots 503 -> robots_blocked; a page redirecting into /fs/ -> skipped / path_not_allowed (nothing under /fs/ requested)', async () => {
    const a = harness({ grants: [ttGrant('te', 'te.ttusd.org')], other: (u) => (u.pathname === '/robots.txt' ? text('down', 503) : text('', 404)) });
    expect(await a.run()).toBe(0);
    expect(a.submits()[0].body.run).toMatchObject({ status: 'robots_blocked' });
    expect(a.submits()[0].body.items).toEqual([]);
    const b = harness({
      grants: [ttGrant('te', 'te.ttusd.org')],
      other: (u) => (u.pathname === '/robots.txt' ? text(TT_ROBOTS) : new Response(null, { status: 302, headers: { location: 'https://te.ttusd.org/fs/calendar-manager/events.ics?calendar_ids[]=1' } })),
    });
    expect(await b.run()).toBe(0);
    expect(b.submits()[0].body.run).toMatchObject({ status: 'skipped', error_code: 'path_not_allowed' });
    expect(b.net.urls().some((x) => x.includes('/fs/'))).toBe(false);
  });
  it('the runner never has two TTUSD sources in flight, and the family floor spaces the first request of the next', async () => {
    let live = 0; let max = 0;
    const adapter = fake('html_finalsite', async () => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 10)); live--; return okResult(1); });
    const h = harness({
      grants: [ttGrant('te', 'te.ttusd.org'), ttGrant('nths', 'nths.ttusd.org'), ttGrant('district', 'www.ttusd.org', '/parents-students/calendars/calendars2')],
      adapters: { html_finalsite: adapter },
    });
    expect(await h.run()).toBe(0);
    expect(h.submits()).toHaveLength(3);
    expect(max).toBe(1);
  });
});

describe('A13 members-only is ours alone (AC-M1-128b r4)', () => {
  const run = async (family: string, hints: string[]) => {
    const h = harness({ grants: [grant(family)], adapters: { [family]: fake(family, async () => ({ items: [at('Sample', 'k', { categoriesHint: hints, tagReasons: ['cat:source_map'] })], status: 'ok' as const })) } });
    await h.run();
    return h.submits()[0].body.items[0];
  };
  it('a Tribe item with categoriesHint [members-only, music] reaches the batch without it', async () => {
    const it = await run('tribe', ['members-only', 'music']);
    expect(it.categoriesHint).toEqual(['music']);
  });
  it('an html_tahoedonner item keeps it', async () => {
    const it = await run('html_tahoedonner', ['members-only', 'food-drink']);
    expect(it.categoriesHint).toEqual(['members-only', 'food-drink']);
  });
  it('the Tahoe Donner source runs through the runner: found=8 ... filtered=6, counts only', async () => {
    const BASE = 'https://www.tahoedonner.com';
    const h = harness({
      grants: [{ grant: 'g-td', run_id: 'r-td', source: source({ slug: 'tahoe-donner', family: 'html_tahoedonner', allowed_hosts: ['www.tahoedonner.com'], allowed_methods: ['html'], page_cap: 45,
        config: { listUrl: `${BASE}/events/`, tz: 'America/Los_Angeles' } }) }],
      other: (u) => {
        if (u.pathname === '/robots.txt') return text(fixture('tahoedonner/robots.txt'));
        const h = (b: string) => new Response(b, { status: 200, headers: { 'content-type': 'text/html' } });
        if (u.pathname === '/events/') {
          const c = u.searchParams.get('categories[]');
          return h(fixture(c === '94' ? 'tahoedonner/list_family.html' : c ? 'tahoedonner/list_kids.html' : 'tahoedonner/list.html'));
        }
        const m = /^\/events\/([a-z0-9-]+)\/$/.exec(u.pathname);
        return m ? h(fixture(`tahoedonner/detail_${m[1]}.html`)) : text('nf', 404);
      },
    });
    expect(await h.run()).toBe(0);
    const line = h.logs.find((l) => l.startsWith('source=tahoe-donner'))!;
    expect(line).toMatch(/^source=tahoe-donner status=ok found=8 new=\d+ changed=\d+ invalid=0 filtered=6 /);
    expect(line).not.toMatch(/Light Up|Board|https?:|tahoedonner\.com/i);
    expect(h.submits()[0].body.run.parser_version).toBe('html_tahoedonner.1-c2');
    expect(h.submits()[0].body.items).toHaveLength(8);
  });
});
