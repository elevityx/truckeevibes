// AC-SV2-31 (Spec_Sources_V2 §9 github.ts): unauthenticated GitHub reads for the Jobs panel (parse, cache, pause, job lookups).
import { describe, expect, it, vi } from 'vitest';
import { GH_API, RUN_URL_RE, createGithubReader, parseFailedStep, parseRuns, type GhDeps } from './github';

const T0 = Date.parse('2026-11-05T18:00:00Z');
const MIN = 60_000;
const INGEST_URL = `${GH_API}/actions/workflows/ingest.yml/runs?per_page=30`;
const REBUILD_URL = `${GH_API}/actions/workflows/rebuild.yml/runs?per_page=10`;
const jobsUrl = (id: number, attempt: number) => `${GH_API}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=10`;

function rawRun(id: number, o: Record<string, unknown> = {}) {
  return {
    id, run_attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success',
    created_at: '2026-11-05T15:00:00Z', run_started_at: '2026-11-05T15:00:05Z', updated_at: '2026-11-05T15:04:00Z',
    html_url: `https://github.com/elevityx/truckeevibes/actions/runs/${id}`, ...o,
  };
}
const jobsBody = (runId: number, attempt: number, step = 'Call the Pages deploy hook') => ({
  jobs: [{ run_id: runId, run_attempt: attempt, conclusion: 'failure', steps: [
    { name: 'Set up job', conclusion: 'success' }, { name: step, conclusion: 'failure' }, { name: 'Later', conclusion: 'failure' },
  ] }],
});

interface Fake {
  ingest?: unknown[];
  rebuild?: unknown[];
  status?: number;
  headers?: Record<string, string>;
  jobs?: (id: number, attempt: number) => unknown;
}
function setup(f: Fake = {}, storage: GhDeps['storage'] = null) {
  let now = T0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    const headers = { 'content-type': 'application/json', ...(f.headers ?? {}) };
    if (url === INGEST_URL) return new Response(JSON.stringify({ workflow_runs: f.ingest ?? [rawRun(1)] }), { status: f.status ?? 200, headers });
    if (url === REBUILD_URL) return new Response(JSON.stringify({ workflow_runs: f.rebuild ?? [] }), { status: f.status ?? 200, headers });
    const m = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=10$/.exec(url);
    if (m) {
      const body = f.jobs ? f.jobs(Number(m[1]), Number(m[2])) : jobsBody(Number(m[1]), Number(m[2]));
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    return new Response('{}', { status: 404 });
  });
  const reader = createGithubReader({ fetch: fetch as unknown as typeof globalThis.fetch, now: () => now, storage });
  const urls = () => fetch.mock.calls.map((c) => c[0] as string);
  const lists = () => urls().filter((u) => u === INGEST_URL || u === REBUILD_URL).length;
  const jobCalls = () => urls().filter((u) => u.includes('/jobs?'));
  return { reader, fetch, urls, lists, jobCalls, advance: (ms: number) => { now += ms; } };
}
function memStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: vi.fn((k: string) => m.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      m.set(k, v);
    }),
  };
}

describe('parseRuns', () => {
  it('maps a run', () => {
    expect(parseRuns({ workflow_runs: [rawRun(7, { run_attempt: 2, event: 'workflow_dispatch' })] })).toEqual([{
      id: 7, attempt: 2, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', createdAt: '2026-11-05T15:00:00Z',
      startedAt: '2026-11-05T15:00:05Z', updatedAt: '2026-11-05T15:04:00Z', url: 'https://github.com/elevityx/truckeevibes/actions/runs/7',
    }]);
  });
  it('keeps a queued run with run_started_at null or absent (startedAt null)', () => {
    const queued = rawRun(8, { status: 'queued', conclusion: null, run_started_at: null });
    const absent: Record<string, unknown> = rawRun(9, { status: 'queued', conclusion: null });
    delete absent.run_started_at;
    const r = parseRuns({ workflow_runs: [queued, absent] });
    expect(r?.map((x) => [x.id, x.startedAt, x.conclusion])).toEqual([[8, null, null], [9, null, null]]);
  });
  it('a non-matching html_url becomes url null (the run is kept)', () => {
    for (const html_url of ['https://evil.test/elevityx/truckeevibes/actions/runs/5', 'https://github.com/other/repo/actions/runs/5',
      'javascript:alert(1)', 'https://github.com/elevityx/truckeevibes/actions/runs/5/x', 42]) {
      const [r] = parseRuns({ workflow_runs: [rawRun(5, { html_url })] }) ?? [];
      expect(r?.id).toBe(5);
      expect(r?.url).toBeNull();
    }
    expect(RUN_URL_RE.test('https://github.com/elevityx/truckeevibes/actions/runs/123')).toBe(true);
  });
  it('skips bad items', () => {
    const bad = [
      rawRun(0), rawRun(-1), rawRun(1.5), { ...rawRun(2), id: '3' }, rawRun(Number.MAX_SAFE_INTEGER + 2),
      rawRun(4, { run_attempt: 0 }), rawRun(5, { run_attempt: 1.5 }), rawRun(6, { event: 'Bad-Event' }), rawRun(7, { status: 'x'.repeat(41) }),
      rawRun(8, { conclusion: 'not ok' }), rawRun(9, { created_at: 'yesterday' }), rawRun(10, { updated_at: null }),
      rawRun(11, { run_started_at: 'soon' }), null, 'x',
    ];
    expect(parseRuns({ workflow_runs: [...bad, rawRun(99)] })?.map((r) => r.id)).toEqual([99]);
  });
  it('returns null without a workflow_runs array', () => {
    expect(parseRuns({})).toBeNull();
    expect(parseRuns(null)).toBeNull();
    expect(parseRuns({ workflow_runs: 'x' })).toBeNull();
    expect(parseRuns('<html>')).toBeNull();
  });
});

