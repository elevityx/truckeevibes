// "read tdrpd" (Spec_Kids_Live Amendment K3): reads the TDRPD Rec1 catalog with plain curl, maps youth programs, and submits them
// through svc_manual_grant -> svc_ingest_batch -> svc_cluster_and_publish over the conductor's linked Supabase CLI login.
// Run by the conductor only when the owner asks. Never scheduled: the source is manual_only, so the cron path never grants it.
//
//   scripts/tdrpd-refresh.sh              read, map, submit
//   scripts/tdrpd-refresh.sh --from DIR   re-map a saved failed read: map only, no grant, no database write
//
// Needs: curl, the Supabase CLI linked to the project (run from the repo root; env SUPABASE_BIN overrides ~/.local/bin/supabase).
// Prints counts and codes only. Raw JSON is kept under ~/.truckeevibes/tdrpd/<stamp>/ (mode 700, outside the repo) only when a read
// fails, for the mapper fix; it never enters the database (V6).
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyNotices } from '../core/notices';
import { collect, mapSessions, Rec1Fail, runRead, type HttpReq, type JsonSource, type MapOut, type Rec1Config } from './rec1';

const run = promisify(execFile);
const SLUG = 'tdrpd-rec1';
const SUPABASE = process.env.SUPABASE_BIN || join(homedir(), '.local', 'bin', 'supabase');
const log = (s: string) => console.log(`tdrpd-refresh: ${s}`);

async function sql<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const dir = mkdtempSync(join(tmpdir(), 'tv-tdrpd-sql-'));
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
function lit(s: string): string {
  let tag = '';
  do tag = `tv_${randomBytes(6).toString('hex')}`; while (s.includes(tag));
  return `$${tag}$${s}$${tag}$`;
}

function curlHttp(jar: string) {
  return async (req: HttpReq): Promise<{ status: number; body: string }> => {
    const out = join(jar, 'body');
    // -q: ignore any ~/.curlrc; no -L (a redirect is an http_error); no retries; curl's own default user agent (owner decision).
    const args = ['-q', '-sS', '--max-time', '30', '--max-filesize', '5000000', '--proto', '=https', '-b', join(jar, 'cookies'), '-c', join(jar, 'cookies'), '-o', out, '-w', '%{http_code}'];
    for (const [k, v] of Object.entries(req.headers)) args.push('-H', `${k}: ${v}`);
    if (req.method === 'POST') for (const [k, v] of Object.entries(req.form ?? {})) args.push('--data-urlencode', `${k}=${v}`);
    args.push(req.url);
    // Review: on a curl error (timeout, size cap) keep the HTTP status and the partial body, so a 403/429 still trips the kill switch.
    let code = '';
    try { code = (await run('curl', args, { maxBuffer: 1024 * 1024 })).stdout; } catch (e) { code = String((e as { stdout?: unknown }).stdout ?? ''); }
    let body = '';
    try { body = readFileSync(out, 'utf8').slice(0, 5_000_000); } catch { body = ''; }
    rmSync(out, { force: true });
    const status = /^\d{3}$/.test(code.trim()) ? Number(code.trim()) : 0;
    return { status, body };
  };
}

async function submit(grant: string, startedAt: string, status: string, items: unknown[], extra: Record<string, unknown>, then = ''): Promise<Record<string, unknown>> {
  const runMeta = { status, started_at: startedAt, parser_version: 'rec1_catalog.2-c5', ...extra };
  const rows = await sql<{ batch: Record<string, unknown> }>(
    `select public.svc_ingest_batch(${lit(grant)}, ${lit(JSON.stringify(runMeta))}::jsonb, ${lit(JSON.stringify(items))}::jsonb) as batch;${then}`);
  return rows[0]?.batch ?? {};
}

