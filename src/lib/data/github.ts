// Sources V2 (§9): unauthenticated GitHub reads for the admin Jobs panel (the repo is public). Not in the data barrel, so public
// pages never pull it in; JobsTab imports it directly. Requests carry no headers (no CORS preflight) and share the viewer's hourly
// IP quota, so lists are cached and the reader pauses near the limit.

export const GH_API = 'https://api.github.com/repos/elevityx/truckeevibes';
export const RUN_URL_RE = /^https:\/\/github\.com\/elevityx\/truckeevibes\/actions\/runs\/\d+$/;

export interface GhRun {
  id: number; attempt: number; event: string; status: string; conclusion: string | null; createdAt: string; startedAt: string | null;
  updatedAt: string; url: string | null;
}
// startedAt null = GitHub has not started the run yet (run_started_at null while queued): the row is kept and labelled, never joined
export interface GhRebuildRun extends GhRun { failedStep?: string | null } // undefined = not looked up; null = no failed step found
export type GhState =
  | { ok: true; ingest: GhRun[]; rebuild: GhRebuildRun[]; fetchedAt: number }
  | { ok: false; reason: 'paused'; until: number }
  | { ok: false; reason: 'unavailable' };

const WORD_RE = /^[a-z_]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseRun(x: unknown): GhRun | null {
  if (!isObj(x)) return null;
  const { id, run_attempt: attempt, event, status, conclusion, created_at, updated_at, run_started_at, html_url } = x;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  if (typeof event !== 'string' || !WORD_RE.test(event) || typeof status !== 'string' || !WORD_RE.test(status)) return null;
  if (conclusion !== null && (typeof conclusion !== 'string' || !WORD_RE.test(conclusion))) return null;
  if (!isIso(created_at) || !isIso(updated_at)) return null;
  if (run_started_at !== undefined && run_started_at !== null && !isIso(run_started_at)) return null;
  return {
    id, attempt, event, status, conclusion, createdAt: created_at, startedAt: run_started_at ?? null, updatedAt: updated_at,
    url: typeof html_url === 'string' && RUN_URL_RE.test(html_url) ? html_url : null,
  };
}

/** body.workflow_runs (else null); bad items are skipped. */
export function parseRuns(body: unknown): GhRun[] | null {
  if (!isObj(body) || !Array.isArray(body.workflow_runs)) return null;
  const out: GhRun[] = [];
  for (const x of body.workflow_runs) {
    const r = parseRun(x);
    if (r) out.push(r);
  }
  return out;
}

/** Every job must belong to this run and attempt (else 'invalid'); the first failed job's first failed step name, else null. */
export function parseFailedStep(body: unknown, runId: number, attempt: number): string | null | 'invalid' {
  if (!isObj(body) || !Array.isArray(body.jobs)) return 'invalid';
  const jobs = body.jobs;
  if (!jobs.every((j) => isObj(j) && j.run_id === runId && j.run_attempt === attempt)) return 'invalid';
  const job = (jobs as Record<string, unknown>[]).find((j) => j.conclusion === 'failure');
  if (!job || !Array.isArray(job.steps)) return null;
  const step = (job.steps as unknown[]).find((s) => isObj(s) && s.conclusion === 'failure') as Record<string, unknown> | undefined;
  return step && typeof step.name === 'string' ? step.name.slice(0, 100) : null;
}

export interface GhDeps {
  fetch: typeof fetch; now(): number;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
}

const LIST_TTL = 5 * 60_000;
const REFRESH_MIN = 60_000;
const PAUSE_DEFAULT = 15 * 60_000;
const PAUSE_AT = 10;
const MAX_JOB_LOOKUPS = 3;
const jobKey = (id: number, attempt: number) => `tv.admin.ghjob.v1.${id}:${attempt}`;

