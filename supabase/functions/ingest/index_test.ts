// AC-M1-01 and the S1.6 contract of the `ingest` Edge Function handler. Failing-first: ./index.ts does not exist yet, so every
// test fails at the dynamic import. The handler is `handle(req, env, deps)` with injected deps (S1.6); `deps.now()` is epoch
// milliseconds, and an optional `deps.sleep(ms)` is the pacing hook the geocode spacing test needs (the clock is fake).
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';

// deno-lint-ignore no-explicit-any
type Handle = (req: Request, env: { hmacKey: string } | null, deps: any) => Promise<Response>;
async function load(): Promise<Handle> {
  const m = await import('./index.ts');
  return m.handle as Handle;
}

// A key built from fragments so the test text carries no key-shaped literal.
const KEY = ['unit', 'test', 'hmac', 'key', '0123456789abcdef'].join('-');
const T0 = Date.UTC(2026, 10, 5, 18, 0, 0); // ms
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function sha256hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
let nonceCounter = 0;
const nextNonce = () => (++nonceCounter).toString(16).padStart(32, '0');

interface SignOpts { ts?: number; nonce?: string; key?: string; omit?: string[]; tamper?: boolean; sig?: string }
async function signedRequest(body: string | Uint8Array, o: SignOpts = {}): Promise<Request> {
  const bytes: Uint8Array<ArrayBuffer> = typeof body === 'string' ? new Uint8Array(enc.encode(body)) : new Uint8Array(body);
  const ts = o.ts ?? Math.floor(T0 / 1000);
  const nonce = o.nonce ?? nextNonce();
  const sig = o.sig ?? await hmacHex(o.key ?? KEY, `${ts}\n${nonce}\n${await sha256hex(bytes)}`);
  const headers: Record<string, string> = { 'x-tv-ts': String(ts), 'x-tv-nonce': nonce, 'x-tv-sig': sig, 'content-type': 'application/json' };
  for (const h of o.omit ?? []) delete headers[h];
  const sent: Uint8Array<ArrayBuffer> = o.tamper ? new Uint8Array(enc.encode(new TextDecoder().decode(bytes).replace('}', ' }'))) : bytes;
  return new Request('https://fn.test/ingest', { method: 'POST', headers, body: sent });
}
const op = (o: Record<string, unknown>) => JSON.stringify(o);

interface Fake {
  calls: string[];
  logs: string[];
  clock: { t: number };
  geocodeCalls: { q: string; at: number }[];
  censusCalls: { a: string; at: number }[];
  geoSet: unknown[][];
  clusterCalls: number[];
  deps: Record<string, unknown>;
}
function fake(over: {
  batch?: (g: string, run: unknown, items: unknown[]) => Promise<unknown>;
  geocode?: (q: string) => Promise<{ lat: number; lng: number } | null>;
  census?: (a: string) => Promise<{ lat: number; lng: number } | null>;
  cluster?: () => Promise<{ processed: number; remaining: number; public_changed: boolean; busy?: boolean }>;
  nonce?: (n: string) => Promise<boolean>;
} = {}): Fake {
  const f: Fake = { calls: [], logs: [], clock: { t: T0 }, geocodeCalls: [], censusCalls: [], geoSet: [], clusterCalls: [], deps: {} };
  const seen = new Set<string>();
  f.deps = {
    db: {
      nonce: (n: string) => {
        f.calls.push('nonce');
        if (over.nonce) return over.nonce(n);
        if (seen.has(n)) return Promise.resolve(false);
        seen.add(n);
        return Promise.resolve(true);
      },
      grants: () => { f.calls.push('grants'); return Promise.resolve([{ grant: 'g'.repeat(64), run_id: '99999999-0000-4000-8000-000000000001', source: { slug: 'alibi-truckee' } }]); },
      batch: (g: string, run: unknown, items: unknown[]) => {
        f.calls.push('batch');
        return over.batch ? over.batch(g, run, items) : Promise.resolve({ run_id: '99999999-0000-4000-8000-000000000002', status: 'ok', new: items.length, changed: 0, gone: 0, geocode: [] });
      },
      setGeocode: (...a: unknown[]) => { f.calls.push('setGeocode'); f.geoSet.push(a); return Promise.resolve(); },
      cluster: (limit: number) => {
        f.calls.push('cluster');
        f.clusterCalls.push(limit);
        return over.cluster ? over.cluster() : Promise.resolve({ processed: 0, remaining: 0, public_changed: false });
      },
    },
    geocode: async (q: string) => {
      f.geocodeCalls.push({ q, at: f.clock.t });
      const hit = over.geocode ? await over.geocode(q) : { lat: 39.328, lng: -120.1833 };
      return { hit, status: hit ? 200 : 404 };
    },
    census: async (a: string) => {
      f.censusCalls.push({ a, at: f.clock.t });
      const hit = over.census ? await over.census(a) : null;
      return { hit, status: hit ? 200 : 404 };
    },
    now: () => f.clock.t,
    sleep: (ms: number) => { f.clock.t += ms; return Promise.resolve(); },
    log: (line: string) => { f.logs.push(line); },
  };
  return f;
}
const ENV = { hmacKey: KEY };
const DUE = op({ op: 'due_sources' });

