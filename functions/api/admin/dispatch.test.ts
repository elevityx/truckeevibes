// Sources V2 (AC-SV2-25, 26, 27): POST /api/admin/dispatch. Gates in order (method, same origin, bearer, body, admin_whoami, token),
// then exactly one GitHub workflow_dispatch. No token, JWT or upstream body ever reaches a response or a log line.
import { describe, expect, it } from 'vitest';
import { handle, onRequest, type Deps } from './dispatch';
import { DISPATCH_URL } from '../../_lib/github';
import { ENV, jsonResponse, recordingFetch, type RecordingFetch } from '../../_lib/testing';
import type { Env } from '../../_lib/types';

const SITE = 'https://truckeevibes.com';
const BASE = `${SITE}/api/admin/dispatch`;
const JWT = 'hdr.payload.sig';
const TOKEN = 'test-dispatch-token';
const MARK = 'UPSTREAM-BODY-MARKER';
const WHOAMI = 'http://127.0.0.1:55421/rest/v1/rpc/admin_whoami';
const ENV_T = { ...ENV, GITHUB_DISPATCH_TOKEN: TOKEN };
const LOG_RE = /^admin dispatch status=\d{3} outcome=(ok|not_configured|rejected|unknown|-)( reason=[a-z_]+)?( gh=\d+)?$/;

type Who = () => Response | Promise<Response>;
type Gh = () => Response | Promise<Response>;
interface Call { method?: string; origin?: string | null; sfs?: string | null; ct?: string | null; auth?: string | null; body?: string | null }

function setup(o: { who?: Who; gh?: Gh; env?: Env; adminTimeoutMs?: number; githubTimeoutMs?: number } = {}) {
  const who = o.who ?? (() => jsonResponse(true));
  const gh = o.gh ?? (() => new Response(null, { status: 204 }));
  const fetch: RecordingFetch = recordingFetch((url) => {
    if (url === WHOAMI) return who();
    if (url === DISPATCH_URL) return gh();
    throw new Error(`unexpected fetch ${url}`);
  });
  const logs: string[] = [];
  const deps: Deps = { fetch, log: (l: string) => logs.push(l), adminTimeoutMs: o.adminTimeoutMs, githubTimeoutMs: o.githubTimeoutMs };
  const whoCalls = () => fetch.calls.filter((c) => c.url === WHOAMI);
  const ghCalls = () => fetch.calls.filter((c) => c.url === DISPATCH_URL);
  const call = async (c: Call = {}) => {
    const method = c.method ?? 'POST';
    const h = new Headers();
    const set = (k: string, v: string | null | undefined, d: string) => { const x = v === undefined ? d : v; if (x !== null) h.set(k, x); };
    set('origin', c.origin, SITE);
    set('sec-fetch-site', c.sfs, 'same-origin');
    set('content-type', c.ct, 'application/json');
    set('authorization', c.auth, `Bearer ${JWT}`);
    const body = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : (c.body === undefined ? '{}' : c.body ?? undefined);
    const res = await handle(new Request(BASE, { method, headers: h, ...(body !== undefined ? { body } : {}) }), o.env ?? ENV_T, deps);
    const text = await res.text();
    return { res, text, json: text ? JSON.parse(text) : null };
  };
  return { fetch, logs, call, whoCalls, ghCalls };
}

const acKeys = (r: Response) => [...r.headers.keys()].filter((k) => k.startsWith('access-control-'));

describe('AC-SV2-25 gate 1: method', () => {
  for (const method of ['GET', 'PUT', 'OPTIONS', 'DELETE', 'PATCH']) {
    it(`${method} -> 405 method_not_allowed, allow: POST, no access-control-*, no upstream call`, async () => {
      const s = setup();
      const { res, json } = await s.call({ method, origin: 'https://example.com' });
      expect(res.status).toBe(405);
      expect(json).toEqual({ error: 'method_not_allowed' });
      expect(res.headers.get('allow')).toBe('POST');
      expect(acKeys(res)).toEqual([]);
      expect(s.fetch.calls).toHaveLength(0);
    });
  }
});

