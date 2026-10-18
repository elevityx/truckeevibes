// Test-only fakes for the Pages Function: a recording fetch, an in-memory Workers Cache, synthetic RPC envelopes and an
// independent strict JSON Schema checker (the subset events.v1.schema.json uses), so shape.ts is not checked by itself.
import type { Env } from './types';

export const ENV: Env = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55421',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  CF_PAGES_BRANCH: 'main',
};

export type FetchCall = { url: string; init: RequestInit };
export type RecordingFetch = typeof fetch & { calls: FetchCall[] };
export function recordingFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): RecordingFetch {
  const calls: FetchCall[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as RecordingFetch;
  f.calls = calls;
  return f;
}
export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// In-memory stand-in for caches.default (match/put/delete by URL; stores body text and headers). `failPut` makes a put reject.
export class FakeCache {
  store = new Map<string, { body: string; headers: Record<string, string> }>();
  puts: string[] = [];
  failPut: (key: string) => boolean = () => false;
  failDelete = false;
  private key(req: RequestInfo | URL) {
    return typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
  }
  async match(req: RequestInfo | URL): Promise<Response | undefined> {
    const hit = this.store.get(this.key(req));
    return hit ? new Response(hit.body, { status: 200, headers: hit.headers }) : undefined;
  }
  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const key = this.key(req);
    if (this.failPut(key)) throw new Error('put rejected');
    this.puts.push(key);
    this.store.set(key, { body: await res.text(), headers: Object.fromEntries(res.headers.entries()) });
  }
  async delete(req: RequestInfo | URL): Promise<boolean> {
    if (this.failDelete) throw new Error('delete rejected');
    return this.store.delete(this.key(req));
  }
}

// a generation (= the RPC's dataAt, microseconds, Z) `ms` milliseconds after the epoch
export const gen = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

const pad = (n: number, w = 12) => String(n).padStart(w, '0');
export const uuidOf = (i: number) => `00000000-0000-4000-a000-${pad(i)}`;

export function row(i: number, origin: 'lights' | 'vibes' = 'vibes', descLen = 0): Record<string, unknown> {
  const start = new Date(Date.UTC(2026, 9, 31, 1, 0, 0) + i * 60_000).toISOString().replace('.000Z', 'Z');
  const lights = origin === 'lights';
  return {
    id: uuidOf(i), origin, formerIds: [], pageUrl: lights ? null : `https://truckeevibes.com/e/event-${i}-abcdef/`,
    title: `Synthetic event ${i}`, description: lights ? words(i, descLen) : null, summary: lights ? null : 'Synthetic summary.',
    startsAt: start, endsAt: null, allDay: false, startDate: null, endDate: null, timeKnown: true,
    venue: lights ? null : 'Test Hall', address: `${i} Main St, Truckee`, town: lights ? null : 'Truckee',
    lat: 39.3 + (i % 100) / 1000, lng: -120.2 + (i % 100) / 1000, categories: lights ? [] : ['music'],
    age: 'unknown', adultsOnly: false, url: `https://example.test/e/${i}`, ticketUrl: null,
  };
}

// deterministic word salad of exactly `len` chars (synthetic; V10)
const VOCAB = ['lights', 'house', 'street', 'glow', 'walk', 'music', 'cocoa', 'snow', 'tree', 'porch', 'window', 'display', 'family',
  'neighbors', 'evening', 'drive', 'slowly', 'park', 'corner', 'bright', 'colors', 'show', 'nightly', 'until', 'ten', 'bring', 'friends',
  'candy', 'pumpkins', 'ghosts', 'yard', 'synced', 'radio', 'station', 'tune', 'in', 'the', 'and', 'with', 'from', 'on', 'at'];
export function words(seed: number, len: number): string {
  let s = '';
  let x = seed * 2654435761 >>> 0;
  while (s.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += (s ? ' ' : '') + VOCAB[x % VOCAB.length];
  }
  return s.slice(0, len);
}

export function rawEnvelope(o: { n?: number; origin?: 'lights' | 'vibes'; nextCursor?: string | null; dataAt?: string; descLen?: number;
                                 mirror?: Record<string, unknown> } = {}): Record<string, unknown> {
  const n = o.n ?? 2;
  return {
    dataAt: o.dataAt ?? '2026-10-17T20:00:00.000000Z',
    mirror: o.mirror ?? { state: 'none', confirmedAt: null, heldSince: null, heldCount: 0 },
    region: { tz: 'America/Los_Angeles', localBox: { minLat: 39.1, maxLat: 39.5, minLng: -120.47, maxLng: -119.88 } },
    count: n,
    nextCursor: o.nextCursor === undefined ? null : o.nextCursor,
    events: Array.from({ length: n }, (_, i) => row(i + 1, o.origin ?? 'vibes', o.descLen ?? 0)),
  };
}

// Independent strict checker for the schema subset in use: type, enum, const, properties, required,
// additionalProperties:false, items, local $ref, minimum. Returns the list of violations (empty = valid).
type S = Record<string, unknown>;
export function validate(root: S, value: unknown, schema: S = root, path = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce<unknown>((o, k) => (o as S)[k], root) as S;
    return validate(root, value, target, path);
  }
  const errs: string[] = [];
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) errs.push(`${path}: type ${t}`);
  }
  if ('const' in schema && value !== schema.const) errs.push(`${path}: const`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) errs.push(`${path}: enum`);
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) errs.push(`${path}: minimum`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) errs.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(root, v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: additional`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(root, v, schema.items as S, `${path}[${i}]`)));
  return errs;
}
