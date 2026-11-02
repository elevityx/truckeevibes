// Sources V2 (AC-SV2-25, 27, 28): the admin Function helpers: same-origin policy, bearer shape, capped body read, the admin_whoami
// check (caller's bearer + publishable key, redirect 'manual', timeout) and the no-store reply. Fixture JWT is `hdr.payload.sig`.
import { describe, expect, it } from 'vitest';
import { MAX_BEARER, MAX_BODY, bearerOf, checkAdmin, readCapped, reply, sameOrigin } from './admin';
import { ENV, jsonResponse, recordingFetch } from './testing';

const SITE = 'https://truckeevibes.com';
const URL_ = `${SITE}/api/admin/dispatch`;
const JWT = 'hdr.payload.sig';
const WHOAMI = 'http://127.0.0.1:55421/rest/v1/rpc/admin_whoami';

const req = (method: string, headers: Record<string, string> = {}, body?: BodyInit) =>
  new Request(URL_, { method, headers, ...(body !== undefined ? { body } : {}) });

describe('constants', () => {
  it('MAX_BODY 1024 bytes, MAX_BEARER 4096 chars', () => {
    expect(MAX_BODY).toBe(1024);
    expect(MAX_BEARER).toBe(4096);
  });
});

describe('sameOrigin (V14)', () => {
  const okPost = { origin: SITE, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  it('POST: own Origin + same-origin + JSON passes; Sec-Fetch-Site may be absent', () => {
    expect(sameOrigin(req('POST', okPost, '{}'), 'POST')).toBe(true);
    expect(sameOrigin(req('POST', { origin: SITE, 'content-type': 'application/json' }, '{}'), 'POST')).toBe(true);
  });
  it('POST: a foreign or missing Origin is refused', () => {
    expect(sameOrigin(req('POST', { ...okPost, origin: 'https://example.com' }, '{}'), 'POST')).toBe(false);
    expect(sameOrigin(req('POST', { ...okPost, origin: 'http://truckeevibes.com' }, '{}'), 'POST')).toBe(false);
    expect(sameOrigin(req('POST', { ...okPost, origin: 'https://www.truckeevibes.com' }, '{}'), 'POST')).toBe(false);
    expect(sameOrigin(req('POST', { origin: 'null', 'content-type': 'application/json' }, '{}'), 'POST')).toBe(false);
    expect(sameOrigin(req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, '{}'), 'POST')).toBe(false);
  });
  it('POST: Sec-Fetch-Site other than same-origin is refused', () => {
    for (const s of ['cross-site', 'same-site', 'none']) {
      expect(sameOrigin(req('POST', { ...okPost, 'sec-fetch-site': s }, '{}'), 'POST')).toBe(false);
    }
  });
  it('POST: a non-JSON or missing content-type is refused (text/plain is a CORS-simple type)', () => {
    expect(sameOrigin(req('POST', { ...okPost, 'content-type': 'text/plain' }, '{}'), 'POST')).toBe(false);
    expect(sameOrigin(req('POST', { ...okPost, 'content-type': 'application/x-www-form-urlencoded' }, 'a=1'), 'POST')).toBe(false);
    expect(sameOrigin(req('POST', { origin: SITE, 'sec-fetch-site': 'same-origin' }, new Uint8Array([123, 125])), 'POST')).toBe(false);
  });
  it('GET: both absent passes (non-browser); own Origin passes; same-origin Sec-Fetch-Site with no Origin passes', () => {
    expect(sameOrigin(req('GET'), 'GET')).toBe(true);
    expect(sameOrigin(req('GET', { origin: SITE }), 'GET')).toBe(true);
    expect(sameOrigin(req('GET', { 'sec-fetch-site': 'same-origin' }), 'GET')).toBe(true);
  });
  it('GET: a foreign Origin or a non-same-origin Sec-Fetch-Site is refused', () => {
    expect(sameOrigin(req('GET', { origin: 'https://example.com' }), 'GET')).toBe(false);
    expect(sameOrigin(req('GET', { 'sec-fetch-site': 'cross-site' }), 'GET')).toBe(false);
    expect(sameOrigin(req('GET', { 'sec-fetch-site': 'same-site' }), 'GET')).toBe(false);
    expect(sameOrigin(req('GET', { origin: SITE, 'sec-fetch-site': 'cross-site' }), 'GET')).toBe(false);
  });
});

