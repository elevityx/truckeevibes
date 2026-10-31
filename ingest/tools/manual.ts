// Manual (owner-invoked) readers for sources that block bots (Spec_Manual_Sources M1). Never scheduled: every source here is
// manual_only, so the cron grant path never returns it. A curl-backed `ctx.fetch` lets the existing Adapter interface run unchanged
// (Tribe), and three small mappers cover the other shapes. Facts only: title, time, venue, link. None of these families is in
// `ingest/adapters/index.ts` (the scheduled registry); this registry is the only way to read them.
import { adapter as tribe } from '../adapters/tribe';
import { addDays, decodeUtf8, localDate, makeEvent, sha256Hex, tzOf, dedupe } from '../adapters/common';
import { parseIcs } from '../adapters/ics';
import type { FetchKind, FetchOut, PoliteFetch } from '../core/politeFetch';
import { isValidZone, toUtcFromLocal, validateSourceEvent } from '../core/normalize';
import { applyNotices } from '../core/notices';
import { applySourceDefaults, stripMembersOnly } from '../run';
import { isBlocked } from './rec1';
import type { Adapter, AdapterCtx, AdapterResult, GrantOut, SourceEvent } from '../types';

export const SPACING_MS = 6_000;
export const MAX_ITEMS = 1000;
export const MAX_PAYLOAD_BYTES = 2_097_152;
export class ManualBlock extends Error { constructor(readonly httpStatus: number) { super('site_block'); } }
export class ManualLayout extends Error { constructor() { super('layout_changed'); } }
/** A guard refused a request before curl ran (`host_not_allowed`, `method_not_allowed`, `page_cap`, ...). */
export class ManualRefused extends Error {}

export interface ShimDeps { http(url: string): Promise<{ status: number; body: string }>; now(): number; sleep(ms: number): Promise<void> }
/**
 * DR-M2: https only, no credentials or port in the URL, host in allowed_hosts, kind in allowed_methods, <= page_cap requests,
 * >= 6 s apart. 401/403/429 or a challenge page throws ManualBlock before the adapter sees the body (review P0-2).
 */
export function curlFetch(source: GrantOut['source'], deps: ShimDeps): PoliteFetch & { requests(): number } {
  let n = 0;
  let last = -Infinity;
  const f = async (url: string, opts: { kind: FetchKind }): Promise<FetchOut> => {
    let u: URL;
    try { u = new URL(url); } catch { throw new ManualRefused('bad_url'); }
    if (u.protocol !== 'https:') throw new ManualRefused('not_https');
    if (u.username || u.password || u.port) throw new ManualRefused('url_credentials_or_port');
    if (!source.allowed_hosts.includes(u.hostname)) throw new ManualRefused('host_not_allowed');
    if (!source.allowed_methods.includes(opts?.kind)) throw new ManualRefused('method_not_allowed');
    if (n >= source.page_cap) throw new ManualRefused('page_cap');
    const wait = last + SPACING_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    last = deps.now();
    n++;
    const r = await deps.http(u.toString());
    if (isBlocked(r.status, r.body)) throw new ManualBlock(r.status);
    return { status: r.status, headers: new Headers(), body: new TextEncoder().encode(r.body), notModified: false, finalUrl: u.toString() };
  };
  return Object.assign(f, { robotsInfo: () => undefined, fetchRobots: async () => {}, requests: () => n });
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const hintsOf = (c: Record<string, unknown>) => (Array.isArray(c.hints) ? c.hints.filter((h): h is string => typeof h === 'string').slice(0, 5) : []);
interface VenueCfg { match?: string; name?: string; address?: string; town?: string; lat?: number; lng?: number }
const venueOf = (v: unknown): VenueCfg => (v && typeof v === 'object' && !Array.isArray(v) ? v as VenueCfg : {});
const httpsUrl = (v: unknown, host?: string) => {
  try { const u = new URL(str(v)); return u.protocol === 'https:' && !u.port && !u.username && (!host || u.hostname === host) ? u.toString() : undefined; } catch { return undefined; }
};

/**
 * DR-M5 (review P1-4): an item without coordinates takes them from config. `config.venues[]` entries (`match` = a case-insensitive
 * regex on the item's venue name) replace the venue facts; an item with no venue name takes `config.venue`. An item that already
 * has coordinates, or names another venue that matches nothing, keeps its own facts.
 */
export function withVenue(e: SourceEvent, cfg: Record<string, unknown>): SourceEvent {
  const town = str(cfg.town) || undefined;
  if (typeof e.lat === 'number' && typeof e.lng === 'number') return { ...e, town: e.town ?? town };
  const list = Array.isArray(cfg.venues) ? cfg.venues.map(venueOf) : [];
  const single = venueOf(cfg.venue);
  let v: VenueCfg | undefined;
  if (e.venueName) {
    // a single-venue source (no venues[]) puts every item at its venue (PR review P1-3)
    v = list.length === 0 ? single : list.find((x) => { try { return !!x.match && new RegExp(x.match, 'i').test(e.venueName ?? ''); } catch { return false; } });
  } else {
    v = single;
  }
  if (!v || !v.name || num(v.lat) === undefined || num(v.lng) === undefined) return { ...e, town: e.town ?? town };
  const out: SourceEvent = { ...e, venueName: v.name, lat: v.lat, lng: v.lng, town: v.town ?? town ?? e.town };
  if (v.address) out.address = v.address; else delete out.address;
  return out;
}

function finish(items: SourceEvent[], dropped: Record<string, number>, body: string): AdapterResult & { dropped: Record<string, number> } {
  return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(body), filteredBy: dropped, dropped };
}