async function main(argv: string[]): Promise<number> {
  const fromIdx = argv.indexOf('--from');
  const from = fromIdx >= 0 ? argv[fromIdx + 1] : undefined;

  const [src] = await sql<{ config: Rec1Config; ok: boolean }>(`select config, (enabled and manual_only) as ok from public.sources where slug = '${SLUG}'`);
  if (!src) { log('source not found'); return 1; }
  const cfg = src.config;

  if (from) { // map only: no grant, no write (review r2-5)
    // K3.1 (DR-K3.1-6): the same parser over the saved answers; K3's items-<tab>.json names still read.
    const have = new Set(readdirSync(from));
    const file = (...names: string[]) => {
      const n = names.find((x) => have.has(x));
      if (!n) throw new Rec1Fail('layout_changed');
      return Promise.resolve(readFileSync(join(from, n), 'utf8'));
    };
    const src: JsonSource = {
      left: () => Number.MAX_SAFE_INTEGER,
      tabs: () => file('tabs.json'),
      tab: (t, p) => (p === 1 ? file(`tab-${t}.json`, `items-${t}.json`) : file(`tab-${t}-p${p}.json`, `items-${t}-p${p}.json`)),
      group: (t, g, p) => file(`group-${t}-${g}-p${p}.json`),
    };
    let c;
    try { c = await collect(src); } catch (e) { if (e instanceof Rec1Fail) { log(`replay ${e.code}`); return 1; } throw e; }
    log(`replay status=${c.status} notes=${JSON.stringify(c.notes)}`);
    if (c.status !== 'ok') return 1;
    report(mapSessions(c.sessions, cfg, new Date()));
    return 0;
  }
  if (!src.ok) { log('source is disabled or not manual_only: nothing read'); return 1; }

  // Review r2-3: the grant is issued and committed before the first request; a refusal (read in the last 24 h, terms, disabled) reads nothing.
  // There is no network dry run (review): every read holds a committed grant.
  let grant = '';
  try {
    const [g] = await sql<{ g: string }>(`select public.svc_manual_grant('${SLUG}') ->> 'grant' as g`);
    grant = g?.g ?? '';
  } catch { grant = ''; }
  if (!/^[0-9a-f]{64}$/.test(grant)) { log('grant refused (already read in the last 24 h, or the source is not permitted): nothing read'); return 1; }
  const startedAt = new Date(Date.now() - 2000).toISOString();

  const jar = mkdtempSync(join(tmpdir(), 'tv-tdrpd-'));
  chmodSync(jar, 0o700);
  let r;
  try {
    r = await runRead(cfg, { http: curlHttp(jar), now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
  } finally {
    rmSync(jar, { recursive: true, force: true }); // the per-run cookie jar never outlives the run
  }
  log(`read status=${r.status} requests=${r.requests} http=${r.httpStatus ?? '-'} notes=${JSON.stringify(r.notes ?? {})}`);
  const keepRaw = () => {
    const dir = join(homedir(), '.truckeevibes', 'tdrpd', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [n, b] of Object.entries(r.raw ?? {})) writeFileSync(join(dir, n), b, { mode: 0o600 });
    log(`raw kept for the mapper fix: ${dir}`);
  };

  if (r.status === 'site_block') {
    await submit(grant, startedAt, 'http_error', [], { error_code: 'site_block', ...(r.httpStatus ? { http_status: r.httpStatus } : {}) },
      `\nupdate public.sources set enabled = false where slug = '${SLUG}' and manual_only;`);
    log('BLOCKED: run recorded as site_block and tdrpd-rec1 disabled. Do not retry.');
    return 2;
  }
  let mapped: MapOut | undefined;
  let failCode = r.status === 'ok' ? '' : r.status;
  if (!failCode) {
    try { mapped = mapSessions(r.sessions, cfg, new Date()); } catch (e) { if (e instanceof Rec1Fail) failCode = e.code; else throw e; }
  }
  if (!mapped) {
    keepRaw();
    await submit(grant, startedAt, failCode === 'http_error' ? 'http_error' : 'parse_error', [], { error_code: failCode, ...(r.httpStatus ? { http_status: r.httpStatus } : {}) });
    log(`stopped: ${failCode}; a zero-item non-ok run was recorded (nothing marked missing)`);
    return 1;
  }
  const items = report(mapped);

  const contentHash = createHash('sha256').update(Object.values(r.raw ?? {}).join('\n')).digest('hex');
  const batch = await submit(grant, startedAt, 'ok', items, { http_status: 200, content_hash: contentHash });
  log(`batch status=${String(batch.status)} new=${Number(batch.new ?? 0)} changed=${Number(batch.changed ?? 0)} gone=${Number(batch.gone ?? 0)} invalid=${Number(batch.invalid ?? 0)}`);
  for (let i = 0; i < 10; i++) { // drain clustering (review r2-9)
    const [pub] = await sql<{ r: { processed?: number; remaining?: number } }>('select public.svc_cluster_and_publish(500) as r');
    log(`cluster_and_publish processed=${Number(pub?.r?.processed ?? 0)} remaining=${Number(pub?.r?.remaining ?? 0)}`);
    if (!pub?.r?.remaining) break;
  }
  return 0;
}

function report(m: MapOut) {
  const noticed = applyNotices(m.items);
  const kids = noticed.items.filter((i) => i.categoriesHint.includes('kids')).length;
  log(`sessions=${m.found} kept=${noticed.items.length} kids=${kids} dropped=${JSON.stringify(m.dropped)}`);
  return noticed.items;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { log(`error ${e instanceof Error ? e.constructor.name : 'unknown'}`); process.exit(1); });
