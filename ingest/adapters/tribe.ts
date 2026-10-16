// The Events Calendar (Tribe) REST adapter (spec S1.9 tribe, A2 config.filter). Request kind `api` only.
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { addDays, dedupe, decodeUtf8, localDate, makeEvent, sha256Hex, tzOf } from './common';
import { toUtcFromLocal } from '../core/normalize';

interface TribeVenue { venue?: string; address?: string; city?: string; geo_lat?: number | string; geo_lng?: number | string }
interface TribeEvent {
  id: number | string; title?: string; url?: string; description?: string; all_day?: boolean; cost?: string;
  start_date?: string; end_date?: string; utc_start_date?: string; utc_end_date?: string;
  categories?: { slug?: string }[]; venue?: TribeVenue | unknown[];
}
interface TribeFilter { windowDays?: number; towns?: string[]; maxDurationDays?: number; excludeCategorySlugs?: string[]; maxItems?: number }

const utcIso = (s: string | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : undefined);

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function filterOf(config: Record<string, unknown>): TribeFilter | undefined {
  const f = config.filter;
  return f && typeof f === 'object' && !Array.isArray(f) ? (f as TribeFilter) : undefined;
}

function toEvent(e: TribeEvent, tz: string): { item: SourceEvent; city: string; slugs: string[]; cats: Set<string>; startMs: number; endMs: number } | null {
  if (e.id === undefined || e.id === null || !e.start_date) return null;
  const venue = e.venue && !Array.isArray(e.venue) && typeof e.venue === 'object' ? (e.venue as TribeVenue) : undefined;
  const slugs = (e.categories ?? []).map((c) => String(c.slug ?? '')).filter(Boolean);
  const cats = new Set((e.categories ?? []).map((c) => String(c?.slug ?? '').trim().toLowerCase()).filter(Boolean));
  const allDay = e.all_day === true;
  const localStart = e.start_date.slice(0, 10);
  let startsAt = utcIso(e.utc_start_date);
  if (!startsAt) {
    const r = toUtcFromLocal(localStart, (e.start_date.slice(11, 19) || '00:00:00'), tz);
    if (r === 'dst_gap') return null;
    startsAt = r;
  }
  const endsAt = utcIso(e.utc_end_date);
  const description = typeof e.description === 'string' ? e.description : undefined;
  const item = makeEvent({
    externalKey: String(e.id), title: e.title ?? '', startsAt, endsAt, allDay,
    startDate: allDay ? localStart : undefined,
    endDate: allDay ? addDays((e.end_date ?? e.start_date).slice(0, 10), 1) : undefined,
    tz, venueName: venue?.venue, address: venue?.address, town: venue?.city,
    lat: num(venue?.geo_lat), lng: num(venue?.geo_lng), url: typeof e.url === 'string' ? e.url : undefined,
    priceText: typeof e.cost === 'string' ? e.cost : undefined, hints: slugs, family: 'tribe',
  }, description);
  const startMs = Date.parse(startsAt);
  const endMs = endsAt ? Date.parse(endsAt) : startMs;
  return { item, city: (venue?.city ?? '').trim().toLowerCase(), slugs, cats, startMs, endMs };
}

export const adapter: Adapter = {
  family: 'tribe',
  version: 'tribe.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const { source, now } = ctx;
    const config = source.config;
    const base = typeof config.base === 'string' ? config.base.replace(/\/+$/, '') : '';
    if (!base) throw new Error('config_base_required');
    const tz = tzOf(config);
    const filter = filterOf(config);
    const today = localDate(now, tz);
    const windowDays = filter?.windowDays && filter.windowDays >= 1 && filter.windowDays <= 120 ? filter.windowDays : 120;
    const end = addDays(today, windowDays);

    const events: TribeEvent[] = [];
    const bodies: string[] = [];
    let httpStatus = 200;
    for (let page = 1; page <= source.page_cap; page++) {
      const q = new URLSearchParams({ start_date: today, end_date: end, per_page: '50', page: String(page) });
      const res = await ctx.fetch(`${base}/wp-json/tribe/events/v1/events?${q.toString()}`, { kind: 'api' });
      if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status };
      httpStatus = res.status;
      const text = decodeUtf8(res.body);
      bodies.push(text);
      const json = JSON.parse(text) as { events?: unknown; next_rest_url?: unknown };
      if (!Array.isArray(json.events)) throw new Error('bad_shape');
      events.push(...(json.events as TribeEvent[]));
      if (!json.next_rest_url) break;
    }

    let filtered = 0;
    const kept: SourceEvent[] = [];
    const towns = filter?.towns ? new Set(filter.towns.map((t) => String(t).trim().toLowerCase())) : undefined;
    const exclude = filter?.excludeCategorySlugs ? new Set(filter.excludeCategorySlugs.map((x) => String(x).trim().toLowerCase()).filter(Boolean)) : undefined;
    for (const e of events) {
      const m = toEvent(e, tz);
      if (!m) continue;
      if (filter) {
        if (towns && (m.city === '' || !towns.has(m.city))) { filtered++; continue; }
        if (typeof filter.maxDurationDays === 'number' && m.endMs - m.startMs > filter.maxDurationDays * 86_400_000) { filtered++; continue; }
        if (exclude && exclude.size > 0 && [...m.cats].some((c) => exclude.has(c))) { filtered++; continue; }
      }
      kept.push(m.item);
    }
    const items = dedupe(kept);
    const out: Partial<AdapterResult> = filter ? { filtered } : {};
    if (typeof filter?.maxItems === 'number' && items.length > filter.maxItems) {
      return { items: [], status: 'parse_error', errorCode: 'filter_cap', httpStatus, ...out };
    }
    return { items, status: 'ok', httpStatus, contentHash: sha256Hex(bodies.join('\n')), ...out };
  },
};
