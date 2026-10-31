// TDRPD programs from the Rec1 catalog (Spec_Kids_Live Amendment K3), read only when the owner asks ("read tdrpd").
// Pure parts (page, block detection, session grammar, mapping) plus `runRead`, the request plan with an injected HTTP client.
// Facts only: program name, first upcoming meeting, location, Rec1's own age range, and the catalog URL as the link. Prices,
// descriptions and images are never read into an item. Every grammar fails closed and every drop is counted by reason.
import { makeEvent, localDate, addDays } from '../adapters/common';
import { decodeEntities, toUtcFromLocal, validateSourceEvent } from '../core/normalize';
import type { SourceEvent } from '../types';

export interface Rec1Venue { match: string; name: string; address?: string; lat: number; lng: number }
export interface Rec1Config { catalogUrl: string; tz: string; town: string; venues: Rec1Venue[] }
export interface Session { id: string; name: string; features: Record<string, string>; flags: Record<string, unknown> }

export const REQUEST_BUDGET = 12;
export const SPACING_MS = 10_000;
const WINDOW_DAYS = 120;
const CATALOG_URL = /^https:\/\/secure\.rec1\.com\/[A-Z]{2}\/([a-z0-9-]{2,40})\/catalog$/;

export class Rec1Fail extends Error { constructor(readonly code: 'layout_changed' | 'site_block' | 'http_error') { super(code); } }

/** The checkout key and CSRF metas from the public catalog page; anything else is `layout_changed`. */
export function extractPage(html: string): { key: string; csrfKey: string; csrfToken: string } {
  const pd = /data-page-data="([^"]{2,200000})"/.exec(html);
  const meta = (n: string) => new RegExp(`<meta name="${n}" content="([A-Za-z0-9]{1,128})"`).exec(html)?.[1];
  let key: unknown;
  try { key = (JSON.parse(decodeEntities(pd?.[1] ?? '')) as { checkoutData?: { key?: unknown } }).checkoutData?.key; } catch { key = undefined; }
  const csrfKey = meta('csrf-key');
  const csrfToken = meta('csrf-token');
  if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key) || !csrfKey || !csrfToken) throw new Rec1Fail('layout_changed');
  return { key, csrfKey, csrfToken };
}

const BLOCK_TEXT = /cf-chl|challenge-platform|attention required|access denied|are you a robot|verify you are human/i;
/** 401/403/429, or a challenge/block page. The normal catalog page loads reCAPTCHA's script and is not a block. */
export function isBlocked(status: number, body: string): boolean {
  return status === 401 || status === 403 || status === 429 || BLOCK_TEXT.test(body.slice(0, 20000));
}

const fname = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Every object that looks like a catalog session: an id, a name, and a `features` list of {name, value}. Deduped by id. */
export function collectSessions(json: unknown): Session[] {
  const out = new Map<string, Session>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const name = [o.text, o.name, o.label, o.title].find((x): x is string => typeof x === 'string' && x.trim() !== '');
    const id = typeof o.id === 'number' || typeof o.id === 'string' ? String(o.id) : '';
    if (Array.isArray(o.features) && name && /^\d{1,12}$/.test(id)) {
      const features: Record<string, string> = {};
      for (const f of o.features) {
        if (f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string') {
          const val = (f as { value?: unknown }).value;
          if (typeof val === 'string' || typeof val === 'number') features[fname((f as { name: string }).name)] = String(val).trim();
        }
      }
      const flags: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) if (typeof x === 'boolean' || ((typeof x === 'string' || typeof x === 'number') && SPOT_KEY.test(k))) flags[k] = x;
      if (!out.has(id)) out.set(id, { id, name: name.trim(), features, flags });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(json, 0);
  return [...out.values()];
}

/** Tab ids; any tab without a valid id makes the whole list unusable (review: no silently skipped tab). */
/**
 * Every leaf object reached through a list (an object with no nested list of objects) must be a valid session; anything else, whatever
 * keys it has, is counted here and fails the read closed (recheck r2-r4 P1: mixed tabs never become a partial snapshot).
 */
