// GET /api/v1/events: the public, read-only events API (V13: GET/HEAD/OPTIONS only, no secret, counts-only logs).
import { corsHeaders } from '../../_lib/cors';
import { putFresh, putLkg, readFresh, readLkg } from '../../_lib/lkg';
import { parseQuery } from '../../_lib/query';
import { RpcError, callApiEvents } from '../../_lib/rpc';
import { shapeEnvelope } from '../../_lib/shape';
import type { Env, PagesCtx } from '../../_lib/types';

export interface Deps {
  fetch: typeof fetch;
  cache: Pick<Cache, 'match' | 'put'>;
  now: () => number;
  log: (line: string) => void;
  waitUntil: (p: Promise<unknown>) => void;
  rpcTimeoutMs?: number;
}

const LKG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FRESH_CC = 'public, max-age=60, s-maxage=300, stale-while-revalidate=300';

function respond(req: Request, status: number, body: string | null, cc: string, cors: Headers, extra: Record<string, string> = {}) {
  const h = new Headers(cors);
  h.set('cache-control', cc);
  if (body !== null) {
    h.set('content-type', 'application/json; charset=utf-8');
    h.set('x-content-type-options', 'nosniff');
  }
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(req.method === 'HEAD' ? null : body, { status, headers: h });
}
const countOf = (body: string) => {
  try {
    const n = (JSON.parse(body) as { count?: unknown }).count;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
};

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin'), env.CF_PAGES_BRANCH);
  const log = (status: number, scope: string, count: number, cache: 'hit' | 'miss' | 'lkg' | 'none') =>
    deps.log(`api v1 status=${status} scope=${scope} count=${count} cache=${cache}`);

  if (req.method === 'OPTIONS') {
    const h = new Headers(cors);
    if (h.has('access-control-allow-origin')) {
      h.set('access-control-allow-methods', 'GET, HEAD');
      h.set('access-control-max-age', '86400');
    }
    return new Response(null, { status: 204, headers: h });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    log(405, '-', 0, 'none');
    const h = new Headers(cors);
    h.set('allow', 'GET, HEAD, OPTIONS');
    h.set('cache-control', 'no-store');
    h.set('content-type', 'application/json; charset=utf-8');
    h.set('x-content-type-options', 'nosniff');
    return new Response('{"error":"method_not_allowed"}', { status: 405, headers: h });
  }

  const parsed = parseQuery(new URL(req.url));
  if (!parsed.ok) {
    log(400, '-', 0, 'none');
    return respond(req, 400, JSON.stringify({ error: 'bad_param', param: parsed.param }), 'no-store', cors);
  }
  const { q, canonical } = parsed;

  const fresh = await readFresh(deps.cache, canonical).catch(() => null);
  if (fresh !== null) {
    log(200, q.scope, countOf(fresh), 'hit');
    return respond(req, 200, fresh, FRESH_CC, cors);
  }

  try {
    const raw = await callApiEvents(env, q, deps.fetch, deps.rpcTimeoutMs);
    const envelope = shapeEnvelope(raw, q);
    if (!envelope) throw new RpcError(502, null);
    const body = JSON.stringify(envelope);
    deps.waitUntil(Promise.all([putFresh(deps.cache, canonical, body), putLkg(deps.cache, canonical, body)]).catch(() => undefined));
    log(200, q.scope, envelope.count, 'miss');
    return respond(req, 200, body, FRESH_CC, cors);
  } catch (e) {
    if (e instanceof RpcError && e.status === 400 && e.code) {
      log(400, q.scope, 0, 'none');
      return respond(req, 400, JSON.stringify({ error: 'bad_param', param: e.code }), 'no-store', cors);
    }
    const lkg = await readLkg(deps.cache, canonical).catch(() => null);
    const at = lkg && typeof lkg.dataAt === 'string' ? Date.parse(lkg.dataAt) : NaN;
    if (lkg && Number.isFinite(at) && deps.now() - at <= LKG_MAX_AGE_MS) {
      const count = typeof lkg.count === 'number' ? lkg.count : 0;
      log(200, q.scope, count, 'lkg');
      return respond(req, 200, JSON.stringify({ ...lkg, stale: true }), 'no-store', cors, { 'x-tv-stale': '1' });
    }
    log(503, q.scope, 0, 'none');
    return respond(req, 503, '{"error":"unavailable"}', 'no-store', cors);
  }
}

export async function onRequest(ctx: PagesCtx): Promise<Response> {
  return handle(ctx.request, ctx.env, {
    fetch,
    cache: (caches as unknown as { default: Cache }).default,
    now: Date.now,
    log: console.log,
    waitUntil: (p) => ctx.waitUntil(p),
  });
}
