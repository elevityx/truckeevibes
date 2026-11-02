// "read manual" (Spec_Manual_Sources M1): reads one manual-only source with plain curl and submits it over the linked Supabase CLI.
//   manual-read.ts --list     enabled manual-only slugs, one per line
//   manual-read.ts <slug>     grant (committed) -> curl -> map -> svc_ingest_batch -> svc_cluster_and_publish
//   manual-read.ts --requested <slug>   the same, through the request-bound grant (svc_manual_grant_requested, Sources V2)
//   manual-read.ts --requests [--slugs] pending read requests (Sources V2), or only their slugs, one per line
// Exit: 0 ok, 1 failed (a zero-item non-ok run is recorded), 2 blocked (recorded, source disabled), 3 grant refused or request
// withdrawn (nothing read).
import { mkdtempSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GrantOut } from '../types';
import { curlFetch, ManualBlock, ManualLayout, ManualRefused, manualAdapter, postProcess } from './manual';
import { curlHttp, drain, manualGrant, pendingRequests, recordBlock, sql, submit, SLUG_RE } from './manualDb';
import { formatRequests } from './requests';

export interface ManualReadDeps {
  sql: typeof sql; manualGrant: typeof manualGrant; pendingRequests: typeof pendingRequests;
  curlHttp: typeof curlHttp; submit: typeof submit; recordBlock: typeof recordBlock; drain: typeof drain; log: (line: string) => void;
}
const REAL: ManualReadDeps = { sql, manualGrant, pendingRequests, curlHttp, submit, recordBlock, drain, log: (line) => console.log(line) };

export async function main(argv: string[], deps: ManualReadDeps = REAL): Promise<number> {
  const { sql, manualGrant, pendingRequests, curlHttp, submit, recordBlock, drain } = deps;
  if (argv[0] === '--list') {
    const rows = await sql<{ slug: string }>(`select slug from public.sources where enabled and manual_only order by slug`);
    for (const r of rows) if (SLUG_RE.test(r.slug)) deps.log(r.slug);
    return 0;
  }
  if (argv[0] === '--requests') {
    const rows = await pendingRequests();
    const lines = argv[1] === '--slugs' ? rows.map((r) => r.slug) : formatRequests(rows, Date.now());
    for (const l of lines) deps.log(l);
    return 0;
  }
  const requested = argv[0] === '--requested';
  const slug = (requested ? argv[1] : argv[0]) ?? '';
  const say = (s: string) => deps.log(`manual-read ${slug}: ${s}`);
  if (!SLUG_RE.test(slug) || slug === 'tdrpd-rec1') { say('usage: manual-read.ts <slug> (tdrpd-rec1 uses tdrpd-refresh.sh)'); return 1; }
  const { grant, source, refused } = await manualGrant<GrantOut['source']>(slug, requested ? { requested: true } : {});
  if (refused === 'withdrawn') { say('request withdrawn: skipped (nothing read)'); return 3; }
  if (!grant || !source) { say('grant refused (read in the last 24 h, disabled, or not manual-only): nothing read'); return 3; }
  const startedAt = new Date(Date.now() - 2000).toISOString();
  let adapter;
  try { adapter = manualAdapter(source); } catch { await submit(grant, startedAt, 'parse_error', [], { error_code: 'no_adapter' }, 'manual.1'); say('no manual adapter'); return 1; }
  const version = `${adapter.version}-c5`;
  const dir = mkdtempSync(join(tmpdir(), 'tv-manual-'));
  chmodSync(dir, 0o700);
  const http = curlHttp(dir, false, say);
  const fetch = curlFetch(source, { http: (url) => http({ method: 'GET', url, headers: {} }), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  let res;
  try {
    res = await adapter.fetch({ source, fetch, now: new Date() });
  } catch (e) {
    if (e instanceof ManualBlock) {
      await recordBlock(grant, startedAt, slug, version, e.httpStatus);
      say(`BLOCKED (http ${e.httpStatus}): run recorded as site_block and ${slug} disabled. Do not retry.`);
      return 2;
    }
    const code = e instanceof ManualLayout ? 'layout_changed' : e instanceof ManualRefused && /^[a-z_]{1,40}$/.test(e.message) ? e.message : 'parse_error';
    await submit(grant, startedAt, 'parse_error', [], { error_code: code }, version);
    say(`stopped: ${code} (${e instanceof Error ? e.constructor.name : 'unknown'}); a zero-item non-ok run was recorded`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  say(`fetch status=${res.status} http=${res.httpStatus ?? '-'} requests=${fetch.requests()}`);
  if (res.status !== 'ok') {
    await submit(grant, startedAt, res.status === 'http_error' ? 'http_error' : 'parse_error', [], { error_code: res.errorCode ?? res.status, ...(res.httpStatus ? { http_status: res.httpStatus } : {}) }, version);
    return 1;
  }
  const pp = postProcess(res.items, source);
  if ('error' in pp) {
    await submit(grant, startedAt, 'parse_error', [], { error_code: pp.error }, version);
    say(`stopped: ${pp.error}; a zero-item non-ok run was recorded`);
    return 1;
  }
  const items = pp.items;
  const geo = items.filter((i) => typeof i.lat === 'number').length;
  say(`found=${res.items.length} kept=${items.length} with_coords=${geo} invalid=${pp.invalid} notices=${pp.noticeDropped}/${pp.cancelled} dropped=${JSON.stringify(res.filteredBy ?? {})}`);
  const batch = await submit(grant, startedAt, 'ok', items, { http_status: 200, ...(res.contentHash ? { content_hash: res.contentHash } : {}) }, version);
  say(`batch status=${String(batch.status)} new=${Number(batch.new ?? 0)} changed=${Number(batch.changed ?? 0)} gone=${Number(batch.gone ?? 0)} invalid=${Number(batch.invalid ?? 0)}`);
  await drain(say);
  return 0;
}

const entry = process.argv[1];
if (entry) {
  let self = false;
  try { self = import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { self = false; }
  if (self) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.log(`manual-read: error ${e instanceof Error ? e.constructor.name : 'unknown'}`); process.exit(1); });
}
