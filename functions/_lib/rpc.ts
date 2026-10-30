// The one upstream call: public.api_events_v1 through PostgREST with the publishable key (V13: no secret, read RPC only).
import type { Query } from './query';
import { PARAMS } from './query';
import type { Env } from './types';

export class RpcError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`rpc ${status}`);
    this.name = 'RpcError';
  }
}

const KNOWN = new Set<string>(PARAMS);

export async function callApiEvents(env: Env, q: Query, fetchFn: typeof fetch, timeoutMs = 4000): Promise<unknown> {
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) throw new RpcError(0, null);
  const body = {
    p_scope: q.scope, p_season: q.season ?? null, p_year: q.year ?? null, p_from: q.from ?? null, p_to: q.to ?? null,
    p_areas: q.area ?? null, p_categories: q.category ?? null, p_limit: q.limit ?? null, p_cursor: q.cursor ?? null,
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchFn(`${base.replace(/\/$/, '')}/rest/v1/rpc/api_events_v1`, {
        method: 'POST',
        headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'manual', // Workers fetch has no 'error' (throws); a 3xx is rejected below (Amendment W1-3)
      });
    } catch {
      throw new RpcError(504, null);
    }
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) throw new RpcError(502, null);
    if (!res.ok) {
      let code: string | null = null;
      try {
        const err = (await res.json()) as { code?: unknown; details?: unknown };
        if (err && err.code === '22023' && typeof err.details === 'string' && KNOWN.has(err.details)) code = err.details;
      } catch {
        // a non-JSON error body is never read further
      }
      throw new RpcError(res.status, code);
    }
    try {
      return await res.json();
    } catch {
      throw new RpcError(502, null);
    }
  } finally {
    clearTimeout(timer);
  }
}