// Review P1-6: anchored; hour 1-12, optional :mm, am/pm, optional separator, then the rest.
const TITLE_TIME = /^\s*(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?\s*(?:[-–—:|]+\s*)?(\S[\s\S]*)$/i;
/** `9pm Blues Monsters` -> 21:00 + `Blues Monsters`; anything else (or a rest under 3 characters) -> null. */
export function titleTime(title: string): { hhmm: string; rest: string } | null {
  const m = TITLE_TIME.exec(title);
  if (!m) return null;
  const rest = m[4].trim();
  if (rest.length < 3) return null;
  const h = (+m[1] % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  return { hhmm: `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`, rest };
}

/**
 * DR-M4 manual_gcal: a public Google Calendar ICS. A one-day all-day row titled with a leading time becomes a timed row at that
 * local time with the time stripped; every other all-day row drops (`no_time`, it would never auto-publish); timed rows stay.
 * The link is always `config.link` (never a VEVENT URL or calendar.google.com).
 */
export function mapGcal(text: string, cfg: Record<string, unknown>, now: Date) {
  if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) throw new ManualLayout();
  const tz = tzOf(cfg);
  const link = httpsUrl(cfg.link);
  if (!link) throw new Error('config_link');
  const r = parseIcs(text, { now, family: 'ics', tz, eventUrl: link });
  const dropped: Record<string, number> = { ...r.dropped };
  const drop = (c: string) => { dropped[c] = (dropped[c] ?? 0) + 1; };
  const items: SourceEvent[] = [];
  // The venue name goes into makeEvent so the classifier sees it (adult venue words; PR review P1-3).
  const vName = venueOf(cfg.venue).name;
  const hints = hintsOf(cfg);
  for (const e of r.items) {
    if (!e.allDay) {
      if (Date.parse(e.startsAt) < now.getTime()) { drop('past'); continue; }
      items.push(makeEvent({ externalKey: e.externalKey, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, allDay: false, tz: e.tz, url: link,
        venueName: vName ?? e.venueName, family: 'ics', hints, cancelled: e.cancelled, seriesUid: e.seriesUid }));
      continue;
    }
    const t = titleTime(e.title);
    if (!t || !e.startDate || e.endDate !== addDays(e.startDate, 1)) { drop('no_time'); continue; }
    const startsAt = toUtcFromLocal(e.startDate, t.hhmm, tz);
    if (startsAt === 'dst_gap') { drop('dst_gap'); continue; }
    if (Date.parse(startsAt) < now.getTime()) { drop('past'); continue; }
    items.push(makeEvent({ externalKey: e.externalKey, title: t.rest, startsAt, allDay: false, tz, url: link, venueName: vName, family: 'ics', hints, cancelled: e.cancelled }));
  }
  return finish(items, dropped, text);
}

/** DR-M4 manual_elfsight: the Event Calendar widget's boot JSON; one-off dated events only. */
export function mapElfsight(text: string, cfg: Record<string, unknown>, now: Date) {
  const wid = str(cfg.widget);
  if (!/^[0-9a-f-]{36}$/.test(wid)) throw new Error('config_widget');
  let events: unknown;
  try {
    const j = JSON.parse(text) as { data?: { widgets?: Record<string, { data?: { settings?: { events?: unknown } } }> } };
    events = j.data?.widgets?.[wid]?.data?.settings?.events;
  } catch { throw new ManualLayout(); }
  if (!Array.isArray(events)) throw new ManualLayout();
  const tz0 = tzOf(cfg);
  const link = httpsUrl(cfg.link);
  if (!link) throw new Error('config_link');
  const today = localDate(now, tz0);
  const last = addDays(today, 120);
  const winEnd = now.getTime() + 120 * 86_400_000;
  const vName = venueOf(cfg.venue).name;
  const dropped: Record<string, number> = {};
  const drop = (c: string) => { dropped[c] = (dropped[c] ?? 0) + 1; };
  const items: SourceEvent[] = [];
  const D = /^\d{4}-\d{2}-\d{2}$/, T = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const raw of events) {
    const e = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; name?: unknown; start?: { type?: unknown; date?: unknown; time?: unknown }; end?: { type?: unknown; date?: unknown; time?: unknown }; timeZone?: unknown; repeatPeriod?: unknown };
    const id = str(e.id), name = str(e.name).trim();
    if (!/^[0-9a-z-]{1,64}$/i.test(id) || !name) { drop('invalid'); continue; }
    if (e.repeatPeriod !== 'noRepeat') { drop('repeating'); continue; }
    const st = e.start?.type, et = e.end?.type;
    if ((st !== 'date' && st !== 'datetime') || st !== et) { drop('type_unsupported'); continue; }
    const tz = isValidZone(str(e.timeZone)) ? str(e.timeZone) : tz0;
    const sd = str(e.start?.date), ed = str(e.end?.date);
    if (!D.test(sd) || !D.test(ed) || ed < sd) { drop('date_unparsed'); continue; }
    if (ed < today || sd > last) { drop('out_of_window'); continue; }
    const key = `elfsight:${wid}#${id}`;
    if (st === 'date') {
      if (sd < today) { drop('past'); continue; } // the database refuses a start more than a day back (PR review P2-1)
      // Elfsight's all-day end date is inclusive; the database wants an exclusive end (review P1-6).
      if (ed > addDays(sd, 14)) { drop('long_range'); continue; }
      const mid = toUtcFromLocal(sd, '00:00', tz);
      if (mid === 'dst_gap') { drop('dst_gap'); continue; }
      if (Date.parse(mid) > winEnd) { drop('out_of_window'); continue; }
      items.push(makeEvent({ externalKey: key, title: name, startsAt: mid, allDay: true, startDate: sd, endDate: addDays(ed, 1), tz, url: link, venueName: vName, family: 'elfsight', hints: hintsOf(cfg) }));
      continue;
    }
    if (!T.test(str(e.start?.time)) || !T.test(str(e.end?.time))) { drop('time_unparsed'); continue; }
    const s = toUtcFromLocal(sd, str(e.start?.time), tz);
    const en = toUtcFromLocal(ed, str(e.end?.time), tz);
    if (s === 'dst_gap' || en === 'dst_gap') { drop('dst_gap'); continue; }
    const span = Date.parse(en) - Date.parse(s);
    if (!(span > 0 && span <= 12 * 3_600_000)) { drop('implausible_time'); continue; }
    if (Date.parse(s) < now.getTime()) { drop('past'); continue; }
    if (Date.parse(s) > winEnd) { drop('out_of_window'); continue; }
    items.push(makeEvent({ externalKey: key, title: name, startsAt: s, endsAt: en, allDay: false, tz, url: link, venueName: vName, family: 'elfsight', hints: hintsOf(cfg) }));
  }
  return finish(items, dropped, text);
}

