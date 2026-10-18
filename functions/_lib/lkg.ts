// Edge cache and last-known-good copies in the Workers Cache API (SD4). Stored responses carry only the JSON body and a TTL;
// client headers (incl. CORS) are rebuilt per request.
export const FRESH_S = 300;
export const LKG_S = 21600;
const ORIGIN = 'https://truckeevibes.com';

type CacheLike = Pick<Cache, 'match' | 'put'>;

export const cacheKey = (canonical: string) => `${ORIGIN}/__cache/api/v1/events?${canonical}`;
export const lkgKey = (canonical: string) => `${ORIGIN}/__lkg/api/v1/events?${canonical}`;

const stored = (body: string, ttl: number) =>
  new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `s-maxage=${ttl}` } });

export async function readFresh(cache: CacheLike, canonical: string): Promise<string | null> {
  const r = await cache.match(cacheKey(canonical));
  return r ? r.text() : null;
}
export async function putFresh(cache: CacheLike, canonical: string, body: string): Promise<void> {
  await cache.put(cacheKey(canonical), stored(body, FRESH_S));
}
export async function readLkg(cache: CacheLike, canonical: string): Promise<Record<string, unknown> | null> {
  const r = await cache.match(lkgKey(canonical));
  if (!r) return null;
  try {
    const v = (await r.json()) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
export async function putLkg(cache: CacheLike, canonical: string, body: string): Promise<void> {
  await cache.put(lkgKey(canonical), stored(body, LKG_S));
}
