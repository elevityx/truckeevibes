// Ports of Truckee Lights src/components/events/links.ts (worthTheDrive, placeLine, googleCalendarUrl, directionsUrl, safeWebsite,
// townOf) and src/lib/data/eventUrl.ts checkEventUrl, same rules. Every URL here is built with URL/URLSearchParams, never by string
// concatenation of data.
import { DEFAULT_LENGTH_MS } from './clock';
import type { Box, WidgetEvent } from './types';

/** Calendar entries with no end time get the same 3 hours the map uses. */
const CAL_LENGTH_MS = DEFAULT_LENGTH_MS;

function gcalStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261030T230000Z
}

/** Inclusive, like SQL BETWEEN; NaN and Infinity fail. */
export const inBox = (b: Box, lat: number, lng: number) => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;

/** Amendment 3 (Lights): an event outside the host's local box (e.g. Reno) is "Worth the drive". */
export function worthTheDrive(localBox: Box, e: Pick<WidgetEvent, 'lat' | 'lng'>): boolean {
  return !inBox(localBox, e.lat, e.lng);
}

export function placeLine(e: Pick<WidgetEvent, 'venue' | 'address'>): string {
  return e.venue ? `${e.venue}, ${e.address}` : e.address;
}

/** Google Calendar "add event" link. Times are UTC (Z); ctz only sets the zone Google shows. */
export function googleCalendarUrl(e: WidgetEvent, tz: string): string {
  const end = e.endsAt ?? new Date(Date.parse(e.startsAt) + CAL_LENGTH_MS).toISOString();
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', e.title);
  u.searchParams.set('dates', `${gcalStamp(e.startsAt)}/${gcalStamp(end)}`);
  u.searchParams.set('ctz', tz);
  u.searchParams.set('details', e.url ? `${e.description}\n\n${e.url}` : e.description);
  u.searchParams.set('location', placeLine(e));
  return u.toString();
}

/** Directions to the pin's coordinates (not the free-text address). */
export function directionsUrl(e: Pick<WidgetEvent, 'lat' | 'lng'>): string {
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  u.searchParams.set('destination', `${e.lat},${e.lng}`);
  return u.toString();
}

/** Only https links that pass the database URL rules render as a Website button. */
export function safeWebsite(url: string | null): string | null {
  if (!url) return null;
  try {
    if (!checkEventUrl(url).ok) return null; // the same rules as the database (shorteners, IPs, ports, userinfo)
    return new URL(url).toString();
  } catch {
    return null;
  }
}

/** A TruckeeVibes event page link, or null (exact host, https, no userinfo or port). */
export function safePageUrl(url: string | null): string | null {
  if (!url || !url.startsWith('https://truckeevibes.com/')) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'truckeevibes.com' || u.port || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Town for a list row: the address segment before the state, e.g. "Tahoe City". */
export function townOf(address: string): string {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  // "10046 Church St, Truckee, CA 96161, USA" -> "Truckee"; "Heritage Plaza, Tahoe City, CA" -> "Tahoe City"
  const stateAt = parts.findIndex((p, i) => i > 0 && /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
  if (stateAt > 0) return parts[stateAt - 1];
  return parts[1];
}

// ---- checkEventUrl: the client mirror of Lights' private.valid_event_url (Lights src/lib/data/eventUrl.ts) ----
export const EVENT_URL_SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly'] as const;
export const EVENT_URL_MAX = 300;

export type EventUrlProblem = 'length' | 'scheme' | 'chars' | 'port' | 'host' | 'shortener';
export type EventUrlCheck = { ok: true; host: string } | { ok: false; problem: EventUrlProblem };

// Same character set as the SQL: userinfo, backslash, whitespace, control characters, quotes, angle brackets, backtick.
const BAD_CHARS = /[@\\\s\u0000-\u001f\u007f-\u009f"'<>`]/;
const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Check an already-trimmed URL exactly as the server does (case-sensitive scheme, no trailing dot, no port). */
export function checkEventUrl(v: string): EventUrlCheck {
  // Count Unicode code points, as Postgres char_length does (string.length counts an emoji as two units).
  if ([...v].length > EVENT_URL_MAX) return { ok: false, problem: 'length' };
  if (!v.startsWith('https://')) return { ok: false, problem: 'scheme' };
  if (BAD_CHARS.test(v)) return { ok: false, problem: 'chars' };
  const host = v.slice(8).toLowerCase().split('/', 1)[0].split('?', 1)[0].split('#', 1)[0];
  if (/[:[\]]/.test(host)) return { ok: false, problem: 'port' };
  // The letters-only TLD also rejects every IPv4 notation, single-label hosts and a trailing dot.
  if (!HOST_RE.test(host) || host === 'localhost' || host.endsWith('.localhost')) return { ok: false, problem: 'host' };
  if (EVENT_URL_SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`))) return { ok: false, problem: 'shortener' };
  return { ok: true, host };
}