describe('AC-SV2-25 gate 2: same origin', () => {
  const bad: [string, Call][] = [
    ['a foreign Origin', { origin: 'https://example.com' }],
    ['a missing Origin', { origin: null }],
    ['an http Origin', { origin: 'http://truckeevibes.com' }],
    ['Sec-Fetch-Site: cross-site', { sfs: 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { sfs: 'same-site' }],
    ['content-type text/plain', { ct: 'text/plain' }],
    ['no content-type', { ct: null }],
  ];
  for (const [name, c] of bad) {
    it(`${name} -> 403 bad_origin, no upstream call`, async () => {
      const s = setup();
      const { res, json } = await s.call(c);
      expect(res.status).toBe(403);
      expect(json).toEqual({ error: 'bad_origin' });
      expect(s.fetch.calls).toHaveLength(0);
    });
  }
  it('no Sec-Fetch-Site (non-browser) with the own Origin passes the gate', async () => {
    const s = setup();
    const { res } = await s.call({ sfs: null });
    expect(res.status).toBe(202);
  });
  it('the origin gate runs before the bearer gate (foreign Origin + no bearer -> 403)', async () => {
    const s = setup();
    const { res, json } = await s.call({ origin: 'https://example.com', auth: null });
    expect(res.status).toBe(403);
    expect(json).toEqual({ error: 'bad_origin' });
  });
});

describe('AC-SV2-25 gate 3: bearer', () => {
  const bad: [string, string | null][] = [
    ['missing', null],
    ['Basic', 'Basic dXNlcjpwYXNz'],
    ['two-segment', 'Bearer hdr.payload'],
    ['over 4096 chars', `Bearer ${'a'.repeat(2500)}.${'b'.repeat(2500)}.sig`],
    ['no scheme', JWT],
  ];
  for (const [name, auth] of bad) {
    it(`${name} bearer -> 401 unauthorized, no upstream call`, async () => {
      const s = setup();
      const { res, json } = await s.call({ auth });
      expect(res.status).toBe(401);
      expect(json).toEqual({ error: 'unauthorized' });
      expect(s.fetch.calls).toHaveLength(0);
    });
  }
  it('the bearer gate runs before the body gate (no bearer + bad body -> 401)', async () => {
    const s = setup();
    const { res } = await s.call({ auth: null, body: '[]' });
    expect(res.status).toBe(401);
  });
});

describe('AC-SV2-25 gate 4: body', () => {
  const bad: [string, string][] = [
    ['over 1024 bytes', `{"a":"${'x'.repeat(2000)}"}`],
    ['1025 bytes', `{"a":"${'x'.repeat(1025 - 8)}"}`],
    ['[]', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['a number', '1'],
    ['true', 'true'],
    ['invalid JSON', '{'],
    ['empty', ''],
  ];
  for (const [name, body] of bad) {
    it(`${name} -> 400 bad_body, no admin_whoami call`, async () => {
      const s = setup();
      const { res, json } = await s.call({ body });
      expect(res.status).toBe(400);
      expect(json).toEqual({ error: 'bad_body' });
      expect(s.fetch.calls).toHaveLength(0);
    });
  }
  it('exactly 1024 bytes of JSON object passes', async () => {
    const body = `{"a":"${'x'.repeat(1024 - 8)}"}`;
    expect(body.length).toBe(1024);
    const s = setup();
    const { res } = await s.call({ body });
    expect(res.status).toBe(202);
  });
});

describe('AC-SV2-25 gate 5: admin_whoami', () => {
  it('the call carries the caller bearer, the publishable key and redirect manual', async () => {
    const s = setup();
    await s.call();
    expect(s.whoCalls()).toHaveLength(1);
    const { init } = s.whoCalls()[0];
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${JWT}`);
    expect(h.get('apikey')).toBe('test-publishable-key');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
  });
  const cases: [string, Who, number, unknown][] = [
    ['false', () => jsonResponse(false), 403, { error: 'forbidden' }],
    ['403', () => jsonResponse({ code: '42501' }, 403), 403, { error: 'forbidden' }],
    ['401', () => jsonResponse({ code: 'PGRST301' }, 401), 401, { error: 'unauthorized' }],
    ['500', () => new Response('boom', { status: 500 }), 503, { error: 'unavailable' }],
    ['302', () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), 503, { error: 'unavailable' }],
    ['a throw', () => { throw new TypeError('network'); }, 503, { error: 'unavailable' }],
  ];
  for (const [name, who, status, body] of cases) {
    it(`admin_whoami ${name} -> ${status}, no GitHub call`, async () => {
      const s = setup({ who });
      const { res, json } = await s.call();
      expect(res.status).toBe(status);
      expect(json).toEqual(body);
      expect(s.ghCalls()).toHaveLength(0);
    });
  }
  it('admin_whoami timeout -> 503 unavailable', async () => {
    const t0 = Date.now();
    // the whoami fetch settles only when checkAdmin aborts it on its own timer
    const f = recordingFetch((url, init) => url === WHOAMI
      ? new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
      : new Response(null, { status: 204 }));
    const logs: string[] = [];
    const res = await handle(new Request(BASE, { method: 'POST', headers: { origin: SITE, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', authorization: `Bearer ${JWT}` }, body: '{}' }), ENV_T, { fetch: f, log: (l: string) => logs.push(l), adminTimeoutMs: 30 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.calls.filter((c) => c.url === DISPATCH_URL)).toHaveLength(0);
    expect(logs).toEqual(['admin dispatch status=503 outcome=-']);
  });
  it('a non-admin with no token configured gets 403, not 503 (configuration is never revealed)', async () => {
    for (const env of [ENV, { ...ENV, GITHUB_DISPATCH_TOKEN: '' }]) {
      const s = setup({ who: () => jsonResponse(false), env });
      const { res, json } = await s.call();
      expect(res.status).toBe(403);
      expect(json).toEqual({ error: 'forbidden' });
    }
  });
});

describe('AC-SV2-26 outcomes', () => {
  it('no token -> 503 not_configured, zero GitHub calls (after the admin check)', async () => {
    for (const env of [ENV, { ...ENV, GITHUB_DISPATCH_TOKEN: '' }]) {
      const s = setup({ env });
      const { res, json } = await s.call();
      expect(res.status).toBe(503);
      expect(json).toEqual({ outcome: 'not_configured' });
      expect(s.whoCalls()).toHaveLength(1);
      expect(s.ghCalls()).toHaveLength(0);
    }
  });
  const cases: [string, Gh, number, unknown][] = [
    ['204', () => new Response(null, { status: 204 }), 202, { outcome: 'ok' }],
    ['200', () => new Response(MARK, { status: 200 }), 202, { outcome: 'ok' }],
    ['401', () => jsonResponse({ message: MARK }, 401), 502, { outcome: 'rejected', reason: 'token_refused' }],
    ['403', () => jsonResponse({ message: MARK }, 403), 502, { outcome: 'rejected', reason: 'token_refused' }],
    ['404', () => jsonResponse({ message: MARK }, 404), 502, { outcome: 'rejected', reason: 'workflow_not_found' }],
    ['422', () => jsonResponse({ message: MARK }, 422), 502, { outcome: 'rejected', reason: 'ref_rejected' }],
    ['302', () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), 502, { outcome: 'unknown', reason: 'upstream' }],
    ['500', () => new Response(MARK, { status: 500 }), 502, { outcome: 'unknown', reason: 'upstream' }],
    ['a throw', () => { throw new TypeError(MARK); }, 502, { outcome: 'unknown', reason: 'upstream' }],
  ];
  for (const [name, gh, status, body] of cases) {
    it(`GitHub ${name} -> ${status} ${JSON.stringify(body)}`, async () => {
      const s = setup({ gh });
      const { res, json } = await s.call();
      expect(res.status).toBe(status);
      expect(json).toEqual(body);
      expect(s.ghCalls()).toHaveLength(1);
    });
  }
  it('GitHub timeout -> 502 unknown/upstream', async () => {
    const f = recordingFetch((url, init) => url === WHOAMI ? jsonResponse(true)
      : new Promise<Response>((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const t0 = Date.now();
    const res = await handle(new Request(BASE, { method: 'POST', headers: { origin: SITE, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', authorization: `Bearer ${JWT}` }, body: '{}' }), ENV_T, { fetch: f, log: () => undefined, githubTimeoutMs: 30 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ outcome: 'unknown', reason: 'upstream' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('exactly one GitHub request to DISPATCH_URL: body {"ref":"main"}, the token, the GitHub headers, redirect manual', async () => {
    const s = setup();
    await s.call();
    expect(s.ghCalls()).toHaveLength(1);
    expect(s.fetch.calls).toHaveLength(2);
    const { init } = s.ghCalls()[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"ref":"main"}');
    expect(init.redirect).toBe('manual');
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(h.get('user-agent')).toBe('truckeevibes-admin');
    expect(h.get('x-github-api-version')).toBe('2022-11-28');
    expect(h.get('accept')).toBe('application/vnd.github+json');
    // the caller's JWT and the publishable key never go to GitHub
    expect(JSON.stringify([...h.entries()])).not.toContain(JWT);
    expect(JSON.stringify([...h.entries()])).not.toContain('test-publishable-key');
  });
  it('the caller body is never forwarded to GitHub', async () => {
    const s = setup();
    await s.call({ body: '{"ref":"evil","inputs":{"x":"1"}}' });
    expect(s.ghCalls()[0].init.body).toBe('{"ref":"main"}');
  });
});

describe('AC-SV2-27 token never leaks; headers; one log line of codes', () => {
  const scenarios: [string, Parameters<typeof setup>[0], Call][] = [
    ['405', {}, { method: 'GET' }],
    ['bad origin', {}, { origin: 'https://example.com' }],
    ['no bearer', {}, { auth: null }],
    ['bad body', {}, { body: '[]' }],
    ['whoami false', { who: () => jsonResponse(false) }, {}],
    ['whoami 401', { who: () => jsonResponse({}, 401) }, {}],
    ['whoami 500', { who: () => new Response(MARK, { status: 500 }) }, {}],
    ['not configured', { env: ENV }, {}],
    ['ok', {}, {}],
    ['token refused', { gh: () => jsonResponse({ message: MARK }, 401) }, {}],
    ['workflow not found', { gh: () => jsonResponse({ message: MARK }, 404) }, {}],
    ['ref rejected', { gh: () => jsonResponse({ message: MARK }, 422) }, {}],
    ['upstream 500', { gh: () => new Response(MARK, { status: 500 }) }, {}],
    ['upstream throw', { gh: () => { throw new TypeError(MARK); } }, {}],
  ];
  for (const [name, o, c] of scenarios) {
    it(`${name}: no token/JWT/upstream body in the body, headers or logs; no-store, nosniff, no access-control-*; one log line`, async () => {
      const s = setup(o);
      const { res, text } = await s.call(c);
      const headers = JSON.stringify([...res.headers.entries()]);
      for (const secret of [TOKEN, JWT, MARK, 'test-publishable-key']) {
        expect(text).not.toContain(secret);
        expect(headers).not.toContain(secret);
        expect(s.logs.join('\n')).not.toContain(secret);
      }
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(acKeys(res)).toEqual([]);
      expect(s.logs).toHaveLength(1);
      expect(s.logs[0]).toMatch(LOG_RE);
      expect(s.logs[0]).toContain(`status=${res.status}`);
    });
  }
  it('exact log lines for representative outcomes', async () => {
    const line = async (o: Parameters<typeof setup>[0], c: Call = {}) => { const s = setup(o); await s.call(c); return s.logs[0]; };
    expect(await line({}, { method: 'GET' })).toBe('admin dispatch status=405 outcome=-');
    expect(await line({}, { origin: 'https://example.com' })).toBe('admin dispatch status=403 outcome=-');
    expect(await line({ env: ENV })).toBe('admin dispatch status=503 outcome=not_configured');
    expect(await line({})).toBe('admin dispatch status=202 outcome=ok gh=204');
    expect(await line({ gh: () => jsonResponse({}, 401) })).toBe('admin dispatch status=502 outcome=rejected reason=token_refused gh=401');
    expect(await line({ gh: () => new Response(null, { status: 500 }) })).toBe('admin dispatch status=502 outcome=unknown reason=upstream gh=500');
  });
});

describe('onRequest', () => {
  it('is exported for Pages', () => {
    expect(typeof onRequest).toBe('function');
  });
});
