// AC-W3-19 (Spec_Vibes_Widget W3.3): readLightsSnapshot over the real LightsClient and a fake fetch, synthetic rows only.
import { describe, expect, it } from 'vitest';
import type { PoliteSource } from '../core/politeFetch';
import { createLightsClient } from './lightsClient';
import { readLightsSnapshot, EVENTS_SELECT } from './truckeelights';

const NOW = Date.parse('2026-10-17T18:00:00Z');
const SOURCE: PoliteSource = {
  allowed_hosts: ['supabase.co'], allowed_methods: ['api'], page_cap: 30, etag: null, last_modified: null,
  ingest_disposition: 'permitted', terms_recheck_at: '2027-10-17T00:00:00Z',
};
const REGION = '7a1e0000-0000-4000-8000-000000000001';
const ctx = (over: Record<string, unknown> = {}) => ({
  region: { id: REGION, slug: 'truckee', name: 'Truckee' }, season: 'halloween', year: 2026, events: { open: true }, ...over,
});
const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, region_id: REGION, season: 'halloween', year: 2026,
  title: `Synthetic house ${i}`, description: 'A synthetic house description.', venue: null, address: '1 Main St, Truckee',
  lat: 39.33, lng: -120.18, starts_at: '2026-10-30T02:00:00+00:00', ends_at: null, url: null, adults_only: false, ...over,
});

interface Plan { ctx1?: unknown; ctx2?: unknown; rows?: unknown[]; range?: string | null; status?: number }
function fakeLights(p: Plan) {
  const urls: string[] = [];
  let rpcCalls = 0;
  const fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/rpc/get_region_context')) {
      rpcCalls++;
      const body = rpcCalls === 1 ? (p.ctx1 ?? ctx()) : (p.ctx2 ?? p.ctx1 ?? ctx());
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const rows = p.rows ?? [row(1), row(2)];
    const headers: Record<string, string> = {};
    const range = p.range === undefined ? (rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0') : p.range;
    if (range !== null) headers['content-range'] = range;
    return new Response(JSON.stringify(rows), { status: p.status ?? 200, headers });
  }) as typeof globalThis.fetch;
  return { urls, fetch };
}
const read = (p: Plan) => {
  const f = fakeLights(p);
  const client = createLightsClient(SOURCE, { LIGHTS_REST_URL: 'https://x.supabase.co', LIGHTS_PUBLISHABLE_KEY: 'k' }, { fetch: f.fetch, now: () => NOW });
  return { f, out: readLightsSnapshot(client) };
};

describe('AC-W3-19 readLightsSnapshot', () => {
  it('happy path: ctx, exact-count events read, ctx again; returns the pair and the rows', async () => {
    const { f, out } = read({});
    expect(await out).toEqual({ ok: true, pair: { region: 'truckee', season: 'halloween', year: 2026 }, rows: [row(1), row(2)] });
    expect(f.urls).toHaveLength(3);
    const q = new URL(f.urls[1]).searchParams;
    expect(q.get('select')).toBe(EVENTS_SELECT);
    expect(EVENTS_SELECT).toBe('id,region_id,season,year,title,description,venue,address,lat,lng,starts_at,ends_at,url,adults_only');
    expect(q.get('region_id')).toBe(`eq.${REGION}`);
    expect(q.get('season')).toBe('eq.halloween');
    expect(q.get('year')).toBe('eq.2026');
    expect(q.get('order')).toBe('starts_at,id');
    expect(q.get('limit')).toBe('1000');
  });
  it('an empty season reads as ok with zero rows (Content-Range */0)', async () => {
    expect(await read({ rows: [] }).out).toEqual({ ok: true, pair: { region: 'truckee', season: 'halloween', year: 2026 }, rows: [] });
  });
  it('Content-Range total 12 with 11 rows -> partial', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => row(i + 1));
    expect(await read({ rows, range: '0-10/12' }).out).toMatchObject({ ok: false, code: 'partial' });
  });
  it('1,000 rows -> partial (the limit may have cut the list)', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    expect(await read({ rows, range: '0-999/1000' }).out).toMatchObject({ ok: false, code: 'partial' });
  });
  it('missing Content-Range -> partial', async () => {
    expect(await read({ range: null }).out).toMatchObject({ ok: false, code: 'partial' });
  });
  it('a row of another season -> pair_mismatch; of another year or region -> pair_mismatch', async () => {
    expect(await read({ rows: [row(1), row(2, { season: 'christmas' })] }).out).toMatchObject({ ok: false, code: 'pair_mismatch' });
    expect(await read({ rows: [row(1, { year: 2025 })] }).out).toMatchObject({ ok: false, code: 'pair_mismatch' });
    expect(await read({ rows: [row(1, { region_id: '7a1e0000-0000-4000-8000-000000000009' })] }).out).toMatchObject({ ok: false, code: 'pair_mismatch' });
  });
  it('ctx2 season differs -> pair_changed (and the known pair is the first one)', async () => {
    expect(await read({ ctx2: ctx({ season: 'christmas' }) }).out).toEqual({ ok: false, code: 'pair_changed', pair: { region: 'truckee', season: 'halloween', year: 2026 } });
    expect(await read({ ctx2: ctx({ year: 2027 }) }).out).toMatchObject({ ok: false, code: 'pair_changed' });
  });
  it('no events key -> no_events, with no events read', async () => {
    const { f, out } = read({ ctx1: { region: { id: REGION, slug: 'truckee' }, season: 'halloween', year: 2026 } });
    expect(await out).toMatchObject({ ok: false, code: 'no_events' });
    expect(f.urls).toHaveLength(1);
  });
  it('a malformed context (no season / unknown season / other region) -> bad_context', async () => {
    expect(await read({ ctx1: ctx({ season: null }) }).out).toMatchObject({ ok: false, code: 'bad_context' });
    expect(await read({ ctx1: ctx({ season: 'easter' }) }).out).toMatchObject({ ok: false, code: 'bad_context' });
    expect(await read({ ctx1: ctx({ region: { id: REGION, slug: 'reno' } }) }).out).toMatchObject({ ok: false, code: 'bad_context' });
  });
  it('an HTTP error on the events read -> http_<n>, with the pair known', async () => {
    expect(await read({ status: 500 }).out).toEqual({ ok: false, code: 'http_500', pair: { region: 'truckee', season: 'halloween', year: 2026 } });
  });
  it('a client refusal surfaces its FetchError code', async () => {
    const client = createLightsClient({ ...SOURCE, allowed_methods: ['feed'] }, { LIGHTS_REST_URL: 'https://x.supabase.co', LIGHTS_PUBLISHABLE_KEY: 'k' },
      { fetch: fakeLights({}).fetch, now: () => NOW });
    expect(await readLightsSnapshot(client)).toEqual({ ok: false, code: 'method_gate' });
  });
});