/** DR-M4 manual_squarespace: an events collection's `?format=json`; `upcoming[]` with ms times; links stay on the site's host. */
export function mapSquarespace(text: string, cfg: Record<string, unknown>, now: Date) {
  const page = httpsUrl(cfg.link);
  if (!page) throw new Error('config_link');
  const host = new URL(page).hostname;
  let up: unknown;
  try { up = (JSON.parse(text) as { upcoming?: unknown }).upcoming; } catch { throw new ManualLayout(); }
  if (!Array.isArray(up)) throw new ManualLayout();
  const tz = tzOf(cfg);
  const dropped: Record<string, number> = {};
  const drop = (c: string) => { dropped[c] = (dropped[c] ?? 0) + 1; };
  const items: SourceEvent[] = [];
  const end = now.getTime() + 120 * 86_400_000;
  for (const raw of up) {
    const e = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; title?: unknown; startDate?: unknown; endDate?: unknown; fullUrl?: unknown; location?: { addressTitle?: unknown; addressLine1?: unknown; addressLine2?: unknown; mapLat?: unknown; mapLng?: unknown } };
    const id = str(e.id), title = str(e.title).trim();
    const sMs = num(e.startDate);
    if (!/^[0-9a-f]{12,32}$/.test(id) || !title || sMs === undefined) { drop('invalid'); continue; }
    const eMs = e.endDate === undefined || e.endDate === null ? undefined : num(e.endDate);
    if (e.endDate !== undefined && e.endDate !== null && (eMs === undefined || eMs <= sMs)) { drop('implausible_time'); continue; }
    if (sMs < now.getTime()) { drop('past'); continue; }
    if (sMs > end) { drop('out_of_window'); continue; }
    const fu = str(e.fullUrl);
    if (!/^\/(?!\/)/.test(fu)) { drop('off_site_link'); continue; }
    const full = httpsUrl(`https://${host}${fu}`, host);
    if (!full) { drop('off_site_link'); continue; }
    const url = full.length <= 300 ? full : page; // a much-duplicated event's slug can outgrow the 300-char URL limit (PR review P2-3)
    const endsAt = eMs !== undefined && eMs - sMs <= 24 * 3_600_000 ? new Date(eMs).toISOString() : undefined;
    const loc = e.location && typeof e.location === 'object' ? e.location : {};
    const lat = num(loc.mapLat), lng = num(loc.mapLng);
    const geo = lat !== undefined && lng !== undefined && lat !== 0 && lng !== 0;
    items.push(makeEvent({ externalKey: `sqs:${host}#${id}`, title, startsAt: new Date(sMs).toISOString(), endsAt, allDay: false, tz, url,
      venueName: str(loc.addressTitle).trim() || venueOf(cfg.venue).name || undefined, address: [str(loc.addressLine1), str(loc.addressLine2)].map((x) => x.trim()).filter(Boolean).join(', ') || undefined,
      lat: geo ? lat : undefined, lng: geo ? lng : undefined, family: 'squarespace', hints: hintsOf(cfg) }));
  }
  return finish(items, dropped, text);
}