describe('bearerOf', () => {
  it('"Bearer <a>.<b>.<c>" (base64url) -> the token', () => {
    expect(bearerOf(req('GET', { authorization: `Bearer ${JWT}` }))).toBe(JWT);
    expect(bearerOf(req('GET', { authorization: 'Bearer aA0-_.bB1-_.cC2-_' }))).toBe('aA0-_.bB1-_.cC2-_');
  });
  it('missing, Basic, two-segment, four-segment or non-base64url -> null', () => {
    expect(bearerOf(req('GET'))).toBeNull();
    expect(bearerOf(req('GET', { authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
    expect(bearerOf(req('GET', { authorization: 'Bearer hdr.payload' }))).toBeNull();
    expect(bearerOf(req('GET', { authorization: 'Bearer a.b.c.d' }))).toBeNull();
    expect(bearerOf(req('GET', { authorization: 'Bearer a+b.c/d.e=' }))).toBeNull();
    expect(bearerOf(req('GET', { authorization: JWT }))).toBeNull();
  });
  it('a bearer over MAX_BEARER chars -> null', () => {
    const long = `${'a'.repeat(2500)}.${'b'.repeat(2500)}.sig`;
    expect(bearerOf(req('GET', { authorization: `Bearer ${long}` }))).toBeNull();
  });
});

describe('readCapped', () => {
  it('returns the text up to MAX_BODY bytes', async () => {
    const body = `{"a":"${'x'.repeat(MAX_BODY - 8)}"}`;
    expect(new TextEncoder().encode(body).length).toBe(MAX_BODY);
    expect(await readCapped(req('POST', { 'content-type': 'application/json' }, body))).toBe(body);
    expect(await readCapped(req('POST', {}, '{}'))).toBe('{}');
  });
  it('MAX_BODY + 1 bytes -> null; bytes, not characters, are counted', async () => {
    expect(await readCapped(req('POST', {}, 'x'.repeat(MAX_BODY + 1)))).toBeNull();
    expect(await readCapped(req('POST', {}, 'é'.repeat(MAX_BODY / 2)))).toBe('é'.repeat(MAX_BODY / 2));
    expect(await readCapped(req('POST', {}, 'é'.repeat(MAX_BODY / 2 + 1)))).toBeNull();
  });
  it('a streamed body with no Content-Length is still capped', async () => {
    const chunk = new Uint8Array(600).fill(120);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(chunk); c.enqueue(chunk); c.close(); } });
    const r = new Request(URL_, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(r.headers.get('content-length')).toBeNull();
    expect(await readCapped(r)).toBeNull();
  });
  it('Content-Length > MAX_BODY short-circuits without reading', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(10)); c.close(); } });
    const r = new Request(URL_, { method: 'POST', body: stream, duplex: 'half', headers: { 'content-length': '5000' } } as RequestInit);
    const before = pulled;
    expect(await readCapped(r)).toBeNull();
    expect(pulled - before).toBeLessThanOrEqual(1);
  });
});

describe('checkAdmin (admin_whoami)', () => {
  it('POSTs rpc/admin_whoami with body {}, the publishable key, the caller bearer, JSON and redirect manual', async () => {
    const f = recordingFetch(() => jsonResponse(true));
    expect(await checkAdmin(ENV, JWT, f)).toBe('admin');
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(WHOAMI);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(init.headers);
    expect(h.get('apikey')).toBe('test-publishable-key');
    expect(h.get('authorization')).toBe(`Bearer ${JWT}`);
    expect(h.get('content-type')).toBe('application/json');
  });
  it('200 + anything but true -> forbidden; 403 -> forbidden; 401 -> unauthorized', async () => {
    for (const body of [false, null, 'true', { admin: true }, [true], 1]) {
      expect(await checkAdmin(ENV, JWT, recordingFetch(() => jsonResponse(body)))).toBe('forbidden');
    }
    expect(await checkAdmin(ENV, JWT, recordingFetch(() => new Response('not json', { status: 200 })))).toBe('forbidden');
    expect(await checkAdmin(ENV, JWT, recordingFetch(() => jsonResponse({ code: '42501' }, 403)))).toBe('forbidden');
    expect(await checkAdmin(ENV, JWT, recordingFetch(() => jsonResponse({ code: 'PGRST301' }, 401)))).toBe('unauthorized');
  });
  it('the body is parsed only on 200 (a 403 whose body is `true` stays forbidden, unread)', async () => {
    let read = 0;
    const f = recordingFetch(() => {
      const r = new Response('true', { status: 403, headers: { 'content-type': 'application/json' } });
      const json = r.json.bind(r);
      const text = r.text.bind(r);
      r.json = () => { read += 1; return json(); };
      r.text = () => { read += 1; return text(); };
      return r;
    });
    expect(await checkAdmin(ENV, JWT, f)).toBe('forbidden');
    expect(read).toBe(0);
  });
  it('3xx, 5xx, other statuses, network errors -> unavailable', async () => {
    for (const status of [301, 302, 307, 400, 404, 500, 502, 503]) {
      const f = recordingFetch(() => new Response(null, { status, headers: status < 400 ? { location: 'https://example.com/' } : {} }));
      expect(await checkAdmin(ENV, JWT, f)).toBe('unavailable');
    }
    expect(await checkAdmin(ENV, JWT, recordingFetch(() => { throw new TypeError('network'); }))).toBe('unavailable');
  });
  it('times out through AbortController -> unavailable', async () => {
    const f = recordingFetch((_u, init) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const t0 = Date.now();
    expect(await checkAdmin(ENV, JWT, f, 50)).toBe('unavailable');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('missing Supabase env -> unavailable, no fetch', async () => {
    const f = recordingFetch(() => jsonResponse(true));
    expect(await checkAdmin({}, JWT, f)).toBe('unavailable');
    expect(await checkAdmin({ NEXT_PUBLIC_SUPABASE_URL: ENV.NEXT_PUBLIC_SUPABASE_URL }, JWT, f)).toBe('unavailable');
    expect(f.calls).toHaveLength(0);
  });
});

describe('reply', () => {
  it('JSON with no-store and nosniff, never access-control-*; extra headers added', async () => {
    const r = reply(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    expect(r.status).toBe(405);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.headers.get('allow')).toBe('POST');
    expect([...r.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    expect(await r.json()).toEqual({ error: 'method_not_allowed' });
  });
});