describe('parseFailedStep', () => {
  it('first failed job -> its first failed step', () => {
    expect(parseFailedStep(jobsBody(5, 2, 'Deploy'), 5, 2)).toBe('Deploy');
  });
  it('no failed job -> null', () => {
    expect(parseFailedStep({ jobs: [{ run_id: 5, run_attempt: 1, conclusion: 'success', steps: [] }] }, 5, 1)).toBeNull();
  });
  it('a job of another run or attempt -> invalid', () => {
    expect(parseFailedStep(jobsBody(5, 1), 5, 2)).toBe('invalid');
    expect(parseFailedStep(jobsBody(6, 1), 5, 1)).toBe('invalid');
    const mixed = { jobs: [...jobsBody(5, 1).jobs, { run_id: 5, run_attempt: 2, conclusion: 'success', steps: [] }] };
    expect(parseFailedStep(mixed, 5, 1)).toBe('invalid');
  });
  it('a body without a jobs array -> invalid', () => {
    expect(parseFailedStep({}, 5, 1)).toBe('invalid');
    expect(parseFailedStep(null, 5, 1)).toBe('invalid');
  });
  it('names are at most 100 chars', () => {
    const s = parseFailedStep(jobsBody(5, 1, 'n'.repeat(300)), 5, 1);
    expect(typeof s === 'string' && s.length <= 100).toBe(true);
  });
});

