// AC-SV2-29 / AC-SV2-30 (Spec_Sources_V2 §9 adminJobs.ts): stamp + jobs RPC wrappers and the dispatch Function client.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const getSession = vi.fn();
vi.mock('@/lib/supabase/client', () => ({ getSupabase: () => ({ rpc, auth: { getSession } }) }));

import * as j from './adminJobs';
import { DataError } from './types';

beforeEach(() => {
  rpc.mockReset();
  getSession.mockReset();
});

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jwt = async () => 'hdr.payload.sig';

describe('adminSetForceDue / adminSetReadRequest', () => {
  it('admin_set_force_due takes {p_slug, p_on} and maps the result', async () => {
    rpc.mockResolvedValue({
      data: { slug: 'alibi-truckee', force_due_at: '2026-11-05T18:00:00Z', already: false, next_due_at: '2026-11-06T00:00:00Z',
        last_grant_at: '2026-11-05T12:00:00Z' },
      error: null,
    });
    const r = await j.adminSetForceDue('alibi-truckee', true);
    expect(rpc).toHaveBeenCalledWith('admin_set_force_due', { p_slug: 'alibi-truckee', p_on: true });
    expect(r).toEqual({ slug: 'alibi-truckee', at: '2026-11-05T18:00:00Z', already: false, nextDueAt: '2026-11-06T00:00:00Z',
      lastGrantAt: '2026-11-05T12:00:00Z' });
  });
  it('a cancel maps a null stamp', async () => {
    rpc.mockResolvedValue({ data: { slug: 's', force_due_at: null, already: false, next_due_at: null, last_grant_at: null }, error: null });
    const r = await j.adminSetForceDue('s', false);
    expect(rpc).toHaveBeenCalledWith('admin_set_force_due', { p_slug: 's', p_on: false });
    expect(r).toEqual({ slug: 's', at: null, already: false, nextDueAt: null, lastGrantAt: null });
  });
  it('admin_set_read_request takes {p_slug, p_on}; at = read_requested_at, lastGrantAt null when absent', async () => {
    rpc.mockResolvedValue({ data: { slug: 'bar-of-america', read_requested_at: '2026-11-05T18:00:00Z', already: true,
      next_due_at: '2026-11-06T09:00:00Z' }, error: null });
    const r = await j.adminSetReadRequest('bar-of-america', true);
    expect(rpc).toHaveBeenCalledWith('admin_set_read_request', { p_slug: 'bar-of-america', p_on: true });
    expect(r).toEqual({ slug: 'bar-of-america', at: '2026-11-05T18:00:00Z', already: true, nextDueAt: '2026-11-06T09:00:00Z', lastGrantAt: null });
  });
  it('surfaces DataError with its detail', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'rate_limited', details: 'too_soon', code: 'P0001' } });
    const e1 = await j.adminSetForceDue('s', true).catch((e) => e);
    expect(e1).toBeInstanceOf(DataError);
    expect(e1).toMatchObject({ code: 'rate_limited', detail: 'too_soon' });
    rpc.mockResolvedValue({ data: null, error: { message: 'invalid_input', details: 'manual_only', code: '22023' } });
    expect(await j.adminSetForceDue('s', true).catch((e) => e)).toMatchObject({ code: 'invalid_input', detail: 'manual_only' });
    rpc.mockResolvedValue({ data: null, error: { message: 'invalid_input', details: 'not_manual', code: '22023' } });
    expect(await j.adminSetReadRequest('s', true).catch((e) => e)).toMatchObject({ code: 'invalid_input', detail: 'not_manual' });
  });
  it('a TypeError becomes network', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    for (const c of [() => j.adminSetForceDue('s', true), () => j.adminSetReadRequest('s', true), () => j.adminJobs()]) {
      expect(await c().catch((e: unknown) => e)).toMatchObject({ code: 'network' });
    }
  });
});

