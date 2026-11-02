// GET /api/admin/dispatch-status (Sources V2, V14): tells an admin whether GITHUB_DISPATCH_TOKEN is set, so the console can show
// "needs setup". Gates: method, the GET origin policy, bearer, admin_whoami. Never a GitHub call; the token is only tested for presence.
import { bearerOf, checkAdmin, reply, sameOrigin } from '../../_lib/admin';
import type { Env, PagesCtx } from '../../_lib/types';

export interface Deps { fetch: typeof fetch; log(line: string): void; adminTimeoutMs?: number; githubTimeoutMs?: number }

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const done = (status: number, body: Record<string, unknown>, tail = '', extra?: Record<string, string>) => {
    deps.log(`admin dispatch-status status=${status}${tail}`);
    return reply(status, body, extra);
  };
  if (req.method !== 'GET') return done(405, { error: 'method_not_allowed' }, '', { allow: 'GET' });
  if (!sameOrigin(req, 'GET')) return done(403, { error: 'bad_origin' });
  const jwt = bearerOf(req);
  if (!jwt) return done(401, { error: 'unauthorized' });
  const who = await checkAdmin(env, jwt, deps.fetch, deps.adminTimeoutMs);
  if (who === 'unauthorized') return done(401, { error: 'unauthorized' });
  if (who === 'forbidden') return done(403, { error: 'forbidden' });
  if (who !== 'admin') return done(503, { error: 'unavailable' });
  const configured = typeof env.GITHUB_DISPATCH_TOKEN === 'string' && env.GITHUB_DISPATCH_TOKEN.length > 0;
  return done(200, { configured }, ` configured=${configured}`);
}

export async function onRequest(ctx: PagesCtx): Promise<Response> {
  return handle(ctx.request, ctx.env, { fetch, log: console.log });
}
