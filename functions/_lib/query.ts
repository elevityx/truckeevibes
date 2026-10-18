// Query-string parsing for GET /api/v1/events. Shape and syntax are checked here; the SQL RPC re-checks every bound (D11).
export type Season = 'halloween' | 'christmas';
export type Query = {
  scope: 'vibes' | 'lights';
  season?: Season;
  year?: number;
  from?: string;
  to?: string;
  area?: string[];
  category?: string[];
  limit?: number;
  cursor?: string;
};
export const PARAMS = ['scope', 'season', 'year', 'from', 'to', 'area', 'category', 'limit', 'cursor'] as const;
export type Param = (typeof PARAMS)[number];

const SLUG = /^[a-z0-9_-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function list(v: string): string[] | null {
  const items = v.split(',');
  if (items.length > 10 || items.some((x) => !SLUG.test(x))) return null;
  return [...new Set(items)].sort();
}

export function parseQuery(url: URL): { ok: true; q: Query; canonical: string } | { ok: false; param: string } {
  const seen = new Map<string, string>();
  for (const [k, v] of url.searchParams) {
    if (!(PARAMS as readonly string[]).includes(k)) return { ok: false, param: k };
    if (seen.has(k)) return { ok: false, param: k };
    seen.set(k, v);
  }
  const q: Query = { scope: 'vibes' };
  const scope = seen.get('scope');
  if (scope !== undefined) {
    if (scope !== 'vibes' && scope !== 'lights') return { ok: false, param: 'scope' };
    q.scope = scope;
  }
  const season = seen.get('season');
  if (season !== undefined) {
    if (season !== 'halloween' && season !== 'christmas') return { ok: false, param: 'season' };
    q.season = season;
  }
  const year = seen.get('year');
  if (year !== undefined) {
    if (!/^\d{4}$/.test(year)) return { ok: false, param: 'year' };
    q.year = Number(year);
  }
  for (const k of ['from', 'to'] as const) {
    const v = seen.get(k);
    if (v !== undefined) {
      if (!realDate(v)) return { ok: false, param: k };
      q[k] = v;
    }
  }
  for (const k of ['area', 'category'] as const) {
    const v = seen.get(k);
    if (v !== undefined) {
      const l = list(v);
      if (!l) return { ok: false, param: k };
      q[k] = l;
    }
  }
  const limit = seen.get('limit');
  if (limit !== undefined) {
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 500) return { ok: false, param: 'limit' };
    q.limit = Number(limit);
  }
  const cursor = seen.get('cursor');
  if (cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return { ok: false, param: 'cursor' };
    q.cursor = cursor;
  }
  if (q.scope === 'lights') {
    if (q.season === undefined) return { ok: false, param: 'season' };
    if (q.year === undefined) return { ok: false, param: 'year' };
    if (q.area !== undefined) return { ok: false, param: 'area' };
    if (q.category !== undefined) return { ok: false, param: 'category' };
  } else {
    if (q.season !== undefined) return { ok: false, param: 'season' };
    if (q.year !== undefined) return { ok: false, param: 'year' };
  }
  const canonical = PARAMS.filter((k) => q[k] !== undefined)
    .slice()
    .sort()
    .map((k) => `${k}=${Array.isArray(q[k]) ? (q[k] as string[]).join(',') : String(q[k])}`)
    .join('&');
  return { ok: true, q, canonical };
}