describe('adminJobs', () => {
  const RAW = {
    generated_at: '2026-11-05T18:00:00Z',
    batches: [{ issued_at: '2026-11-05T16:00:00Z', grants: 3, pending: 0, unused: 1, run_now: ['alibi-truckee'],
      runs: [{ slug: 'alibi-truckee', status: 'ok', found: 3, new: 1, changed: 0, error_code: null, finished_at: '2026-11-05T16:02:00Z' }] }],
    manual: [{ issued_at: '2026-11-05T15:00:00Z', slug: 'bar-of-america', requested: true, state: 'done',
      run: { slug: 'bar-of-america', status: 'ok', found: 4, new: 0, changed: 1, error_code: null, finished_at: '2026-11-05T15:01:00Z' } },
    { issued_at: '2026-11-05T14:00:00Z', slug: 'fiftyfifty-brewing', requested: false, state: 'no_result', run: null }],
    stamps: [{ slug: 'alibi-truckee', name: 'Alibi Ale Works', kind: 'run_now', requested_at: null, served_at: '2026-11-05T16:02:00Z',
      pending: false, expired: false }],
  };
  it('defaults to p_limit 10 and maps snake_case to camelCase', async () => {
    rpc.mockResolvedValue({ data: RAW, error: null });
    const r = await j.adminJobs();
    expect(rpc).toHaveBeenCalledWith('admin_jobs', { p_limit: 10 });
    expect(r).toEqual({
      generatedAt: '2026-11-05T18:00:00Z',
      batches: [{ issuedAt: '2026-11-05T16:00:00Z', grants: 3, pending: 0, unused: 1, runNow: ['alibi-truckee'],
        runs: [{ slug: 'alibi-truckee', status: 'ok', found: 3, new: 1, changed: 0, errorCode: null, finishedAt: '2026-11-05T16:02:00Z' }] }],
      manual: [{ issuedAt: '2026-11-05T15:00:00Z', slug: 'bar-of-america', requested: true, state: 'done',
        run: { slug: 'bar-of-america', status: 'ok', found: 4, new: 0, changed: 1, errorCode: null, finishedAt: '2026-11-05T15:01:00Z' } },
      { issuedAt: '2026-11-05T14:00:00Z', slug: 'fiftyfifty-brewing', requested: false, state: 'no_result', run: null }],
      stamps: [{ slug: 'alibi-truckee', name: 'Alibi Ale Works', kind: 'run_now', requestedAt: null, servedAt: '2026-11-05T16:02:00Z',
        pending: false, expired: false }],
    });
  });
  it('clamps p_limit to trunc 1..20', async () => {
    rpc.mockResolvedValue({ data: RAW, error: null });
    for (const [given, sent] of [[0, 1], [-4, 1], [500, 20], [3.7, 3], [20, 20]] as const) {
      await j.adminJobs(given);
      expect(rpc).toHaveBeenLastCalledWith('admin_jobs', { p_limit: sent });
    }
  });
  it.each([null, 'x', 42])('a non-object reply (%j) -> DataError unknown', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    const e = await j.adminJobs().catch((x) => x);
    expect(e).toBeInstanceOf(DataError);
    expect(e.code).toBe('unknown');
  });
  it('missing arrays become empty', async () => {
    rpc.mockResolvedValue({ data: { generated_at: 'g' }, error: null });
    expect(await j.adminJobs()).toEqual({ generatedAt: 'g', batches: [], manual: [], stamps: [] });
  });
});

