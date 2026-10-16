import type { VibeEvent } from '@/lib/data/types';
import { addDays, formatDay, formatRange, formatTimes, localDate, longDay, startOfDay } from '@/lib/time/pacific';

/** Short time text for a row: "6:30 pm", "4–6 pm", "All day", or "Time not listed". */
export function timeText(e: VibeEvent, tz: string): string {
  if (e.allDay) return 'All day';
  if (!e.timeKnown) return 'Time not listed';
  return formatTimes(e.startsAt, e.endsAt, tz);
}

/** Full when line for the sheet: "Fri, Oct 30 · 4–6 pm", "Sat, Nov 7 · All day", "Sat, Nov 7 – Sun, Nov 8 · All day". */
export function whenLine(e: VibeEvent, tz: string): string {
  if (e.allDay && e.startDate) {
    const first = formatDay(new Date(startOfDay(e.startDate, tz)).toISOString(), tz);
    const lastDate = e.endDate ? addDays(e.endDate, -1) : e.startDate;
    if (lastDate > e.startDate) return `${first} – ${formatDay(new Date(startOfDay(lastDate, tz)).toISOString(), tz)} · All day`;
    return `${first} · All day`;
  }
  if (!e.timeKnown) return `${formatDay(e.startsAt, tz)} · Time not listed`;
  return formatRange(e.startsAt, e.endsAt, tz);
}

export const WORTH_THE_DRIVE_AREA = 'reno_carson';
export const isFar = (e: Pick<VibeEvent, 'area'>): boolean => e.area === WORTH_THE_DRIVE_AREA;
export const is21 = (e: Pick<VibeEvent, 'age'>): boolean => e.age === '21_plus';

/** "Free", "$5", "$5–$10", or null when the price is not known. Text only. */
export function priceText(e: Pick<VibeEvent, 'priceKind' | 'priceMin' | 'priceMax'>): string | null {
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  if (e.priceKind === 'free') return 'Free';
  if (e.priceKind === 'donation') return 'By donation';
  if (e.priceKind !== 'paid') return null;
  if (e.priceMin !== null && e.priceMax !== null && e.priceMax !== e.priceMin) return `${money(e.priceMin)}–${money(e.priceMax)}`;
  const one = e.priceMin ?? e.priceMax;
  return one !== null ? money(one) : 'Paid';
}

/** The sheet's when line without the zone: "Sunday, Oct 18 · 6–8:30 pm" (the long-day variant of whenLine). */
export function sheetWhenLine(e: VibeEvent, tz: string): string {
  const day = (ymd: string) => longDay(new Date(startOfDay(ymd, tz) + 12 * 3_600_000).toISOString(), tz);
  if (e.allDay && e.startDate) {
    const lastDate = e.endDate ? addDays(e.endDate, -1) : e.startDate;
    return lastDate > e.startDate ? `${day(e.startDate)} – ${day(lastDate)} · All day` : `${day(e.startDate)} · All day`;
  }
  if (!e.timeKnown) return `${longDay(e.startsAt, tz)} · Time not listed`;
  if (e.endsAt && localDate(Date.parse(e.endsAt), tz) !== localDate(Date.parse(e.startsAt), tz)) return whenLine(e, tz);
  return `${longDay(e.startsAt, tz)} · ${formatTimes(e.startsAt, e.endsAt, tz)}`;
}

/** The Ages row of the sheet. */
export function agesText(age: string): string {
  switch (age) {
    case '21_plus': return '21+';
    case '18_plus': return '18+';
    case 'all_ages': return 'All ages';
    case 'family': return 'Family friendly';
    default: return 'Not listed.';
  }
}
