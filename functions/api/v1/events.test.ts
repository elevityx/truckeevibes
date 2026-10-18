// AC-W1-20, 22, 23, 24, 25: the /api/v1/events Pages Function (handle) over a recording fetch and an in-memory cache.
import { describe, expect, it } from 'vitest';
import { handle, type Deps } from './events';
import { ORIGINS } from '../../_lib/origins';
import { cacheKey, lkgKey, putLkg, readLkg } from '../../_lib/lkg';
import { ENV, FakeCache, gen, jsonResponse, rawEnvelope, recordingFetch, type RecordingFetch } from '../../_lib/testing';
import type { Env } from '../../_lib/types';

const NOW = Date.parse('2026-10-17T20:00:00Z');
const BASE = 'https://truckeevibes.com/api/v1/events';

function setup(responder: Parameters<typeof recordingFetch>[0] = () => jsonResponse(rawEnvelope({ n: 2 })), env: Env = ENV) {
  const fetch: RecordingFetch = recordingFetch(responder);
  const cache = new FakeCache();
  const logs: string[] = [];
  const waits: Promise<unknown>[] = [];
  const deps: Deps = { fetch, cache, now: () => NOW, log: (l: string) => logs.push(l), waitUntil: (p) => waits.push(p) };
  const call = async (qs = 'scope=vibes', init: RequestInit & { origin?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set('origin', init.origin);
    const res = await handle(new Request(`${BASE}${qs ? `?${qs}` : ''}`, { method: init.method ?? 'GET', headers }), env, deps);
    await Promise.all(waits.splice(0));
    return res;
  };
  return { fetch, cache, logs, deps, call };
}
const headerMap = (r: Response) => Object.fromEntries([...r.headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
const FRESH_CC = 'public, max-age=60, s-maxage=300, stale-while-revalidate=300';

describe('AC-W1-20 happy path headers and CORS', () => {
  it('200 with exactly content-type, cache-control, nosniff, vary (no Origin -> no ACAO)', async () => {
    const { call } = setup();
    const r = await call('scope=vibes');
    expect(r.status).toBe(200);
    expect(headerMap(r)).toEqual({ 'cache-control': FRESH_CC, 'content-type': 'application/json; charset=utf-8',
      vary: 'Origin', 'x-content-type-options': 'nosniff' });
    const body = await r.json();
    expect(body).toMatchObject({ version: 1, scope: 'vibes', stale: false, count: 2 });
  });
  it('ACAO echoed for each of the five allowed origins', async () => {
    for (const o of ORIGINS) {
      const { call } = setup();
      const r = await call('scope=vibes', { origin: o });
      expect(headerMap(r)).toEqual({ 'access-control-allow-origin': o, 'cache-control': FRESH_CC,
        'content-type': 'application/json; charset=utf-8', vary: 'Origin', 'x-content-type-options': 'nosniff' });
    }
  });
  it('no ACAO for https://evil.example', async () => {
    const { call } = setup();
    const r = await call('scope=vibes', { origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('vary')).toBe('Origin');
  });
  it('http://localhost:3000 only when CF_PAGES_BRANCH is not main', async () => {
    const onMain = await setup().call('scope=vibes', { origin: 'http://localhost:3000' });
    expect(onMain.headers.get('access-control-allow-origin')).toBeNull();
    const preview = await setup(undefined, { ...ENV, CF_PAGES_BRANCH: 'w1-api' }).call('scope=vibes', { origin: 'http://localhost:3000' });
    expect(preview.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });
  it('HEAD -> 200, same headers, no body', async () => {
    const { call } = setup();
    const r = await call('scope=vibes', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(FRESH_CC);
    expect(await r.text()).toBe('');
  });
  it('the RPC is called with the parsed query', async () => {
    const { call, fetch } = setup();
    await call('scope=lights&season=halloween&year=2026&limit=5');
    expect(JSON.parse(String(fetch.calls[0].init.body))).toMatchObject({ p_scope: 'lights', p_season: 'halloween', p_year: 2026, p_limit: 5 });
  });
});

describe('AC-W1-21 response keys', () => {
  it('an extra raw key (confidence) never reaches the client', async () => {
    const raw = rawEnvelope({ n: 1 });
    (raw.events as Record<string, unknown>[])[0].confidence = 90;
    const r = await setup(() => jsonResponse(raw)).call('scope=vibes');
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain('confidence');
  });
});

describe('AC-W1-19 / bad params', () => {
  it('400 {error:bad_param, param}', async () => {
    const { call, fetch } = setup();
    const r = await call('nope=1', { origin: 'https://truckeelights.com' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_param', param: 'nope' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBe('https://truckeelights.com');
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('AC-W1-22 edge cache', () => {
  it('a second canonical-equal request is served from the cache without calling fetch', async () => {
    const { call, fetch, logs } = setup();
    const a = await call('area=b,a,a&scope=vibes');
    expect(a.status).toBe(200);
    const bodyA = await a.text();
    const b = await call('scope=vibes&area=a,b', { origin: 'https://truckeevibes.com' });
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(bodyA);
    expect(fetch.calls).toHaveLength(1);
    expect(b.headers.get('cache-control')).toBe(FRESH_CC);
    expect(b.headers.get('access-control-allow-origin')).toBe('https://truckeevibes.com');
    expect(logs.at(-2)).toMatch(/ cache=miss$/);
    expect(logs.at(-1)).toMatch(/ cache=hit$/);
  });
  it('a different canonical query misses', async () => {
    const { call, fetch } = setup();
    await call('area=truckee');
    await call('area=donner_lake');
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('AC-W1-23 last known good', () => {
  const failures: Array<[string, Parameters<typeof recordingFetch>[0]]> = [
    ['500', () => new Response('upstream secret text', { status: 500 })],
    ['timeout', (_u, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('abort'))))],
    ['malformed body', () => jsonResponse({ hello: 'upstream secret text' })],
    ['network error', () => Promise.reject(new TypeError('upstream secret text'))],
  ];
  const seedLkg = async (cache: FakeCache, ageMs: number) => {
    const dataAt = gen(NOW - ageMs);
    const env: Record<string, unknown> = { ...rawEnvelope({ n: 1, mirror: { state: 'confirmed', confirmedAt: dataAt, heldSince: null, heldCount: 0 } }), dataAt,
      version: 1, scope: 'vibes', season: null, year: null, stale: false, pageComplete: true,
      attribution: { name: 'TruckeeVibes', url: 'https://truckeevibes.com/' } };
    await putLkg(cache, 'scope=vibes', JSON.stringify(env), dataAt);
    return env;
  };
  for (const [name, responder] of failures) {
    it(`${name}: LKG 5 h 59 min old -> 200 stale:true, dataAt and mirror kept, x-tv-stale: 1, no-store`, async () => {
      const s = setup(responder);
      const lkg = await seedLkg(s.cache, (5 * 60 + 59) * 60_000);
      const r = await handleWithShortTimeout(s, 'scope=vibes');
      expect(r.status).toBe(200);
      expect(r.headers.get('x-tv-stale')).toBe('1');
      expect(r.headers.get('cache-control')).toBe('no-store');
      const body = await r.json();
      expect(body.stale).toBe(true);
      expect(body.dataAt).toBe(lkg.dataAt);
      expect(body.mirror).toEqual(lkg.mirror);
      expect(s.logs.at(-1)).toMatch(/ cache=lkg$/);
    });
    it(`${name}: LKG 6 h 1 min old -> 503 unavailable`, async () => {
      const s = setup(responder);
      await seedLkg(s.cache, (6 * 60 + 1) * 60_000);
      const r = await handleWithShortTimeout(s, 'scope=vibes');
      expect(r.status).toBe(503);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ error: 'unavailable' });
      expect(text).not.toContain('upstream');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(s.logs.at(-1)).toMatch(/ cache=none$/);
    });
    it(`${name}: no LKG -> 503, body never carries upstream text`, async () => {
      const s = setup(responder);
      const r = await handleWithShortTimeout(s, 'scope=vibes');
      expect(r.status).toBe(503);
      expect(await r.text()).toBe('{"error":"unavailable"}');
    });
  }
  it('a fresh success also writes the LKG copy', async () => {
    const s = setup();
    await s.call('scope=vibes');
    expect(s.cache.puts.sort()).toEqual(['https://truckeevibes.com/__cache/api/v1/events?scope=vibes',
      'https://truckeevibes.com/__lkg/api/v1/events?scope=vibes']);
  });
});

// the timeout case needs the Function's RPC timeout to fire quickly; handle takes it from deps.rpcTimeoutMs
async function handleWithShortTimeout(s: ReturnType<typeof setup>, qs: string) {
  s.deps.rpcTimeoutMs = 50;
  return s.call(qs);
}

describe('AC-W1-24 upstream 400', () => {
  it("RPC 400 with details:'limit' -> 400 {error:'bad_param', param:'limit'}", async () => {
    const s = setup(() => jsonResponse({ code: '22023', details: 'limit', hint: null, message: 'invalid_input' }, 400));
    const r = await s.call('scope=vibes&limit=5');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_param', param: 'limit' });
  });
  it("RPC 400 with details:'area' (slug not in public.areas) -> 400 bad_param area", async () => {
    const s = setup(() => jsonResponse({ code: '22023', details: 'area', hint: null, message: 'invalid_input' }, 400));
    const r = await s.call('area=atlantis');
    expect(await r.json()).toEqual({ error: 'bad_param', param: 'area' });
  });
  it('an unknown upstream detail -> the 503 path', async () => {
    const s = setup(() => jsonResponse({ code: '22023', details: 'something_else', message: 'invalid_input' }, 400));
    const r = await s.call('scope=vibes');
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'unavailable' });
  });
});

describe('AC-W1-25 methods and logs', () => {
  it('OPTIONS -> 204 with allow-methods GET, HEAD for allowed origins', async () => {
    for (const o of ORIGINS) {
      const r = await setup().call('scope=vibes', { method: 'OPTIONS', origin: o });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-methods')).toBe('GET, HEAD');
      expect(r.headers.get('access-control-allow-origin')).toBe(o);
      expect(r.headers.get('access-control-max-age')).toBe('86400');
    }
    const evil = await setup().call('scope=vibes', { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(evil.status).toBe(204);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('POST/PUT/DELETE/PATCH -> 405', async () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const s = setup();
      const r = await s.call('scope=vibes', { method: m });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
      expect(s.fetch.calls).toHaveLength(0);
    }
  });
  it('log lines are only `api v1 status=… scope=… count=… cache=…` (no query values, no titles)', async () => {
    const s = setup();
    await s.call('scope=vibes&area=truckee&from=2026-10-17');
    await s.call('scope=vibes&area=truckee&from=2026-10-17');
    await s.call('nope=secret-value');
    await s.call('scope=vibes', { method: 'POST' });
    const s2 = setup(() => new Response('x', { status: 500 }));
    await s2.call('scope=lights&season=halloween&year=2026');
    const lines = [...s.logs, ...s2.logs];
    expect(lines.length).toBe(5);
    for (const l of lines) {
      expect(l).toMatch(/^api v1 status=\d{3} scope=(vibes|lights|-) count=\d+ cache=(hit|miss|lkg|none)$/);
      expect(l).not.toMatch(/\?|title|truckee|secret|2026/);
    }
    expect(s.logs[0]).toBe('api v1 status=200 scope=vibes count=2 cache=miss');
    expect(s.logs[1]).toBe('api v1 status=200 scope=vibes count=2 cache=hit');
    expect(s2.logs[0]).toBe('api v1 status=503 scope=lights count=0 cache=none');
  });
});

describe('Amendment W1-1: no LKG resurrection', () => {
  const G = (min: number) => gen(NOW - 60 * 60_000 + min * 60_000);
  // a responder that walks through a script: an envelope (n events at generation g) or an outage
  const scripted = (steps: Array<{ n: number; g: string } | 'down'>) => {
    let i = 0;
    return () => {
      const st = steps[Math.min(i++, steps.length - 1)];
      return st === 'down' ? new Response('upstream secret text', { status: 500 }) : jsonResponse(rawEnvelope({ n: st.n, dataAt: st.g }));
    };
  };
  const expireFresh = (c: FakeCache, canonical = 'scope=vibes') => c.store.delete(cacheKey(canonical));

  it('AC-W1-30 fresh success with 0 events + rejected LKG write -> a later outage is 503, never the earlier 1-event body', async () => {
    const s = setup(scripted([{ n: 1, g: G(0) }, { n: 0, g: G(10) }, 'down']));
    expect((await (await s.call('scope=vibes')).json()).count).toBe(1);
    expect((await readLkg(s.cache, 'scope=vibes'))!.env.count).toBe(1);
    expireFresh(s.cache);
    s.cache.failPut = (k) => k === lkgKey('scope=vibes');
    const r2 = await s.call('scope=vibes');
    expect((await r2.json()).count).toBe(0);
    expect(await readLkg(s.cache, 'scope=vibes')).toBeNull();               // the older LKG was deleted (fail closed)
    expireFresh(s.cache);
    const r3 = await s.call('scope=vibes');
    expect(r3.status).toBe(503);
    expect(await r3.text()).toBe('{"error":"unavailable"}');
  });
  it('AC-W1-30 control: with no write failure an outage serves the newer LKG (0 events), not the older one', async () => {
    const s = setup(scripted([{ n: 1, g: G(0) }, { n: 0, g: G(10) }, 'down']));
    await s.call('scope=vibes');
    expireFresh(s.cache);
    await s.call('scope=vibes');
    expireFresh(s.cache);
    const r3 = await s.call('scope=vibes');
    expect(r3.status).toBe(200);
    const b = await r3.json();
    expect(b).toMatchObject({ stale: true, count: 0, dataAt: G(10) });
  });
  it('AC-W1-31 two responses finishing in reverse order keep the newer generation in the cache and the LKG', async () => {
    const release: Array<() => void> = [];
    const bodies = [rawEnvelope({ n: 1, dataAt: G(0) }), rawEnvelope({ n: 0, dataAt: G(10) })];
    let i = 0;
    const s = setup(() => {
      const b = bodies[i++];
      return new Promise<Response>((res) => release.push(() => res(jsonResponse(b))));
    });
    const waits: Promise<unknown>[] = [];
    s.deps.waitUntil = (p) => waits.push(p);
    const req = () => handle(new Request(`${BASE}?scope=vibes`), ENV, s.deps);
    const older = req();
    const newer = req();
    await new Promise((r) => setTimeout(r, 0));
    release[1]();                                                          // the newer finishes first
    expect((await (await newer).json()).count).toBe(0);
    await Promise.all(waits.splice(0));
    release[0]();                                                          // then the older one
    expect((await (await older).json()).count).toBe(1);
    await Promise.all(waits.splice(0));
    expect(JSON.parse(s.cache.store.get(cacheKey('scope=vibes'))!.body).dataAt).toBe(G(10));
    expect((await readLkg(s.cache, 'scope=vibes'))!.generation).toBe(G(10));
  });
  it('AC-W1-32 an LKG without a valid generation is never served (header missing, malformed, mismatched, bad body)', async () => {
    const good = JSON.stringify({ ...rawEnvelope({ n: 1, dataAt: G(0) }), version: 1, scope: 'vibes', season: null, year: null, stale: false,
      pageComplete: true, attribution: { name: 'TruckeeVibes', url: 'https://truckeevibes.com/' } });
    const cases: Array<[string, Record<string, string>]> = [
      [good, {}], [good, { 'x-tv-generation': '2026-10-17T19:00:00Z' }], [good, { 'x-tv-generation': G(5) }], ['not json', { 'x-tv-generation': G(0) }],
      [JSON.stringify({ dataAt: G(0), count: 1 }), { 'x-tv-generation': G(0) }],                   // not a valid envelope
    ];
    for (const [b, h] of cases) {
      const s = setup(() => new Response('x', { status: 500 }));
      s.cache.store.set(lkgKey('scope=vibes'), { body: b, headers: { 'cache-control': 's-maxage=21600', ...h } });
      const r = await s.call('scope=vibes');
      expect(r.status).toBe(503);
    }
  });
  it('an RPC success without a valid generation is treated as a failure (not cached)', async () => {
    const s = setup(() => jsonResponse(rawEnvelope({ n: 1, dataAt: '2026-10-17T20:00:00Z' })));
    const r = await s.call('scope=vibes');
    expect(r.status).toBe(503);
    expect(s.cache.store.size).toBe(0);
  });
});
