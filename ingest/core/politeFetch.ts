// The only way ingest code reaches the network (spec S1.8 politeFetch, with A2 crawl-delay and A3 per-hop checks).
import { createHash } from 'node:crypto';
import robotsParser from 'robots-parser';
import { createSpacer, type Spacer } from './rateLimit';

export const USER_AGENT = 'TruckeeVibesBot/1.0 (+https://truckeevibes.com/bot/)';
const ROBOTS_TOKEN = 'TruckeeVibesBot';
const MAX_HOPS = 5;
const MAX_BODY = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_CRAWL_DELAY_S = 30;

export type FetchErrorCode =
  | 'terms_gate' | 'method_gate' | 'host_not_allowed' | 'robots_blocked' | 'page_cap' | 'crawl_delay'
  | 'redirect_blocked' | 'timeout' | 'too_large' | 'network' | 'path_not_allowed';

export class FetchError extends Error {
  constructor(readonly code: FetchErrorCode) {
    super(code);
    this.name = 'FetchError';
  }
}

/**
 * Host families with a shared spacing floor and a request path guard (A12, generalized in A13). A request on a family host passes only
 * when its path is not denied, is short, and matches one allowed (path, query) rule exactly. TTUSD's robots.txt asks for a 5 s crawl
 * delay and disallows `/fs/` (where its ICS export lives); Tahoe Donner's disallows its calendar action views and the ai1ec exporter,
 * and our guard also keeps us off its RSS feed and the WordPress API. Crystal Bay Casino (A14) is limited to its one WP REST event route.
 */
export interface HostFamily { floorMs: number; deny: RegExp; rules: { path: RegExp; search: RegExp }[] }
export const HOST_FAMILIES: Record<string, HostFamily> = {
  'ttusd.org': {
    floorMs: 5000,
    deny: /^\/fs\//,
    rules: [
      { path: /^\/robots\.txt$/, search: /^$/ },
      { path: /^\/(?:calendar|parents-students\/calendars\/calendars2)$/, search: /^\?cal_date=\d{4}-\d{2}-01$/ },
    ],
  },
  'tahoedonner.com': {
    floorMs: 5000,
    deny: /^\/(?:calendar|wp-|feed)|action~|ai1ec|controller=|^\/events\/feed\//i,
    rules: [
      { path: /^\/robots\.txt$/, search: /^$/ },
      { path: /^\/events\/$/, search: /^(?:\?categories%5B%5D=(?:94|180|95))?$/ },
      { path: /^\/events\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/, search: /^$/ },
    ],
  },
  // A14: Crystal Bay Casino. robots.txt allows everything and sets no delay; the 5 s floor is our choice. Only the one REST route is read.
  // `deny` is tested against path + query, so the lookahead lets the exact route (with or without a query) through to the rules below.
  'crystalbaycasino.com': {
    floorMs: 5000,
    deny: /^\/wp-json\/(?!wp\/v2\/event(?:\?|$))/,
    rules: [
      { path: /^\/robots\.txt$/, search: /^$/ },
      { path: /^\/wp-json\/wp\/v2\/event$/, search: /^\?per_page=100$/ },
    ],
  },
  // Kids live (Spec_Kids_Live K1): public library LibCal hosts (*.libcal.com). robots.txt asks for a 10 s crawl delay and disallows only
  // `/process_`; we read nothing but the month RSS feed (never the ajax JSON, the iCal export, calendar or event pages).
  'libcal.com': {
    floorMs: 10000,
    deny: /^\/(?:process_|ajax|ical_subscribe|calendar|event)/,
    rules: [
      { path: /^\/robots\.txt$/, search: /^$/ },
      { path: /^\/rss\.php$/, search: /^\?cid=\d{1,6}&m=month(?:&cam=\d{1,6})?$/ },
    ],
  },
};

export function familyOf(host: string): string | undefined {
  const h = host.toLowerCase();
  return Object.keys(HOST_FAMILIES).find((f) => h === f || h.endsWith(`.${f}`));
}
export const spacingKey = (host: string): string => familyOf(host) ?? host.toLowerCase();

/** True when `u` may be requested on a family host (see `HostFamily`). Non-family hosts always pass. */
function familyPathOk(u: URL): boolean {
  const f = familyOf(u.hostname);
  if (!f) return true;
  const fam = HOST_FAMILIES[f];
  return u.pathname.length <= 120 && !fam.deny.test(u.pathname + u.search) && fam.rules.some((r) => r.path.test(u.pathname) && r.search.test(u.search));
}

