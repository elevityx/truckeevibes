// I3 classify-report: runs the real adapters, the notice rule and the classifier over live feeds and prints what it would tag.
// It requests no grant, calls no ingest endpoint and submits nothing. It refuses any source the runner could not fetch (V4).
// Titles may appear in the output: it goes to the vault, never to CI logs.
//   npm run classify-report -- --sources <path to a JSON array exported from `sources`>
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { adapters } from '../adapters/index';
import { classifyObserver } from '../adapters/common';
import { createPoliteFetch, FetchError } from '../core/politeFetch';
import { createSpacer } from '../core/rateLimit';
import { validateSourceEvent } from '../core/normalize';
import { applyNotices } from '../core/notices';
import { applySourceDefaults } from '../run';
import type { Adapter, AdapterResult, GrantOut, SourceEvent } from '../types';

export interface ReportRow {
  slug: string; family: string; config: Record<string, unknown>; allowed_hosts: string[]; allowed_methods: string[];
  page_cap: number; ingest_disposition: string; terms_recheck_at: string | null; enabled: boolean;
  manual_only?: boolean; automation_restricted?: boolean;
}
export interface ReportDeps {
  /** Test seam: replaces the adapter registry. */
  adapters?: Record<string, Adapter>;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const OK_DISPOSITIONS = new Set(['permitted', 'official_api_only']);

/** Slugs of rows the runner would not fetch: disabled, manual-only or restricted (M1), wrong disposition, or terms re-check missing or in the past. */
export function refusedRows(rows: ReportRow[], now: Date): string[] {
  return rows
    .filter((r) => r.enabled !== true || r.manual_only === true || r.automation_restricted === true || !OK_DISPOSITIONS.has(r.ingest_disposition) || !r.terms_recheck_at || !(Date.parse(r.terms_recheck_at) > now.getTime()))
    .map((r) => String(r.slug));
}

const counts = (m: Record<string, number>) => Object.keys(m).sort().map((k) => `${k}:${m[k]}`).join(',');

export async function runReport(rows: ReportRow[], deps: ReportDeps): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) { deps.err('classify-report: the sources file has no rows'); return 1; }
  const refused = refusedRows(rows, deps.now());
  if (refused.length > 0) { deps.err(`classify-report: refusing, not enabled with a permitted disposition and a future terms_recheck_at, or manual-only: ${refused.join(', ')}`); return 1; }
  const spacer = createSpacer({ now: () => deps.now().getTime(), sleep: deps.sleep });
  for (const row of rows) {
    const adapter = (deps.adapters ?? adapters)[row.family];
    if (!adapter) { deps.out(`source=${row.slug} status=skipped code=no_adapter`); continue; }
    const source: GrantOut['source'] = {
      slug: row.slug, family: row.family, config: row.config ?? {}, allowed_hosts: row.allowed_hosts, allowed_methods: row.allowed_methods, page_cap: row.page_cap,
      etag: null, last_modified: null, content_hash: null, ingest_disposition: row.ingest_disposition, terms_recheck_at: row.terms_recheck_at,
    };
    const unmapped: Record<string, number> = {};
    classifyObserver.current = (e) => { for (const u of e.unmapped) unmapped[u] = (unmapped[u] ?? 0) + 1; };
    let result: AdapterResult;
    try {
      const pf = createPoliteFetch(source, { fetch: deps.fetch, now: () => deps.now().getTime(), sleep: deps.sleep, spacer });
      result = await adapter.fetch({ source, fetch: pf, now: deps.now() });
    } catch (e) {
      deps.out(`source=${row.slug} status=error code=${e instanceof FetchError ? e.code : 'parse'}`);
      continue;
    } finally {
      classifyObserver.current = undefined;
    }
    if (result.status !== 'ok') { deps.out(`source=${row.slug} status=${result.status}`); continue; }
    const valid: SourceEvent[] = [];
    for (const it of result.items) { const v = validateSourceEvent(it); if (!('invalid' in v)) valid.push(v); }
    const noticed = applyNotices(valid);
    const kept = noticed.items.map((i) => applySourceDefaults(i, source.config));
    const keptKeys = new Set(kept.map((i) => i.externalKey));
    const tags: Record<string, number> = {};
    const priceReasons: Record<string, number> = {};
    let free = 0; let ambiguous = 0; let conflicts = 0; let kidsAdult = 0; let wordlistOnly = 0;
    for (const i of kept) {
      for (const c of new Set(i.categoriesHint)) tags[c] = (tags[c] ?? 0) + 1;
      if (i.priceKind === 'free') free++;
      const r = i.tagReasons ?? [];
      for (const c of r) if (c.startsWith('price:')) priceReasons[c] = (priceReasons[c] ?? 0) + 1;
      if (r.includes('age:ambiguous')) ambiguous++;
      if (r.some((c) => c.startsWith('conflict:'))) conflicts++;
      const adultish = r.some((c) => c.startsWith('conflict:') || c === 'age:ambiguous' || c === 'age:21_admission' || c === 'age:18_admission' || c === 'age:adult_phrase');
      // the fingerprint the final invariant leaves when it strips a kids/family positive on the word list alone
      if (r.includes('conflict:adult_signal') && r.includes('age:ambiguous') && !r.includes('conflict:adult')) wordlistOnly++;
      if (adultish && (i.categoriesHint.includes('kids') || i.categoriesHint.includes('family'))) kidsAdult++;
    }
    deps.out(`source=${row.slug} status=ok found=${valid.length} kept=${kept.length}`);
    deps.out(`  tags: ${counts(tags) || 'none'}`);
    deps.out(`  free: ${free}`);
    deps.out(`  price_reasons: ${counts(priceReasons) || 'none'}`);
    deps.out(`  age_ambiguous: ${ambiguous}`);
    deps.out(`  conflicts: ${conflicts}`);
    deps.out(`  kids_family_with_adult_code: ${kidsAdult}`);
    deps.out(`  kids_family_wordlist_only: ${wordlistOnly}`);
    deps.out(`  notices: ${noticed.dropped}/${noticed.cancelled}`);
    deps.out(`  unmapped: ${counts(unmapped) || 'none'}`);
    for (const i of valid) if (!keptKeys.has(i.externalKey)) deps.out(`  notice-dropped ${i.externalKey} ${i.title}`);
    for (const i of kept) deps.out(`  event ${i.externalKey} cats=${[...i.categoriesHint].sort().join(',') || '-'} age=${i.age ?? 'unknown'} price=${i.priceKind ?? 'unknown'} ${(i.tagReasons ?? []).join(',') || '-'}${i.cancelled ? ' cancelled' : ''}`);
  }
  return 0;
}

const entry = process.argv[1];
if (entry) {
  let self = false;
  try { self = import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { self = false; }
  if (self) {
    const i = process.argv.indexOf('--sources');
    const path = i >= 0 ? process.argv[i + 1] : undefined;
    if (!path) { console.error('usage: classify-report --sources <path>'); process.exit(1); }
    let rows: ReportRow[];
    try { rows = JSON.parse(readFileSync(path, 'utf8')); } catch { console.error('classify-report: cannot read the sources file'); process.exit(1); }
    runReport(rows, {
      fetch: globalThis.fetch, now: () => new Date(), sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      out: (l) => console.log(l), err: (l) => console.error(l),
    }).then((code) => process.exit(code), () => process.exit(1));
  }
}
