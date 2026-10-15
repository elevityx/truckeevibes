import type { VibeEvent } from '@/lib/data/types';
import { DEFAULT_LENGTH_MS, addDays } from '@/lib/time/pacific';

// Adapted from truckeelights src/components/events/links.ts. Every URL is built with URL/URLSearchParams,
// never by concatenating data into a string.

function gcalStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261030T230000Z
}

/** "Venue, address", the address alone, or the venue alone. */
export function placeLine(e: Pick<VibeEvent, 'venue' | 'address'>): string {
  return [e.venue, e.address].filter((p): p is string => !!p).join(', ');
}

/** Start and end instants for calendars; an event with no end gets the same 3 hours the list uses. */
export function calendarSpan(e: Pick<VibeEvent, 'startsAt' | 'endsAt'>): { start: string; end: string } {
  return { start: e.startsAt, end: e.endsAt ?? new Date(Date.parse(e.startsAt) + DEFAULT_LENGTH_MS).toISOString() };
}

/** All-day events: first day and the day after the last (exclusive) as YYYYMMDD; null for anything else. Shared by Google and .ics. */
export function allDaySpan(e: Pick<VibeEvent, 'allDay' | 'startDate' | 'endDate'>): { start: string; end: string } | null {
  if (!e.allDay || !e.startDate) return null;
  const end = e.endDate && e.endDate > e.startDate ? e.endDate : addDays(e.startDate, 1);
  return { start: e.startDate.replace(/-/g, ''), end: end.replace(/-/g, '') };
}

/** Google Calendar "add event" link. Times are UTC (Z); ctz only sets the zone Google shows. */
export function googleCalendarUrl(e: VibeEvent, tz: string): string {
  const { start, end } = calendarSpan(e);
  const d = allDaySpan(e);
  const site = safeWebsite(e.url);
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', e.title);
  u.searchParams.set('dates', d ? `${d.start}/${d.end}` : `${gcalStamp(start)}/${gcalStamp(end)}`);
  u.searchParams.set('ctz', tz);
  u.searchParams.set('details', site ? `${e.summary}\n\n${site}` : e.summary);
  u.searchParams.set('location', placeLine(e));
  return u.toString();
}

/** Directions to the pin's coordinates; with no pin, to the address. */
export function directionsUrl(e: Pick<VibeEvent, 'lat' | 'lng' | 'address' | 'venue'>): string {
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  u.searchParams.set('destination', e.lat !== null && e.lng !== null ? `${e.lat},${e.lng}` : placeLine(e));
  return u.toString();
}

/** True when directions can be offered at all. */
export function hasPlace(e: Pick<VibeEvent, 'lat' | 'lng' | 'address' | 'venue'>): boolean {
  return (e.lat !== null && e.lng !== null) || placeLine(e) !== '';
}

/** Only plain https links render as a Website button: no userinfo, no script or data schemes, no other protocol. */
export function safeWebsite(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hostname === '') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Town for a row: the address segment before the state, e.g. "Tahoe City". Copied unchanged from Lights. */
export function townOf(address: string): string {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  // "10046 Church St, Truckee, CA 96161, USA" -> "Truckee"; "Heritage Plaza, Tahoe City, CA" -> "Tahoe City"
  const stateAt = parts.findIndex((p, i) => i > 0 && /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  if (stateAt > 0) return parts[stateAt - 1];
  return parts[1];
}

/** Link that opens one event's sheet (`/?event=<id>`). */
export function eventShareUrl(base: string, eventId: string): string {
  const u = new URL('/', base);
  u.searchParams.set('event', eventId);
  return u.toString();
}
