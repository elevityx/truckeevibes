// AC-W3-19a (Spec_Vibes_Widget W3.3 r2): the Lights REST client, run for real over a recording fake fetch.
import { describe, expect, it } from 'vitest';
import { FetchError, USER_AGENT, type PoliteSource } from '../core/politeFetch';
import { createLightsClient, type MirrorEnv } from './lightsClient';

const NOW = Date.parse('2026-10-17T18:00:00Z');
// A key built from fragments so the test text carries no key-shaped literal.
const KEY = ['sb', 'publishable', 'unit', 'test'].join('_');
const ENV: MirrorEnv = { LIGHTS_REST_URL: 'https://x.supabase.co', LIGHTS_PUBLISHABLE_KEY: KEY };
const SOURCE: PoliteSource = {
  allowed_hosts: ['supabase.co'], allowed_methods: ['api'], page_cap: 30, etag: null, last_modified: null,
  ingest_disposition: 'permitted', terms_recheck_at: '2027-10-17T00:00:00Z',
};

interface Call { url: string; init: RequestInit }
function recorder(reply: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return reply(c);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const json = (v: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const client = (fetch: typeof globalThis.fetch, over: { source?: Partial<PoliteSource>; env?: Partial<MirrorEnv>; timeoutSignal?: (ms: number) => AbortSignal } = {}) =>
  createLightsClient({ ...SOURCE, ...over.source }, { ...ENV, ...over.env }, { fetch, now: () => NOW, timeoutSignal: over.timeoutSignal });
const headerNames = (init: RequestInit) => [...new Headers(init.headers as HeadersInit).keys()].sort();
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'resolved'; } catch (e) { return e instanceof FetchError ? `fetch:${e.code}` : e instanceof Error ? e.message : 'thrown'; }
};
const query = () => new URLSearchParams({ select: 'id', order: 'starts_at,id', limit: '1000' });

describe('AC-W3-19a request shape', () => {
  it('the context call is POST /rest/v1/rpc/get_region_context with {"p_slug":"truckee"} and exactly the five headers', async () => {
    const r = recorder(() => json({ events: { open: true } }));
    await client(r.fetch).rpc('get_region_context', { p_slug: 'truckee' });
    expect(r.calls).toHaveLength(1);
    const c = r.calls[0];
    expect(c.url).toBe('https://x.supabase.co/rest/v1/rpc/get_region_context');
    expect(c.init.method).toBe('POST');
    expect(c.init.body).toBe('{"p_slug":"truckee"}');
    expect(headerNames(c.init)).toEqual(['accept', 'apikey', 'authorization', 'content-type', 'user-agent']);
    const h = new Headers(c.init.headers as HeadersInit);
    expect(h.get('apikey')).toBe(KEY);
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(h.get('accept')).toBe('application/json');
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('user-agent')).toBe(USER_AGENT);
  });
  it('the events call is GET /rest/v1/events?<query> with prefer: count=exact', async () => {
    const r = recorder(() => json([], { 'content-range': '*/0' }));
    await client(r.fetch).selectEvents(query());
    const c = r.calls[0];
    expect(c.url).toBe(`https://x.supabase.co/rest/v1/events?${query().toString()}`);
    expect(c.init.method).toBe('GET');
    expect(c.init.body ?? null).toBeNull();
    const h = new Headers(c.init.headers as HeadersInit);
    expect(h.get('prefer')).toBe('count=exact');
    expect(h.get('apikey')).toBe(KEY);
    expect(h.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(h.get('user-agent')).toBe(USER_AGENT);
  });
  it("every call has redirect: 'error', credentials: 'omit' and an abort signal", async () => {
    const r = recorder((c) => (c.url.includes('/rpc/') ? json({ events: {} }) : json([], { 'content-range': '*/0' })));
    const lc = client(r.fetch);
    await lc.rpc('get_region_context', { p_slug: 'truckee' });
    await lc.selectEvents(query());
    for (const c of r.calls) {
      expect(c.init.redirect).toBe('error');
      expect(c.init.credentials).toBe('omit');
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('asks for a 10,000 ms timeout signal', async () => {
    const asked: number[] = [];
    const r = recorder(() => json({}));
    await client(r.fetch, { timeoutSignal: (ms) => { asked.push(ms); return new AbortController().signal; } }).rpc('get_region_context', { p_slug: 'truckee' });
    expect(asked).toEqual([10_000]);
  });
});

describe('AC-W3-19a Content-Range total', () => {
  it.each([['0-11/12', 12], ['*/0', 0], [null, null], ['0-4/*', null]])('%s -> %s', async (cr, want) => {
    const r = recorder(() => json([], cr === null ? {} : { 'content-range': cr }));
    expect((await client(r.fetch).selectEvents(query())).total).toBe(want);
  });
  it('returns the rows array', async () => {
    const r = recorder(() => json([{ id: 'a' }, { id: 'b' }], { 'content-range': '0-1/2' }));
    expect(await client(r.fetch).selectEvents(query())).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], total: 2 });
  });
});

