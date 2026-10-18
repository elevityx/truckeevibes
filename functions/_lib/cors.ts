import { allowedOrigin } from './origins';

// Per-request CORS headers (never cached): the allowed origin echoed, and always `vary: Origin`.
export function corsHeaders(origin: string | null, branch?: string): Headers {
  const h = new Headers({ vary: 'Origin' });
  const allowed = allowedOrigin(origin, branch);
  if (allowed) h.set('access-control-allow-origin', allowed);
  return h;
}
