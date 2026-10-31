// TDRPD programs from the Rec1 catalog (Spec_Kids_Live Amendment K3), read only when the owner asks ("read tdrpd").
// Pure parts (page, block detection, session grammar, mapping) plus `runRead`, the request plan with an injected HTTP client.
// Facts only: program name, first upcoming meeting, location, Rec1's own age range, and the catalog URL as the link. Prices,
// descriptions and images are never read into an item. Every grammar fails closed and every drop is counted by reason.
import { createHash } from 'node:crypto';
import { makeEvent, localDate, addDays } from '../adapters/common';
import { decodeEntities, toUtcFromLocal, validateSourceEvent } from '../core/normalize';
import type { SourceEvent } from '../types';

export interface Rec1Venue { match: string; name: string; address?: string; lat: number; lng: number }
export interface Rec1Config { catalogUrl: string; tz: string; town: string; venues: Rec1Venue[] }
export interface Session { id: string; name: string; features: Record<string, string>; flags: Record<string, unknown>; group?: { id: string; name: string } }

export const REQUEST_BUDGET = 80; // K3.1 (DR-K3.1-2): four youth tabs plus their deferred activity groups
export const SPACING_MS = 6_000;
export const RETRY_WAIT_MS = 30_000;
export const MAX_RETRIES = 3;
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
      let conflict = false;
      for (const f of o.features) {
        if (f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string') {
          const val = (f as { value?: unknown }).value;
          if (typeof val === 'string' || typeof val === 'number') {
            const k = fname((f as { name: string }).name);
            const v = String(val).trim();
            if (k === '' || (k in features && features[k] !== v)) conflict = true; // review r10 P2: no silent overwrite
            features[k] = v;
          }
        }
      }
      const flags: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) if (typeof x === 'boolean' || ((typeof x === 'string' || typeof x === 'number') && (SPOT_KEY.test(k) || CLOSED_FLAG.test(k) || OPEN_FLAG.test(k) || k === 'regStart'))) flags[k] = x;
      if (conflict) flags.featureConflict = true;
      const prev = out.get(id);
      if (prev && JSON.stringify(prev) !== JSON.stringify({ id, name: name.trim(), features, flags })) prev.flags.duplicateConflict = true;
      if (!prev) out.set(id, { id, name: name.trim(), features, flags });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(json, 0);
  return [...out.values()];
}

export function collectTabIds(json: unknown): string[] {
  const tabs = Array.isArray(json) ? json : (json as { tabs?: unknown })?.tabs;
  if (!Array.isArray(tabs)) return [];
  const ids = tabs.map((t) => (t && typeof t === 'object' ? String((t as { id?: unknown }).id ?? '') : ''));
  return ids.every((id) => /^\d{1,10}$/.test(id)) ? ids : [];
}

const pick = (f: Record<string, string>, names: string[]) => names.map((n) => f[n]).find((x) => x !== undefined && x !== '') ?? '';

