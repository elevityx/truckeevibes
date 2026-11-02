// Sources V2 (AC-SV2-27, 28): GET /api/admin/dispatch-status. Method, the GET origin policy (before the bearer and the RPC),
// bearer, admin_whoami, then {configured} for an admin only. Never a GitHub call; the token never leaks.
import { describe, expect, it } from 'vitest';
import { handle, onRequest, type Deps } from './dispatch-status';
import { ENV, jsonResponse, recordingFetch, type RecordingFetch } from '../../_lib/testing';
import type { Env } from '../../_lib/types';

const SITE = 'https://truckeevibes.com';
const BASE = `${SITE}/api/admin/dispatch-status`;
const JWT = 'hdr.payload.sig';
const TOKEN = 'test-dispatch-token';
const WHOAMI = 'http://127.0.0.1:55421/rest/v1/rpc/admin_whoami';
const ENV_T = { ...ENV, GITHUB_DISPATCH_TOKEN: TOKEN };

interface Call { method?: string; origin?: string | null; sfs?: string | null; auth?: string | null }

function setup(o: { who?: () => Response | Promise<Response>; env?: Env } = {}) {
  const who = o.who ?? (() => jsonResponse(true));
  const fetch: RecordingFetch = recordingFetch((url) => {
    if (url === WHOAMI) return who();
    throw new Error(`unexpected fetch ${url}`);
  });
  const logs: string[] = [];
  const deps: Deps = { fetch, log: (l: string) => logs.push(l) };
  const call = async (c: Call = {}) => {
    const h = new Headers();
    const set = (k: string, v: string | null | undefined, d: string | null) => { const x = v === undefined ? d : v; if (x !== null) h.set(k, x); };
    set('origin', c.origin, null);
    set('sec-fetch-site', c.sfs, 'same-origin');
    set('authorization', c.auth, `Bearer ${JWT}`);
    const method = c.method ?? 'GET';
    const res = await handle(new Request(BASE, { method, headers: h, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) }),
      o.env ?? ENV_T, deps);
    const text = await res.text();
    return { res, text, json: text ? JSON.parse(text) : null };
  };
  return { fetch, logs, call };
}
const acKeys = (r: Response) => [...r.headers.keys()].filter((k) => k.startsWith('access-control-'));