const holdsObjectList = (v: unknown, d: number): boolean => {
  if (d > 12 || v === null || typeof v !== 'object') return d > 12;
  if (Array.isArray(v)) return v.some((y) => y && typeof y === 'object');
  return Object.values(v).some((x) => holdsObjectList(x, d + 1));
};
export function unrecognizedRecords(json: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number, viaList: boolean) => {
    if (depth > 12) { n++; return; }
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1, true); return; }
    const o = v as Record<string, unknown>;
    if (!viaList && !Object.values(o).some((x) => Array.isArray(x) || (x && typeof x === 'object'))) return; // a plain metadata object
    if (Array.isArray(o.features)) { // a session candidate: it must meet the collectSessions grammar exactly
      const named = [o.text, o.name, o.label, o.title].some((x) => typeof x === 'string' && x.trim() !== '');
      const id = typeof o.id === 'number' || typeof o.id === 'string' ? String(o.id) : '';
      if (!named || !/^\d{1,12}$/.test(id)) n++;
      // recheck r5: a session that nests any other list of objects could hide a record, so it fails closed too
      if (Object.entries(o).some(([k, x]) => k !== 'features' && holdsObjectList(x, 0))) n++;
      return;
    }
    const nested = Object.values(o).filter((x) => Array.isArray(x) && x.some((y) => y && typeof y === 'object'));
    // plain object properties are metadata unless they hold lists, which are walked (a list anywhere is checked)
    const props = Object.values(o).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (nested.length === 0 && depth > 0 && viaList) n++;
    for (const x of nested) walk(x, depth + 1, true);
    for (const x of props) walk(x, depth + 1, false);
  };
  walk(json, 0, false);
  return n;
}

export function collectTabIds(json: unknown): string[] {
  const tabs = Array.isArray(json) ? json : (json as { tabs?: unknown })?.tabs;
  if (!Array.isArray(tabs)) return [];
  const ids = tabs.map((t) => (t && typeof t === 'object' ? String((t as { id?: unknown }).id ?? '') : ''));
  return ids.every((id) => /^\d{1,10}$/.test(id)) ? ids : [];
}

/** An items answer must carry a boolean `hasMoreResults` and at least one array container (sections, groups or items). */
export function itemsEnvelopeOk(json: unknown): json is { hasMoreResults: boolean } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const o = json as Record<string, unknown>;
  return typeof o.hasMoreResults === 'boolean' && ['sections', 'groups', 'items'].some((k) => Array.isArray(o[k]));
}

const pick = (f: Record<string, string>, names: string[]) => names.map((n) => f[n]).find((x) => x !== undefined && x !== '') ?? '';

const YU = String.raw`(?:\s*y(?:rs?)?(?:\s*\d{1,2}\s*m)?|\s*(?:years?|yrs?))?`;
const GENDER = String.raw`(?:\s*[/,]?\s*(?:coed|co-ed|male|female|boys|girls))?`;
const AGE_RANGE = new RegExp(String.raw`^(?:ages?\s*)?(\d{1,2})${YU}\s*(?:-|–|to)\s*(\d{1,2})${YU}${GENDER}$`);
const AGE_UP = new RegExp(String.raw`^(?:ages?\s*)?(\d{1,2})${YU}\s*(?:\+|and up|& up|and older|and over)${GENDER}$`);
/** Rec1 age text -> years, anchored on the whole value. `18y and up` / `5+` -> max 99. Grades, months, several ranges -> null. */
export function parseAges(s: string): { min: number; max: number } | null {
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const up = AGE_UP.exec(t);
  if (up) return { min: +up[1], max: 99 };
  const m = AGE_RANGE.exec(t);
  if (!m || +m[1] > +m[2]) return null;
  return { min: +m[1], max: +m[2] };
}