describe('AC-W3-19a refusals', () => {
  it('a 302 -> redirect_blocked', async () => {
    const r = recorder(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect(await codeOf(client(r.fetch).rpc('get_region_context', { p_slug: 'truckee' }))).toBe('fetch:redirect_blocked');
  });
  it('a fetch that rejects on a redirect (redirect: error) -> redirect_blocked', async () => {
    const r = recorder(() => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); });
    expect(await codeOf(client(r.fetch).rpc('get_region_context', { p_slug: 'truckee' }))).toBe('fetch:redirect_blocked');
  });
  it('a non-200 -> http_<status>', async () => {
    const r = recorder(() => new Response('{}', { status: 503 }));
    expect(await codeOf(client(r.fetch).selectEvents(query()))).toBe('http_503');
  });
  it('a 2 MiB + 1 body -> too_large (streamed, no content-length)', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(32);
    const r = recorder(() => new Response(new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), { status: 200 }));
    expect(await codeOf(client(r.fetch).selectEvents(query()))).toBe('fetch:too_large');
  });
  it('exactly 2 MiB is read', async () => {
    const body = new TextEncoder().encode(JSON.stringify(['x'.repeat(2 * 1024 * 1024 - 4)]));
    expect(body.byteLength).toBe(2 * 1024 * 1024);
    const r = recorder(() => new Response(body, { status: 200, headers: { 'content-range': '0-0/1' } }));
    expect((await client(r.fetch).selectEvents(query())).total).toBe(1);
  });
  it('a declared content-length over the cap -> too_large', async () => {
    const r = recorder(() => new Response('[]', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }));
    expect(await codeOf(client(r.fetch).selectEvents(query()))).toBe('fetch:too_large');
  });
  it('the fake timing out -> timeout', async () => {
    const r = recorder(() => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
    expect(await codeOf(client(r.fetch).rpc('get_region_context', { p_slug: 'truckee' }))).toBe('fetch:timeout');
  });
  it('a body that is not JSON -> parse; an events body that is not an array -> parse', async () => {
    const r1 = recorder(() => new Response('<html>', { status: 200 }));
    expect(await codeOf(client(r1.fetch).rpc('get_region_context', { p_slug: 'truckee' }))).toBe('parse');
    const r2 = recorder(() => json({ a: 1 }, { 'content-range': '*/0' }));
    expect(await codeOf(client(r2.fetch).selectEvents(query()))).toBe('parse');
  });
  it('terms_recheck_at in the past -> terms_gate with zero fetch calls', async () => {
    const r = recorder(() => json({}));
    expect(await codeOf(client(r.fetch, { source: { terms_recheck_at: '2026-10-01T00:00:00Z' } }).rpc('get_region_context', { p_slug: 'truckee' })))
      .toBe('fetch:terms_gate');
    expect(await codeOf(client(r.fetch, { source: { ingest_disposition: 'permission_required' } }).selectEvents(query()))).toBe('fetch:terms_gate');
    expect(r.calls).toHaveLength(0);
  });
  it("allowed_methods ['feed'] -> method_gate with zero fetch calls", async () => {
    const r = recorder(() => json({}));
    expect(await codeOf(client(r.fetch, { source: { allowed_methods: ['feed'] } }).rpc('get_region_context', { p_slug: 'truckee' }))).toBe('fetch:method_gate');
    expect(r.calls).toHaveLength(0);
  });
  it.each([
    ['https://x.evil.example'], ['http://x.supabase.co'], ['https://x.supabase.co:8443'], ['https://user:pw@x.supabase.co'],
    ['https://x.supabase.co/rest/v1'], ['https://supabase.co.evil.example'], ['https://xsupabase.co'], ['not a url'],
  ])('LIGHTS_REST_URL %s -> host_not_allowed with zero calls', async (u) => {
    const r = recorder(() => json({}));
    expect(await codeOf(client(r.fetch, { env: { LIGHTS_REST_URL: u } }).rpc('get_region_context', { p_slug: 'truckee' }))).toBe('fetch:host_not_allowed');
    expect(r.calls).toHaveLength(0);
  });
  it('a trailing slash on LIGHTS_REST_URL is fine', async () => {
    const r = recorder(() => json({}));
    await client(r.fetch, { env: { LIGHTS_REST_URL: 'https://x.supabase.co/' } }).rpc('get_region_context', { p_slug: 'truckee' });
    expect(r.calls[0].url).toBe('https://x.supabase.co/rest/v1/rpc/get_region_context');
  });
  it('a 4th request -> page_cap (the run needs exactly 3)', async () => {
    const r = recorder(() => json({}));
    const lc = client(r.fetch);
    for (let i = 0; i < 3; i++) await lc.rpc('get_region_context', { p_slug: 'truckee' });
    expect(await codeOf(lc.rpc('get_region_context', { p_slug: 'truckee' }))).toBe('fetch:page_cap');
    expect(r.calls).toHaveLength(3);
  });
});
