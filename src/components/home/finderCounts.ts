// The counts the FinderBar shows: each is the number of rows in the list with every OTHER filter applied.
import type { VibeEvent } from '@/lib/data/types';
import { REGION_TZ, applyFilters } from '@/lib/filters/predicates';
import { AREAS, EMPTY_FILTERS, type FilterState } from '@/lib/filters/state';

export interface FinderCounts {
  today: number;
  weekend: number;
  d7: number;
  free: number;
  kids: number;
  areas: Record<string, number>;
  /** Upcoming rows in the list, no filter: the search placeholder. */
  total: number;
}

export function finderCounts(listEvents: readonly VibeEvent[], f: FilterState, now: number, tz: string = REGION_TZ): FinderCounts {
  const n = (over: Partial<FilterState>) => applyFilters(listEvents, { ...f, ...over }, now, tz).length;
  return {
    today: n({ when: 'today' }),
    weekend: n({ when: 'weekend' }),
    d7: n({ when: '7d' }),
    free: n({ free: true }),
    kids: n({ kids: true }),
    areas: Object.fromEntries(AREAS.map((a) => [a, n({ areas: [a] })])),
    total: applyFilters(listEvents, EMPTY_FILTERS, now, tz).length,
  };
}

/** The phone chip row shows the selected areas and the two with the most rows (only those with rows), in AREAS order. */
export function chipAreas(counts: Record<string, number>, selected: readonly string[]): string[] {
  const top = AREAS.filter((a) => (counts[a] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || AREAS.indexOf(a) - AREAS.indexOf(b))
    .slice(0, 2);
  return AREAS.filter((a) => selected.includes(a) || top.includes(a));
}
