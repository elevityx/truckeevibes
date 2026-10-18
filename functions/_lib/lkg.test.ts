// Cache keys and stored responses (body + s-maxage only; no CORS is ever cached).
import { describe, expect, it } from 'vitest';
import { cacheKey, lkgKey, putFresh, putLkg, readFresh, readLkg } from './lkg';
import { FakeCache } from './testing';

describe('lkg', () => {
  it('keys', () => {
    expect(cacheKey('scope=vibes')).toBe('https://truckeevibes.com/__cache/api/v1/events?scope=vibes');
    expect(lkgKey('scope=vibes')).toBe('https://truckeevibes.com/__lkg/api/v1/events?scope=vibes');
  });
  it('fresh: stored with s-maxage=300 and only content-type + cache-control', async () => {
    const c = new FakeCache();
    expect(await readFresh(c, 'scope=vibes')).toBeNull();
    await putFresh(c, 'scope=vibes', '{"a":1}');
    expect(await readFresh(c, 'scope=vibes')).toBe('{"a":1}');
    const stored = c.store.get(cacheKey('scope=vibes'))!;
    expect(stored.headers['cache-control']).toBe('s-maxage=300');
    expect(Object.keys(stored.headers).sort()).toEqual(['cache-control', 'content-type']);
  });
  it('lkg: stored with s-maxage=21600; read parses JSON, a bad body reads as null', async () => {
    const c = new FakeCache();
    expect(await readLkg(c, 'scope=vibes')).toBeNull();
    await putLkg(c, 'scope=vibes', '{"dataAt":"2026-10-17T20:00:00Z"}');
    expect(await readLkg(c, 'scope=vibes')).toEqual({ dataAt: '2026-10-17T20:00:00Z' });
    expect(c.store.get(lkgKey('scope=vibes'))!.headers['cache-control']).toBe('s-maxage=21600');
    await putLkg(c, 'scope=lights', 'not json');
    expect(await readLkg(c, 'scope=lights')).toBeNull();
  });
});
