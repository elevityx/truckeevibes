// schema.org Event JSON-LD parser (spec S1.9 jsonld). Pure; used by later sources, no M1 source depends on it.
import * as cheerio from 'cheerio';
import { toUtcFromLocal, isoZ } from '../core/normalize';
import type { SourceEvent } from '../types';
import { addDays, DEFAULT_TZ, makeEvent } from './common';

const MAX_SCRIPT = 200 * 1024;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function flatten(node: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (isObj(node)) {
    out.push(node);
    if (node['@graph']) flatten(node['@graph'], out);
  }
  return out;
}

function isEvent(n: Json): boolean {
  const t = n['@type'];
  return (Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && (/Event$/.test(x) || x === 'Festival'));
}

function address(a: unknown): string | undefined {
  if (typeof a === 'string') return a;
  if (isObj(a)) return [a.streetAddress, a.addressLocality, a.addressRegion].map(str).filter(Boolean).join(', ') || undefined;
  return undefined;
}

/** Offset-bearing -> that instant; local date-time -> `tz`; date only -> all-day. */
function when(s: string, tz: string): { kind: 'instant'; iso: string } | { kind: 'date'; date: string } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: 'date', date: s };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const ms = Date.parse(s); return Number.isNaN(ms) ? null : { kind: 'instant', iso: isoZ(ms) }; }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const r = toUtcFromLocal(m[1], `${m[2]}:${m[3] ?? '00'}`, tz);
  return r === 'dst_gap' ? null : { kind: 'instant', iso: r };
}

export function parseJsonLdEvents(html: string, pageUrl: string, opts: { tz?: string } = {}): SourceEvent[] {
  const tz = opts.tz ?? DEFAULT_TZ;
  const $ = cheerio.load(html);
  const out: SourceEvent[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (raw.length > MAX_SCRIPT) return;
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; }
    for (const n of flatten(json)) {
      if (!isEvent(n)) continue;
      const name = str(n.name);
      const startRaw = str(n.startDate);
      if (!name || !startRaw) continue;
      const start = when(startRaw, tz);
      if (!start) continue;
      const endRaw = str(n.endDate);
      const end = endRaw ? when(endRaw, tz) : null;
      const loc = Array.isArray(n.location) ? n.location[0] : n.location;
      const place = isObj(loc) ? loc : undefined;
      const geo = place && isObj(place.geo) ? place.geo : undefined;
      let url = pageUrl;
      const u = str(n.url);
      if (u) { try { url = new URL(u, pageUrl).href; } catch { /* keep the page URL */ } }
      const key = `${str(n['@id']) ?? u ?? pageUrl}|${startRaw}`;
      const description = str(n.description);
      const status = str(n.eventStatus) ?? '';
      const common = {
        externalKey: key, title: name, url, tz,
        venueName: place ? str(place.name) : typeof loc === 'string' ? loc : undefined,
        address: place ? address(place.address) : undefined,
        lat: geo ? Number(geo.latitude) : undefined, lng: geo ? Number(geo.longitude) : undefined,
        cancelled: /Cancel/i.test(status),
      };
      if (start.kind === 'date') {
        const mid = toUtcFromLocal(start.date, '00:00', tz);
        if (mid === 'dst_gap') continue;
        const ed = end && end.kind === 'date' ? addDays(end.date, 1) : addDays(start.date, 1);
        out.push(makeEvent({ ...common, startsAt: mid, allDay: true, startDate: start.date, endDate: ed > start.date ? ed : addDays(start.date, 1) }, description));
      } else {
        out.push(makeEvent({ ...common, startsAt: start.iso, endsAt: end && end.kind === 'instant' ? end.iso : undefined, allDay: false }, description));
      }
    }
  });
  return out;
}
