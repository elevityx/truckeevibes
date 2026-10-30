// callApiEvents: the PostgREST request (publishable key only, the nine p_* args), timeout, and RpcError codes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RpcError, callApiEvents } from './rpc';
import { ENV, jsonResponse, rawEnvelope, recordingFetch } from './testing';

const fail = (p: Promise<unknown>): Promise<RpcError> => p.then(() => { throw new Error('resolved'); }, (x) => x as RpcError);

describe('callApiEvents', () => {
  it('POSTs rpc/api_events_v1 with the publishable key and all nine args (absent -> null)', async () => {
    const f = recordingFetch(() => jsonResponse(rawEnvelope()));
    const out = await callApiEvents(ENV, { scope: 'vibes', area: ['truckee'], limit: 5 }, f);
    expect(out).toEqual(rawEnvelope());
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe('http://127.0.0.1:55421/rest/v1/rpc/api_events_v1');
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('apikey')).toBe('test-publishable-key');
    expect(h.get('authorization')).toBe('Bearer test-publishable-key');
    expect(h.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ p_scope: 'vibes', p_season: null, p_year: null, p_from: null, p_to: null,
      p_areas: ['truckee'], p_categories: null, p_limit: 5, p_cursor: null });
  });
  it('maps every Query field to its p_* arg', async () => {
    const f = recordingFetch(() => jsonResponse(rawEnvelope()));
    await callApiEvents(ENV, { scope: 'lights', season: 'halloween', year: 2026, from: '2026-10-01', to: '2026-10-31', limit: 500, cursor: 'abc' }, f);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ p_scope: 'lights', p_season: 'halloween', p_year: 2026, p_from: '2026-10-01',
      p_to: '2026-10-31', p_areas: null, p_categories: null, p_limit: 500, p_cursor: 'abc' });
    const g = recordingFetch(() => jsonResponse(rawEnvelope()));
    await callApiEvents(ENV, { scope: 'vibes', category: ['music'] }, g);
    expect(JSON.parse(String(g.calls[0].init.body)).p_categories).toEqual(['music']);
  });
  it('a 400 with code 22023 and a known param detail -> RpcError(400, param)', async () => {
    const f = recordingFetch(() => jsonResponse({ code: '22023', details: 'limit', hint: null, message: 'invalid_input' }, 400));
    const e = await fail(callApiEvents(ENV, { scope: 'vibes' }, f));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.status).toBe(400);
    expect(e.code).toBe('limit');
  });
  it('an unknown detail or other body never becomes the code', async () => {
    for (const body of [{ code: '22023', details: 'p_secret', message: 'x' }, { code: 'PGRST202', details: 'limit' }, { message: 'boom' }]) {
      const e = await fail(callApiEvents(ENV, { scope: 'vibes' }, recordingFetch(() => jsonResponse(body, 400))));
      expect(e).toBeInstanceOf(RpcError);
      expect(e.code).toBeNull();
      expect(String(e.message)).not.toContain('boom');
    }
    const e = await fail(callApiEvents(ENV, { scope: 'vibes' }, recordingFetch(() => new Response('<html>oops</html>', { status: 500 }))));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.status).toBe(500);
    expect(e.code).toBeNull();
  });
  it('times out through AbortController', async () => {
    const f = recordingFetch((_u, init) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const t0 = Date.now();
    const e = await fail(callApiEvents(ENV, { scope: 'vibes' }, f, 50));
    expect(e).toBeInstanceOf(RpcError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('a 200 with a non-JSON body -> RpcError', async () => {
    const e = await fail(callApiEvents(ENV, { scope: 'vibes' }, recordingFetch(() => new Response('not json', { status: 200 }))));
    expect(e).toBeInstanceOf(RpcError);
  });
  it('no Supabase env -> RpcError, no fetch', async () => {
    const f = recordingFetch(() => jsonResponse(rawEnvelope()));
    const e = await fail(callApiEvents({}, { scope: 'vibes' }, f));
    expect(e).toBeInstanceOf(RpcError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('Amendment W1-3: Workers-compatible redirect handling', () => {
  it("passes redirect: 'manual' (AC-W1-36)", async () => {
    const f = recordingFetch(() => jsonResponse(rawEnvelope()));
    await callApiEvents(ENV, { scope: 'vibes' }, f);
    expect(f.calls[0].init.redirect).toBe('manual');
  });
  it("no Function source uses redirect: 'error' (AC-W1-36)", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const f of walk(join(__dirname, '..')).filter((x) => /\.ts$/.test(x) && !/\.test\.ts$/.test(x))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/redirect:\s*['"`]error/);
  });
  it.each([301, 302, 307])('a %i upstream is RpcError(502), never followed (AC-W1-37)', async (status) => {
    const f = recordingFetch(() => new Response(null, { status, headers: { location: 'https://example.invalid/' } }));
    const e = await fail(callApiEvents(ENV, { scope: 'vibes' }, f));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.status).toBe(502);
    expect(f.calls).toHaveLength(1);
  });
});
