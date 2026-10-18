// Verbatim port of Truckee Lights src/lib/time/pacific.ts (wallClock, toUtc, localDate, addDays, startOfDay, formatDay, formatTimes,
// formatRange, dateChip, groupEvents): same strings, same edge rules. Plus the Vibes-only labels formatAllDay / timeUnknown and the
// note clock. Wall-clock time in a named zone (the region's), never the device zone. Pure Intl, no Temporal.
import { notEnded } from './clock';

const HOUR = 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];


export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `t` (ms since epoch). */
export function wallClock(t: number, tz: string): WallClock {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(t))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const hour = p.hour === 24 ? 0 : p.hour;
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour,
    minute: p.minute,
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
  };
}

/** UTC offset of `tz` at instant `t`, in ms (PDT = -7 h). */
function offsetMs(t: number, tz: string): number {
  const s = Math.floor(t / 1000) * 1000;
  const w = wallClock(s, tz);
  const p = formatter(tz).formatToParts(new Date(s));
  const sec = Number(p.find((x) => x.type === 'second')?.value ?? 0);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, sec) - s;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/**
 * Local date ("YYYY-MM-DD") and time ("HH:MM") in `tz` to an ISO UTC string.
 * A time that does not exist (the spring-forward gap) returns 'dst_gap'. A time that happens twice
 * (the fall-back hour) takes the earlier instant, which is daylight time.
 */
export function toUtc(localDate: string, localTime: string, tz: string): string | 'dst_gap' {
  const d = DATE_RE.exec(localDate);
  const t = TIME_RE.exec(localTime);
  if (!d || !t) throw new RangeError('bad local date or time');
  const [y, mo, day, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59) throw new RangeError('bad local date or time');
  const guess = Date.UTC(y, mo - 1, day, h, mi);
  if (new Date(guess).getUTCDate() !== day) throw new RangeError('bad local date or time'); // e.g. Feb 30
  const offsets = new Set([offsetMs(guess - 12 * HOUR, tz), offsetMs(guess, tz), offsetMs(guess + 12 * HOUR, tz)]);
  const hits: number[] = [];
  for (const o of offsets) {
    const cand = guess - o;
    const w = wallClock(cand, tz);
    if (w.year === y && w.month === mo && w.day === day && w.hour === h && w.minute === mi) hits.push(cand);
  }
  if (hits.length === 0) return 'dst_gap';
  return new Date(Math.min(...hits)).toISOString();
}

/** "YYYY-MM-DD" of the instant in `tz`. */
export function localDate(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}



/** Add whole calendar days to "YYYY-MM-DD". */
export function addDays(ymd: string, n: number): string {
  const m = DATE_RE.exec(ymd);
  if (!m) throw new RangeError('bad date');
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3] + n);
  return new Date(t).toISOString().slice(0, 10);
}

/** First instant of the local day "YYYY-MM-DD" in `tz` (ms). */
export function startOfDay(ymd: string, tz: string): number {
  for (const hhmm of ['00:00', '01:00', '02:00']) {
    const r = toUtc(ymd, hhmm, tz);
    if (r !== 'dst_gap') return Date.parse(r);
  }
  throw new RangeError('no start of day');
}

function clock(w: WallClock, withMeridiem: boolean): string {
  const h = w.hour % 12 || 12;
  const s = w.minute ? `${h}:${String(w.minute).padStart(2, '0')}` : String(h);
  return withMeridiem ? `${s} ${w.hour < 12 ? 'am' : 'pm'}` : s;
}

function sameDay(a: WallClock, b: WallClock): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Ends at 12:00 am the day after it starts: reads "9 pm–midnight" on one day. */
function endsAtMidnight(s: WallClock, e: WallClock): boolean {
  if (e.hour !== 0 || e.minute !== 0) return false;
  const next = new Date(Date.UTC(s.year, s.month - 1, s.day + 1));
  return next.getUTCFullYear() === e.year && next.getUTCMonth() + 1 === e.month && next.getUTCDate() === e.day;
}

/** "Fri, Oct 30" */
export function formatDay(iso: string, tz: string): string {
  const w = wallClock(Date.parse(iso), tz);
  return `${WEEKDAYS[w.weekday]}, ${MONTHS[w.month - 1]} ${w.day}`;
}

/** Whole local calendar days from the start's date to the end's date. */
function dayGap(s: WallClock, e: WallClock): number {
  return Math.round((Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(s.year, s.month - 1, s.day)) / 86_400_000);
}

/** The clock span of one day: "6–10 pm", "11 am–3 pm". */
function clockSpan(s: WallClock, e: WallClock): string {
  const sameHalf = s.hour < 12 === e.hour < 12;
  return `${clock(s, !sameHalf)}–${clock(e, true)}`;
}

/** A run that spans more than one day: "Oct 2 – Nov 1 · nightly 6–10 pm", or "Through Nov 1" when it starts at 12 am.
 *  An end at exactly 12 am is the exclusive edge of the previous day: that day is the last one and the clock reads "midnight". */
function multiDay(s: WallClock, e: WallClock): string {
  const endsMidnight = e.hour === 0 && e.minute === 0;
  const last = new Date(Date.UTC(e.year, e.month - 1, endsMidnight ? e.day - 1 : e.day));
  const lastLabel = `${MONTHS[last.getUTCMonth()]} ${last.getUTCDate()}`;
  if (s.hour === 0 && s.minute === 0) return endsMidnight ? `Through ${lastLabel}` : `Through ${lastLabel} · until ${clock(e, true)}`;
  const span = endsMidnight ? `${clock(s, true)}–midnight` : clockSpan(s, e);
  return `${MONTHS[s.month - 1]} ${s.day} – ${lastLabel} · nightly ${span}`;
}