Deno.test('AC-M1-01 a valid signed due_sources -> 200 with the grants', async () => {
  const handle = await load();
  const f = fake();
  const res = await handle(await signedRequest(DUE), ENV, f.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.grants) && body.grants.length === 1);
  assertEquals(f.calls, ['nonce', 'grants']);
});

Deno.test('AC-M1-01 a body altered after signing -> 401 and zero DB calls (not even the nonce)', async () => {
  const handle = await load();
  const f = fake();
  const res = await handle(await signedRequest(DUE, { tamper: true }), ENV, f.deps);
  assertEquals(res.status, 401);
  assertEquals(f.calls, []);
});

Deno.test('AC-M1-01 a signature made with another key -> 401 and zero DB calls', async () => {
  const handle = await load();
  const f = fake();
  const res = await handle(await signedRequest(DUE, { key: KEY + '-other' }), ENV, f.deps);
  assertEquals(res.status, 401);
  assertEquals(f.calls, []);
});

Deno.test('AC-M1-01 ts 301 s old -> 401 stale; 300 s is accepted; a future ts 301 s ahead is stale too', async () => {
  const handle = await load();
  const f = fake();
  const old = await handle(await signedRequest(DUE, { ts: Math.floor(T0 / 1000) - 301 }), ENV, f.deps);
  assertEquals(old.status, 401);
  assertEquals((await old.json()).error, 'stale');
  assertEquals(f.calls, []);
  const edge = await handle(await signedRequest(DUE, { ts: Math.floor(T0 / 1000) - 300 }), ENV, f.deps);
  assertEquals(edge.status, 200);
  const future = await handle(await signedRequest(DUE, { ts: Math.floor(T0 / 1000) + 301 }), ENV, f.deps);
  assertEquals(future.status, 401);
});

Deno.test('AC-M1-01 the same nonce twice -> the second is 409 replay', async () => {
  const handle = await load();
  const f = fake();
  const n = nextNonce();
  assertEquals((await handle(await signedRequest(DUE, { nonce: n }), ENV, f.deps)).status, 200);
  const again = await handle(await signedRequest(DUE, { nonce: n }), ENV, f.deps);
  assertEquals(again.status, 409);
  assertEquals((await again.json()).error, 'replay');
  assertEquals(f.calls.filter((c) => c === 'grants').length, 1);
});

Deno.test('AC-M1-01 op svc_set_trust -> 400 bad_op (only due_sources, submit_batch, finish exist)', async () => {
  const handle = await load();
  const f = fake();
  const res = await handle(await signedRequest(op({ op: 'svc_set_trust', slug: 'alibi-truckee', trust: 'auto' })), ENV, f.deps);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, 'bad_op');
  assertFalse(f.calls.includes('grants') || f.calls.includes('batch') || f.calls.includes('cluster'));
});

Deno.test('AC-M1-01 GET -> 405 with zero DB calls; missing env -> 500 unavailable', async () => {
  const handle = await load();
  const f = fake();
  const get = await handle(new Request('https://fn.test/ingest', { method: 'GET' }), ENV, f.deps);
  assertEquals(get.status, 405);
  assertEquals(f.calls, []);
  const noEnv = await handle(await signedRequest(DUE), null, f.deps);
  assertEquals(noEnv.status, 500);
  assertEquals((await noEnv.json()).error, 'unavailable');
  assertEquals(f.calls, []);
});

