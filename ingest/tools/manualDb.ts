// Shared database and curl helpers for the manual (owner-invoked) readers: Spec_Kids_Live K3 (TDRPD) and Spec_Manual_Sources (M1).
// Everything goes over the conductor's linked Supabase CLI login (`supabase db query --linked -f <tempfile>`); no HMAC key, no secret.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SUPABASE = process.env.SUPABASE_BIN || join(homedir(), '.local', 'bin', 'supabase');

export async function sql<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const dir = mkdtempSync(join(tmpdir(), 'tv-manual-sql-'));
  chmodSync(dir, 0o700);
  const f = join(dir, 'q.sql');
  writeFileSync(f, text, { mode: 0o600 });
  try {
    const { stdout } = await run(SUPABASE, ['db', 'query', '--linked', '--output-format', 'json', '-f', f], { maxBuffer: 16 * 1024 * 1024 });
    return (JSON.parse(stdout) as { rows?: T[] }).rows ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dollar-quotes a payload with a random tag that cannot occur in it. */
export function lit(s: string): string {
  let tag = '';
  do tag = `tv_${randomBytes(6).toString('hex')}`; while (s.includes(tag));
  return `$${tag}$${s}$${tag}$`;
}

export const SLUG_RE = /^[a-z0-9-]{2,60}$/;

export interface CurlReq { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; form?: Record<string, string> }
/** Plain curl with curl's own default user agent (owner decision): -q (no curlrc), https only, no -L, no retry, 30 s (TDRPD 60 s), 5 MB. */
export function curlArgs(req: CurlReq, out: string, jar?: string, maxTime = 30): string[] {
  const args = ['-q', '-sS', '--max-time', String(maxTime), '--max-filesize', '5000000', '--proto', '=https', '-o', out, '-w', '%{http_code}'];
  if (jar) args.push('-b', join(jar, 'cookies'), '-c', join(jar, 'cookies'));
  for (const [k, v] of Object.entries(req.headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(k) || /[\r\n]/.test(v)) throw new Error('bad_header');
    args.push('-H', `${k}: ${v}`);
  }
  if (req.method === 'POST') for (const [k, v] of Object.entries(req.form ?? {})) args.push('--data-urlencode', `${k}=${v}`);
  args.push(req.url);
  return args;
}

/** `log` gets one line per curl error (the exit code only: no URL, V11). */
export function curlHttp(dir: string, useJar: boolean, log: (s: string) => void = () => {}, maxTime = 30) {
  return async (req: CurlReq): Promise<{ status: number; body: string }> => {
    const out = join(dir, 'body');
    // On a curl error (timeout, size cap) keep the HTTP status and the partial body, so a 403/429 still trips the kill switch.
    let code = '';
    try { code = (await run('curl', curlArgs(req, out, useJar ? dir : undefined, maxTime), { maxBuffer: 1024 * 1024 })).stdout; } catch (e) {
      code = String((e as { stdout?: unknown }).stdout ?? '');
      log(`curl exit ${String((e as { code?: unknown }).code ?? '?')}`);
    }
    let body = '';
    try { body = readFileSync(out, 'utf8').slice(0, 5_000_000); } catch { body = ''; }
    rmSync(out, { force: true });
    const status = /^\d{3}$/.test(code.trim()) ? Number(code.trim()) : 0;
    return { status, body };
  };
}

/**
 * One committed grant for one due manual-only source. `refused` only for the database's own `manual_grant_refused` (read in the last
 * 24 h, not permitted, disabled); any other CLI or database error throws (M1 review P0-1: an unlinked CLI must never look like a skip).
 */
export async function manualGrant<S = Record<string, unknown>>(slug: string): Promise<{ grant: string; source?: S; refused?: boolean }> {
  if (!SLUG_RE.test(slug)) return { grant: '', refused: true };
  let rows;
  try {
    rows = await sql<{ g: { grant?: string; source?: S } }>(`select public.svc_manual_grant('${slug}') as g`);
  } catch (e) {
    const msg = `${String((e as { stderr?: unknown }).stderr ?? '')} ${String((e as { stdout?: unknown }).stdout ?? '')} ${e instanceof Error ? e.message : ''}`;
    if (/manual_grant_refused/.test(msg)) return { grant: '', refused: true };
    throw new Error('grant_call_failed');
  }
  const g = rows[0]?.g;
  const grant = typeof g?.grant === 'string' && /^[0-9a-f]{64}$/.test(g.grant) ? g.grant : '';
  if (!grant) throw new Error('grant_shape');
  return { grant, source: g?.source };
}

export async function submit(grant: string, startedAt: string, status: string, items: unknown[], extra: Record<string, unknown>, parserVersion: string, then = ''): Promise<Record<string, unknown>> {
  const runMeta = { status, started_at: startedAt, parser_version: parserVersion, ...extra };
  const rows = await sql<{ batch: Record<string, unknown> }>(
    `select public.svc_ingest_batch(${lit(grant)}, ${lit(JSON.stringify(runMeta))}::jsonb, ${lit(JSON.stringify(items))}::jsonb) as batch;${then}`);
  return rows[0]?.batch ?? {};
}

/** Records a block through the grant, then disables the manual-only row (record first: the batch rechecks permission). */
export async function recordBlock(grant: string, startedAt: string, slug: string, parserVersion: string, httpStatus?: number): Promise<void> {
  if (!SLUG_RE.test(slug)) throw new Error('slug');
  const disable = `update public.sources set enabled = false where slug = '${slug}' and manual_only;`;
  const status = httpStatus && httpStatus >= 100 && httpStatus <= 599 ? { http_status: httpStatus } : {};
  try {
    await submit(grant, startedAt, 'http_error', [], { error_code: 'site_block', ...status }, parserVersion, `\n${disable}`);
  } catch (e) {
    await sql(disable); // PR review P1-1: the kill switch holds even when the run record fails (expired grant, clock skew)
    throw e;
  }
}

export async function drain(log: (s: string) => void): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const [pub] = await sql<{ r: { processed?: number; remaining?: number } }>('select public.svc_cluster_and_publish(500) as r');
    log(`cluster_and_publish processed=${Number(pub?.r?.processed ?? 0)} remaining=${Number(pub?.r?.remaining ?? 0)}`);
    if (!pub?.r?.remaining) break;
  }
}
