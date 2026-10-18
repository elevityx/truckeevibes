// The Lights mirror's narrow REST client (spec W3.3, r2). createPoliteFetch cannot be used: it only does GET with fixed headers
// and a 20 s timeout. This client shares only the legal gate (checkLegal). It sends Lights' public publishable key to the one
// configured Supabase host, never follows a redirect (so the key never reaches another host), and makes at most 3 requests.
// It logs nothing; the runner logs codes.
import { checkLegal, FetchError, USER_AGENT, type PoliteSource } from '../core/politeFetch';

export interface MirrorEnv { LIGHTS_REST_URL: string; LIGHTS_PUBLISHABLE_KEY: string }

export interface LightsClient {
  rpc(name: 'get_region_context', body: { p_slug: 'truckee' }): Promise<unknown>;          // POST /rest/v1/rpc/<name>
  selectEvents(query: URLSearchParams): Promise<{ rows: unknown[]; total: number | null }>; // GET /rest/v1/events?<query>
}

export interface LightsClientDeps { fetch: typeof fetch; now(): number; timeoutSignal?(ms: number): AbortSignal }

const TIMEOUT_MS = 10_000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REQUESTS = 3;

/** The REST origin when LIGHTS_REST_URL is https, has no userinfo, port or path, and its host is (a subdomain of) an allowed host. */
function restOrigin(raw: string, allowedHosts: string[]): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  const ok = allowedHosts.some((a) => { const x = a.toLowerCase(); return host === x || host.endsWith(`.${x}`); });
  return ok ? u.origin : null;
}

function toFetchError(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new FetchError('timeout');
  const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  const text = `${e instanceof Error ? e.message : ''} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  return new FetchError(/redirect/i.test(text) ? 'redirect_blocked' : 'network');
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) { await res.body?.cancel().catch(() => undefined); throw new FetchError('too_large'); }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) { await reader.cancel().catch(() => undefined); throw new FetchError('too_large'); }
      chunks.push(value);
    }
  } catch (e) {
    throw toFetchError(e);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** `Content-Range: <a>-<b>/<total>` or `*\/<total>` -> total; a missing header or an unknown total (`/*`) -> null. */
export function contentRangeTotal(v: string | null): number | null {
  const m = v ? /^(?:\d+-\d+|\*)\/(\d+)$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : null;
}

export function createLightsClient(source: PoliteSource, env: MirrorEnv, deps: LightsClientDeps): LightsClient {
  let requests = 0;

  async function send(path: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<{ json: unknown; res: Response }> {
    checkLegal(source, 'api', deps.now());
    const origin = restOrigin(env.LIGHTS_REST_URL, source.allowed_hosts);
    if (!origin) throw new FetchError('host_not_allowed');
    if (requests >= MAX_REQUESTS) throw new FetchError('page_cap');
    requests++;
    const headers = {
      apikey: env.LIGHTS_PUBLISHABLE_KEY, authorization: `Bearer ${env.LIGHTS_PUBLISHABLE_KEY}`, accept: 'application/json',
      'user-agent': USER_AGENT, ...init.headers,
    };
    let res: Response;
    try {
      res = await deps.fetch(`${origin}${path}`, {
        method: init.method, headers, body: init.body, redirect: 'error', credentials: 'omit',
        signal: deps.timeoutSignal?.(TIMEOUT_MS) ?? AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw toFetchError(e);
    }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => undefined); throw new FetchError('redirect_blocked'); }
    if (res.status !== 200) { await res.body?.cancel().catch(() => undefined); throw new Error(`http_${res.status}`); }
    const bytes = await readCapped(res);
    let json: unknown;
    try { json = JSON.parse(new TextDecoder('utf-8').decode(bytes)); } catch { throw new Error('parse'); }
    return { json, res };
  }

  return {
    async rpc(name, body) {
      const { json } = await send(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return json;
    },
    async selectEvents(query) {
      const { json, res } = await send(`/rest/v1/events?${query.toString()}`, { method: 'GET', headers: { prefer: 'count=exact' } });
      if (!Array.isArray(json)) throw new Error('parse');
      return { rows: json, total: contentRangeTotal(res.headers.get('content-range')) };
    },
  };
}