Deno.test('S1.6 missing or malformed auth headers -> 401 and zero DB calls', async () => {
  const handle = await load();
  const f = fake();
  for (const o of [{ omit: ['x-tv-ts'] }, { omit: ['x-tv-nonce'] }, { omit: ['x-tv-sig'] }, { nonce: 'not-hex' }, { nonce: 'ab'.repeat(15) }, { sig: 'zz'.repeat(32) }, { sig: 'ab' }]) {
    const res = await handle(await signedRequest(DUE, o as SignOpts), ENV, f.deps);
    assertEquals(res.status, 401, JSON.stringify(o));
  }
  const nan = await handle(await signedRequest(DUE, { ts: Number.NaN }), ENV, f.deps);
  assertEquals(nan.status, 401);
  assertEquals(f.calls, []);
});

Deno.test('AC-M1-01 a 2,097,153-byte body -> 413 and the handler stops reading (never buffers the rest)', async () => {
  const handle = await load();
  const f = fake();
  const chunk = new Uint8Array(65536).fill(97);
  const total = 3 * 1024 * 1024;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= total) { c.close(); return; }
      pulled += chunk.length;
      c.enqueue(chunk);
    },
  });
  const req = new Request('https://fn.test/ingest', {
    method: 'POST', body: stream, duplex: 'half',
    headers: { 'x-tv-ts': String(Math.floor(T0 / 1000)), 'x-tv-nonce': nextNonce(), 'x-tv-sig': 'ab'.repeat(32) },
  } as RequestInit);
  const res = await handle(req, ENV, f.deps);
  assertEquals(res.status, 413);
  assertEquals((await res.json()).error, 'too_large');
  assert(pulled <= 2_097_152 + 2 * 65536, `read ${pulled} bytes of ${total}`);
  assert(pulled < total);
  assertEquals(f.calls, []);
});

Deno.test('AC-M1-01 exactly 2,097,152 bytes is accepted', async () => {
  const handle = await load();
  const f = fake();
  const head = '{"op":"due_sources","pad":"';
  const tail = '"}';
  const pad = 'a'.repeat(2_097_152 - head.length - tail.length);
  const body = head + pad + tail;
  assertEquals(enc.encode(body).length, 2_097_152);
  const res = await handle(await signedRequest(body), ENV, f.deps);
  assertEquals(res.status, 200);
});

Deno.test('AC-M1-01 1,001 items -> 413 (and db.batch is never called); 1,000 items pass', async () => {
  const handle = await load();
  const f = fake();
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ externalKey: `k${i}` }));
  const run = { status: 'ok' };
  const over = await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run, items: items(1001) })), ENV, f.deps);
  assertEquals(over.status, 413);
  assertFalse(f.calls.includes('batch'));
  const ok = await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run, items: items(1000) })), ENV, f.deps);
  assertEquals(ok.status, 200);
  assert(f.calls.includes('batch'));
});

Deno.test('S1.6 order: signature is checked before the nonce; the nonce is consumed before the JSON is parsed', async () => {
  const handle = await load();
  const f = fake();
  const bad = await handle(await signedRequest(DUE, { key: 'wrong-key' }), ENV, f.deps);
  assertEquals(bad.status, 401);
  assertEquals(f.calls, []);
  const notJson = await handle(await signedRequest('this is not json'), ENV, f.deps);
  assertEquals(notJson.status, 400);
  assertEquals(f.calls, ['nonce']);
});

Deno.test('S1.6 submit_batch hands the grant, run meta and items to db.batch unchanged and returns the run result', async () => {
  const handle = await load();
  let seen: unknown[] = [];
  const f = fake({ batch: (g, run, items) => { seen = [g, run, items]; return Promise.resolve({ run_id: 'r1', status: 'ok', new: 1, changed: 0, gone: 0, geocode: [] }); } });
  const grant = 'a1'.repeat(32);
  const run = { status: 'ok', started_at: '2026-11-05T17:59:00Z', parser_version: 'ics-1' };
  const items = [{ externalKey: 'x1', title: 'A Show' }];
  const res = await handle(await signedRequest(op({ op: 'submit_batch', grant, run, items })), ENV, f.deps);
  assertEquals(res.status, 200);
  assertEquals(seen, [grant, run, items]);
  const body = await res.json();
  assertEquals(body.status, 'ok');
  assertEquals(body.run_id, 'r1');
});

Deno.test('S1.6 a grant error from the database (SQLSTATE P0001) -> 403 grant_rejected', async () => {
  const handle = await load();
  const f = fake({ batch: () => Promise.reject(Object.assign(new Error('rpc svc_ingest_batch failed'), { code: 'P0001' })) });
  const res = await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f.deps);
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, 'grant_rejected');
});

