// Edge cache and last-known-good copies in the Workers Cache API (SD4). Stored responses carry only the JSON body, a TTL and the
// body's generation (x-tv-generation = the RPC's dataAt, microseconds); client headers (incl. CORS) are rebuilt per request.
// Amendment W1-1: writes are fenced (an entry is replaced only by a strictly newer generation) and an LKG is served only when
// its generation is valid and matches its body.
export const FRESH_S = 300;
export const LKG_S = 21600;
export const GEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;   // fixed width, so string order = time order
const ORIGIN = 'https://truckeevibes.com';
const GEN_H = 'x-tv-generation';

export type CacheLike = Pick<Cache, 'match' | 'put' | 'delete'>;

export const cacheKey = (canonical: string) => `${ORIGIN}/__cache/api/v1/events?${canonical}`;
export const lkgKey = (canonical: string) => `${ORIGIN}/__lkg/api/v1/events?${canonical}`;

const stored = (body: string, ttl: number, generation: string) =>
  new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `s-maxage=${ttl}`, [GEN_H]: generation } });

// fenced put: skip when the stored entry already has a valid generation >= this one
async function fencedPut(cache: CacheLike, key: string, body: string, ttl: number, generation: string): Promise<void> {
  if (!GEN_RE.test(generation)) throw new Error('invalid_generation');
  const cur = await cache.match(key);
  const g = cur?.headers.get(GEN_H);
  if (cur) await cur.body?.cancel();
  if (g && GEN_RE.test(g) && g >= generation) return;
  await cache.put(key, stored(body, ttl, generation));
}

export async function readFresh(cache: CacheLike, canonical: string): Promise<string | null> {
  const r = await cache.match(cacheKey(canonical));
  return r ? r.text() : null;
}
export async function putFresh(cache: CacheLike, canonical: string, body: string, generation: string): Promise<void> {
  await fencedPut(cache, cacheKey(canonical), body, FRESH_S, generation);
}
export async function readLkg(cache: CacheLike, canonical: string): Promise<{ env: Record<string, unknown>; generation: string } | null> {
  const r = await cache.match(lkgKey(canonical));
  if (!r) return null;
  const generation = r.headers.get(GEN_H);
  try {
    const v = (await r.json()) as unknown;
    if (!generation || !GEN_RE.test(generation)) return null;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const env = v as Record<string, unknown>;
    return env.dataAt === generation ? { env, generation } : null;
  } catch {
    return null;
  }
}
export async function putLkg(cache: CacheLike, canonical: string, body: string, generation: string): Promise<void> {
  await fencedPut(cache, lkgKey(canonical), body, LKG_S, generation);
}
export async function deleteLkg(cache: CacheLike, canonical: string): Promise<void> {
  await cache.delete(lkgKey(canonical));
}
