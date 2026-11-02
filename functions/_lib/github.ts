// Sources V2 (V14): the one GitHub call an admin Function makes, an input-less workflow_dispatch of ingest.yml on main.
// The upstream body is never read or forwarded, and the token never appears in a result or log.
export const GH_REPO = 'elevityx/truckeevibes';
export const GH_WORKFLOW = 'ingest.yml';
export const GH_REF = 'main';
export const DISPATCH_URL = `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`;

export type Dispatch =
  | { outcome: 'ok' }
  | { outcome: 'rejected'; reason: 'token_refused' | 'workflow_not_found' | 'ref_rejected' }
  | { outcome: 'unknown'; reason: 'upstream' };

const UPSTREAM: Dispatch = { outcome: 'unknown', reason: 'upstream' };

/** Exactly one POST to DISPATCH_URL; 200/204 ok, 401/403 token_refused, 404 workflow_not_found, 422 ref_rejected, anything else
 *  (3xx, 5xx, timeout, network) unknown/upstream (status 0 when thrown). */
export async function dispatchIngest(token: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<{ result: Dispatch; status: number }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchFn(DISPATCH_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'truckeevibes-admin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: GH_REF }),
        signal: ctl.signal,
        redirect: 'manual',
      });
    } catch {
      return { result: UPSTREAM, status: 0 };
    }
    try { await res.body?.cancel(); } catch { /* best effort: the body is never read */ }
    const s = res.status;
    if (s === 200 || s === 204) return { result: { outcome: 'ok' }, status: s };
    if (s === 401 || s === 403) return { result: { outcome: 'rejected', reason: 'token_refused' }, status: s };
    if (s === 404) return { result: { outcome: 'rejected', reason: 'workflow_not_found' }, status: s };
    if (s === 422) return { result: { outcome: 'rejected', reason: 'ref_rejected' }, status: s };
    return { result: UPSTREAM, status: s };
  } finally {
    clearTimeout(timer);
  }
}
