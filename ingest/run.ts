// Ingest runner (spec S1.8 run.ts). Holds no database key: only INGEST_HMAC_KEY and the deploy-hook URL.
// Logs one line per source with counts and status only: never titles, URLs, query strings, tokens or keys.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { adapters as defaultAdapters } from './adapters/index';
import { callIngest, IngestHttpError } from './core/hmacClient';
import { createPoliteFetch, FetchError, spacingKey } from './core/politeFetch';
import { createSpacer } from './core/rateLimit';
import { validateSourceEvent } from './core/normalize';
import { applyNotices } from './core/notices';
import { OUR_SLUGS } from './core/categoryMaps';
import { capReasons } from './core/reasonCodes';
import type { Adapter, AdapterResult, GrantOut, RunMeta, RunStatus, SourceEvent } from './types';

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  adapters?: Record<string, Adapter>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const CONCURRENCY = 3;
const MAX_ITEMS = 1000;
const MAX_BODY_BYTES = 2_097_152;
const SKEW_ALLOWANCE_MS = 2000; // the database refuses a started_at in its future

const safeCode = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : 'unknown');
const classNameOf = (e: unknown) => { const n = e instanceof Error ? e.constructor.name : ''; return /^[A-Za-z0-9_]{1,60}$/.test(n) ? n : 'Error'; };

interface Outcome { status: RunStatus; items: SourceEvent[]; result: Partial<AdapterResult>; errorCode?: string; errorDetail?: string; invalid: number; dropped?: number; cancelled?: number }

const KNOWN_SLUGS: ReadonlySet<string> = new Set(OUR_SLUGS);
const ADULT_REASON = /^(?:age:21_admission|age:18_admission|age:adult_phrase|age:ambiguous|conflict:.*)$/;

/** DR12: `config.defaultCategories` fills an item with no category, never adding kids/family to an adult or ambiguous item. */
export function applySourceDefaults(item: SourceEvent, config: Record<string, unknown>): SourceEvent {
  const d = config.defaultCategories;
  if (item.categoriesHint.length > 0 || !Array.isArray(d)) return item;
  const adult = (item.tagReasons ?? []).some((c) => ADULT_REASON.test(c));
  const slugs = [...new Set(d.filter((x): x is string => typeof x === 'string' && KNOWN_SLUGS.has(x)))].filter((x) => !(adult && (x === 'kids' || x === 'family')));
  if (slugs.length === 0) return item;
  return { ...item, categoriesHint: slugs, tagReasons: capReasons([...(item.tagReasons ?? []), 'cat:default']) };
}

/** A13: `members-only` is a Tahoe Donner label set only by that adapter; every other source family loses it before submit. */
export function stripMembersOnly(item: SourceEvent, family: string): SourceEvent {
  if (family === 'html_tahoedonner' || !item.categoriesHint.includes('members-only')) return item;
  return { ...item, categoriesHint: item.categoriesHint.filter((c) => c !== 'members-only') };
}

/** ` tags=<slug>:<n>,… free:<n> age_ambiguous=<n> conflicts=<n> notices=<dropped>/<cancelled>`: counts only (V11). */
function tagStats(o: Pick<Outcome, 'items' | 'dropped' | 'cancelled'>): string {
  const by: Record<string, number> = {};
  let free = 0;
  let ambiguous = 0;
  let conflicts = 0;
  for (const i of o.items) {
    for (const c of new Set(i.categoriesHint)) by[c] = (by[c] ?? 0) + 1;
    if (i.priceKind === 'free') free++;
    const r = i.tagReasons ?? [];
    if (r.includes('age:ambiguous')) ambiguous++;
    if (r.some((c) => c.startsWith('conflict:'))) conflicts++;
  }
  const parts = Object.keys(by).sort().map((k) => `${k}:${by[k]}`);
  if (free > 0) parts.push(`free:${free}`);
  return `tags=${parts.length ? parts.join(',') : 'none'} age_ambiguous=${ambiguous} conflicts=${conflicts} notices=${o.dropped ?? 0}/${o.cancelled ?? 0}`;
}