Deno.test('S1.6 any other database error -> a non-2xx that never echoes the database message', async () => {
  const handle = await load();
  const f = fake({ batch: () => Promise.reject(Object.assign(new Error('secret-db-detail'), { code: '22023' })) });
  const res = await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f.deps);
  assert(res.status >= 400);
  assertFalse((await res.text()).includes('secret-db-detail'));
  assertFalse(f.logs.join('\n').includes('secret-db-detail'));
});

const geo = (n: number) => Array.from({ length: n }, (_, i) => ({ venue_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, query: `Venue ${i}, ${i} Pine St, Truckee` }));

Deno.test('S1.6 geocoding: each returned venue is looked up sequentially >= 1,000 ms apart and stored with geocoder nominatim', async () => {
  const handle = await load();
  const f = fake({ batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 3, changed: 0, gone: 0, geocode: geo(3) }) });
  const res = await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [{ externalKey: 'a' }] })), ENV, f.deps);
  assertEquals(res.status, 200);
  assertEquals(f.geocodeCalls.map((c) => c.q), geo(3).map((g) => g.query));
  for (let i = 1; i < f.geocodeCalls.length; i++) assert(f.geocodeCalls[i].at - f.geocodeCalls[i - 1].at >= 1000, `gap ${i}`);
  assertEquals(f.geoSet.length, 3);
  assertEquals(f.geoSet[0], [geo(3)[0].venue_id, 39.328, -120.1833, 'nominatim']);
});

Deno.test('S1.6 geocoding: a null result is stored as null/null (it still counts an attempt)', async () => {
  const handle = await load();
  const f = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 1, changed: 0, gone: 0, geocode: geo(1) }),
    geocode: () => Promise.resolve(null),
  });
  await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f.deps);
  assertEquals(f.geoSet, [[geo(1)[0].venue_id, null, null, 'nominatim']]);
});

Deno.test('S1.6 geocoding: at most 20 entries, and no new lookup once 60 s have elapsed', async () => {
  const handle = await load();
  const f = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 30, changed: 0, gone: 0, geocode: geo(25) }),
    geocode: () => { f.clock.t += 25_000; return Promise.resolve({ lat: 39.3, lng: -120.1 }); },
  });
  await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f.deps);
  assertEquals(f.geocodeCalls.length, 3, 'calls at ~0 s, ~26 s, ~52 s; the next would start at 77 s');
  const f2 = fake({ batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 30, changed: 0, gone: 0, geocode: geo(25) }) });
  await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f2.deps);
  assertEquals(f2.geocodeCalls.length, 20);
});

Deno.test('S1.6 finish loops db.cluster(500) until remaining is 0 and sums the results', async () => {
  const handle = await load();
  const seq = [
    { processed: 500, remaining: 1200, public_changed: false },
    { processed: 500, remaining: 700, public_changed: true },
    { processed: 500, remaining: 200, public_changed: false },
    { processed: 200, remaining: 0, public_changed: false },
  ];
  let i = 0;
  const f = fake({ cluster: () => Promise.resolve(seq[i++]) });
  const res = await handle(await signedRequest(op({ op: 'finish' })), ENV, f.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { public_changed: true, processed: 1700, remaining: 0 });
  assertEquals(f.clusterCalls, [500, 500, 500, 500]);
});

Deno.test('S1.6 finish stops looping after 100 s even if work remains', async () => {
  const handle = await load();
  const f = fake({ cluster: () => { f.clock.t += 60_000; return Promise.resolve({ processed: 500, remaining: 100, public_changed: false }); } });
  const res = await handle(await signedRequest(op({ op: 'finish' })), ENV, f.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.remaining, 100);
  assertEquals(f.clusterCalls.length, 2);
});

Deno.test('S1.6 logs carry the op, counts and status codes only: no title, grant, key or signature', async () => {
  const handle = await load();
  const f = fake();
  const sentinel = 'SYNTHETIC-TITLE-SENTINEL';
  const grant = 'f0'.repeat(32);
  const req = await signedRequest(op({ op: 'submit_batch', grant, run: { status: 'ok' }, items: [{ externalKey: 'x', title: sentinel }] }));
  const sig = req.headers.get('x-tv-sig') ?? '';
  await handle(req, ENV, f.deps);
  const logged = f.logs.join('\n');
  assertFalse(logged.includes(sentinel));
  assertFalse(logged.includes(grant));
  assertFalse(logged.includes(KEY));
  assertFalse(logged.includes(sig));
  assert(f.logs.length > 0, 'the handler logs the op and counts');
  assertStringIncludes(logged, 'submit_batch');
});

