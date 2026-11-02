import { getSupabase } from '@/lib/supabase/client';
import { toDataError } from './errors';
import { DataError } from './types';

// Sources V2 (§9): the Run-now / Read-request stamp RPCs, the Jobs panel read, and the same-origin admin dispatch Function client.
// The database and the Function enforce the admin gate; nothing here is a security boundary.

export interface JobRun { slug: string; status: string; found: number; new: number; changed: number; errorCode: string | null; finishedAt: string }
export interface IngestBatch { issuedAt: string; grants: number; pending: number; unused: number; runNow: string[]; runs: JobRun[] }
export interface ManualRead { issuedAt: string; slug: string; requested: boolean; state: 'reading' | 'no_result' | 'done'; run: JobRun | null }
export interface StampRow {
  slug: string; name: string; kind: 'run_now' | 'read_request'; requestedAt: string | null; servedAt: string | null; pending: boolean; expired: boolean;
}
export interface AdminJobs { generatedAt: string; batches: IngestBatch[]; manual: ManualRead[]; stamps: StampRow[] }
export interface StampResult { slug: string; at: string | null; already: boolean; nextDueAt: string | null; lastGrantAt: string | null }

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- PostgREST jsonb rows, mapped field by field below
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = args === undefined ? await getSupabase().rpc(fn) : await getSupabase().rpc(fn, args);
    if (error) throw error;
    return data;
  } catch (e) {
    throw toDataError(e);
  }
}

function mapStamp(r: unknown, atKey: 'force_due_at' | 'read_requested_at'): StampResult {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new DataError('unknown');
  const o = r as Raw;
  return { slug: o.slug, at: o[atKey] ?? null, already: !!o.already, nextDueAt: o.next_due_at ?? null, lastGrantAt: o.last_grant_at ?? null };
}

export async function adminSetForceDue(slug: string, on: boolean): Promise<StampResult> {
  return mapStamp(await call('admin_set_force_due', { p_slug: slug, p_on: on }), 'force_due_at');
}

export async function adminSetReadRequest(slug: string, on: boolean): Promise<StampResult> {
  return mapStamp(await call('admin_set_read_request', { p_slug: slug, p_on: on }), 'read_requested_at');
}

const mapRun = (x: Raw): JobRun => ({
  slug: x.slug, status: x.status, found: num(x.found), new: num(x.new), changed: num(x.changed), errorCode: x.error_code ?? null,
  finishedAt: x.finished_at,
});

export async function adminJobs(limit = 10): Promise<AdminJobs> {
  const p_limit = Math.min(20, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 10)));
  const data = await call('admin_jobs', { p_limit });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DataError('unknown');
  const d = data as Raw;
  return {
    generatedAt: d.generated_at,
    batches: arr<Raw>(d.batches).map((b) => ({
      issuedAt: b.issued_at, grants: num(b.grants), pending: num(b.pending), unused: num(b.unused), runNow: arr<string>(b.run_now),
      runs: arr<Raw>(b.runs).map(mapRun),
    })),
    manual: arr<Raw>(d.manual).map((m) => ({
      issuedAt: m.issued_at, slug: m.slug, requested: !!m.requested, state: m.state, run: m.run && typeof m.run === 'object' ? mapRun(m.run) : null,
    })),
    stamps: arr<Raw>(d.stamps).map((s) => ({
      slug: s.slug, name: s.name, kind: s.kind, requestedAt: s.requested_at ?? null, servedAt: s.served_at ?? null, pending: !!s.pending,
      expired: !!s.expired,
    })),
  };
}

export type DispatchOutcome =
  | { outcome: 'ok' } | { outcome: 'not_configured' } | { outcome: 'unavailable' }
  | { outcome: 'rejected'; reason: 'token_refused' | 'workflow_not_found' | 'ref_rejected' }
  | { outcome: 'unknown'; reason: 'upstream' };

const REJECT_REASONS: readonly string[] = ['token_refused', 'workflow_not_found', 'ref_rejected'];

/** Pure. 401/403 -> throws DataError('forbidden'). A recognized envelope is kept on its own status: 202 ok, 503 not_configured,
 *  502 rejected (known reason) or unknown ('upstream'). Anything else -> unavailable. */
export function dispatchOutcome(status: number, body: unknown): DispatchOutcome {
  if (status === 401 || status === 403) throw new DataError('forbidden');
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Raw) : null;
  if (!o) return { outcome: 'unavailable' };
  if (status === 202 && o.outcome === 'ok') return { outcome: 'ok' };
  if (status === 503 && o.outcome === 'not_configured') return { outcome: 'not_configured' };
  if (status === 502 && o.outcome === 'rejected' && typeof o.reason === 'string' && REJECT_REASONS.includes(o.reason)) {
    return { outcome: 'rejected', reason: o.reason as 'token_refused' | 'workflow_not_found' | 'ref_rejected' };
  }
  if (status === 502 && o.outcome === 'unknown' && o.reason === 'upstream') return { outcome: 'unknown', reason: 'upstream' };
  return { outcome: 'unavailable' };
}

interface FnDeps { fetch?: typeof fetch; jwt?: () => Promise<string | null> }

const defaultJwt = async (): Promise<string | null> => (await getSupabase().auth.getSession()).data.session?.access_token ?? null;
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

async function readJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

export async function adminDispatch(deps: FnDeps = {}): Promise<DispatchOutcome> {
  const jwt = await (deps.jwt ?? defaultJwt)();
  if (!jwt) throw new DataError('forbidden');
  let res: Response;
  try {
    res = await (deps.fetch ?? defaultFetch)('/api/admin/dispatch', {
      method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: '{}',
      cache: 'no-store', credentials: 'same-origin',
    });
  } catch {
    return { outcome: 'unavailable' };
  }
  return dispatchOutcome(res.status, await readJson(res));
}

/** 401/403 -> DataError('forbidden'); 200 + configured === true -> 'configured'; anything else -> 'needs_setup'. */
export async function adminDispatchStatus(deps: FnDeps = {}): Promise<'configured' | 'needs_setup'> {
  const jwt = await (deps.jwt ?? defaultJwt)();
  if (!jwt) throw new DataError('forbidden');
  let res: Response;
  try {
    res = await (deps.fetch ?? defaultFetch)('/api/admin/dispatch-status', {
      method: 'GET', headers: { authorization: `Bearer ${jwt}` }, cache: 'no-store', credentials: 'same-origin',
    });
  } catch {
    return 'needs_setup';
  }
  if (res.status === 401 || res.status === 403) throw new DataError('forbidden');
  if (res.status !== 200) return 'needs_setup';
  const body = await readJson(res);
  return body && typeof body === 'object' && (body as Raw).configured === true ? 'configured' : 'needs_setup';
}
