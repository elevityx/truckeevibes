// Tahoe Donner event rules (A13 r6): pure text, date and time grammar plus the closed venue directory. No network, no database.
// Nothing here decides who may attend: every event is listed (owner decision r4), and `membersOnly` only sets a label.
import { addDays, localDate } from '../adapters/common';

export type TdDrop = 'oversize' | 'date_unparsed' | 'no_time' | 'long_range' | 'series_unsupported' | 'out_of_window';

/** A raw description over this many characters drops the event (detail pages are <= 1 MB; real descriptions are < 3,000). */
export const TD_MAX_DESCRIPTION = 20_000;

export interface TdVenue { name: string; address: string; hints: string[] }

const LODGE: TdVenue = { name: 'The Lodge Restaurant & Pub', address: '12850 Northwoods Blvd, Truckee, CA 96161', hints: [] };
const DOWNHILL: TdVenue = { name: 'Tahoe Donner Downhill Ski Resort', address: '11603 Slalom Way, Truckee, CA 96161', hints: ['downhill ski resort'] };
const XC: TdVenue = { name: 'Tahoe Donner Cross Country Ski Center', address: '15275 Alder Creek Rd, Truckee, CA 96161', hints: ['cross country ski center'] };
// The Alder Creek address is unverified (spec step 9 gate): confirm it from one real Alder Creek event page before relying on it.
const ALDER: TdVenue = { name: 'Alder Creek Adventure Center', address: '15275 Alder Creek Rd, Truckee, CA 96161', hints: [] };
const NORTHWOODS: TdVenue = { name: 'Tahoe Donner Northwoods Clubhouse', address: '11509 Northwoods Blvd, Truckee, CA 96161', hints: [] };

/** Address directory, key = normalized venue text (lowercase, nbsp -> space, collapsed, trimmed). Unknown text is never an error. */
export const TD_VENUES: Record<string, TdVenue> = {
  'the lodge restaurant & pub': LODGE,
  'the lodge restaurant & pub pavilion': LODGE,
  'the lodge pavilion': LODGE,
  'the lodge': LODGE,
  'downhill ski resort': DOWNHILL,
  'cross country ski center': XC,
  'alder creek cafe': ALDER,
  'alder creek adventure center': ALDER,
  'northwoods clubhouse': NORTHWOODS,
};

const venueKey = (s: string) => s.replace(/[ \s]+/g, ' ').trim().toLowerCase();
export function tdVenue(text: string): TdVenue | undefined {
  const k = venueKey(text);
  return Object.prototype.hasOwnProperty.call(TD_VENUES, k) ? TD_VENUES[k] : undefined;
}

