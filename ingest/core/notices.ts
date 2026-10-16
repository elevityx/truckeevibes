// Notices (spec R4b + Amendment R4b-1): exact TS twin of `private.is_notice_title(p, p_sibling)` and `private.notice_rest`,
// plus the runner-side drop and cancel. Pure. A notice is never submitted or published.
import { DEFAULT_TZ, localDate } from '../adapters/common';
import type { SourceEvent } from '../types';
import { MAX_REASONS } from './reasonCodes';

/** Twin of `btrim(regexp_replace(lower(t), '\s+', ' ', 'g'))`. */
export const normTitle = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The `<rest>` of `^no\s+<rest>\s+(tonight|today)$`, normalized; null when it does not match or is empty. */
export function noticeRest(p: string): string | null {
  const m = /^no\s+(.+)\s+(?:tonight|today)$/.exec(p.trim().toLowerCase());
  if (!m) return null;
  const rest = normTitle(m[1]);
  return rest === '' ? null : rest;
}

export function isNoticeTitle(p: string | null | undefined, context = false): boolean {
  if (p == null) return false;
  const lower = p.toLowerCase();
  return (/\bclos(?:ed|ing)\b\s+(?:at|early|today|tonight|for|until)\b/.test(lower) && !/[:(,]/.test(p))
    || /(?:holiday|special) hours/.test(lower)
    || (context && noticeRest(p) !== null);
}

/** `YYYY-MM-DD`: `startDate` for all-day items, else the calendar date of `startsAt` in `tz`. */
export function pacificDay(item: SourceEvent, tz = DEFAULT_TZ): string {
  if (item.allDay && item.startDate) return item.startDate;
  return localDate(new Date(item.startsAt), tz);
}

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

export interface NoticeContext { sameDay: SourceEvent[]; series: boolean; context: boolean }

/** Candidates are the other items whose normalized title equals the notice's `<rest>`. */
export function noticeContext(notice: SourceEvent, batch: SourceEvent[], tz = DEFAULT_TZ): NoticeContext {
  const rest = noticeRest(notice.title);
  if (rest === null) return { sameDay: [], series: false, context: false };
  const day = dayNumber(pacificDay(notice, tz));
  const candidates = batch.filter((i) => i.externalKey !== notice.externalKey && normTitle(i.title) === rest);
  const sameDay = candidates.filter((i) => dayNumber(pacificDay(i, tz)) === day);
  const near = candidates.filter((i) => Math.abs(dayNumber(pacificDay(i, tz)) - day) <= 14);
  const series = near.length >= 2;
  return { sameDay, series, context: sameDay.length >= 1 || series };
}

const venuesAgree = (a?: string, b?: string) => !a || !b || normTitle(a) === normTitle(b);

export function applyNotices(items: SourceEvent[], tz = DEFAULT_TZ): { items: SourceEvent[]; dropped: number; cancelled: number } {
  const drop = new Set<string>();
  const cancel = new Set<string>();
  for (const it of items) {
    const ctx = noticeContext(it, items, tz);
    if (!isNoticeTitle(it.title, ctx.context)) continue;
    drop.add(it.externalKey);
    const [sib] = ctx.sameDay;
    if (ctx.sameDay.length === 1 && !sib.cancelled && venuesAgree(it.venueName, sib.venueName)) cancel.add(sib.externalKey);
  }
  const kept: SourceEvent[] = [];
  let cancelled = 0;
  for (const it of items) {
    if (drop.has(it.externalKey)) continue;
    if (cancel.has(it.externalKey) && !drop.has(it.externalKey)) {
      const reasons = it.tagReasons ?? [];
      const tagReasons = reasons.includes('notice:cancel_sibling') || reasons.length >= MAX_REASONS ? reasons : [...reasons, 'notice:cancel_sibling' as const];
      kept.push({ ...it, cancelled: true, tagReasons });
      cancelled++;
    } else kept.push(it);
  }
  return { items: kept, dropped: drop.size, cancelled };
}