describe('dispatchOutcome (AC-SV2-29, astra R3-1)', () => {
  it('keeps recognized envelopes on their own status', () => {
    expect(j.dispatchOutcome(202, { outcome: 'ok' })).toEqual({ outcome: 'ok' });
    expect(j.dispatchOutcome(503, { outcome: 'not_configured' })).toEqual({ outcome: 'not_configured' });
    for (const reason of ['token_refused', 'workflow_not_found', 'ref_rejected'] as const) {
      expect(j.dispatchOutcome(502, { outcome: 'rejected', reason })).toEqual({ outcome: 'rejected', reason });
    }
    expect(j.dispatchOutcome(502, { outcome: 'unknown', reason: 'upstream' })).toEqual({ outcome: 'unknown', reason: 'upstream' });
  });
  it.each([401, 403])('%i throws DataError forbidden', (status) => {
    let caught: unknown;
    try {
      j.dispatchOutcome(status, { error: 'forbidden' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DataError);
    expect((caught as DataError).code).toBe('forbidden');
  });
  it.each<[number, unknown]>([
    [404, { outcome: 'ok' }],
    [200, { outcome: 'ok' }],
    [202, '<html>hi</html>'],
    [502, { outcome: 'weird' }],
    [502, { outcome: 'rejected', reason: 'nope' }],
    [502, { outcome: 'unknown', reason: 'other' }],
    [502, null],
    [503, { error: 'unavailable' }],
    [202, { outcome: 'not_configured' }],
    [503, { outcome: 'ok' }],
    [500, { outcome: 'ok' }],
  ])('%i %j -> unavailable', (status, body) => {
    expect(j.dispatchOutcome(status, body)).toEqual({ outcome: 'unavailable' });
  });
});

describe('adminDispatch', () => {
  it('POSTs /api/admin/dispatch with the bearer, a JSON {} body, no-store and same-origin credentials', async () => {
    const fetch = vi.fn(async () => json(202, { outcome: 'ok' }));
    expect(await j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt })).toEqual({ outcome: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/dispatch');
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe('Bearer hdr.payload.sig');
    expect(h.get('content-type')).toBe('application/json');
    expect(init.body).toBe('{}');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('same-origin');
  });
  it('keeps the structured 502 / 503 envelopes', async () => {
    let fetch = vi.fn(async () => json(502, { outcome: 'rejected', reason: 'token_refused' }));
    expect(await j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt })).toEqual({ outcome: 'rejected', reason: 'token_refused' });
    fetch = vi.fn(async () => json(503, { outcome: 'not_configured' }));
    expect(await j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt })).toEqual({ outcome: 'not_configured' });
  });
  it('a thrown fetch -> unavailable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt })).toEqual({ outcome: 'unavailable' });
  });
  it('a body that is not JSON -> unavailable', async () => {
    const fetch = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    expect(await j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt })).toEqual({ outcome: 'unavailable' });
  });
  it('401 -> DataError forbidden', async () => {
    const fetch = vi.fn(async () => json(401, { error: 'unauthorized' }));
    await expect(j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('no session -> DataError forbidden and no request', async () => {
    const fetch = vi.fn(async () => json(202, { outcome: 'ok' }));
    await expect(j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch, jwt: async () => null })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('the default jwt is the Supabase session access token', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'a.b.c' } }, error: null });
    const fetch = vi.fn(async () => json(202, { outcome: 'ok' }));
    await j.adminDispatch({ fetch: fetch as unknown as typeof globalThis.fetch });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer a.b.c');
  });
});

describe('adminDispatchStatus', () => {
  const call = (fetch: unknown) => j.adminDispatchStatus({ fetch: fetch as typeof globalThis.fetch, jwt });
  it('GETs /api/admin/dispatch-status with the bearer; configured true -> configured', async () => {
    const fetch = vi.fn(async () => json(200, { configured: true }));
    expect(await call(fetch)).toBe('configured');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe('/api/admin/dispatch-status');
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hdr.payload.sig');
  });
  it.each([401, 403])('%i -> DataError forbidden', async (status) => {
    await expect(call(vi.fn(async () => json(status, { error: 'x' })))).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('everything else -> needs_setup', async () => {
    expect(await call(vi.fn(async () => json(200, { configured: false })))).toBe('needs_setup');
    expect(await call(vi.fn(async () => json(200, { configured: 'yes' })))).toBe('needs_setup');
    expect(await call(vi.fn(async () => json(404, 'not found')))).toBe('needs_setup');
    expect(await call(vi.fn(async () => json(503, { error: 'unavailable' })))).toBe('needs_setup');
    expect(await call(vi.fn(async () => new Response('<html>', { status: 200 })))).toBe('needs_setup');
    expect(
      await call(vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })),
    ).toBe('needs_setup');
  });
});