describe('createGithubReader.load', () => {
  it('GETs both lists with per_page=30 / 10 and no request headers (no preflight)', async () => {
    const t = setup();
    const st = await t.reader.load();
    expect(st.ok).toBe(true);
    expect(t.urls().sort()).toEqual([INGEST_URL, REBUILD_URL].sort());
    for (const c of t.fetch.mock.calls) {
      const init = c[1] as RequestInit | undefined;
      expect([...new Headers(init?.headers).keys()]).toEqual([]);
    }
  });
  it('returns every parsed run (no slicing before the join)', async () => {
    const t = setup({ ingest: Array.from({ length: 30 }, (_, i) => rawRun(i + 1)) });
    const st = await t.reader.load();
    expect(st.ok && st.ingest.length).toBe(30);
    expect(st.ok && st.fetchedAt).toBe(T0);
  });
  it('a network error or an invalid list -> unavailable', async () => {
    const t = setup();
    t.fetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await t.reader.load()).toEqual({ ok: false, reason: 'unavailable' });
    const bad = vi.fn(async () => new Response('{}', { status: 200 }));
    const r2 = createGithubReader({ fetch: bad as unknown as typeof fetch, now: () => T0, storage: null });
    expect(await r2.load()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('caches lists for 5 min; force inside 60 s returns the cache; force after 60 s refetches', async () => {
    const t = setup();
    const first = await t.reader.load();
    expect(t.lists()).toBe(2);
    t.advance(30_000);
    expect(t.reader.canRefresh()).toBe(false);
    expect(await t.reader.load(true)).toEqual(first);
    expect(t.lists()).toBe(2);
    t.advance(4 * MIN); // 4.5 min old
    expect(t.reader.canRefresh()).toBe(true);
    await t.reader.load();
    expect(t.lists()).toBe(2);
    await t.reader.load(true);
    expect(t.lists()).toBe(4);
    t.advance(5 * MIN + 1);
    await t.reader.load();
    expect(t.lists()).toBe(6);
  });
  it('canRefresh is true with no cache', () => {
    expect(setup().reader.canRefresh()).toBe(true);
  });
  it('concurrent loads share one promise', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.reader.load(), t.reader.load()]);
    expect(a).toEqual(b);
    expect(t.lists()).toBe(2);
  });

  it('pauses at x-ratelimit-remaining 10 until reset, with no request while paused', async () => {
    const reset = Math.floor((T0 + 20 * MIN) / 1000);
    const t = setup({
      headers: { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(reset) },
      rebuild: [rawRun(50, { conclusion: 'failure' })],
    });
    await t.reader.load();
    expect(t.jobCalls()).toEqual([]); // job lookups run only while not paused
    const n = t.fetch.mock.calls.length;
    t.advance(6 * MIN);
    expect(await t.reader.load(true)).toEqual({ ok: false, reason: 'paused', until: reset * 1000 });
    expect(t.fetch.mock.calls.length).toBe(n);
    expect(t.reader.canRefresh()).toBe(false);
    t.advance(15 * MIN); // past reset
    await t.reader.load(true);
    expect(t.fetch.mock.calls.length).toBeGreaterThan(n);
  });
  it('remaining 11 does not pause', async () => {
    const t = setup({ headers: { 'x-ratelimit-remaining': '11', 'x-ratelimit-reset': String(Math.floor(T0 / 1000) + 3600) } });
    await t.reader.load();
    t.advance(6 * MIN);
    expect((await t.reader.load()).ok).toBe(true);
  });
  it.each([403, 429])('a %i pauses until reset (15 min when the header is missing)', async (status) => {
    const t = setup({ status });
    await t.reader.load();
    const n = t.fetch.mock.calls.length;
    t.advance(MIN);
    expect(await t.reader.load(true)).toEqual({ ok: false, reason: 'paused', until: T0 + 15 * MIN });
    expect(t.fetch.mock.calls.length).toBe(n);
  });
  it('a 403 with a reset header pauses until that reset', async () => {
    const reset = Math.floor((T0 + 40 * MIN) / 1000);
    const t = setup({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    await t.reader.load();
    t.advance(MIN);
    expect(await t.reader.load(true)).toEqual({ ok: false, reason: 'paused', until: reset * 1000 });
  });
});

describe('failed-step lookups', () => {
  const failed = (id: number, o: Record<string, unknown> = {}) => rawRun(id, { conclusion: 'failure', ...o });

  it('looks up the failed step at /runs/{id}/attempts/{n}/jobs and caches {step} under id:attempt', async () => {
    const s = memStorage();
    const t = setup({ rebuild: [failed(60, { run_attempt: 2 }), rawRun(61)] }, s);
    const st = await t.reader.load();
    expect(t.jobCalls()).toEqual([jobsUrl(60, 2)]);
    expect(st.ok && st.rebuild[0].failedStep).toBe('Call the Pages deploy hook');
    expect(st.ok && st.rebuild[1].failedStep).toBeUndefined(); // not looked up
    expect(s.setItem).toHaveBeenCalledTimes(1);
    const [k, v] = s.setItem.mock.calls[0];
    expect(k).toBe('tv.admin.ghjob.v1.60:2');
    expect(JSON.parse(v)).toEqual({ step: 'Call the Pages deploy hook' });
  });
  it('a storage hit skips the request', async () => {
    const s = memStorage();
    s.m.set('tv.admin.ghjob.v1.60:1', JSON.stringify({ step: 'Checkout' }));
    const t = setup({ rebuild: [failed(60)] }, s);
    const st = await t.reader.load();
    expect(t.jobCalls()).toEqual([]);
    expect(st.ok && st.rebuild[0].failedStep).toBe('Checkout');
  });
  it('a body whose run_attempt or run_id differs is invalid and never cached', async () => {
    for (const jobs of [(id: number) => jobsBody(id, 9), (_id: number, a: number) => jobsBody(12345, a)]) {
      const s = memStorage();
      const t = setup({ rebuild: [failed(60)], jobs }, s);
      const st = await t.reader.load();
      expect(t.jobCalls()).toHaveLength(1);
      expect(s.setItem).not.toHaveBeenCalled();
      expect(st.ok && st.rebuild[0].failedStep).not.toBe('Call the Pages deploy hook');
    }
  });
  it('a run that has not completed is never looked up or cached', async () => {
    const s = memStorage();
    const t = setup({ rebuild: [failed(60, { status: 'in_progress' })] }, s);
    await t.reader.load();
    expect(t.jobCalls()).toEqual([]);
    expect(s.setItem).not.toHaveBeenCalled();
  });
  it('at most 3 job lookups per load (the newest 3 failed runs)', async () => {
    const t = setup({ rebuild: [failed(71), failed(72), failed(73), failed(74), failed(75)] });
    await t.reader.load();
    expect(t.jobCalls()).toEqual([jobsUrl(71, 1), jobsUrl(72, 1), jobsUrl(73, 1)]);
  });
  it('storage null works', async () => {
    const t = setup({ rebuild: [failed(60)] }, null);
    const st = await t.reader.load();
    expect(st.ok && st.rebuild[0].failedStep).toBe('Call the Pages deploy hook');
  });
  it('a throwing storage works', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const t = setup({ rebuild: [failed(60)] }, throwing);
    const st = await t.reader.load();
    expect(st.ok).toBe(true);
    expect(st.ok && st.rebuild[0].failedStep).toBe('Call the Pages deploy hook');
  });
});
