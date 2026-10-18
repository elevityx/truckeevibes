// AC-W3-20 (Spec_Vibes_Widget W3.3): the mirror runner. Signed calls go to a fake ingest endpoint; Lights reads to a fake REST host.
import { describe, expect, it } from 'vitest';
import { main } from './run';

const KEY = ['unit', 'test', 'hmac', 'key'].join('-');
const ENV = { INGEST_URL: 'https://fn.test/ingest', INGEST_HMAC_KEY: KEY, LIGHTS_REST_URL: 'https://x.supabase.co', LIGHTS_PUBLISHABLE_KEY: 'pk' };
const REGION = '7a1e0000-0000-4000-8000-000000000001';
const SOURCE = {
  slug: 'truckee-lights', allowed_hosts: ['supabase.co'], allowed_methods: ['api'], page_cap: 30, etag: null, last_modified: null,
  ingest_disposition: 'permitted', terms_recheck_at: '2099-01-01T00:00:00Z',
};
const ctx = { region: { id: REGION, slug: 'truckee' }, season: 'halloween', year: 2026, events: { open: true } };
const row = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, region_id: REGION, season: 'halloween', year: 2026,
  title: `SYNTHETIC-TITLE-${i}`, description: 'A synthetic description.', venue: null, address: '1 Main St', lat: 39.3, lng: -120.2,
  starts_at: '2026-10-30T02:00:00+00:00', ends_at: null, url: `https://synthetic-url.example/${i}`, adults_only: false,
});

interface Opts { grant?: string | null; ingestFail?: 'grant' | 'submit'; lights?: 'ok' | 'partial' | 'down' | 'http503'; submitReply?: Record<string, unknown> }
function world(o: Opts = {}) {
  const ops: { op: string; body: Record<string, unknown> }[] = [];
  const lightsCalls: string[] = [];
  const logs: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === ENV.INGEST_URL) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      ops.push({ op: String(body.op), body });
      if (body.op === 'mirror_grant') {
        if (o.ingestFail === 'grant') throw new TypeError('fetch failed');
        return new Response(JSON.stringify(o.grant === null ? { grant: null } : { grant: o.grant ?? 'g'.repeat(64), run_id: 'r', source: SOURCE }), { status: 200 });
      }
      if (o.ingestFail === 'submit') return new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 });
      const run = body.run as Record<string, unknown>;
      return new Response(JSON.stringify(o.submitReply ?? (run.status === 'aborted' ? { status: 'aborted' }
        : { status: 'ok', seen: (body.rows as unknown[]).length, added: 2, changed: 0, removed: 0, held: 0, invalid: 0 })), { status: 200 });
    }
    lightsCalls.push(u);
    if (o.lights === 'down') throw new DOMException('timed out', 'TimeoutError');
    if (u.includes('/rpc/')) return new Response(JSON.stringify(ctx), { status: 200 });
    if (o.lights === 'http503') return new Response('{}', { status: 503 });
    const rows = [row(1), row(2)];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-range': o.lights === 'partial' ? '0-1/3' : '0-1/2' } });
  }) as typeof globalThis.fetch;
  return { ops, lightsCalls, logs, deps: { env: ENV, fetch, log: (l: string) => logs.push(l) } };
}
// counts and codes only (V11): never a title, URL, key or grant
const SAFE = /^mirror: (?:not due|status=[a-z]+ rows=\d+ added=\d+ changed=\d+ removed=\d+ held=\d+ invalid=\d+|aborted code=[a-z0-9_]+(?: run_status=[a-z]+)?|[a-z_ ]+(?: code=[a-z0-9_]+)?)$/;
const expectSafe = (logs: string[]) => {
  expect(logs.length).toBeGreaterThan(0);
  for (const l of logs) {
    expect(l).toMatch(SAFE);
    expect(l).not.toMatch(/SYNTHETIC|synthetic-url|https?:|pk|g{8}/);
  }
};

describe('AC-W3-20 mirror runner', () => {
  it('null grant -> exit 0, no Lights read, "mirror: not due"', async () => {
    const w = world({ grant: null });
    expect(await main(w.deps)).toBe(0);
    expect(w.lightsCalls).toEqual([]);
    expect(w.ops.map((x) => x.op)).toEqual(['mirror_grant']);
    expect(w.logs).toEqual(['mirror: not due']);
  });
  it('happy path -> submit_lights_mirror with {status: ok, total} and the rows; exit 0; a counts-only log line', async () => {
    const w = world();
    expect(await main(w.deps)).toBe(0);
    expect(w.ops.map((x) => x.op)).toEqual(['mirror_grant', 'submit_lights_mirror']);
    const s = w.ops[1].body;
    expect(s.grant).toBe('g'.repeat(64));
    expect(s.run).toEqual({ region: 'truckee', season: 'halloween', year: 2026, status: 'ok', total: 2 });
    expect(s.rows).toEqual([row(1), row(2)]);
    expect(w.lightsCalls).toHaveLength(3);
    expect(w.logs).toEqual(['mirror: status=ok rows=2 added=2 changed=0 removed=0 held=0 invalid=0']);
    expectSafe(w.logs);
  });
  it('a held result is logged with its status', async () => {
    const w = world({ submitReply: { status: 'held', seen: 2, added: 0, changed: 0, removed: 0, held: 4, invalid: 0 } });
    expect(await main(w.deps)).toBe(0);
    expect(w.logs).toEqual(['mirror: status=held rows=2 added=0 changed=0 removed=0 held=4 invalid=0']);
  });
  it('read failure (partial) -> an aborted submit with rows: [] and the pair; exit 0', async () => {
    const w = world({ lights: 'partial' });
    expect(await main(w.deps)).toBe(0);
    const s = w.ops[1].body;
    expect(s.run).toEqual({ region: 'truckee', season: 'halloween', year: 2026, status: 'aborted', abort_code: 'partial' });
    expect(s.rows).toEqual([]);
    expect(w.logs[0]).toBe('mirror: aborted code=partial');
    expectSafe(w.logs);
  });
  it('read failure before the pair is known (timeout) -> an aborted submit without a pair, rows: []', async () => {
    const w = world({ lights: 'down' });
    expect(await main(w.deps)).toBe(0);
    expect(w.ops[1].body.run).toEqual({ region: 'truckee', status: 'aborted', abort_code: 'timeout' });
    expect(w.ops[1].body.rows).toEqual([]);
    expectSafe(w.logs);
  });
  it('transport failure on the grant -> exit 1, no Lights read', async () => {
    const w = world({ ingestFail: 'grant' });
    expect(await main(w.deps)).toBe(1);
    expect(w.lightsCalls).toEqual([]);
    expectSafe(w.logs);
  });
  it('transport failure on the submit -> exit 1', async () => {
    const w = world({ ingestFail: 'submit' });
    expect(await main(w.deps)).toBe(1);
    expectSafe(w.logs);
  });
  it('missing env -> exit 1 before any call', async () => {
    const w = world();
    expect(await main({ ...w.deps, env: { ...ENV, LIGHTS_REST_URL: undefined } })).toBe(1);
    expect(w.ops).toEqual([]);
    expectSafe(w.logs);
  });
  it('an events read that returns 503 -> an aborted submit with abort_code http_503 (the code pgTAP 27 accepts)', async () => {
    const w = world({ lights: 'http503' });
    expect(await main(w.deps)).toBe(0);
    expect(w.ops[1].body.run).toEqual({ region: 'truckee', season: 'halloween', year: 2026, status: 'aborted', abort_code: 'http_503' });
    expect(w.logs[0]).toBe('mirror: aborted code=http_503');
    expectSafe(w.logs);
  });
});