/** `finalUrl` is the URL of the last hop, so a caller can tell a redirect to another page from the page it asked for. */
export interface FetchOut { status: number; headers: Headers; body: Uint8Array; notModified: boolean; finalUrl: string }
export type FetchKind = 'feed' | 'api' | 'html';
export interface RobotsInfo { hash: string; aiBotsBlocked: boolean }

export interface PoliteFetch {
  (url: string, opts: { kind: FetchKind; conditional?: boolean }): Promise<FetchOut>;
  /** What this run learned from a host's robots.txt (undefined when none was fetched or the host has no robots file). */
  robotsInfo(host: string): RobotsInfo | undefined;
  /** Fetches (and caches) robots.txt for a host. Exempt from the legal gate and from `page_cap`. */
  fetchRobots(host: string): Promise<void>;
}

export interface PoliteDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutSignal?: (ms: number) => AbortSignal;
  /** Share across sources in one run so two sources on one host still respect the spacing. */
  spacer?: Spacer;
}

export interface PoliteSource {
  allowed_hosts: string[]; allowed_methods: string[]; page_cap: number; etag: string | null; last_modified: string | null;
  ingest_disposition: string; terms_recheck_at: string | null;
}

const AI_BOTS = ['ClaudeBot', 'Claude-SearchBot', 'anthropic-ai', 'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'CCBot', 'Google-Extended',
  'Bytespider', 'PerplexityBot', 'Applebot-Extended', 'meta-externalagent'];

/** True when robots.txt names any known AI crawler in its own group and disallows `/` for it. */
export function computeAiBotsBlocked(robotsText: string): boolean {
  if (!robotsText) return false;
  const named = new Set<string>();
  for (const line of robotsText.split(/\r?\n/)) {
    const m = /^\s*user-agent\s*:\s*(\S+)/i.exec(line);
    if (m) named.add(m[1].toLowerCase());
  }
  const parser = robotsParser('https://robots.invalid/robots.txt', robotsText);
  return AI_BOTS.some((bot) => named.has(bot.toLowerCase()) && parser.isDisallowed('https://robots.invalid/', bot) === true);
}

/** Crawl-delay seconds: the LARGEST of our group, the `*` group and any line before the first User-agent line (A6-1). */
function crawlDelayOf(text: string, parser: ReturnType<typeof robotsParser>): number {
  const v = (x: unknown) => (typeof x === 'number' && !Number.isNaN(x) && x >= 0 ? x : 0);
  let pre = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*user-agent\s*:/i.test(line)) break;
    const m = /^\s*crawl-delay\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
    if (m) pre = Math.max(pre, Number(m[1]));
  }
  return Math.max(v(parser.getCrawlDelay(ROBOTS_TOKEN)), v(parser.getCrawlDelay('*')), pre);
}

interface RobotsEntry { blocked: boolean; parser?: ReturnType<typeof robotsParser>; delay: number; info?: RobotsInfo }