const TIME = /^\s*(\d{1,2})(?::([0-5]\d))?\s*(?:([ap])\.?m\.?)?\s*(?:-|–|to)\s*(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\s*$/i;
const to24 = (h: number, mm: string | undefined, ap: string) => {
  if (h < 1 || h > 12) return null;
  const hh = (h % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  return `${String(hh).padStart(2, '0')}:${mm ?? '00'}`;
};
/** `3:30 PM - 4:15 PM`, `9:00am-12:00pm`, `3:30-4:30 PM` -> 24h local start/end. Anything else -> null. */
export function parseTimes(s: string): { start: string; end: string } | null {
  const m = TIME.exec(s);
  if (!m) return null;
  const end = to24(+m[4], m[5], m[6]);
  let start = to24(+m[1], m[2], m[3] ?? m[6]);
  if (!m[3] && start && end && start > end) start = to24(+m[1], m[2], 'a');
  if (!start || !end || end <= start) return null;
  return { start, end };
}

const DAY_TOKENS: [RegExp, number][] = [[/^su/, 0], [/^m/, 1], [/^tu/, 2], [/^w/, 3], [/^th/, 4], [/^f/, 5], [/^sa/, 6]];
const dayOf = (tok: string) => DAY_TOKENS.find(([r]) => r.test(tok.toLowerCase()))?.[1];
function parseDays(s: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(/[,/&]|\band\b/).map((x) => x.trim()).filter(Boolean)) {
    const r = /^([a-z]+)\s*[-–]\s*([a-z]+)$/i.exec(part);
    if (r) {
      const a = dayOf(r[1]); const b = dayOf(r[2]);
      if (a === undefined || b === undefined) return null;
      for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
      continue;
    }
    const d = dayOf(part);
    if (d === undefined) return null;
    out.add(d);
  }
  return out;
}

const DATES = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?:\s*(?:-|–|to)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?)?\s*$/;
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};
/** The first meeting on or after the session's start (honouring its days), with the year inferred when Rec1 omits it. */
export function firstMeeting(dates: string, days: string, today: string): { date: string; multi: boolean } | null {
  const m = DATES.exec(dates);
  if (!m) return null;
  const ty = +today.slice(0, 4);
  const yr = (y: string | undefined) => (y ? (y.length === 2 ? 2000 + +y : +y) : undefined);
  let start = ymd(yr(m[3]) ?? ty, +m[1], +m[2]);
  if (start && !m[3] && start < addDays(today, -180)) start = ymd(ty + 1, +m[1], +m[2]);
  if (!start) return null;
  let end = start;
  if (m[4]) {
    const sy = +start.slice(0, 4);
    let e = ymd(yr(m[6]) ?? sy, +m[4], +m[5]);
    if (e && !m[6] && e < start) e = ymd(sy + 1, +m[4], +m[5]);
    if (!e || e < start) return null;
    end = e;
  }
  const set = days.trim() ? parseDays(days) : null;
  if (days.trim() && !set) return null;
  let date = start;
  if (set && set.size > 0) {
    let d = start;
    while (d <= end && !set.has(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
    if (d > end) return null;
    date = d;
  }
  return { date, multi: end > start };
}

const CLOSED_FLAG = /^(?:is)?(?:full|closed|soldout|registrationclosed|registrationover|cancell?ed|waitlistonly)$/i;
const OPEN_FLAG = /^(?:is)?(?:open|available|registrationopen)$/i;
const SPOT_KEY = /^(?:spots|openings|spotsavailable|availability|available|remaining|status|spotsleft)$/i;
/** Explicit availability: any closed signal vetoes; open needs a positive signal; nothing recognized is unknown (dropped). */
export function availability(s: Session): 'open' | 'closed' | 'unknown' {
  const signals: string[] = [];
  for (const [k, v] of Object.entries(s.flags)) {
    if (typeof v === 'boolean') { if (CLOSED_FLAG.test(k)) signals.push(v ? 'closed' : ''); else if (OPEN_FLAG.test(k)) signals.push(v ? 'open' : 'closed'); }
    else if (typeof v === 'number' && SPOT_KEY.test(k)) signals.push(v > 0 ? 'open' : 'closed');
    else if (typeof v === 'string' && SPOT_KEY.test(k)) signals.push(textSignal(v));
  }
  for (const [k, v] of Object.entries(s.features)) if (SPOT_KEY.test(k)) signals.push(textSignal(v));
  if (signals.includes('closed')) return 'closed';
  if (signals.includes('unknown')) return 'unknown';
  return signals.includes('open') ? 'open' : 'unknown';
}
function textSignal(v: string): string {
  const t = v.trim().toLowerCase();
  if (/^\d{1,4}$/.test(t)) return +t > 0 ? 'open' : 'closed';
  if (/full|closed|wait|cancel|sold out|^none$/.test(t)) return 'closed';
  if (/^(?:open|available|\d{1,4} (?:spots?|openings?)(?: left| available)?)$/.test(t)) return /^0 /.test(t) ? 'closed' : 'open';
  return t === '' ? '' : 'unknown';
}

export interface MapOut { items: SourceEvent[]; dropped: Record<string, number>; found: number }
/** Sessions -> youth events (DR-K3-6/7). Throws `layout_changed` when there is no session at all. */
export function mapSessions(sessions: Session[], cfg: Rec1Config, now: Date): MapOut {
  if (sessions.length === 0) throw new Rec1Fail('layout_changed');
  const agency = CATALOG_URL.exec(cfg.catalogUrl)?.[1];
  if (!agency) throw new Error('config_rec1_invalid');
  const venues = cfg.venues.map((v) => ({ ...v, re: new RegExp(v.match, 'i') }));
  const today = localDate(now, cfg.tz);
  const last = addDays(today, WINDOW_DAYS);
  const items: SourceEvent[] = [];
  const dropped: Record<string, number> = {};
  const drop = (c: string) => { dropped[c] = (dropped[c] ?? 0) + 1; };
  for (const s of sessions) {
    const ages = parseAges(pick(s.features, ['agegender', 'ages', 'age', 'agerange', 'agegroup']));
    if (!ages) { drop('age_unparsed'); continue; }
    if (ages.max > 17) { drop('not_youth'); continue; }
    const avail = availability(s);
    if (avail === 'closed') { drop('full_or_closed'); continue; }
    if (avail === 'unknown') { drop('availability_unknown'); continue; }
    const meet = firstMeeting(pick(s.features, ['dates', 'date', 'daterange', 'sessiondates']), pick(s.features, ['days', 'day', 'daysoftheweek', 'daysofweek']), today);
    if (!meet) { drop('date_unparsed'); continue; }
    if (meet.date < today) { drop('started'); continue; }
    if (meet.date > last) { drop('out_of_window'); continue; }
    const times = parseTimes(pick(s.features, ['times', 'time', 'timerange']));
    if (!times) { drop('time_unparsed'); continue; }
    const startsAt = toUtcFromLocal(meet.date, times.start, cfg.tz);
    const endsAt = toUtcFromLocal(meet.date, times.end, cfg.tz);
    if (startsAt === 'dst_gap') { drop('dst_gap'); continue; }
    if (Date.parse(startsAt) <= now.getTime()) { drop('started'); continue; }
    const loc = pick(s.features, ['location', 'locations', 'facility']);
    const v = venues.find((x) => x.re.test(loc));
    const key = `rec1:${agency}#${s.id}`;
    const e = makeEvent({
      externalKey: key, title: s.name, startsAt, endsAt: endsAt === 'dst_gap' ? undefined : endsAt, allDay: false, tz: cfg.tz,
      venueName: v ? v.name : loc || undefined, address: v?.address, town: cfg.town, lat: v?.lat, lng: v?.lng,
      url: cfg.catalogUrl, hints: ages.min <= 12 ? ['audience:kids'] : [], family: 'rec1_catalog', seriesUid: meet.multi ? key : undefined,
    });
    const ok = validateSourceEvent(e);
    if ('invalid' in ok) { drop('invalid'); continue; }
    items.push(ok);
  }
  return { items, dropped, found: sessions.length };
}

export interface HttpReq { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; form?: Record<string, string> }
export interface ReadDeps { http(req: HttpReq): Promise<{ status: number; body: string }>; now(): number; sleep(ms: number): Promise<void> }
export interface ReadOut { status: 'ok' | 'site_block' | 'http_error' | 'layout_changed' | 'incomplete'; sessions: Session[]; raw?: Record<string, string>; requests: number; httpStatus?: number }

/** DR-K3-4/5: page, tabs, then one read-only search per tab (paged), <= 12 requests, >= 10 s apart, stop at once on a block. */
export async function runRead(cfg: Rec1Config, deps: ReadDeps): Promise<ReadOut> {
  if (!CATALOG_URL.test(cfg.catalogUrl)) throw new Error('config_rec1_invalid');
  let requests = 0;
  let last = -Infinity;
  const raw: Record<string, string> = {};
  const sessions: Session[] = [];
  async function call(req: HttpReq, json: boolean): Promise<string> {
    if (requests >= REQUEST_BUDGET) throw new Error('budget');
    const wait = last + SPACING_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    last = deps.now();
    requests++;
    const r = await deps.http(req);
    if (isBlocked(r.status, r.body)) throw new Rec1Fail('site_block');
    if (r.status !== 200) throw Object.assign(new Rec1Fail('http_error'), { httpStatus: r.status });
    if (json) { try { JSON.parse(r.body); } catch { throw new Rec1Fail('site_block'); } }
    return r.body;
  }
  try {
    const page = extractPage(await call({ method: 'GET', url: cfg.catalogUrl, headers: { Accept: 'text/html' } }, false));
    const xhr = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-KEY': page.csrfKey, 'X-CSRF-TOKEN': page.csrfToken };
    const base = `${cfg.catalogUrl}/`;
    raw['tabs.json'] = await call({ method: 'GET', url: `${base}getTabs/${page.key}`, headers: xhr }, true);
    const tabs = collectTabIds(JSON.parse(raw['tabs.json']));
    if (tabs.length === 0) throw new Rec1Fail('layout_changed');
    for (const tab of tabs) {
      for (let p = 1; ; p++) {
        // Review r2-2: a read that cannot finish inside the budget is never submitted as a full snapshot.
        if (requests >= REQUEST_BUDGET) return { status: 'incomplete', sessions: [], raw, requests };
        const body = await call({ method: 'POST', url: `${base}getItems/${page.key}/${tab}`, headers: xhr, form: { page: String(p) } }, true);
        raw[p === 1 ? `items-${tab}.json` : `items-${tab}-p${p}.json`] = body;
        const j: unknown = JSON.parse(body);
        if (!itemsEnvelopeOk(j)) throw new Rec1Fail('layout_changed');
        const found = collectSessions(j);
        // Recheck P1: a non-empty answer whose records are not recognizable sessions is a shape change, never an empty tab.
        const o = j as unknown as Record<string, unknown[] | undefined>;
        if (found.length === 0 && ['sections', 'groups', 'items'].some((k) => Array.isArray(o[k]) && o[k]!.length > 0)) throw new Rec1Fail('layout_changed');
        if (unrecognizedRecords(j) > 0) throw new Rec1Fail('layout_changed');
        sessions.push(...found);
        if (!j.hasMoreResults) break;
      }
    }
  } catch (e) {
    if (e instanceof Rec1Fail) return { status: e.code, sessions: [], raw, requests, httpStatus: (e as { httpStatus?: number }).httpStatus };
    throw e;
  }
  const seen = new Set<string>();
  return { status: 'ok', sessions: sessions.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true))), raw, requests };
}