export async function main(deps: RunDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const doFetch = deps.fetch ?? globalThis.fetch;
  const registry = deps.adapters ?? defaultAdapters;
  const nowDate = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = deps.env.INGEST_URL;
  const key = deps.env.INGEST_HMAC_KEY;
  const hook = deps.env.PAGES_DEPLOY_HOOK_URL;
  if (!url || !key) { log('ingest: INGEST_URL and INGEST_HMAC_KEY are required'); return 1; }
  const client = { url, key, fetch: doFetch, now: () => nowDate().getTime() };

  let grants: GrantOut[];
  try {
    const r = await callIngest<{ grants?: GrantOut[] }>('due_sources', {}, client);
    grants = Array.isArray(r.grants) ? r.grants : [];
  } catch (e) {
    log(`ingest: due_sources failed code=${e instanceof IngestHttpError ? safeCode(e.code) : 'unknown'}`);
    return 1;
  }
  log(`ingest: ${grants.length} source(s) due`);

  let fatal = false;
  const nowMs = () => nowDate().getTime();
  const spacer = createSpacer({ now: nowMs, sleep }); // one per run, shared across sources

  async function runOne(g: GrantOut): Promise<void> {
    const slug = g.source.slug;
    const startedMs = nowDate().getTime();
    const o = await produce(g);
    const run: RunMeta = {
      status: o.status,
      started_at: new Date(startedMs - SKEW_ALLOWANCE_MS).toISOString(),
      duration_ms: Math.max(0, nowDate().getTime() - startedMs),
    };
    const r = o.result;
    if (r.httpStatus !== undefined) run.http_status = r.httpStatus;
    if (r.etag) run.etag = r.etag;
    if (r.lastModified) run.last_modified = r.lastModified;
    if (r.contentHash) run.content_hash = r.contentHash;
    const adapter = registry[g.source.family];
    if (adapter) run.parser_version = `${adapter.version}-c2`;
    const code = o.errorCode ?? r.errorCode;
    if (code) run.error_code = code;
    if (o.errorDetail) run.error_detail = o.errorDetail;
    if (r.robots) run.robots = { hash: r.robots.hash, ai_bots_blocked: r.robots.aiBotsBlocked };

    let items = o.items;
    let body = JSON.stringify({ op: 'submit_batch', grant: g.grant, run, items });
    if (items.length > 0 && Buffer.byteLength(body) > MAX_BODY_BYTES) {
      items = [];
      run.status = 'parse_error';
      run.error_code = 'too_large';
      o.status = 'parse_error';
      body = '';
    }
    let line = `source=${slug} status=${run.status} found=${items.length} `;
    try {
      const out = await callIngest<{ new?: number; changed?: number }>('submit_batch', { grant: g.grant, run, items }, client);
      line += `new=${Number(out.new ?? 0)} changed=${Number(out.changed ?? 0)} invalid=${o.invalid}`;
      if (r.filtered !== undefined) line += ` filtered=${r.filtered}`;
      log(`${line} ${tagStats({ items, dropped: o.dropped, cancelled: o.cancelled })}`);
    } catch (e) {
      const status = e instanceof IngestHttpError ? e.status : 0;
      const c = e instanceof IngestHttpError ? safeCode(e.code) : 'unknown';
      log(`${line}new=0 changed=0 invalid=${o.invalid} ${tagStats({ items, dropped: o.dropped, cancelled: o.cancelled })} submit_failed status=${status} code=${c}`);
      if (status === 401) fatal = true; // HMAC rejected: infrastructure, not this source
    }
  }

  async function produce(g: GrantOut): Promise<Outcome> {
    const empty = (status: RunStatus, errorCode?: string, errorDetail?: string, result: Partial<AdapterResult> = {}): Outcome =>
      ({ status, items: [], result, errorCode, errorDetail, invalid: 0 });
    const adapter = registry[g.source.family];
    if (!adapter) return empty('skipped', 'no_adapter');
    const pf = createPoliteFetch(g.source, { fetch: doFetch, now: nowMs, sleep, spacer });
    let result: AdapterResult;
    try {
      result = await adapter.fetch({ source: g.source, fetch: pf, now: nowDate() });
    } catch (e) {
      if (e instanceof FetchError) {
        if (e.code === 'robots_blocked') return empty('robots_blocked', undefined, undefined, robotsOf(g, pf));
        const transport = e.code === 'timeout' || e.code === 'network' || e.code === 'too_large';
        return empty(transport ? 'http_error' : 'skipped', e.code, undefined, robotsOf(g, pf));
      }
      return empty('parse_error', 'parse', classNameOf(e), robotsOf(g, pf));
    }
    const robots = result.robots ?? robotsOf(g, pf).robots;
    const base: Partial<AdapterResult> = { ...result, robots, items: [] };
    if (result.status !== 'ok') return { status: result.status, items: [], result: base, invalid: 0 };
    if (result.items.length > MAX_ITEMS) return { status: 'parse_error', items: [], result: base, errorCode: 'too_many_items', invalid: 0 };
    const valid: SourceEvent[] = [];
    let invalid = 0;
    for (const it of result.items) {
      const v = validateSourceEvent(it);
      if ('invalid' in v) invalid++;
      else valid.push(v);
    }
    const noticed = applyNotices(valid);
    const items = noticed.items.map((i) => applySourceDefaults(stripMembersOnly(i, g.source.family), g.source.config));
    return { status: 'ok', items, result: base, invalid, dropped: noticed.dropped, cancelled: noticed.cancelled };
  }

  // 3 sources at a time, never two on the same host
  const pending = [...grants];
  const activeHosts = new Set<string>();
  const hostOf = (g: GrantOut) => spacingKey(g.source.allowed_hosts[0] ?? g.source.slug); // a host family (TTUSD) counts as one host
  await new Promise<void>((resolve) => {
    let running = 0;
    const pump = () => {
      while (!fatal && running < CONCURRENCY) {
        const i = pending.findIndex((g) => !activeHosts.has(hostOf(g)));
        if (i < 0) break;
        const [g] = pending.splice(i, 1);
        const h = hostOf(g);
        activeHosts.add(h);
        running++;
        runOne(g)
          .catch((e) => log(`source=${g.source.slug} status=error code=${classNameOf(e)}`))
          .finally(() => { activeHosts.delete(h); running--; pump(); });
      }
      if (running === 0 && (pending.length === 0 || fatal)) resolve();
    };
    pump();
  });
  if (fatal) { log('ingest: HMAC rejected by the ingest function'); return 1; }

  let finished: { public_changed?: boolean; processed?: number; remaining?: number };
  try {
    finished = await callIngest('finish', {}, client);
  } catch (e) {
    log(`ingest: finish failed code=${e instanceof IngestHttpError ? safeCode(e.code) : 'unknown'}`);
    return 1;
  }
  log(`ingest: finish processed=${Number(finished.processed ?? 0)} remaining=${Number(finished.remaining ?? 0)} public_changed=${finished.public_changed === true}`);

  if (finished.public_changed === true && hook) {
    try {
      const res = await doFetch(hook, { method: 'POST', signal: AbortSignal.timeout(10_000) });
      log(`ingest: deploy hook status=${res.status}`);
    } catch {
      log('ingest: deploy hook failed');
    }
  }
  return 0;
}

function robotsOf(g: GrantOut, pf: ReturnType<typeof createPoliteFetch>): Partial<AdapterResult> {
  for (const h of g.source.allowed_hosts) {
    const info = pf.robotsInfo(h);
    if (info) return { robots: info };
  }
  return {};
}

const entry = process.argv[1];
if (entry) {
  let self = false;
  try { self = import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { self = false; }
  if (self) main({ env: process.env }).then((code) => process.exit(code), () => process.exit(1));
}
