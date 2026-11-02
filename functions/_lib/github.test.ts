// Sources V2 (AC-SV2-26, 27): dispatchIngest sends exactly one input-less workflow_dispatch of ingest.yml on main and maps GitHub's
// answer to an outcome. The upstream body is never read or forwarded; the token never appears in the result.
import { describe, expect, it } from 'vitest';
import { DISPATCH_URL, GH_REF, GH_REPO, GH_WORKFLOW, dispatchIngest } from './github';
import { recordingFetch } from './testing';

const TOKEN = 'test-dispatch-token';
const MARK = 'UPSTREAM-BODY-MARKER';

// a response whose body reads are counted (the body must never be read)
function counted(status: number, headers: Record<string, string> = {}) {
  const state = { reads: 0 };
  const r = new Response(status === 204 || status === 304 ? null : JSON.stringify({ message: MARK }), { status, headers });
  for (const m of ['json', 'text', 'arrayBuffer', 'blob'] as const) {
    const orig = (r[m] as () => Promise<unknown>).bind(r);
    (r as unknown as Record<string, unknown>)[m] = () => { state.reads += 1; return orig(); };
  }
  return { r, state };
}

describe('constants', () => {
  it('repo, workflow, ref and the dispatch URL', () => {
    expect(GH_REPO).toBe('elevityx/truckeevibes');
    expect(GH_WORKFLOW).toBe('ingest.yml');
    expect(GH_REF).toBe('main');
    expect(DISPATCH_URL).toBe('https://api.github.com/repos/elevityx/truckeevibes/actions/workflows/ingest.yml/dispatches');
  });
});

describe('dispatchIngest request', () => {
  it('exactly one POST to DISPATCH_URL, body {"ref":"main"}, the exact headers, redirect manual, a signal', async () => {
    const f = recordingFetch(() => new Response(null, { status: 204 }));
    const out = await dispatchIngest(TOKEN, f);
    expect(out).toEqual({ result: { outcome: 'ok' }, status: 204 });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(DISPATCH_URL);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"ref":"main"}');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(init.headers);
    expect(Object.fromEntries([...h.entries()].sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'truckeevibes-admin',
      'x-github-api-version': '2022-11-28',
    });
  });
});

describe('dispatchIngest outcomes', () => {
  const cases: [number, unknown][] = [
    [200, { outcome: 'ok' }],
    [204, { outcome: 'ok' }],
    [401, { outcome: 'rejected', reason: 'token_refused' }],
    [403, { outcome: 'rejected', reason: 'token_refused' }],
    [404, { outcome: 'rejected', reason: 'workflow_not_found' }],
    [422, { outcome: 'rejected', reason: 'ref_rejected' }],
    [301, { outcome: 'unknown', reason: 'upstream' }],
    [302, { outcome: 'unknown', reason: 'upstream' }],
    [307, { outcome: 'unknown', reason: 'upstream' }],
    [400, { outcome: 'unknown', reason: 'upstream' }],
    [429, { outcome: 'unknown', reason: 'upstream' }],
    [500, { outcome: 'unknown', reason: 'upstream' }],
    [503, { outcome: 'unknown', reason: 'upstream' }],
  ];
  for (const [status, result] of cases) {
    it(`GitHub ${status} -> ${JSON.stringify(result)}; the upstream body is never read`, async () => {
      const { r, state } = counted(status, status >= 300 && status < 400 ? { location: 'https://example.com/' } : {});
      const f = recordingFetch(() => r);
      const out = await dispatchIngest(TOKEN, f);
      expect(out).toEqual({ result, status });
      expect(f.calls).toHaveLength(1);
      expect(state.reads).toBe(0);
      expect(JSON.stringify(out)).not.toContain(MARK);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
    });
  }
  it('a thrown fetch -> unknown/upstream with status 0', async () => {
    const f = recordingFetch(() => { throw new TypeError('network'); });
    expect(await dispatchIngest(TOKEN, f)).toEqual({ result: { outcome: 'unknown', reason: 'upstream' }, status: 0 });
    expect(f.calls).toHaveLength(1);
  });
  it('a timeout -> unknown/upstream with status 0, through AbortController', async () => {
    const f = recordingFetch((_u, init) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const t0 = Date.now();
    expect(await dispatchIngest(TOKEN, f, 50)).toEqual({ result: { outcome: 'unknown', reason: 'upstream' }, status: 0 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