/** NFKC, typographic dashes and quotes folded, whitespace collapsed, lowercase. */
export function normTd(s: string): string {
  return s.normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const TITLE_MEMBERS_ONLY = /(?:^|[^a-z0-9])(?:members? only|member-only|members-only|owners only)(?:$|[^a-z0-9])/;
// Closed list (r6). A sentence matches by exact equality, with or without its final period.
const MEMBERS_ONLY_SENTENCES: ReadonlySet<string> = new Set([
  'this event is for members only', 'this is a members only event', 'members only event', 'open to tahoe donner members only', 'tahoe donner members only',
]);

/**
 * True only when the event's own title says "members only" (word-bounded) or one description sentence is exactly one of five known
 * wordings. A label, never a filter. Runs on the full description (callers must not cap it first). To widen: add a sentence and a test row.
 */
export function membersOnly(title: string, description: string): boolean {
  if (TITLE_MEMBERS_ONLY.test(normTd(title))) return true;
  for (const line of description.split(/\n+/)) {
    for (const raw of normTd(line).split(/(?<=[.!?])\s+/)) {
      if (MEMBERS_ONLY_SENTENCES.has(raw.trim().replace(/\.$/, ''))) return true;
    }
  }
  return false;
}

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const DOWS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY = /^([A-Z][a-z]{2}) (\d{2}), (\d{4})$/;
const RANGE = /^([A-Z][a-z]{2}) (\d{2}), (\d{4}) - ([A-Z][a-z]{2}) (\d{2}), (\d{4})$/;
const WEEKLY = /^Every (Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) - ([A-Z][a-z]{2})$/;

export type TdDate =
  | { kind: 'day'; date: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'weekly'; dow: number; fromMonth: number; toMonth: number };

function ymd(mon: string, d: string, y: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(MONTHS, mon)) return undefined;
  const m = MONTHS[mon];
  const day = Number(d);
  const year = Number(y);
  const dt = new Date(Date.UTC(year, m - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${d}`;
}

/** Parses the detail page's date header (footnote joined by one space). Anything outside the three known forms is undefined. */
export function parseTdDate(input: string): TdDate | undefined {
  const s = input.replace(/\s+/g, ' ').trim();
  if (s.length === 0 || s.length > 80) return undefined;
  let m = DAY.exec(s);
  if (m) {
    const date = ymd(m[1], m[2], m[3]);
    return date ? { kind: 'day', date } : undefined;
  }
  m = RANGE.exec(s);
  if (m) {
    const from = ymd(m[1], m[2], m[3]);
    const to = ymd(m[4], m[5], m[6]);
    return from && to && to >= from ? { kind: 'range', from, to } : undefined;
  }
  m = WEEKLY.exec(s);
  if (m && Object.prototype.hasOwnProperty.call(MONTHS, m[2]) && Object.prototype.hasOwnProperty.call(MONTHS, m[3])) {
    return { kind: 'weekly', dow: DOWS[m[1]], fromMonth: MONTHS[m[2]], toMonth: MONTHS[m[3]] };
  }
  return undefined;
}

const MAX_RANGE_DAYS = 4;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The local dates an event occupies, or the reason it yields none. v1 has no weekly series: the `weekly` form is `series_unsupported`
 * whatever the page body says. A range of up to four days yields every date; longer is `long_range`. Window: local today - 1 .. + 120.
 */
export function expandTd(d: TdDate, now: Date, tz: string): string[] | TdDrop {
  if (d.kind === 'weekly') return 'series_unsupported';
  let dates: string[];
  if (d.kind === 'day') dates = [d.date];
  else {
    const n = daysBetween(d.from, d.to) + 1;
    if (n > MAX_RANGE_DAYS) return 'long_range';
    dates = Array.from({ length: n }, (_, i) => addDays(d.from, i));
  }
  const today = localDate(now, tz);
  const lo = addDays(today, -1);
  const hi = addDays(today, 120);
  const kept = dates.filter((x) => x >= lo && x <= hi);
  return kept.length > 0 ? kept : 'out_of_window';
}

const T = '(\\d{1,2})(?::([0-5]\\d))?\\s*(AM|PM)';
const RANGE_TIME = new RegExp(`^(\\d{1,2})(?::([0-5]\\d))?\\s*(AM|PM)?\\s*-\\s*${T}$`, 'i');
const SINGLE_TIME = new RegExp(`^(?:[A-Za-z ]{1,40} at )?${T}$`, 'i');

const minutes = (h: number, m: string | undefined, pm: boolean): number | undefined => {
  if (h < 1 || h > 12) return undefined;
  return ((h % 12) + (pm ? 12 : 0)) * 60 + Number(m ?? 0);
};
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Local `HH:MM` start (and end when it is later than the start) from the detail meta's last segment. */
export function parseTdTime(input: string): { start: string; end?: string } | undefined {
  const s = input.replace(/[ \s]+/g, ' ').trim();
  if (s.length === 0 || s.length > 60) return undefined;
  let m = RANGE_TIME.exec(s);
  if (m) {
    const endPm = m[6].toUpperCase() === 'PM';
    const end = minutes(Number(m[4]), m[5], endPm);
    let start = minutes(Number(m[1]), m[2], m[3] ? m[3].toUpperCase() === 'PM' : endPm);
    if (start === undefined || end === undefined) return undefined;
    if (!m[3] && start > end) start = minutes(Number(m[1]), m[2], false); // "11-1PM": the start is AM
    if (start === undefined) return undefined;
    return end > start ? { start: hhmm(start), end: hhmm(end) } : { start: hhmm(start) };
  }
  m = SINGLE_TIME.exec(s);
  if (m) {
    const start = minutes(Number(m[1]), m[2], m[3].toUpperCase() === 'PM');
    return start === undefined ? undefined : { start: hhmm(start) };
  }
  return undefined;
}