type Mapper = (text: string, cfg: Record<string, unknown>, now: Date) => AdapterResult & { dropped: Record<string, number> };
const ONE_URL: Record<string, Mapper> = { manual_gcal: mapGcal, manual_elfsight: mapElfsight, manual_squarespace: mapSquarespace };

/** The adapter for a manual source: `config.mapper` names one of the single-URL mappers, or the family is Tribe (existing adapter). */
export function manualAdapter(source: GrantOut['source']): Adapter {
  const name = str(source.config.mapper);
  if (Object.prototype.hasOwnProperty.call(ONE_URL, name)) {
    return {
      family: source.family, version: `${name}.1`,
      async fetch(ctx: AdapterCtx) {
        const res = await ctx.fetch(str(source.config.feedUrl), { kind: 'feed' });
        if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status };
        return ONE_URL[name](decodeUtf8(res.body), source.config, ctx.now);
      },
    };
  }
  if (source.family === 'tribe' && !name) return tribe;
  throw new Error('no_manual_adapter');
}

/**
 * The runner's post-adapter pipeline (ingest/run.ts `produce`, review P1-5): item cap, config venue, validate, notices,
 * members-only strip, source default categories, payload cap. Returns the items to submit, or an error code.
 */
export function postProcess(items: SourceEvent[], source: GrantOut['source']): { items: SourceEvent[]; invalid: number; noticeDropped: number; cancelled: number } | { error: string } {
  if (items.length > MAX_ITEMS) return { error: 'too_many_items' };
  const valid: SourceEvent[] = [];
  let invalid = 0;
  for (const it of items) {
    const v = validateSourceEvent(withVenue(it, source.config));
    if ('invalid' in v) invalid++;
    else valid.push(v);
  }
  const noticed = applyNotices(valid, tzOf(source.config));
  const out = noticed.items.map((i) => applySourceDefaults(stripMembersOnly(i, source.family), source.config));
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_PAYLOAD_BYTES) return { error: 'too_large' };
  return { items: out, invalid, noticeDropped: noticed.dropped, cancelled: noticed.cancelled };
}
