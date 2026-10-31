// "read tdrpd" (Spec_Kids_Live Amendment K3): reads the TDRPD Rec1 catalog with plain curl, maps youth programs, and submits them
// through svc_manual_grant -> svc_ingest_batch -> svc_cluster_and_publish over the conductor's linked Supabase CLI login.
// Run by the conductor only when the owner asks. Never scheduled: the source is manual_only, so the cron path never grants it.
//
//   scripts/tdrpd-refresh.sh              read, map, submit
//   scripts/tdrpd-refresh.sh --from DIR   re-map a saved failed read: map only, no grant, no database write
// Exit: 0 ok, 1 failed, 2 blocked (recorded, source disabled), 3 grant refused (nothing read; `manual-read.sh all` skips it).
//
// Needs: curl, the Supabase CLI linked to the project (run from the repo root; env SUPABASE_BIN overrides ~/.local/bin/supabase).
// Prints counts and codes only. Raw JSON is kept under ~/.truckeevibes/tdrpd/<stamp>/ (mode 700, outside the repo) only when a read
// fails, for the mapper fix; it never enters the database (V6).
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNotices } from '../core/notices';
import { collect, mapSessions, Rec1Fail, runRead, type JsonSource, type MapOut, type Rec1Config } from './rec1';
import { curlHttp, drain, manualGrant, recordBlock, sql, submit as submitBatch } from './manualDb';

const SLUG = 'tdrpd-rec1';
const PARSER = 'rec1_catalog.2-c5';
const log = (s: string) => console.log(`tdrpd-refresh: ${s}`);
const submit = (grant: string, startedAt: string, status: string, items: unknown[], extra: Record<string, unknown>) =>
  submitBatch(grant, startedAt, status, items, extra, PARSER);

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
  // A refusal exits 3 (manual-read.sh all counts it as skipped); any other CLI or database error throws and exits 1 (M1 review P0-1).
  const { grant } = await manualGrant(SLUG);
  if (!grant) { log('grant refused (already read in the last 24 h, or the source is not permitted): nothing read'); return 3; }
  const startedAt = new Date(Date.now() - 2000).toISOString();

  const jar = mkdtempSync(join(tmpdir(), 'tv-tdrpd-'));
  chmodSync(jar, 0o700);
  let r;
  try {
    r = await runRead(cfg, { http: curlHttp(jar, true, log, 60), now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) });
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
    await recordBlock(grant, startedAt, SLUG, PARSER, r.httpStatus);
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
  await drain(log); // review r2-9
  return 0;
}

function report(m: MapOut) {
  const noticed = applyNotices(m.items);
  const kids = noticed.items.filter((i) => i.categoriesHint.includes('kids')).length;
  log(`sessions=${m.found} kept=${noticed.items.length} kids=${kids} dropped=${JSON.stringify(m.dropped)}`);
  return noticed.items;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { log(`error ${e instanceof Error ? e.constructor.name : 'unknown'}`); process.exit(1); });