/** Times only: "4–6 pm", "11 am–3 pm", "6:30 pm", "9 pm–midnight". An end on a later day reads "9 pm–Sat 1 am". */
export function formatTimes(startsAt: string, endsAt: string | null, tz: string): string {
  const s = wallClock(Date.parse(startsAt), tz);
  if (!endsAt) return clock(s, true);
  const e = wallClock(Date.parse(endsAt), tz);
  if (endsAtMidnight(s, e)) return `${clock(s, true)}–midnight`;
  if (dayGap(s, e) > 1) return multiDay(s, e);
  if (!sameDay(s, e)) return `${clock(s, true)}–${WEEKDAYS[e.weekday]} ${clock(e, true)}`;
  const sameHalf = s.hour < 12 === e.hour < 12;
  return `${clock(s, !sameHalf)}–${clock(e, true)}`;
}

/** "Fri, Oct 30 · 4–6 pm". An end on a later day: "Fri, Oct 30 · 9 pm – Sat, Oct 31 · 1 am". */
export function formatRange(startsAt: string, endsAt: string | null, tz: string): string {
  const day = formatDay(startsAt, tz);
  if (endsAt) {
    const s = wallClock(Date.parse(startsAt), tz);
    const e = wallClock(Date.parse(endsAt), tz);
    if (dayGap(s, e) > 1) return formatTimes(startsAt, endsAt, tz); // already carries the dates
    if (!sameDay(s, e) && !endsAtMidnight(s, e)) return `${day} · ${clock(s, true)} – ${formatDay(endsAt, tz)} · ${clock(e, true)}`;
  }
  return `${day} · ${formatTimes(startsAt, endsAt, tz)}`;
}

/** Pieces for a date chip: { month: 'OCT', day: 30, weekday: 'Fri' }. */
export function dateChip(iso: string, tz: string): { month: string; day: number; weekday: string } {
  const w = wallClock(Date.parse(iso), tz);
  return { month: MONTHS[w.month - 1].toUpperCase(), day: w.day, weekday: WEEKDAYS[w.weekday] };
}




export interface EventGroups<T> {
  today: T[];
  week: T[];
  later: T[];
}

/**
 * Today = overlaps today (local); This week = overlaps the 7 local days starting today and is not Today; Later = the rest.
 * Ended events (per notEnded) are dropped, and each group is sorted by start.
 */
export function groupEvents<T extends { startsAt: string; endsAt: string | null }>(
  events: readonly T[],
  now: number | Date,
  tz: string,
): EventGroups<T> {
  const n = typeof now === 'number' ? now : now.getTime();
  const today = localDate(n, tz);
  const tomorrow = startOfDay(addDays(today, 1), tz);
  const weekEnd = startOfDay(addDays(today, 7), tz); // the 7 local days starting today
  const out: EventGroups<T> = { today: [], week: [], later: [] };
  const live = events.filter((e) => notEnded(e, n)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const e of live) {
    // Every live event ends after now - 1 h, so starting before tomorrow means it overlaps today.
    const s = Date.parse(e.startsAt);
    if (s < tomorrow) out.today.push(e);
    else if (s < weekEnd) out.week.push(e);
    else out.later.push(e);
  }
  return out;
}


const ymdParts = (ymd: string) => {
  const m = DATE_RE.exec(ymd);
  if (!m) throw new RangeError('bad date');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
};

/** Vibes all-day rows: "Fri, Oct 30 · All day", or "Oct 30 – Nov 1 · All day" (endDate is exclusive). */
export function formatAllDay(startDate: string, endDate: string | null): string {
  const s = ymdParts(startDate);
  const last = endDate ? ymdParts(addDays(endDate, -1)) : s;
  if (last.getTime() <= s.getTime()) return `${WEEKDAYS[s.getUTCDay()]}, ${MONTHS[s.getUTCMonth()]} ${s.getUTCDate()} · All day`;
  return `${MONTHS[s.getUTCMonth()]} ${s.getUTCDate()} – ${MONTHS[last.getUTCMonth()]} ${last.getUTCDate()} · All day`;
}

/** Vibes rows with a date but no time: "Fri, Oct 30 · Time TBA". */
export function timeUnknown(startsAt: string, tz: string): string {
  return `${formatDay(startsAt, tz)} · Time TBA`;
}

/** The note clock (views/states.ts): "7:08 am", always with minutes. */
export function noteClock(t: number, tz: string): string {
  const w = wallClock(t, tz);
  return `${w.hour % 12 || 12}:${String(w.minute).padStart(2, '0')} ${w.hour < 12 ? 'am' : 'pm'}`;
}

/** What a row and the sheet say for "when": Lights' strings for timed rows, the Vibes labels otherwise. */
export function whenLong(e: { startsAt: string; endsAt: string | null; allDay: boolean; startDate: string | null; endDate: string | null; timeKnown: boolean }, tz: string): string {
  if (e.allDay && e.startDate) return formatAllDay(e.startDate, e.endDate);
  if (!e.timeKnown) return timeUnknown(e.startsAt, tz);
  return formatRange(e.startsAt, e.endsAt, tz);
}
export function whenShort(e: { startsAt: string; endsAt: string | null; allDay: boolean; startDate: string | null; endDate: string | null; timeKnown: boolean }, tz: string): string {
  if (e.allDay && e.startDate) {
    const s = formatAllDay(e.startDate, e.endDate);
    return s.includes(' – ') ? s : 'All day';
  }
  if (!e.timeKnown) return 'Time TBA';
  return formatTimes(e.startsAt, e.endsAt, tz);
}