const YU = String.raw`(?:\s*y(?:rs?)?(?:\s*\d{1,2}\s*m)?|\s*(?:years?|yrs?))?`;
const GENDER = String.raw`(?:\s*[/,]?\s*(?:coed|co-ed|male|female|boys|girls))?`;
const AGE_RANGE = new RegExp(String.raw`^(?:ages?\s*)?(\d{1,2})${YU}\s*(?:-|–|to)\s*(\d{1,2})${YU}${GENDER}$`);
const AGE_UP = new RegExp(String.raw`^(?:ages?\s*)?(\d{1,2})${YU}\s*(?:\+|and up|& up|/\s*up|and older|and over)${GENDER}$`);
const GRADE = String.raw`(?:(pre-?k\s*[34]?|tk|k|kindergarten)|(\d{1,2})(?:st|nd|rd|th))`;
const GRADE_RANGE = new RegExp(String.raw`^${GRADE}(?:\s*grade)?\s*(?:-|–|to)\s*${GRADE}(?:\s*grade)?$`);
const gradeAge = (named: string | undefined, num: string | undefined): number | undefined => {
  if (named) return /^pre/.test(named) ? (/3/.test(named) ? 3 : 4) : named === 'tk' ? 4 : 5;
  const n = Number(num);
  return n >= 1 && n <= 12 ? n + 5 : undefined;
};
/** K3.1 r4: TDRPD states many youth ranges as grades (`1st Grade - 3rd Grade`). Grade g is ages g+5 to g+6; K = 5, TK/Pre-K4 = 4. */
function gradeRange(t: string): { min: number; max: number } | null | undefined {
  const m = GRADE_RANGE.exec(t);
  if (!m) return /grade/.test(t) ? null : undefined;
  const a = gradeAge(m[1], m[2]), b = gradeAge(m[3], m[4]);
  if (a === undefined || b === undefined || a > b) return null;
  return { min: a, max: Math.min(b + 1, 18) };
}
/** Rec1 age text -> years, anchored on the whole value. `18y and up` / `5+` -> max 99. Grades, months, several ranges -> null. */
export function parseAges(s: string): { min: number; max: number } | null {
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const g = gradeRange(t);
  if (g !== undefined) return g;
  const mo = /^(\d{1,2})\s*m\s*(?:-|–|to)\s*(\d{1,2})$/.exec(t); // K3.1 r4: `4m-3` = 4 months to 3 years
  if (mo) return +mo[1] <= 24 ? { min: 0, max: +mo[2] } : null;
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

const CLOSED_FLAG = /^(?:is)?(?:full|sessionfull|closed|soldout|registrationclosed|registrationover|cancell?ed|waitlistonly)$/i;
const OPEN_FLAG = /^(?:is)?(?:open|available|registrationopen)$/i;
const SPOT_KEY = /^(?:spots|openings|spotsavailable|availability|available|remaining|status|spotsleft)$/i;
/** Explicit availability: any closed signal vetoes; open needs a positive signal; nothing recognized is unknown (dropped). */
export function availability(s: Session): 'open' | 'closed' | 'unknown' {
  const signals: string[] = [];
  for (const [k, v] of Object.entries(s.flags)) {
    if (typeof v === 'boolean') { if (CLOSED_FLAG.test(k)) signals.push(v ? 'closed' : ''); else if (OPEN_FLAG.test(k)) signals.push(v ? 'open' : 'closed'); }
    else if (typeof v === 'number' && SPOT_KEY.test(k)) signals.push(v > 0 ? 'open' : 'closed');
    else if (typeof v === 'string' && SPOT_KEY.test(k)) signals.push(textSignal(v));
    else if (typeof v === 'string' && (CLOSED_FLAG.test(k) || OPEN_FLAG.test(k))) signals.push('unknown'); // a string boolean is not trusted either way
  }
  for (const [k, v] of Object.entries(s.features)) if (SPOT_KEY.test(k)) signals.push(textSignal(v));
  // K3.1 r4: registration not open yet (opens on `regStart`, not over, not full, not cancelled) is an upcoming, open program
  if (s.flags.registrationOpen === false && s.flags.registrationOver === false && typeof s.flags.regStart === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(s.flags.regStart)) {
    const i = signals.indexOf('closed');
    if (i >= 0) signals.splice(i, 1, 'open');
  }
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

const NOISE_SEG = /^(?:\d{4}(?:\s*-\s*\d{4})?|fall|winter|spring|summer|session\s+[a-z0-9]{1,4}|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?(?:\s+\d{1,2}:\d{2}\s*[ap]m)?|[a-z]{3}|nov|dec|jan|feb)$/i;
/**
 * K3.1 r4: Rec1 session names carry year, season, session and slot segments (`2026 | Session B | Sat 09:05 AM | Guppy`). Those are
 * dropped; the rest is the program. When the group name already contains it (`Swim Level 0 - Guppy`), the group name is the title;
 * when the rest contains the group name, the rest is; otherwise `<group>: <rest>`. Organizer text only.
 */
export function programTitle(name: string, group?: string): string {
  const segs = name.split('|').map((x) => x.trim()).filter((x) => x && !NOISE_SEG.test(x));
  const rest = segs.join(' | ') || name.trim();
  const g = (group ?? '').replace(/\s+/g, ' ').trim();
  if (!g) return rest;
  const lo = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (lo(g).includes(lo(rest))) return g;
  if (lo(rest).includes(lo(g))) return rest;
  return `${g}: ${rest}`;
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
  const byKey = new Map<string, SourceEvent>();
  for (const s of sessions) {
    if (s.flags.featureConflict || s.flags.duplicateConflict) { drop('conflict'); continue; }
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
    // K3.1 r4: one meeting longer than 10 h is a data-entry error (day camps run ~7 h) (seen: `12:05am-12:35pm` for a 12:05 PM swim class)
    if (endsAt !== 'dst_gap' && Date.parse(endsAt) - Date.parse(startsAt) > 10 * 3_600_000) { drop('time_implausible'); continue; }
    if (Date.parse(startsAt) <= now.getTime()) { drop('started'); continue; }
    const loc = pick(s.features, ['location', 'locations', 'facility']);
    const v = venues.find((x) => x.re.test(loc));
    const title = programTitle(s.name, s.group?.name);
    // K3.1 r4: one row per program (group + cleaned title) at its earliest open meeting; Rec1 lists each time slot as a session
    const key = s.group && /^\d{1,12}$/.test(s.group.id) ? `rec1:${agency}#g${s.group.id}-${createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0, 10)}` : `rec1:${agency}#${s.id}`;
    const prev = byKey.get(key);
    if (prev && prev.startsAt <= startsAt) { drop('same_program'); continue; }
    if (prev) { items.splice(items.indexOf(prev), 1); drop('same_program'); }
    const e = makeEvent({
      externalKey: key, title, startsAt, endsAt: endsAt === 'dst_gap' ? undefined : endsAt, allDay: false, tz: cfg.tz,
      venueName: v ? v.name : loc || undefined, address: v?.address, town: cfg.town, lat: v?.lat, lng: v?.lng,
      url: cfg.catalogUrl, hints: ages.min <= 12 ? ['audience:kids'] : [], family: 'rec1_catalog', seriesUid: meet.multi ? key : undefined,
    });
    const ok = validateSourceEvent(e);
    if ('invalid' in ok) { drop('invalid'); continue; }
    items.push(ok);
    byKey.set(key, ok);
  }
  return { items, dropped, found: sessions.length };
}

// ---- K3.1: tab answers -> deferred activity groups -> getActivitySessions (Spec_Kids_Live Amendment K3.1) ----

/** DR-K3.1-1: the youth tabs, by label (lowercased, non-alphanumerics dropped). Everything else is never requested. */
export const YOUTH_TABS = ['athletics', 'aquatics', 'artdancemusic', 'enrichment'];
const tabKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const GROUP_TYPES = ['activity', 'location', 'rentalItemGroup'];
const PAGE_GUESS = 10; // class.CatalogGroup.js itemsPerPage: an estimate that sizes the plan; the budget still bounds the real read
const isScalar = (x: unknown) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const shape = (): never => { throw new Rec1Fail('layout_changed'); };

/** The chosen youth tab ids and how many tabs were skipped. Any bad tab id voids the list; none of the four = layout_changed. */
export function chooseTabs(json: unknown): { ids: string[]; skipped: number } {
  const ids = collectTabIds(json);
  if (ids.length === 0) shape();
  const tabs = (Array.isArray(json) ? json : (json as { tabs: unknown[] }).tabs) as Record<string, unknown>[];
  // K3.1 r2-2: each of the four youth labels exactly once (a renamed, missing or doubled tab is layout_changed), in getTabs order.
  const chosen = tabs.filter((t) => typeof t.label === 'string' && YOUTH_TABS.includes(tabKey(t.label)));
  const keys = chosen.map((t) => tabKey(t.label as string));
  if (chosen.length !== YOUTH_TABS.length || new Set(keys).size !== YOUTH_TABS.length) shape();
  return { ids: chosen.map((t) => String(t.id)), skipped: tabs.length - chosen.length };
}

export interface GroupRef { groupId: string; itemCount: number; name?: string }
/**
 * K3.1 r3 (first full read, 2026-10-31: 70 groups, plan 103): groups that are never youth events are not requested. Memberships, punch
 * cards, passes, private (one-to-one) lessons, adult and senior programs, dog training and the shuttle. Ages still decide every kept row.
 */
export const SKIP_GROUP = /\b(?:adults?|seniors?|memberships?|punch ?cards?|season pass(?:es)?|private swim lessons|dog training|shuttle)\b/i;
/** DR-K3.1-3: a getItems answer, closed grammar. Inline session records, deferred activity group refs, and a skip count. */
export function parseTabAnswer(json: unknown): { records: unknown[]; refs: GroupRef[]; skipped: number; hasMore: boolean } {
  if (!plain(json) || typeof json.hasMoreResults !== 'boolean') shape();
  const j = json as Record<string, unknown>;
  const records: unknown[] = [];
  const refs: GroupRef[] = [];
  let skipped = 0;
  const group = (g: unknown) => {
    if (!plain(g)) shape();
    const o = g as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) if (!isScalar(v) && k !== 'items') shape();
    if (!Array.isArray(o.items) || typeof o.type !== 'string' || !GROUP_TYPES.includes(o.type)) shape();
    const id = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : '';
    if (!/^\d{1,12}$/.test(id)) shape();
    const items = o.items as unknown[];
    if (o.deferredLoading === true) {
      if (items.length > 0) shape();
      if (o.type !== 'activity') { skipped++; return; }
      const c = typeof o.itemCount === 'number' ? o.itemCount : typeof o.itemCount === 'string' && /^\d{1,3}$/.test(o.itemCount) ? Number(o.itemCount) : NaN;
      if (!Number.isInteger(c) || c < 0 || c > 500) shape();
      refs.push({ groupId: id, itemCount: c, name: typeof o.name === 'string' ? o.name : '' });
    } else if (o.deferredLoading === false || o.deferredLoading === undefined) {
      if (o.type !== 'activity') { skipped++; return; }
      records.push(...items);
    } else shape();
  };
  for (const [k, v] of Object.entries(j)) {
    if (isScalar(v)) continue;
    if (k === 'errors') { if (!Array.isArray(v) || v.length > 0) shape(); continue; }
    if (!Array.isArray(v)) shape();
    if (k === 'items') records.push(...(v as unknown[]));
    else if (k === 'groups') (v as unknown[]).forEach(group);
    else if (k === 'sections') {
      for (const s of v as unknown[]) {
        if (!plain(s)) shape();
        for (const [sk, sv] of Object.entries(s as Record<string, unknown>)) {
          if (isScalar(sv)) continue;
          if (sk !== 'groups' || !Array.isArray(sv)) shape();
          (sv as unknown[]).forEach(group);
        }
      }
    } else shape();
  }
  return { records, refs, skipped, hasMore: j.hasMoreResults as boolean };
}

/** DR-K3.1-4: a getActivitySessions answer, closed grammar: `items`, digit `itemCount`, empty `errors`, `maps` ignored, scalars. */
export function parseGroupAnswer(json: unknown): { records: unknown[]; itemCount: number } {
  if (!plain(json) || !Array.isArray(json.items)) shape();
  const j = json as Record<string, unknown>;
  const c = typeof j.itemCount === 'number' ? j.itemCount : typeof j.itemCount === 'string' && /^\d{1,3}$/.test(j.itemCount) ? Number(j.itemCount) : NaN;
  if (!Number.isInteger(c) || c < 0 || c > 500) shape();
  for (const [k, v] of Object.entries(j)) {
    if (isScalar(v) || k === 'items' || k === 'maps') continue;
    if (k === 'errors' && Array.isArray(v) && v.length === 0) continue;
    shape();
  }
  return { records: j.items as unknown[], itemCount: c };
}

/** One session record, closed grammar: scalars, a flat `features` list, `info` (scalars, never read) and an empty `children`. */
export function toSession(rec: unknown): Session {
  if (!plain(rec)) shape();
  const o = rec as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (isScalar(v)) continue;
    if (k === 'features' && Array.isArray(v) && v.every((f) => plain(f) && Object.values(f).every(isScalar)
        && typeof f.name === 'string' && (typeof f.value === 'string' || typeof f.value === 'number'))) continue;
    if ((k === 'info' || k === 'basicInfo') && Array.isArray(v) && v.every(isScalar)) continue; // r4: basicInfo, never read
    if (k === 'children' && Array.isArray(v) && v.length === 0) continue;
    // K3.1 r2-3: `groups` (CatalogItem.init) is metadata: scalars or flat scalar-only objects, never read into an item
    if (k === 'groups' && Array.isArray(v) && v.every((g) => isScalar(g) || (plain(g) && Object.values(g).every(isScalar)))) continue;
    shape();
  }
  if (!Array.isArray(o.features)) shape();
  const found = collectSessions({ items: [{ ...o, info: undefined, basicInfo: undefined, children: undefined, groups: undefined }] });
  if (found.length !== 1) shape();
  return found[0];
}

