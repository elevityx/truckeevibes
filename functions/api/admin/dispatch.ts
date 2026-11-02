// POST /api/admin/dispatch (Sources V2, V14): wakes the Ingest workflow for Run now. Gates in order, each failing closed: method,
// same origin, bearer, body, admin_whoami, token; then exactly one input-less workflow_dispatch of ingest.yml on main.
// One log line per request, codes only: never the token, the JWT or a body.
import { bearerOf, checkAdmin, readCapped, reply, sameOrigin } from '../../_lib/admin';
import { dispatchIngest } from '../../_lib/github';
import type { Env, PagesCtx } from '../../_lib/types';

export interface Deps { fetch: typeof fetch; log(line: string): void; adminTimeoutMs?: number; githubTimeoutMs?: number }

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const done = (status: number, body: Record<string, unknown>, tail = '-', extra?: Record<string, string>) => {
    deps.log(`admin dispatch status=${status} outcome=${tail}`);
    return reply(status, body, extra);
  };
  if (req.method !== 'POST') return done(405, { error: 'method_not_allowed' }, '-', { allow: 'POST' });
  if (!sameOrigin(req, 'POST')) return done(403, { error: 'bad_origin' });
  const jwt = bearerOf(req);
  if (!jwt) return done(401, { error: 'unauthorized' });
  const text = await readCapped(req);
  let parsed: unknown = null;
  if (text !== null) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return done(400, { error: 'bad_body' });
  const who = await checkAdmin(env, jwt, deps.fetch, deps.adminTimeoutMs);
  if (who === 'unauthorized') return done(401, { error: 'unauthorized' });
  if (who === 'forbidden') return done(403, { error: 'forbidden' });
  if (who !== 'admin') return done(503, { error: 'unavailable' });
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) return done(503, { outcome: 'not_configured' }, 'not_configured');
  const { result, status } = await dispatchIngest(token, deps.fetch, deps.githubTimeoutMs);
  if (result.outcome === 'ok') return done(202, { outcome: 'ok' }, `ok gh=${status}`);
  return done(502, { outcome: result.outcome, reason: result.reason }, `${result.outcome} reason=${result.reason} gh=${status}`);
}

export async function onRequest(ctx: PagesCtx): Promise<Response> {
  return handle(ctx.request, ctx.env, { fetch, log: console.log });
}
