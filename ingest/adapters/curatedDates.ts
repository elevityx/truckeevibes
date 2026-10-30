// curated_dates adapter (A14). Emits only the dates listed in the source config; it makes no network call and generates no date.
// The config is the evidence (its `provenance` says where the dates were read and when); a new date is added only through a reviewed migration.
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { addDays, dedupe, localDate, makeEvent, sha256Hex, tzOf } from './common';
import { OUR_SLUGS } from '../core/categoryMaps';
import { isValidZone, toUtcFromLocal } from '../core/normalize';

const KEYS = new Set(['tz', 'provenance', 'title', 'venueName', 'address', 'town', 'lat', 'lng', 'url', 'priceText', 'categories', 'dates']);
const bad = () => new Error('config_dates_invalid');
const str = (v: unknown, max = 200): string => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(); return v; };
const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const isHm = (s: unknown): s is string => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);

interface Row { date: string; start: string; end?: string }
interface Cfg {
  tz: string; title: string; venueName: string; address: string; town: string; lat: number; lng: number; url: string; priceText?: string;
  categories: string[]; dates: Row[];
}

function validate(ctx: AdapterCtx): Cfg {
  const c = ctx.source.config;
  for (const k of Object.keys(c)) if (!KEYS.has(k)) throw bad();
  const tz = tzOf(c);
  if (!isValidZone(tz)) throw bad();
  const provenance = str(c.provenance, 200);
  if (provenance.length < 10 || provenance.length > 120) throw bad();
  const lat = c.lat;
  const lng = c.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) throw bad();
  const url = str(c.url, 300);
  let host: string;
  try { const u = new URL(url); if (u.protocol !== 'https:') throw bad(); host = u.hostname.toLowerCase(); } catch { throw bad(); }
  if (!ctx.source.allowed_hosts.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`))) throw bad();
  const cats = c.categories;
  if (!Array.isArray(cats) || cats.length === 0 || !cats.every((x) => typeof x === 'string' && (OUR_SLUGS as readonly string[]).includes(x))) throw bad();
  const rows = c.dates;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 12) throw bad();
  const dates: Row[] = [];
  const limit = addDays(localDate(ctx.now, tz), 200);
  for (const r of rows as unknown[]) {
    const x = r as { date?: unknown; start?: unknown; end?: unknown } | null;
    if (!x || typeof x !== 'object' || !isDate(x.date) || !isHm(x.start) || (x.end !== undefined && (!isHm(x.end) || x.end <= x.start))) throw bad();
    if (dates.length > 0 && x.date <= dates[dates.length - 1].date) throw bad();
    dates.push({ date: x.date, start: x.start, end: x.end as string | undefined });
  }
  if (dates[dates.length - 1].date > limit) throw bad();
  return {
    tz, title: str(c.title, 120), venueName: str(c.venueName, 80), address: str(c.address, 160), town: str(c.town, 60), lat, lng, url,
    priceText: c.priceText === undefined ? undefined : str(c.priceText, 80), categories: cats as string[], dates,
  };
}

export const adapter: Adapter = {
  family: 'curated_dates',
  version: 'curated_dates.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const cfg = validate(ctx);
    const today = localDate(ctx.now, cfg.tz);
    const last = addDays(today, 120);
    const items: SourceEvent[] = [];
    for (const r of cfg.dates) {
      if (r.date < today || r.date > last) continue;
      const startsAt = toUtcFromLocal(r.date, r.start, cfg.tz);
      if (startsAt === 'dst_gap') continue;
      const endsAt = r.end ? toUtcFromLocal(r.date, r.end, cfg.tz) : undefined;
      items.push(makeEvent({
        externalKey: `curated:${ctx.source.slug}#${r.date}`, title: cfg.title, startsAt, endsAt: endsAt === 'dst_gap' ? undefined : endsAt, allDay: false, tz: cfg.tz,
        venueName: cfg.venueName, address: cfg.address, town: cfg.town, lat: cfg.lat, lng: cfg.lng, url: cfg.url, priceText: cfg.priceText,
        hints: cfg.categories, family: 'curated_dates',
      }));
    }
    return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(JSON.stringify(ctx.source.config)) };
  },
};