export interface HttpReq { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; form?: Record<string, string> }
export interface ReadDeps { http(req: HttpReq): Promise<{ status: number; body: string }>; now(): number; sleep(ms: number): Promise<void> }
export interface ReadOut {
  status: 'ok' | 'site_block' | 'http_error' | 'layout_changed' | 'incomplete'; sessions: Session[]; raw?: Record<string, string>;
  requests: number; httpStatus?: number; notes?: Record<string, number>;
}
/** Where the JSON answers come from: the network (runRead) or a saved read (`--from`). `left()` is the request budget left. */
export interface JsonSource { tabs(): Promise<string>; tab(t: string, p: number): Promise<string>; group(t: string, g: string, p: number): Promise<string>; left(): number }

/**
 * DR-K3.1-2/5: tabs -> youth tabs (paged) -> each deferred activity group (paged). Blocks and HTTP errors propagate at once; a shape
 * failure is remembered and the read goes on, so the saved raw is complete for `--from`; the result is then layout_changed.
 */
export async function collect(src: JsonSource, raw: Record<string, string> = {}): Promise<Omit<ReadOut, 'requests' | 'httpStatus'>> {
  const notes: Record<string, number> = { tabs_skipped: 0, groups_skipped: 0, groups_repeated: 0, groups: 0, plan: 0 };
  const skippedIds = new Set<string>();
  let bad = false;
  const parse = (body: string): unknown => { try { return JSON.parse(body); } catch { bad = true; return undefined; } };
  const records: { rec: unknown; group?: { id: string; name: string } }[] = [];
  const refs: { tab: string; ref: GroupRef }[] = [];
  raw['tabs.json'] = await src.tabs();
  let tabs: string[];
  try { const c = chooseTabs(parse(raw['tabs.json'])); tabs = c.ids; notes.tabs_skipped = c.skipped; } catch (e) { if (e instanceof Rec1Fail) return { status: 'layout_changed', sessions: [], raw, notes }; throw e; }
  for (const tab of tabs) {
    for (let p = 1; ; p++) {
      if (src.left() <= 0) return { status: 'incomplete', sessions: [], raw, notes };
      const body = await src.tab(tab, p);
      raw[p === 1 ? `tab-${tab}.json` : `tab-${tab}-p${p}.json`] = body;
      let t;
      try { t = parseTabAnswer(parse(body)); } catch (e) { if (!(e instanceof Rec1Fail)) throw e; bad = true; break; }
      records.push(...t.records.map((rec) => ({ rec })));
      for (const ref of t.refs) {
        // r3: the same group is listed under several sections and tabs; read it once (first tab), skip non-event groups
        if (refs.some((x) => x.ref.groupId === ref.groupId) || skippedIds.has(ref.groupId)) { notes.groups_repeated++; continue; }
        if (SKIP_GROUP.test(ref.name ?? '')) { skippedIds.add(ref.groupId); notes.groups_skipped++; continue; }
        refs.push({ tab, ref });
      }
      notes.groups_skipped += t.skipped;
      if (!t.hasMore) break;
    }
  }
  notes.groups = refs.length;
  const manifest = { version: 1, tabs, groups: [] as { tab: string; group: string; itemCount: number; sessions: number }[], outcome: '' };
  const finish = <T extends { status: string }>(o: T): T => { manifest.outcome = o.status; raw['manifest.json'] = JSON.stringify(manifest); return o; };
  notes.plan = refs.reduce((n, r) => n + Math.ceil(r.ref.itemCount / PAGE_GUESS), 0);
  if (notes.plan > src.left()) return finish({ status: 'incomplete' as const, sessions: [], raw, notes });
  for (const { tab, ref } of refs) {
    if (ref.itemCount === 0) continue;
    const ids = new Set<string>();
    let authority = ref.itemCount;
    for (let p = 1; ; p++) {
      if (src.left() <= 0) return finish({ status: 'incomplete' as const, sessions: [], raw, notes });
      const body = await src.group(tab, ref.groupId, p);
      raw[`group-${tab}-${ref.groupId}-p${p}.json`] = body;
      let g;
      try { g = parseGroupAnswer(parse(body)); } catch (e) { if (!(e instanceof Rec1Fail)) throw e; bad = true; break; }
      // K3.1 r5 (third read: discovery said 15, the group answered 18): the group endpoint's own count is the authority; it must
      // stay the same on every page of that group. The discovery count only sizes the plan.
      if (p === 1) authority = g.itemCount;
      else if (g.itemCount !== authority) { bad = true; break; }
      const before = ids.size;
      for (const r of g.records) {
        records.push({ rec: r, group: { id: ref.groupId, name: ref.name ?? '' } });
        const id = plain(r) && (typeof r.id === 'string' || typeof r.id === 'number') ? String(r.id) : '';
        if (id) ids.add(id);
      }
      if (ids.size >= authority) { if (ids.size !== authority) bad = true; break; } // r2-1: exactly itemCount unique ids
      if (ids.size === before) { bad = true; break; } // ended short of itemCount: not a full snapshot of the group
    }
    manifest.groups.push({ tab, group: ref.groupId, itemCount: authority, sessions: ids.size });
  }
  const sessions: Session[] = [];
  for (const r of records) { try { sessions.push({ ...toSession(r.rec), ...(r.group ? { group: r.group } : {}) }); } catch (e) { if (!(e instanceof Rec1Fail)) throw e; bad = true; } }
  if (bad) return finish({ status: 'layout_changed' as const, sessions: [], raw, notes });
  const seen = new Map<string, Session>();
  for (const x of sessions) {
    const prev = seen.get(x.id);
    if (!prev) seen.set(x.id, x);
    else if (JSON.stringify(prev) !== JSON.stringify(x)) prev.flags.duplicateConflict = true; // same id, different facts: dropped as conflict
  }
  return finish({ status: 'ok' as const, sessions: [...seen.values()], raw, notes });
}

