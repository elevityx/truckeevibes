// The fresh edge cache in the Workers Cache API (SD4): stored responses carry only the JSON body, a 300 s TTL and the body's
// generation (x-tv-generation = the RPC's dataAt, microseconds); client headers (incl. CORS) are rebuilt per request.
// Amendment W1-2: there is no stale fallback. The generation guard is best effort (the Cache API has no compare-and-set): an
// older body can win a race for at most one TTL, never during an outage.
export const FRESH_S = 300;
export const GEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;   // fixed width, so string order = time order
const ORIGIN = 'https://truckeevibes.com';
const GEN_H = 'x-tv-generation';

export type CacheLike = Pick<Cache, 'match' | 'put'>;

export const cacheKey = (canonical: string) => `${ORIGIN}/__cache/api/v1/events?${canonical}`;

export async function readFresh(cache: CacheLike, canonical: string): Promise<string | null> {
  const r = await cache.match(cacheKey(canonical));
  return r ? r.text() : null;
}

export async function putFresh(cache: CacheLike, canonical: string, body: string, generation: string): Promise<void> {
  if (!GEN_RE.test(generation)) throw new Error('invalid_generation');
  const key = cacheKey(canonical);
  const cur = await cache.match(key);
  const g = cur?.headers.get(GEN_H);
  if (cur) await cur.body?.cancel();
  if (g && GEN_RE.test(g) && g >= generation) return;
  await cache.put(key, new Response(body, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `s-maxage=${FRESH_S}`, [GEN_H]: generation },
  }));
}