export function createGithubReader(deps: GhDeps): { load(force?: boolean): Promise<GhState>; canRefresh(): boolean } {
  let cache: Extract<GhState, { ok: true }> | null = null;
  let pausedUntil = 0;
  let inflight: Promise<GhState> | null = null;

  const paused = () => deps.now() < pausedUntil;
  const age = () => (cache ? deps.now() - cache.fetchedAt : Infinity);

  /** Reads the rate-limit headers of every answer; pauses at <= 10 remaining or on a 403/429. */
  function watch(res: Response): void {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const resetHdr = res.headers.get('x-ratelimit-reset');
    const limited = res.status === 403 || res.status === 429 || (res.headers.has('x-ratelimit-remaining') && remaining <= PAUSE_AT);
    if (!limited) return;
    const reset = resetHdr !== null && /^\d+$/.test(resetHdr) ? Number(resetHdr) * 1000 : NaN;
    const until = Number.isFinite(reset) && reset > deps.now() ? reset : deps.now() + PAUSE_DEFAULT;
    pausedUntil = Math.max(pausedUntil, until);
  }

  async function get(url: string): Promise<{ res: Response; body: unknown }> {
    const res = await deps.fetch(url);
    watch(res);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { res, body };
  }

  function stored(id: number, attempt: number): string | null | undefined {
    try {
      const v = deps.storage?.getItem(jobKey(id, attempt));
      if (!v) return undefined;
      const o = JSON.parse(v) as unknown;
      if (isObj(o) && (o.step === null || typeof o.step === 'string')) return o.step as string | null;
    } catch { /* storage may be blocked or hold junk */ }
    return undefined;
  }
  function store(id: number, attempt: number, step: string | null): void {
    try { deps.storage?.setItem(jobKey(id, attempt), JSON.stringify({ step })); } catch { /* best effort */ }
  }

  async function fetchAll(): Promise<GhState> {
    let ingestR, rebuildR;
    try {
      [ingestR, rebuildR] = await Promise.all([
        get(`${GH_API}/actions/workflows/ingest.yml/runs?per_page=30`),
        get(`${GH_API}/actions/workflows/rebuild.yml/runs?per_page=10`),
      ]);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (!ingestR.res.ok || !rebuildR.res.ok) return paused() ? { ok: false, reason: 'paused', until: pausedUntil } : { ok: false, reason: 'unavailable' };
    const ingest = parseRuns(ingestR.body);
    const rebuildRuns = parseRuns(rebuildR.body);
    if (!ingest || !rebuildRuns) return { ok: false, reason: 'unavailable' };
    const rebuild: GhRebuildRun[] = rebuildRuns.map((r) => ({ ...r }));
    const failed = rebuild.filter((r) => r.conclusion === 'failure' && r.status === 'completed').slice(0, MAX_JOB_LOOKUPS);
    for (const r of failed) {
      const hit = stored(r.id, r.attempt);
      if (hit !== undefined) { r.failedStep = hit; continue; }
      if (paused()) continue;
      try {
        const { res, body } = await get(`${GH_API}/actions/runs/${r.id}/attempts/${r.attempt}/jobs?per_page=10`);
        if (!res.ok) continue;
        const step = parseFailedStep(body, r.id, r.attempt);
        if (step === 'invalid') { r.failedStep = null; continue; }
        r.failedStep = step;
        store(r.id, r.attempt, step);
      } catch { /* a failed lookup leaves the run unlabelled */ }
    }
    const state = { ok: true as const, ingest, rebuild, fetchedAt: deps.now() };
    cache = state;
    return state;
  }

  return {
    load(force = false) {
      if (paused()) return Promise.resolve({ ok: false, reason: 'paused', until: pausedUntil });
      if (cache && (force ? age() < REFRESH_MIN : age() < LIST_TTL)) return Promise.resolve(cache);
      if (inflight) return inflight;
      inflight = fetchAll().finally(() => { inflight = null; });
      return inflight;
    },
    canRefresh() {
      return !inflight && !paused() && age() >= REFRESH_MIN;
    },
  };
}
