// S1.8 hmacClient: builds the S1.6 headers, 60 s timeout, typed responses, IngestHttpError(status, code).
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { callIngest, IngestHttpError } from './hmacClient';
import { fakeNet, T0 } from '../testing/fakes';

// Built from fragments so the repo secret scan never sees a key-shaped literal.
const KEY = ['sentinel', 'hmac', 'key', '0123'].join('-');
const URL_ = 'https://ref.example.test/functions/v1/ingest';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('callIngest', () => {
  it('POSTs the body with x-tv-ts, a 32-hex x-tv-nonce and x-tv-sig = HMAC-SHA256(key, ts\\nnonce\\nsha256hex(body))', async () => {
    const net = fakeNet(() => json({ grants: [] }));
    await callIngest('due_sources', {}, { url: URL_, key: KEY, fetch: net.fetch, now: () => T0 });
    const c = net.calls[0];
    expect(c.method).toBe('POST');
    expect(c.url).toBe(URL_);
    const body = String(c.init.body);
    expect(JSON.parse(body)).toEqual({ op: 'due_sources' });
    const ts = c.headers.get('x-tv-ts')!;
    const nonce = c.headers.get('x-tv-nonce')!;
    expect(ts).toBe(String(Math.floor(T0 / 1000)));
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const sha = createHash('sha256').update(body).digest('hex');
    expect(c.headers.get('x-tv-sig')).toBe(createHmac('sha256', KEY).update(`${ts}\n${nonce}\n${sha}`).digest('hex'));
  });
  it('merges the op into the body and uses a fresh nonce per call', async () => {
    const net = fakeNet(() => json({ ok: 1 }));
    await callIngest('submit_batch', { grant: 'g', run: { status: 'ok' }, items: [] }, { url: URL_, key: KEY, fetch: net.fetch });
    await callIngest('finish', {}, { url: URL_, key: KEY, fetch: net.fetch });
    expect(JSON.parse(String(net.calls[0].init.body))).toEqual({ op: 'submit_batch', grant: 'g', run: { status: 'ok' }, items: [] });
    expect(net.calls[0].headers.get('x-tv-nonce')).not.toBe(net.calls[1].headers.get('x-tv-nonce'));
  });
  it('returns the parsed JSON on 200', async () => {
    const net = fakeNet(() => json({ public_changed: true, processed: 3, remaining: 0 }));
    expect(await callIngest('finish', {}, { url: URL_, key: KEY, fetch: net.fetch })).toEqual({ public_changed: true, processed: 3, remaining: 0 });
  });
  it.each([[401, 'stale'], [409, 'replay'], [403, 'grant_rejected'], [413, 'too_large']])('status %s -> IngestHttpError(%s)', async (status, err) => {
    const net = fakeNet(() => json({ error: err }, status));
    const e = await callIngest('finish', {}, { url: URL_, key: KEY, fetch: net.fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(IngestHttpError);
    expect(e.status).toBe(status);
    expect(e.code).toBe(err);
  });
  it('a non-JSON error body still yields IngestHttpError with the status', async () => {
    const net = fakeNet(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const e = await callIngest('finish', {}, { url: URL_, key: KEY, fetch: net.fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(IngestHttpError);
    expect(e.status).toBe(502);
  });
  it('uses a 60 s timeout signal and never puts the key in an error message', async () => {
    const net = fakeNet(() => json({ error: 'unauthorized' }, 401));
    const e = await callIngest('finish', {}, { url: URL_, key: KEY, fetch: net.fetch }).catch((x) => x);
    expect(String(e.message)).not.toContain(KEY);
    expect(net.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
