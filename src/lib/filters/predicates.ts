import type { Area, VibeEvent, When } from '@/lib/data/types';
import { DEFAULT_LENGTH_MS, GRACE_MS, addDays, localDate, startOfDay, toUtc, wallClock } from '@/lib/time/pacific';
import type { FilterState } from './state';

export const REGION_TZ = 'America/Los_Angeles';

/** [startMs, endMs). All-day events span whole Pacific days (endDate is exclusive); otherwise the end defaults to start + 3 h. */
export function interval(e: VibeEvent, tz: string = REGION_TZ): [number, number] {
  if (e.allDay && e.startDate) {
    const s = startOfDay(e.startDate, tz);
    const end = e.endDate && e.endDate > e.startDate ? startOfDay(e.endDate, tz) : startOfDay(addDays(e.startDate, 1), tz);
    return [s, end];
  }
  const s = Date.parse(e.startsAt);
  return [s, e.endsAt ? Date.parse(e.endsAt) : s + DEFAULT_LENGTH_MS];
}

function at(ymd: string, hhmm: string, tz: string): number {
  const r = toUtc(ymd, hhmm, tz);
  return r === 'dst_gap' ? startOfDay(ymd, tz) : Date.parse(r);
}

/** The [start, end) window of a When, in the zone. */
export function whenWindow(when: When, now: number, tz: string): [number, number] {
  const today = localDate(now, tz);
  const tomorrow = addDays(today, 1);
  if (typeof when === 'object') return [startOfDay(when.date, tz), startOfDay(addDays(when.date, 1), tz)];
  switch (when) {
    case 'today':
      return [startOfDay(today, tz), startOfDay(tomorrow, tz)];
    case 'tonight':
      return [at(today, '17:00', tz), at(tomorrow, '04:00', tz)];
    case 'tomorrow':
      return [startOfDay(tomorrow, tz), startOfDay(addDays(today, 2), tz)];
    case '7d':
      return [now, startOfDay(addDays(today, 7), tz)];
    case 'weekend': {
      // Sat/Sun: the weekend in progress (Friday is 1 or 2 days back). Mon-Fri: the coming Friday (today, on a Friday).
      const wd = wallClock(now, tz).weekday;
      const friOffset = wd === 6 ? -1 : wd === 0 ? -2 : 5 - wd;
      const fri = addDays(today, friOffset);
      return [at(fri, '15:00', tz), startOfDay(addDays(fri, 3), tz)];
    }
  }
}

export function matchesWhen(e: VibeEvent, when: When | null, now: number, tz: string = REGION_TZ): boolean {
  if (!when) return true;
  const [ws, we] = whenWindow(when, now, tz);
  const [s, end] = interval(e, tz);
  return s < we && end > ws;
}

export function matchesArea(e: VibeEvent, areas: readonly Area[]): boolean {
  if (areas.length === 0) return true;
  return e.area !== null && (areas as readonly string[]).includes(e.area);
}

export function matchesFree(e: VibeEvent): boolean {
  return e.priceKind === 'free';
}

/** Listed until 1 hour after the end (the same rule as list_events). */
export function notEndedAt(e: VibeEvent, now: number, tz: string = REGION_TZ): boolean {
  return interval(e, tz)[1] > now - GRACE_MS;
}

export function applyFilters(events: readonly VibeEvent[], f: FilterState, now: number, tz: string = REGION_TZ): VibeEvent[] {
  return events.filter(
    (e) => notEndedAt(e, now, tz) && matchesWhen(e, f.when, now, tz) && matchesArea(e, f.areas) && (!f.free || matchesFree(e)),
  );
}

/**
 * All-day events carry their span in startDate/endDate; give them a matching startsAt/endsAt so the shared grouping
 * (groupEvents) and the date chip place them by Pacific day.
 */
export function withSpan(e: VibeEvent, tz: string = REGION_TZ): VibeEvent {
  if (!e.allDay || !e.startDate) return e;
  const [s, end] = interval(e, tz);
  return { ...e, startsAt: new Date(s).toISOString(), endsAt: new Date(end).toISOString() };
}
