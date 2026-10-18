// AC-W2-04: atomic paging (up to 4 pages), dedupe, error classes.
import { describe, expect, it } from 'vitest';
import { fetchAll } from './api';
import { jsonResponse, pagedFetch, rawEnvelope, rawRow } from './testing';

const page = (from: number, n: number, next: string | null) =>
  rawEnvelope(Array.from({ length: n }, (_, i) => rawRow(from + i)), { nextCursor: next, pageComplete: next === null });
const opts = (fetchFn: typeof fetch) => ({ endpoint: 'https://truckeevibes.com/api/v1/events', season: 'halloween' as const, year: 2026, fetch: fetchFn });

describe('fetchAll', () => {
  it('drains 3 pages of 500 into one result of 1,500 events', async () => {
    const f = pagedFetch({ '': () => jsonResponse(page(1, 500, 'c2')), c2: () => jsonResponse(page(501, 500, 'c3')), c3: () => jsonResponse(page(1001, 500, null)) });
    const r = await fetchAll(opts(f.fn));
    if ('error' in r) throw new Error(r.error);
    expect(r.events).toHaveLength(1500);
    expect(r.invalid).toBe(0);
    expect(f.calls).toHaveLength(3);
    const first = new URL(f.calls[0]);
    expect(Object.fromEntries(first.searchParams)).toEqual({ scope: 'lights', season: 'halloween', year: '2026' });
    expect(new URL(f.calls[2]).searchParams.get('cursor')).toBe('c3');
  });

  it('sends no credentials and uses the default cache', async () => {
    let init: RequestInit | undefined;
    const fn = (async (_u: RequestInfo | URL, i?: RequestInit) => ((init = i), jsonResponse(page(1, 1, null)))) as typeof fetch;
    await fetchAll(opts(fn));
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('default');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a 5th page needed -> incomplete', async () => {
    const f = pagedFetch({ '': () => jsonResponse(page(1, 2, 'a')), a: () => jsonResponse(page(3, 2, 'b')), b: () => jsonResponse(page(5, 2, 'c')), c: () => jsonResponse(page(7, 2, 'd')) });
    expect(await fetchAll(opts(f.fn))).toEqual({ error: 'incomplete' });
    expect(f.calls).toHaveLength(4);
  });

  it('keeps a duplicate id across pages once', async () => {
    const f = pagedFetch({ '': () => jsonResponse(page(1, 3, 'a')), a: () => jsonResponse(page(3, 3, null)) });
    const r = await fetchAll(opts(f.fn));
    if ('error' in r) throw new Error(r.error);
    expect(r.events.map((e) => e.id)).toHaveLength(5);
    expect(new Set(r.events.map((e) => e.id)).size).toBe(5);
  });

  it('counts and drops invalid rows', async () => {
    const env = rawEnvelope([rawRow(1), rawRow(2, { title: 'a'.repeat(10240) }), rawRow(3, { url: 7 })]);
    const r = await fetchAll(opts(pagedFetch({ '': () => jsonResponse(env) }).fn));
    if ('error' in r) throw new Error(r.error);
    expect(r.events).toHaveLength(1);
    expect(r.invalid).toBe(2);
  });

  it('HTTP 503 -> http (no partial result), on any page', async () => {
    expect(await fetchAll(opts(pagedFetch({ '': () => jsonResponse({ error: 'unavailable' }, 503) }).fn))).toEqual({ error: 'http' });
    const f = pagedFetch({ '': () => jsonResponse(page(1, 2, 'a')), a: () => jsonResponse({ error: 'unavailable' }, 503) });
    expect(await fetchAll(opts(f.fn))).toEqual({ error: 'http' });
  });

  it('non-JSON or a bad envelope -> shape', async () => {
    expect(await fetchAll(opts(pagedFetch({ '': () => new Response('<html>', { status: 200 }) }).fn))).toEqual({ error: 'shape' });
    expect(await fetchAll(opts(pagedFetch({ '': () => jsonResponse({ version: 9 }) }).fn))).toEqual({ error: 'shape' });
  });

  it('a thrown fetch -> network', async () => {
    const fn = (async () => { throw new TypeError('offline'); }) as typeof fetch;
    expect(await fetchAll(opts(fn))).toEqual({ error: 'network' });
  });

  it('aborts after 10 s -> network', async () => {
    const fn = ((_u: RequestInfo | URL, i?: RequestInit) =>
      new Promise<Response>((_res, rej) => i?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
    const r = await fetchAll({ ...opts(fn), timeoutMs: 20 });
    expect(r).toEqual({ error: 'network' });
  });

  it('takes the oldest dataAt and ORs stale across pages', async () => {
    const p1 = page(1, 1, 'a');
    const p2 = { ...page(2, 1, null), dataAt: '2026-10-15T14:40:00.000000Z', stale: true };
    const r = await fetchAll(opts(pagedFetch({ '': () => jsonResponse(p1), a: () => jsonResponse(p2) }).fn));
    if ('error' in r) throw new Error(r.error);
    expect(r.env.dataAt).toBe('2026-10-15T14:40:00.000Z');
    expect(r.env.stale).toBe(true);
  });
});
