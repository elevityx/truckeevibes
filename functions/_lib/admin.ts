// Admin Pages Functions helpers (Sources V2, V14): same-origin policy, bearer shape, a capped body read, the admin_whoami check and
// a no-store JSON reply. No Supabase secret here: the caller's own JWT and the publishable key go to admin_whoami only.
import type { Env } from './types';

export const MAX_BODY = 1024;
export const MAX_BEARER = 4096;

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** POST: Origin === own origin, Sec-Fetch-Site (when sent) === 'same-origin', Content-Type application/json.
 *  GET: a present Origin must equal own origin; a present Sec-Fetch-Site must be 'same-origin'; both absent is allowed (non-browser). */
export function sameOrigin(req: Request, method: 'GET' | 'POST'): boolean {
  const own = new URL(req.url).origin;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  if (method === 'GET') return origin === null || origin === own;
  if (origin !== own) return false;
  const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json';
}

/** "Bearer <a>.<b>.<c>" (base64url segments), total <= MAX_BEARER; else null. */
export function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h || h.length > MAX_BEARER) return null;
  const m = BEARER_RE.exec(h);
  return m ? m[1] : null;
}

/** Reads at most MAX_BODY + 1 bytes from the stream; null when larger (Content-Length > MAX_BODY short-circuits). */
export async function readCapped(req: Request): Promise<string | null> {
  const len = req.headers.get('content-length');
  if (len !== null && (!/^\d+$/.test(len) || Number(len) > MAX_BODY)) {
    try { await req.body?.cancel(); } catch { /* best effort */ }
    return null;
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

export type AdminCheck = 'admin' | 'forbidden' | 'unauthorized' | 'unavailable';

/** POST {NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/admin_whoami with the caller's JWT and the publishable key; redirect 'manual';
 *  AbortController timeout. 200 + body === true -> admin; 200 + anything else or 403 -> forbidden; 401 -> unauthorized; missing env,
 *  3xx, other status, timeout or network -> unavailable. The response body is parsed only on 200. */
export async function checkAdmin(env: Env, jwt: string, fetchFn: typeof fetch, timeoutMs = 4000): Promise<AdminCheck> {
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) return 'unavailable';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchFn(`${base.replace(/\/$/, '')}/rest/v1/rpc/admin_whoami`, {
        method: 'POST',
        headers: { apikey: key, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: '{}',
        signal: ctl.signal,
        redirect: 'manual', // Workers fetch has no 'error'; a 3xx is unavailable below
      });
    } catch {
      return 'unavailable';
    }
    if (res.status === 200) {
      try { return (await res.json()) === true ? 'admin' : 'forbidden'; } catch { return 'forbidden'; }
    }
    try { await res.body?.cancel(); } catch { /* best effort */ }
    if (res.status === 403) return 'forbidden';
    if (res.status === 401) return 'unauthorized';
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

/** JSON response with cache-control no-store and x-content-type-options nosniff; never any access-control-* header. */
export function reply(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const [k, v] of Object.entries(extra)) if (!k.toLowerCase().startsWith('access-control-')) h.set(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}
