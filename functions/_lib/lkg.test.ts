// Cache keys and stored responses (body + s-maxage + generation only; no CORS is ever cached), fenced writes (Amendment W1-1).
import { describe, expect, it } from 'vitest';
import { cacheKey, deleteLkg, GEN_RE, lkgKey, putFresh, putLkg, readFresh, readLkg } from './lkg';
import { FakeCache } from './testing';

const G1 = '2026-10-17T20:00:00.000001Z';
const G2 = '2026-10-17T20:00:00.000002Z';
const body = (g: string, extra = '') => `{"dataAt":"${g}"${extra}}`;

describe('lkg', () => {
  it('keys and the generation format', () => {
    expect(cacheKey('scope=vibes')).toBe('https://truckeevibes.com/__cache/api/v1/events?scope=vibes');
    expect(lkgKey('scope=vibes')).toBe('https://truckeevibes.com/__lkg/api/v1/events?scope=vibes');
    expect(GEN_RE.test(G1)).toBe(true);
    for (const g of ['2026-10-17T20:00:00Z', '2026-10-17T20:00:00.000Z', '', 'x']) expect(GEN_RE.test(g)).toBe(false);
  });
  it('fresh: stored with s-maxage=300, content-type and x-tv-generation only', async () => {
    const c = new FakeCache();
    expect(await readFresh(c, 'scope=vibes')).toBeNull();
    await putFresh(c, 'scope=vibes', body(G1), G1);
    expect(await readFresh(c, 'scope=vibes')).toBe(body(G1));
    const stored = c.store.get(cacheKey('scope=vibes'))!;
    expect(stored.headers['cache-control']).toBe('s-maxage=300');
    expect(Object.keys(stored.headers).sort()).toEqual(['cache-control', 'content-type', 'x-tv-generation']);
  });
  it('lkg: stored with s-maxage=21600; read returns the parsed body and its generation', async () => {
    const c = new FakeCache();
    expect(await readLkg(c, 'scope=vibes')).toBeNull();
    await putLkg(c, 'scope=vibes', body(G1), G1);
    expect(await readLkg(c, 'scope=vibes')).toEqual({ env: { dataAt: G1 }, generation: G1 });
    expect(c.store.get(lkgKey('scope=vibes'))!.headers['cache-control']).toBe('s-maxage=21600');
  });
  it('AC-W1-31 fenced: an older or equal generation never replaces a newer one (fresh and lkg)', async () => {
    const c = new FakeCache();
    await putFresh(c, 'q', body(G2, ',"n":2'), G2);
    await putFresh(c, 'q', body(G1, ',"n":1'), G1);
    await putFresh(c, 'q', body(G2, ',"n":3'), G2);
    expect(await readFresh(c, 'q')).toBe(body(G2, ',"n":2'));
    await putLkg(c, 'q', body(G2, ',"n":2'), G2);
    await putLkg(c, 'q', body(G1, ',"n":1'), G1);
    expect((await readLkg(c, 'q'))!.generation).toBe(G2);
    expect((await readLkg(c, 'q'))!.env.n).toBe(2);
  });
  it('a write without a valid generation is refused', async () => {
    const c = new FakeCache();
    await expect(putLkg(c, 'q', body('2026-10-17T20:00:00Z'), '2026-10-17T20:00:00Z')).rejects.toThrow();
    expect(c.store.size).toBe(0);
  });
  it('AC-W1-32 an LKG without a valid generation is never returned', async () => {
    const c = new FakeCache();
    const k = lkgKey('q');
    const put = (b: string, h: Record<string, string>) => c.store.set(k, { body: b, headers: h });
    put(body(G1), {});                                                    // no generation header
    expect(await readLkg(c, 'q')).toBeNull();
    put(body(G1), { 'x-tv-generation': '2026-10-17T20:00:00Z' });          // malformed header
    expect(await readLkg(c, 'q')).toBeNull();
    put(body(G2), { 'x-tv-generation': G1 });                              // body and header disagree
    expect(await readLkg(c, 'q')).toBeNull();
    put('{"count":1}', { 'x-tv-generation': G1 });                         // body without dataAt
    expect(await readLkg(c, 'q')).toBeNull();
    put('not json', { 'x-tv-generation': G1 });                            // parse error
    expect(await readLkg(c, 'q')).toBeNull();
  });
  it('deleteLkg removes the entry', async () => {
    const c = new FakeCache();
    await putLkg(c, 'q', body(G1), G1);
    await deleteLkg(c, 'q');
    expect(await readLkg(c, 'q')).toBeNull();
  });
});
