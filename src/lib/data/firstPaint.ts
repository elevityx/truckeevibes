import type { Snapshot } from '@/components/list/snapshot';
import { REGION_TZ, matchesWhen, notEndedAt, withSpan } from '@/lib/filters/predicates';
import { AREAS } from '@/lib/filters/state';
import { CATEGORY_SLUGS } from '@/lib/categories';
import { LISTS, countLists, listBySlug, type ListSlug } from '@/lib/lists';
import { addDays, localDate, startOfDay } from '@/lib/time/pacific';
import type { VibeEvent } from './types';

/** DR6: the most rows a page embeds. */
export const FIRST_PAINT_ROWS = 300;
const WINDOW_DAYS = 30;

export interface HeroCounts {
  /** Events matching Next 7 days / This weekend, and all upcoming events. */
  n7: number;
  nw: number;
  total: number;
  /** Pacific date (YYYY-MM-DD) of the last start, or null. */
  lastStart: string | null;
}

export interface SourceCounts {
  active: number;
  paused: number;
  linkOnly: number;
  activeNames: string[];
}

export interface BuildCounts {
  lists: Record<ListSlug, number>;
  areas: Record<string, number>;
  kinds: Record<string, number>;
  hero: HeroCounts;
  sources: SourceCounts;
}

export function heroCounts(events: readonly VibeEvent[], now: number, tz: string = REGION_TZ): HeroCounts {
  const live = events.map((e) => withSpan(e, tz)).filter((e) => notEndedAt(e, now, tz));
  const last = live.reduce<string | null>((m, e) => {
    const d = localDate(Date.parse(e.startsAt), tz);
    return m === null || d > m ? d : m;
  }, null);
  return {
    n7: live.filter((e) => matchesWhen(e, '7d', now, tz)).length,
    nw: live.filter((e) => matchesWhen(e, 'weekend', now, tz)).length,
    total: live.length,
    lastStart: last,
  };
}

export function areaCounts(events: readonly VibeEvent[]): Record<string, number> {
  return Object.fromEntries(AREAS.map((a) => [a, events.filter((e) => e.area === a).length]));
}

export function kindCounts(events: readonly VibeEvent[]): Record<string, number> {
  return Object.fromEntries(CATEGORY_SLUGS.map((c) => [c, events.filter((e) => e.categories.includes(c)).length]));
}

export function buildCounts(events: readonly VibeEvent[], sources: Snapshot['sources'], now: number, tz: string = REGION_TZ): BuildCounts {
  const live = events.filter((e) => notEndedAt(withSpan(e, tz), now, tz));
  const active = sources.filter((s) => s.status === 'active');
  return {
    lists: countLists(live),
    areas: areaCounts(live),
    kinds: kindCounts(live),
    hero: heroCounts(events, now, tz),
    sources: {
      active: active.length,
      paused: sources.filter((s) => s.status === 'paused').length,
      linkOnly: sources.filter((s) => s.status === 'link_only').length,
      activeNames: active.map((s) => s.name),
    },
  };
}

/**
 * First paint (DR6): the list's rows that start before the build day + 30 days, the first 300 by start, plus counts from the
 * FULL snapshot at the build time. Server-side only in practice, but pure.
 */
export function firstPaint(
  snapshot: Snapshot,
  list: ListSlug,
  opts: { tz?: string } = {},
): { initialSnapshot: Pick<Snapshot, 'builtAt' | 'events'>; counts: BuildCounts } {
  const tz = opts.tz ?? REGION_TZ;
  const builtMs = snapshot.builtAt ? Date.parse(snapshot.builtAt) : Date.now();
  const def = listBySlug(list) ?? LISTS[0];
  const cutoff = startOfDay(addDays(localDate(builtMs, tz), WINDOW_DAYS), tz);
  const rows = snapshot.events
    .filter((e) => def.match(e) && Date.parse(e.startsAt) < cutoff)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, FIRST_PAINT_ROWS);
  return { initialSnapshot: { builtAt: snapshot.builtAt, events: rows }, counts: buildCounts(snapshot.events, snapshot.sources, builtMs, tz) };
}