describe('AC-SV2-28 dispatch-status', () => {
  for (const method of ['POST', 'PUT', 'OPTIONS', 'DELETE']) {
    it(`${method} -> 405, allow: GET, no access-control-*, no upstream call`, async () => {
      const s = setup();
      const { res, json } = await s.call({ method });
      expect(res.status).toBe(405);
      expect(json).toEqual({ error: 'method_not_allowed' });
      expect(res.headers.get('allow')).toBe('GET');
      expect(acKeys(res)).toEqual([]);
      expect(s.fetch.calls).toHaveLength(0);
    });
  }
  it('a foreign Origin -> 403 bad_origin even with a valid bearer, before admin_whoami (astra R3-5)', async () => {
    const s = setup();
    const { res, json } = await s.call({ origin: 'https://example.com' });
    expect(res.status).toBe(403);
    expect(json).toEqual({ error: 'bad_origin' });
    expect(s.fetch.calls).toHaveLength(0);
  });
  it('Sec-Fetch-Site: cross-site (or same-site) -> 403 bad_origin, no RPC', async () => {
    for (const sfs of ['cross-site', 'same-site']) {
      const s = setup();
      const { res, json } = await s.call({ sfs });
      expect(res.status).toBe(403);
      expect(json).toEqual({ error: 'bad_origin' });
      expect(s.fetch.calls).toHaveLength(0);
    }
  });
  it('the origin gate runs before the bearer gate (foreign Origin + no bearer -> 403)', async () => {
    const s = setup();
    const { res } = await s.call({ origin: 'https://example.com', auth: null });
    expect(res.status).toBe(403);
  });
  it('same-origin Sec-Fetch-Site with no Origin passes; the own Origin passes; neither header (non-browser) passes', async () => {
    for (const c of [{ origin: null, sfs: 'same-origin' }, { origin: SITE, sfs: 'same-origin' }, { origin: null, sfs: null }] as Call[]) {
      const s = setup();
      const { res, json } = await s.call(c);
      expect(res.status).toBe(200);
      expect(json).toEqual({ configured: true });
    }
  });
  it('no bearer, Basic or two-segment bearer -> 401 unauthorized, no RPC', async () => {
    for (const auth of [null, 'Basic dXNlcjpwYXNz', 'Bearer hdr.payload']) {
      const s = setup();
      const { res, json } = await s.call({ auth });
      expect(res.status).toBe(401);
      expect(json).toEqual({ error: 'unauthorized' });
      expect(s.fetch.calls).toHaveLength(0);
    }
  });
  it('the RPC carries the caller bearer and the publishable key, redirect manual', async () => {
    const s = setup();
    await s.call();
    expect(s.fetch.calls).toHaveLength(1);
    const { url, init } = s.fetch.calls[0];
    expect(url).toBe(WHOAMI);
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${JWT}`);
    expect(h.get('apikey')).toBe('test-publishable-key');
    expect(init.redirect).toBe('manual');
  });
  it('non-admin (false or 403) -> 403 forbidden; 401 -> 401; 500 / 302 / throw -> 503 unavailable', async () => {
    const cases: [() => Response, number, unknown][] = [
      [() => jsonResponse(false), 403, { error: 'forbidden' }],
      [() => jsonResponse({ code: '42501' }, 403), 403, { error: 'forbidden' }],
      [() => jsonResponse({}, 401), 401, { error: 'unauthorized' }],
      [() => new Response('boom', { status: 500 }), 503, { error: 'unavailable' }],
      [() => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), 503, { error: 'unavailable' }],
      [() => { throw new TypeError('network'); }, 503, { error: 'unavailable' }],
    ];
    for (const [who, status, body] of cases) {
      for (const env of [ENV_T, ENV]) {
        const s = setup({ who, env });
        const { res, json } = await s.call();
        expect(res.status).toBe(status);
        expect(json).toEqual(body);
        expect(json).not.toHaveProperty('configured');
      }
    }
  });
  it('admin -> 200 {configured:false} without the token (absent or empty), {configured:true} with it', async () => {
    for (const env of [ENV, { ...ENV, GITHUB_DISPATCH_TOKEN: '' }]) {
      const { res, json } = await setup({ env }).call();
      expect(res.status).toBe(200);
      expect(json).toEqual({ configured: false });
    }
    const { res, json } = await setup().call();
    expect(res.status).toBe(200);
    expect(json).toEqual({ configured: true });
  });
});

describe('AC-SV2-27 dispatch-status: no leak, headers, one log line', () => {
  const scenarios: [string, Parameters<typeof setup>[0], Call][] = [
    ['405', {}, { method: 'POST' }],
    ['bad origin', {}, { origin: 'https://example.com' }],
    ['no bearer', {}, { auth: null }],
    ['non-admin', { who: () => jsonResponse(false) }, {}],
    ['unavailable', { who: () => new Response('boom', { status: 500 }) }, {}],
    ['configured', {}, {}],
    ['not configured', { env: ENV }, {}],
  ];
  for (const [name, o, c] of scenarios) {
    it(`${name}: no token or JWT anywhere; no-store, nosniff, no access-control-*; one log line`, async () => {
      const s = setup(o);
      const { res, text } = await s.call(c);
      const headers = JSON.stringify([...res.headers.entries()]);
      for (const secret of [TOKEN, JWT, 'test-publishable-key']) {
        expect(text).not.toContain(secret);
        expect(headers).not.toContain(secret);
        expect(s.logs.join('\n')).not.toContain(secret);
      }
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(acKeys(res)).toEqual([]);
      expect(s.logs).toHaveLength(1);
      expect(s.logs[0]).toMatch(/^admin dispatch-status status=\d{3}( configured=(true|false))?$/);
      expect(s.logs[0]).toContain(`status=${res.status}`);
    });
  }
  it('exact log lines', async () => {
    const line = async (o: Parameters<typeof setup>[0], c: Call = {}) => { const s = setup(o); await s.call(c); return s.logs[0]; };
    expect(await line({})).toBe('admin dispatch-status status=200 configured=true');
    expect(await line({ env: ENV })).toBe('admin dispatch-status status=200 configured=false');
    expect(await line({}, { auth: null })).toBe('admin dispatch-status status=401');
    expect(await line({}, { method: 'POST' })).toBe('admin dispatch-status status=405');
  });
  it('onRequest is exported for Pages', () => {
    expect(typeof onRequest).toBe('function');
  });
});