export function createPoliteFetch(source: PoliteSource, deps: PoliteDeps): PoliteFetch {
  const spacer: Spacer = deps.spacer ?? createSpacer({ now: deps.now, sleep: deps.sleep });
  const robots = new Map<string, RobotsEntry>();
  let pages = 0;

  const hostAllowed = (h: string) => source.allowed_hosts.some((a) => { const x = a.toLowerCase(); return h === x || h.endsWith(`.${x}`); });
  const signal = () => deps.timeoutSignal?.(TIMEOUT_MS) ?? AbortSignal.timeout(TIMEOUT_MS);

  function legalGate(kind: FetchKind) {
    const ok = source.ingest_disposition === 'permitted' || source.ingest_disposition === 'official_api_only';
    const recheck = source.terms_recheck_at ? Date.parse(source.terms_recheck_at) : Number.NaN;
    if (!ok || !(recheck > deps.now())) throw new FetchError('terms_gate');
    if (!source.allowed_methods.includes(kind)) throw new FetchError('method_gate');
  }

  /** One network request: headers, timeout and error mapping. Redirects are never followed here. */
  async function request(url: string, conditional: boolean): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: '*/*' };
    if (conditional) {
      if (source.etag) headers['If-None-Match'] = source.etag;
      if (source.last_modified) headers['If-Modified-Since'] = source.last_modified;
    }
    try {
      return await deps.fetch(url, { method: 'GET', redirect: 'manual', headers, signal: signal() });
    } catch (e) {
      throw toFetchError(e);
    }
  }

  async function readBody(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY) { await res.body?.cancel().catch(() => undefined); throw new FetchError('too_large'); }
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) { await reader.cancel().catch(() => undefined); throw new FetchError('too_large'); }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw toFetchError(e);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
  }

  /** Seeds the family floor before the first request on a family host (idempotent). */
  function raiseFloor(host: string) {
    const f = familyOf(host);
    if (f) spacer.raise(f, HOST_FAMILIES[f].floorMs);
  }

  async function loadRobots(host: string): Promise<RobotsEntry> {
    const base = `https://${host}`;
    let url = `${base}/robots.txt`;
    try {
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const hu = new URL(url);
        const h = hu.hostname;
        if (!familyPathOk(hu)) return { blocked: true, delay: 0 }; // e.g. robots.txt redirecting into /fs/: fail closed
        raiseFloor(h);
        await spacer.acquire(spacingKey(h), Math.max(1000, (robots.get(h)?.delay ?? 0) * 1000));
        const res = await request(url, false);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.body?.cancel().catch(() => undefined);
          const next = new URL(res.headers.get('location')!, url);
          if (next.protocol !== 'https:' || !hostAllowed(next.hostname.toLowerCase())) return { blocked: true, delay: 0 };
          url = next.href;
          continue;
        }
        if (res.status === 404 || res.status === 410) { await res.body?.cancel().catch(() => undefined); return { blocked: false, delay: 0 }; }
        if (res.status < 200 || res.status >= 300) { await res.body?.cancel().catch(() => undefined); return { blocked: true, delay: 0 }; }
        const bytes = await readBody(res);
        const text = new TextDecoder('utf-8').decode(bytes);
        const parser = robotsParser(`${base}/robots.txt`, text);
        const delay = crawlDelayOf(text, parser);
        spacer.raise(spacingKey(host), delay * 1000);
        return {
          blocked: false, parser, delay,
          info: { hash: createHash('sha256').update(bytes).digest('hex'), aiBotsBlocked: computeAiBotsBlocked(text) },
        };
      }
      return { blocked: true, delay: 0 };
    } catch {
      return { blocked: true, delay: 0 }; // 5xx, timeout, network error, oversize: fail closed
    }
  }

  async function robotsFor(host: string): Promise<RobotsEntry> {
    let e = robots.get(host);
    if (!e) { e = await loadRobots(host); robots.set(host, e); }
    return e;
  }

  const pf = (async (rawUrl: string, opts: { kind: FetchKind; conditional?: boolean }): Promise<FetchOut> => {
    legalGate(opts.kind);
    let url = rawUrl;
    for (let hop = 0; ; hop++) {
      const blockedCode: FetchErrorCode = hop === 0 ? 'host_not_allowed' : 'redirect_blocked';
      let u: URL;
      try { u = new URL(url); } catch { throw new FetchError(blockedCode); }
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || !hostAllowed(host)) throw new FetchError(blockedCode);
      raiseFloor(host);
      if (!familyPathOk(u)) throw new FetchError('path_not_allowed');
      const r = await robotsFor(host);
      if (r.blocked) throw new FetchError('robots_blocked');
      if (r.parser && r.parser.isAllowed(u.href, ROBOTS_TOKEN) === false) throw new FetchError('robots_blocked');
      if (r.delay > MAX_CRAWL_DELAY_S) throw new FetchError('crawl_delay');
      if (pages >= source.page_cap) throw new FetchError('page_cap');
      pages++;
      await spacer.acquire(spacingKey(host), Math.max(1000, r.delay * 1000));
      const res = await request(u.href, !!opts.conditional);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && loc) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_HOPS) throw new FetchError('redirect_blocked');
        try { url = new URL(loc, u.href).href; } catch { throw new FetchError('redirect_blocked'); }
        continue;
      }
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return { status: 304, headers: res.headers, body: new Uint8Array(0), notModified: true, finalUrl: u.href };
      }
      const body = await readBody(res);
      return { status: res.status, headers: res.headers, body, notModified: false, finalUrl: u.href };
    }
  }) as PoliteFetch;

  pf.robotsInfo = (host) => robots.get(host.toLowerCase())?.info;
  pf.fetchRobots = async (host) => {
    const h = host.toLowerCase();
    if (!hostAllowed(h)) throw new FetchError('host_not_allowed');
    await robotsFor(h);
  };
  return pf;
}

function toFetchError(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  const name = e instanceof Error ? e.name : '';
  return new FetchError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}
