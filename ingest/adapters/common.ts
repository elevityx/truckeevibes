// Helpers shared by the adapters. Nothing here keeps description text.
import { createHash } from 'node:crypto';
import { classify } from '../core/classify';
import { cleanTitle, plainText } from '../core/normalize';
import type { SourceEvent } from '../types';

export const DEFAULT_TZ = 'America/Los_Angeles';

export const sha256Hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const decodeUtf8 = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

export function cap(s: string | undefined | null, n: number): string | undefined {
  if (s == null) return undefined;
  const t = plainText(s);
  return t === '' ? undefined : t.slice(0, n);
}

export function tzOf(config: Record<string, unknown>): string {
  return typeof config.tz === 'string' && config.tz ? config.tz : DEFAULT_TZ;
}

export interface EventFacts {
  externalKey: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  tz: string;
  venueName?: string;
  address?: string;
  town?: string;
  lat?: number;
  lng?: number;
  url?: string;
  ticketUrl?: string;
  priceText?: string;
  ageText?: string;
  hints?: string[];
  cancelled?: boolean;
  seriesUid?: string;
}

/** Builds a `SourceEvent` from facts plus a description that is used for classification and then discarded. */
export function makeEvent(f: EventFacts, description?: string): SourceEvent {
  const title = cleanTitle(plainText(f.title));
  const priceText = cap(f.priceText, 80);
  const ageText = cap(f.ageText, 80);
  const c = classify({ title, categoriesHint: f.hints ?? [], priceText, ageText }, description);
  const e: SourceEvent = {
    externalKey: f.externalKey, title, startsAt: f.startsAt, allDay: f.allDay, timeKnown: !f.allDay, tz: f.tz,
    categoriesHint: c.categories, rawSummaryLength: description ? description.length : 0,
    priceKind: c.priceKind, age: c.age,
  };
  if (f.endsAt && !f.allDay) e.endsAt = f.endsAt;
  if (f.allDay) { e.startDate = f.startDate; e.endDate = f.endDate; }
  const venue = cap(f.venueName, 80);
  if (venue) e.venueName = venue;
  const address = cap(f.address, 160);
  if (address) e.address = address;
  const town = cap(f.town, 60);
  if (town) e.town = town;
  if (typeof f.lat === 'number' && typeof f.lng === 'number' && Number.isFinite(f.lat) && Number.isFinite(f.lng)) { e.lat = f.lat; e.lng = f.lng; }
  if (f.url) e.url = f.url;
  if (f.ticketUrl) e.ticketUrl = f.ticketUrl;
  if (priceText) e.priceText = priceText;
  if (ageText) e.ageText = ageText;
  if (c.priceMin !== undefined) e.priceMin = c.priceMin;
  if (c.priceMax !== undefined) e.priceMax = c.priceMax;
  if (f.cancelled) e.cancelled = true;
  if (f.seriesUid) e.seriesUid = f.seriesUid;
  return e;
}

/** `YYYY-MM-DD` plus whole days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The calendar date `now` falls on in `tz`. */
export function localDate(now: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function dedupe(items: SourceEvent[]): SourceEvent[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.externalKey) ? false : (seen.add(i.externalKey), true)));
}
