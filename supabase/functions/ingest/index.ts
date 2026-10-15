// ingest: the runner's only door to the database (spec S1.6). A signed POST (HMAC-SHA256 over ts, nonce and the body
// hash, a 5-minute window, single-use nonces) with three ops: due_sources, submit_batch, finish. The runner holds no
// Supabase key; this function holds the service key in its env and calls only svc_* routines through _shared/db.ts.
// Modeled on TL:supabase/functions/send-digest/index.ts. Logs carry the op, counts and status codes only.
// Env: INGEST_HMAC_KEY, SUPABASE_URL, SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY.
import { type BatchOut, type ClusterOut, type GeocodeRequest, type GrantOut, ingestDb, serviceClient, type IngestDb, type RunMeta } from '../_shared/db.ts';
import { json, timingSafeEqual, UUID } from '../_shared/http.ts';

export interface IngestEnv { hmacKey: string }
export interface IngestDeps {
  db: IngestDb;
  geocode(query: string): Promise<{ lat: number; lng: number } | null>;   // Nominatim, 1 req/s, UA, 10 s timeout
  now(): number;                                                           // epoch milliseconds
  sleep?(ms: number): Promise<void>;
  log(line: string): void;
}

export const MAX_BODY_BYTES = 2_097_152;
export const MAX_ITEMS = 1000;
const WINDOW_SECONDS = 300;
const GEOCODE_MAX = 20;
const GEOCODE_GAP_MS = 1000;
const GEOCODE_BUDGET_MS = 60_000;
const FINISH_BUDGET_MS = 100_000;
export const USER_AGENT = 'TruckeeVibesBot/1.0 (+https://truckeevibes.com/bot/)';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** Reads at most `cap` bytes; null when the body is larger (the rest is never read). */
async function readCapped(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function codeOf(e: unknown): string | null {
  return isObject(e) && typeof e.code === 'string' ? e.code : null;
}

export async function handle(req: Request, env: IngestEnv | null, deps: IngestDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!env) { deps.log('ingest status=500 not_configured'); return json(500, { error: 'unavailable' }); }

  const body = await readCapped(req, MAX_BODY_BYTES);
  if (!body) { deps.log('ingest status=413 too_large'); return json(413, { error: 'too_large' }); }

  const ts = req.headers.get('x-tv-ts') ?? '';
  const nonce = req.headers.get('x-tv-nonce') ?? '';
  const sig = req.headers.get('x-tv-sig') ?? '';
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
    deps.log('ingest status=401 headers');
    return json(401, { error: 'unauthorized' });
  }
  if (Math.abs(deps.now() / 1000 - Number(ts)) > WINDOW_SECONDS) {
    deps.log('ingest status=401 stale');
    return json(401, { error: 'stale' });
  }
  const expected = await hmacHex(env.hmacKey, `${ts}\n${nonce}\n${await sha256Hex(body)}`);
  if (!timingSafeEqual(sig, expected)) { deps.log('ingest status=401 signature'); return json(401, { error: 'unauthorized' }); }

  // Past this point the request is authentic. The nonce is consumed before the body is interpreted.
  let fresh: boolean;
  try { fresh = await deps.db.nonce(nonce); } catch (e) {
    deps.log(`ingest status=500 nonce code=${codeOf(e) ?? 'none'}`);
    return json(500, { error: 'unavailable' });
  }
  if (!fresh) { deps.log('ingest status=409 replay'); return json(409, { error: 'replay' }); }

  let msg: unknown;
  try { msg = JSON.parse(new TextDecoder().decode(body)); } catch { msg = undefined; }
  if (!isObject(msg)) { deps.log('ingest status=400 bad_json'); return json(400, { error: 'bad_json' }); }

  switch (msg.op) {
    case 'due_sources': return await dueSources(deps);
    case 'submit_batch': return await submitBatch(msg, deps);
    case 'finish': return await finish(deps);
    default:
      deps.log('ingest status=400 bad_op');
      return json(400, { error: 'bad_op' });
  }
}

async function dueSources(deps: IngestDeps): Promise<Response> {
  let grants: GrantOut[];
  try { grants = await deps.db.grants(); } catch (e) {
    deps.log(`ingest op=due_sources status=500 code=${codeOf(e) ?? 'none'}`);
    return json(500, { error: 'unavailable' });
  }
  deps.log(`ingest op=due_sources status=200 grants=${grants.length}`);
  return json(200, { grants });
}

