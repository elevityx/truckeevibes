// The fresh edge cache (AC-W1-22, AC-W1-35): body + s-maxage=300 + generation only; best-effort generation guard (Amendment W1-2).
import { describe, expect, it } from 'vitest';
import { cacheKey, FRESH_S, GEN_RE, putFresh, readFresh } from './cache';
import { FakeCache } from './testing';

const G1 = '2026-10-17T20:00:00.000001Z';
const G2 = '2026-10-17T20:00:00.000002Z';
const body = (g: string, extra = '') => `{"dataAt":"${g}"${extra}}`;

describe('fresh cache', () => {
  it('key and generation format', () => {
    expect(cacheKey('scope=vibes')).toBe('https://truckeevibes.com/__cache/api/v1/events?scope=vibes');
    expect(GEN_RE.test(G1)).toBe(true);
    for (const g of ['2026-10-17T20:00:00Z', '2026-10-17T20:00:00.000Z', '', 'x']) expect(GEN_RE.test(g)).toBe(false);
  });
  it('AC-W1-35 the TTL is exactly 300 s; stored headers are content-type, cache-control and x-tv-generation only', async () => {
    expect(FRESH_S).toBe(300);
    const c = new FakeCache();
    expect(await readFresh(c, 'scope=vibes')).toBeNull();
    await putFresh(c, 'scope=vibes', body(G1), G1);
    expect(await readFresh(c, 'scope=vibes')).toBe(body(G1));
    const stored = c.store.get(cacheKey('scope=vibes'))!;
    expect(stored.headers['cache-control']).toBe('s-maxage=300');
    expect(Object.keys(stored.headers).sort()).toEqual(['cache-control', 'content-type', 'x-tv-generation']);
  });
  it('best-effort guard: an older or equal generation does not replace a newer one', async () => {
    const c = new FakeCache();
    await putFresh(c, 'q', body(G2, ',"n":2'), G2);
    await putFresh(c, 'q', body(G1, ',"n":1'), G1);
    await putFresh(c, 'q', body(G2, ',"n":3'), G2);
    expect(await readFresh(c, 'q')).toBe(body(G2, ',"n":2'));
  });
  it('a write without a valid generation is refused', async () => {
    const c = new FakeCache();
    await expect(putFresh(c, 'q', body('2026-10-17T20:00:00Z'), '2026-10-17T20:00:00Z')).rejects.toThrow();
    expect(c.store.size).toBe(0);
  });
});
