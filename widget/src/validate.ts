// Validates the API response before anything renders. Reads only known keys into fresh object literals: no spread of input, so
// `__proto__` / `constructor` keys of a hostile body are never copied. Invalid rows are dropped and counted by the caller.
import type { Envelope, WidgetEvent } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?Z$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** ISO-8601 UTC ("…Z", up to 9 fraction digits) to a canonical toISOString(), or null. */
export function isoZ(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const m = ISO_Z.exec(x);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, ms);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (d.getUTCDate() !== +m[3] || +m[4] > 23 || +m[5] > 59) return null;
  return d.toISOString();
}
const nullableIso = (x: unknown): string | null | undefined => (x === null ? null : (isoZ(x) ?? undefined));
const str = (x: unknown, min: number, max: number): string | undefined =>
  typeof x === 'string' && x.length >= min && x.length <= max ? x : undefined;
const nullableStr = (x: unknown, max: number): string | null | undefined => (x === null ? null : str(x, 0, max));
const bool = (x: unknown): boolean | undefined => (x === true || x === false ? x : undefined);
const finite = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const nullableYmd = (x: unknown): string | null | undefined => (x === null ? null : typeof x === 'string' && YMD.test(x) ? x : undefined);

export function validateEnvelope(x: unknown): Envelope | null {
  if (!isObj(x) || own(x, 'version') !== 1) return null;
  const dataAt = isoZ(own(x, 'dataAt'));
  const stale = bool(own(x, 'stale'));
  const m = own(x, 'mirror');
  const events = own(x, 'events');
  const next = own(x, 'nextCursor');
  if (!dataAt || stale === undefined || !isObj(m) || !Array.isArray(events)) return null;
  if (next !== null && (typeof next !== 'string' || next.length < 1 || next.length > 200)) return null;
  const state = own(m, 'state');
  const confirmedAt = nullableIso(own(m, 'confirmedAt'));
  const heldSince = nullableIso(own(m, 'heldSince'));
  const heldCount = own(m, 'heldCount');
  if (state !== 'none' && state !== 'confirmed' && state !== 'held') return null;
  if (confirmedAt === undefined || heldSince === undefined) return null;
  if (typeof heldCount !== 'number' || !Number.isInteger(heldCount) || heldCount < 0) return null;
  return { dataAt, stale, mirror: { state, confirmedAt, heldSince, heldCount }, nextCursor: next, events: events.slice() };
}

export function validateRow(x: unknown): WidgetEvent | null {
  if (!isObj(x)) return null;
  const id = own(x, 'id');
  const formerRaw = own(x, 'formerIds');
  const origin = own(x, 'origin');
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (!Array.isArray(formerRaw) || !formerRaw.every((f) => typeof f === 'string' && UUID.test(f))) return null;
  if (origin !== 'lights' && origin !== 'vibes') return null;
  const title = str(own(x, 'title'), 1, 200);
  const description = nullableStr(own(x, 'description'), 2000);
  const summary = nullableStr(own(x, 'summary'), 2000);
  const venue = nullableStr(own(x, 'venue'), 300);
  const address = str(own(x, 'address'), 0, 300);
  const startsAt = isoZ(own(x, 'startsAt'));
  const endsAt = nullableIso(own(x, 'endsAt'));
  const lat = finite(own(x, 'lat'));
  const lng = finite(own(x, 'lng'));
  const url = nullableStr(own(x, 'url'), 2048);
  const ticketUrl = nullableStr(own(x, 'ticketUrl'), 2048);
  const pageRaw = own(x, 'pageUrl');
  const adultsOnly = bool(own(x, 'adultsOnly'));
  const allDay = bool(own(x, 'allDay'));
  const timeKnown = bool(own(x, 'timeKnown'));
  const startDate = nullableYmd(own(x, 'startDate'));
  const endDate = nullableYmd(own(x, 'endDate'));
  if (title === undefined || description === undefined || summary === undefined || venue === undefined || address === undefined) return null;
  if (!startsAt || endsAt === undefined || lat === undefined || lng === undefined || url === undefined || ticketUrl === undefined) return null;
  if (adultsOnly === undefined || allDay === undefined || timeKnown === undefined || startDate === undefined || endDate === undefined) return null;
  let pageUrl: string | null = null;
  if (pageRaw !== null) {
    if (typeof pageRaw !== 'string' || pageRaw.length > 2048 || !pageRaw.startsWith('https://truckeevibes.com/')) return null;
    pageUrl = pageRaw;
  }
  return {
    id, title, description: description ?? summary ?? '', venue, address, lat, lng, startsAt, endsAt, url, adultsOnly,
    origin, formerIds: formerRaw.slice() as string[], pageUrl, allDay, startDate, endDate, timeKnown,
  };
}