async function submitBatch(msg: Record<string, unknown>, deps: IngestDeps): Promise<Response> {
  const { grant, run, items } = msg;
  if (typeof grant !== 'string' || !isObject(run) || !Array.isArray(items)) {
    deps.log('ingest op=submit_batch status=400 shape');
    return json(400, { error: 'bad_request' });
  }
  if (items.length > MAX_ITEMS) {
    deps.log(`ingest op=submit_batch status=413 items=${items.length}`);
    return json(413, { error: 'too_large' });
  }
  let result: BatchOut;
  try {
    result = await deps.db.batch(grant, run as RunMeta, items);
  } catch (e) {
    const code = codeOf(e);
    deps.log(`ingest op=submit_batch status=${code === 'P0001' ? 403 : code === '22023' ? 400 : 500} items=${items.length} code=${code ?? 'none'}`);
    if (code === 'P0001') return json(403, { error: 'grant_rejected' });
    if (code === '22023') return json(400, { error: 'invalid_input' });
    return json(500, { error: 'unavailable' });
  }
  const geocoded = await geocodeAll(Array.isArray(result.geocode) ? result.geocode : [], deps);
  deps.log(`ingest op=submit_batch status=200 items=${items.length} run_status=${String(result.status)} new=${Number(result.new ?? 0)} ` +
           `changed=${Number(result.changed ?? 0)} gone=${Number(result.gone ?? 0)} geocoded=${geocoded}`);
  return json(200, { ...result, geocoded });
}

/** Sequential, >= 1 s apart, at most 20 lookups, none started after 60 s. Returns how many results were stored. */
async function geocodeAll(entries: GeocodeRequest[], deps: IngestDeps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = deps.now();
  let last = Number.NEGATIVE_INFINITY;
  let stored = 0;
  for (const entry of entries.slice(0, GEOCODE_MAX)) {
    if (!isObject(entry) || typeof entry.venue_id !== 'string' || !UUID.test(entry.venue_id) || typeof entry.query !== 'string') continue;
    if (deps.now() - t0 >= GEOCODE_BUDGET_MS) break;
    const wait = last + GEOCODE_GAP_MS - deps.now();
    if (wait > 0) {
      if (deps.now() + wait - t0 >= GEOCODE_BUDGET_MS) break;   // the sleep would cross the deadline
      await sleep(wait);
      if (deps.now() - t0 >= GEOCODE_BUDGET_MS) break;          // the clock moved further than asked
    }
    last = deps.now();
    let hit: { lat: number; lng: number } | null = null;
    try { hit = await deps.geocode(entry.query); } catch { hit = null; }
    try {
      await deps.db.setGeocode(entry.venue_id, hit ? hit.lat : null, hit ? hit.lng : null, 'nominatim');
      stored++;
    } catch (e) {
      deps.log(`ingest geocode_store_failed code=${codeOf(e) ?? 'none'}`);
    }
  }
  return stored;
}

async function finish(deps: IngestDeps): Promise<Response> {
  const t0 = deps.now();
  let processed = 0;
  let remaining = 0;
  let publicChanged = false;
  let busy = false;
  try {
    for (;;) {
      const r: ClusterOut = await deps.db.cluster(500);
      processed += r.processed;
      remaining = r.remaining;
      publicChanged = publicChanged || r.public_changed === true;
      if (r.busy === true) { busy = true; break; }
      if (remaining === 0 || deps.now() - t0 >= FINISH_BUDGET_MS) break;
    }
  } catch (e) {
    deps.log(`ingest op=finish status=500 code=${codeOf(e) ?? 'none'}`);
    return json(500, { error: 'unavailable' });
  }
  deps.log(`ingest op=finish status=200 processed=${processed} remaining=${remaining} public_changed=${publicChanged}${busy ? ' busy=1' : ''}`);
  return json(200, busy ? { public_changed: publicChanged, processed, remaining, busy: true } : { public_changed: publicChanged, processed, remaining });
}

/** Nominatim: usage policy needs a descriptive User-Agent and at most one request per second (the caller paces). */
export async function nominatim(query: string, doFetch: typeof fetch = fetch): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  const res = await doFetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) { await res.body?.cancel(); return null; }
  const rows = await res.json() as { lat?: string; lon?: string }[];
  const first = Array.isArray(rows) ? rows[0] : undefined;
  const lat = Number(first?.lat);
  const lng = Number(first?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function readEnv(): IngestEnv | null {
  const hmacKey = Deno.env.get('INGEST_HMAC_KEY');
  return hmacKey ? { hmacKey } : null;
}

if (import.meta.main) {
  const env = readEnv();
  const sb = serviceClient(Deno.env.get('SUPABASE_URL') ?? '');
  Deno.serve((req) => {
    if (!sb) { console.error('500 not configured'); return Promise.resolve(json(500, { error: 'unavailable' })); }
    return handle(req, env, {
      db: ingestDb(sb), geocode: (q) => nominatim(q), now: () => Date.now(), log: (l) => console.log(l),
    });
  });
}