/** DR-K3-4/5 + K3.1: page, tabs, youth tabs, deferred groups; <= 80 requests, >= 6 s apart; stop at once on a block. */
export async function runRead(cfg: Rec1Config, deps: ReadDeps): Promise<ReadOut> {
  if (!CATALOG_URL.test(cfg.catalogUrl)) throw new Error('config_rec1_invalid');
  let requests = 0;
  let retries = 0;
  let last = -Infinity;
  async function call(req: HttpReq, json: boolean): Promise<string> {
    if (requests >= REQUEST_BUDGET) throw new Error('budget');
    const wait = last + SPACING_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    last = deps.now();
    requests++;
    let r = await deps.http(req);
    // K3.1 r6: Rec1 sometimes takes > 30 s on one group (curl exit 28 in reads 2 and 4, different groups). A transport failure (no HTTP
    // status) is retried once after 30 s, at most 3 times a read, inside the budget. Any HTTP status, block or challenge is never retried.
    if (r.status === 0 && retries < MAX_RETRIES && requests < REQUEST_BUDGET) {
      retries++;
      await deps.sleep(RETRY_WAIT_MS);
      last = deps.now();
      requests++;
      r = await deps.http(req);
    }
    if (isBlocked(r.status, r.body)) throw Object.assign(new Rec1Fail('site_block'), { httpStatus: r.status });
    if (r.status !== 200) throw Object.assign(new Rec1Fail('http_error'), { httpStatus: r.status });
    if (json) { try { JSON.parse(r.body); } catch { throw new Rec1Fail('site_block'); } }
    return r.body;
  }
  const raw: Record<string, string> = {}; // filled as answers arrive, so a failed read keeps what it got
  try {
    const page = extractPage(await call({ method: 'GET', url: cfg.catalogUrl, headers: { Accept: 'text/html' } }, false));
    const xhr = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-KEY': page.csrfKey, 'X-CSRF-TOKEN': page.csrfToken };
    const base = `${cfg.catalogUrl}/`;
    const okId = (s: string) => { if (!/^\d{1,12}$/.test(s)) throw new Rec1Fail('layout_changed'); return s; };
    const src: JsonSource = {
      left: () => REQUEST_BUDGET - requests,
      tabs: () => call({ method: 'GET', url: `${base}getTabs/${page.key}`, headers: xhr }, true),
      tab: (t, p) => call({ method: 'POST', url: `${base}getItems/${page.key}/${okId(t)}`, headers: xhr, form: { page: String(p) } }, true),
      group: (t, g, p) => call({ method: 'POST', url: `${base}getActivitySessions/${page.key}/${okId(t)}/${okId(g)}`, headers: xhr, form: { page: String(p) } }, true),
    };
    const out = await collect(src, raw);
    return { ...out, requests };
  } catch (e) {
    if (e instanceof Rec1Fail) return { status: e.code, sessions: [], raw, requests, httpStatus: (e as { httpStatus?: number }).httpStatus };
    throw e;
  }
}