Deno.test('S1.6 responses are JSON and uncacheable', async () => {
  const handle = await load();
  const f = fake();
  const res = await handle(await signedRequest(DUE), ENV, f.deps);
  assertEquals(res.headers.get('Content-Type'), 'application/json');
  assertEquals(res.headers.get('Cache-Control'), 'no-store');
});

// ---------------------------------------------------------------------------------------------------------------------
// Amendment 5. AC-M1-64(d): a `busy` cluster result ends the finish loop. AC-M1-69: no geocode lookup starts after 60 s.
// ---------------------------------------------------------------------------------------------------------------------
Deno.test('AC-M1-64(d) finish: a cluster result with busy: true -> 200 with busy: true, one cluster call, busy=1 in the log', async () => {
  const handle = await load();
  const f = fake({ cluster: () => Promise.resolve({ processed: 0, remaining: 3, public_changed: false, busy: true }) });
  const res = await handle(await signedRequest(op({ op: 'finish' })), ENV, f.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.busy, true);
  assertEquals(body.remaining, 3);
  assertEquals(f.clusterCalls, [500], 'the loop stops at the first busy result');
  assertStringIncludes(f.logs.join('\n'), 'busy=1');
});

/** Submit a batch whose result asks for `n` lookups; `dur[i]` is how long lookup i takes on the fake clock. */
async function geoRun(n: number, dur: number[], sleepAdvance?: (ms: number) => number) {
  const handle = await load();
  let k = 0;
  const f = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: n, changed: 0, gone: 0, geocode: geo(n) }),
    geocode: () => { f.clock.t += dur[k++] ?? 0; return Promise.resolve({ lat: 39.3, lng: -120.1 }); },
  });
  const sleeps: number[] = [];
  f.deps.sleep = (ms: number) => { sleeps.push(ms); f.clock.t += sleepAdvance ? sleepAdvance(ms) : ms; return Promise.resolve(); };
  const res = await handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f.deps);
  assertEquals(res.status, 200);
  const starts = f.geocodeCalls.map((c) => c.at - T0);
  for (const st of starts) assert(st < 60_000, `a lookup started at ${st} ms`);
  return { f, sleeps, starts };
}

Deno.test('AC-M1-69(a) the next lookup would start after 60 s: no sleep, no lookup', async () => {
  // lookup 1 runs 0 -> 59,200; lookup 2 starts at 59,200 and returns at 59,600; the 1,000 ms gap would end at 60,200
  const { sleeps, starts } = await geoRun(3, [59_200, 400]);
  assertEquals(starts, [0, 59_200]);
  assertFalse(sleeps.includes(600), 'sleep(600) must not be called');
  assertEquals(sleeps, []);
});

Deno.test('AC-M1-69(b) a sleep that moves the clock past 60 s ends the loop before the next lookup', async () => {
  // lookup 1: 0 -> 57,800; lookup 2: 57,800 -> 58,500; the gap leaves wait = 300 ms, and the fake sleep advances the clock by 2,000 ms
  const { sleeps, starts } = await geoRun(3, [57_800, 700], () => 2_000);
  assertEquals(sleeps, [300]);
  assertEquals(starts, [0, 57_800], 'no lookup starts after the sleep');
});

Deno.test('AC-M1-69(c) 20 fast entries: 20 lookups, starts >= 1,000 ms apart, all under 60 s', async () => {
  const { starts } = await geoRun(20, []);
  assertEquals(starts.length, 20);
  for (let i = 1; i < starts.length; i++) assert(starts[i] - starts[i - 1] >= 1000, `gap ${i}`);
});

// Amendment 11. AC-M1-99 / AC-M1-100: Census first for a street address, Nominatim fallback, one log line per request.
const geoAddr = (n: number) => Array.from({ length: n }, (_, i) => ({
  venue_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
  query: `Hall ${i}, ${i + 10} Pine St, Truckee`, address: `${i + 10} Pine St, Truckee, CA 96161`,
}));
const submit = async (f: Fake) => {
  const handle = await load();
  return handle(await signedRequest(op({ op: 'submit_batch', grant: 'g'.repeat(64), run: { status: 'ok' }, items: [] })), ENV, f.deps);
};

Deno.test('AC-M1-99 an address venue resolves via Census (no Nominatim call) and is stored with geocoder census', async () => {
  const a = geoAddr(1);
  const f = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 1, changed: 0, gone: 0, geocode: a }),
    census: () => Promise.resolve({ lat: 39.3, lng: -120.2 }),
  });
  await submit(f);
  assertEquals(f.censusCalls.map((c) => c.a), [a[0].address]);
  assertEquals(f.geocodeCalls.length, 0);
  assertEquals(f.geoSet, [[a[0].venue_id, 39.3, -120.2, 'census']]);
});

Deno.test('AC-M1-99 a Census miss falls through to Nominatim (address, then the full query); both failing stores null', async () => {
  const a = geoAddr(1);
  const f = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 1, changed: 0, gone: 0, geocode: a }),
    census: () => Promise.resolve(null),
    geocode: (q) => Promise.resolve(q === a[0].query ? { lat: 39.31, lng: -120.21 } : null),
  });
  await submit(f);
  assertEquals(f.geocodeCalls.map((c) => c.q), [a[0].address, a[0].query]);
  assertEquals(f.geoSet, [[a[0].venue_id, 39.31, -120.21, 'nominatim']]);
  for (let i = 1; i < f.geocodeCalls.length; i++) assert(f.geocodeCalls[i].at - f.geocodeCalls[i - 1].at >= 1000, 'nominatim calls stay >= 1 s apart');
  const f2 = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 1, changed: 0, gone: 0, geocode: a }),
    census: () => Promise.resolve(null), geocode: () => Promise.resolve(null),
  });
  await submit(f2);
  assertEquals(f2.geoSet, [[a[0].venue_id, null, null, 'nominatim']]);
});

Deno.test('AC-M1-99 a venue without an address skips Census and uses the query only', async () => {
  const f = fake({ batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 1, changed: 0, gone: 0, geocode: geo(1) }) });
  await submit(f);
  assertEquals(f.censusCalls.length, 0);
  assertEquals(f.geocodeCalls.map((c) => c.q), [geo(1)[0].query]);
});

Deno.test('AC-M1-100 the geocode log line carries src/status/hit and never the query text', async () => {
  const a = geoAddr(2);
  const f = fake({
    batch: () => Promise.resolve({ run_id: 'r', status: 'ok', new: 2, changed: 0, gone: 0, geocode: a }),
    census: (x) => Promise.resolve(x === a[0].address ? { lat: 39.3, lng: -120.2 } : null),
    geocode: () => Promise.resolve(null),
  });
  await submit(f);
  const lines = f.logs.filter((l) => l.startsWith('geocode '));
  assertEquals(lines, ['geocode src=census status=200 hit=1', 'geocode src=nominatim status=404 hit=0']);
  assertFalse(f.logs.join('\n').includes('Pine St'));
});

Deno.test('census() parses addressMatches, sends the UA, and a miss or HTTP error is a null hit with its status', async () => {
  const mod = await import('./index.ts') as unknown as { census: (a: string, f?: typeof fetch) => Promise<{ hit: { lat: number; lng: number } | null; status: number }> };
  let url = ''; let ua = '';
  const ok = ((u: string, init: RequestInit) => { url = u; ua = (init.headers as Record<string, string>)['User-Agent']; return Promise.resolve(new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -120.2, y: 39.3 } }] } }), { status: 200 })); }) as unknown as typeof fetch;
  assertEquals(await mod.census('12593 Donner Pass Rd, Truckee, CA 96161', ok), { hit: { lat: 39.3, lng: -120.2 }, status: 200 });
  assert(url.startsWith('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=12593%20Donner%20Pass%20Rd%2C%20Truckee%2C%20CA%2096161&benchmark=Public_AR_Current&format=json'), url);
  assert(ua.startsWith('TruckeeVibesBot/'));
  const miss = (() => Promise.resolve(new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 }))) as unknown as typeof fetch;
  assertEquals(await mod.census('x', miss), { hit: null, status: 200 });
  const bad = (() => Promise.resolve(new Response('no', { status: 503 }))) as unknown as typeof fetch;
  assertEquals(await mod.census('x', bad), { hit: null, status: 503 });
  const boom = (() => Promise.reject(new Error('net'))) as unknown as typeof fetch;
  assertEquals(await mod.census('x', boom), { hit: null, status: 0 });
});
