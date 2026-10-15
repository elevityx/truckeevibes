import type { Area, When } from '@/lib/data/types';

/** The seven seeded areas, in display order (Truckee first). */
export const AREAS: readonly Area[] = [
  'truckee', 'donner_lake', 'tahoe_city_west_shore', 'olympic_valley_northstar',
  'kings_beach_north_shore', 'incline_crystal_bay', 'reno_carson',
];

export const AREA_LABELS: Record<string, string> = {
  truckee: 'Truckee',
  donner_lake: 'Donner Lake',
  tahoe_city_west_shore: 'Tahoe City & West Shore',
  olympic_valley_northstar: 'Olympic Valley & Northstar',
  kings_beach_north_shore: 'Kings Beach & North Shore',
  incline_crystal_bay: 'Incline & Crystal Bay',
  reno_carson: 'Reno & Carson',
};

export interface FilterState {
  when: When | null;
  areas: Area[];
  free: boolean;
}

export const EMPTY_FILTERS: FilterState = { when: null, areas: [], free: false };

const NAMED_WHEN = ['today', 'tonight', 'tomorrow', 'weekend', '7d'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function parseWhen(v: string | null): When | null {
  if (!v) return null;
  if ((NAMED_WHEN as readonly string[]).includes(v)) return v as When;
  if (v.startsWith('date:') && realDate(v.slice(5))) return { date: v.slice(5) };
  return null;
}

/** Accepts a search string with or without the leading "?". Unknown values are dropped. */
export function parseFilters(search: string): FilterState {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const picked = new Set((p.get('area') ?? '').split(',').filter(Boolean));
  return {
    when: parseWhen(p.get('when')),
    areas: AREAS.filter((a) => picked.has(a)),
    free: p.get('free') === '1',
  };
}

/** Stable order: when, area (AREAS order), free. No leading "?"; the empty state is ''. Values are safe literals. */
export function filtersToSearch(s: FilterState): string {
  const parts: string[] = [];
  if (s.when) parts.push(`when=${typeof s.when === 'string' ? s.when : `date:${s.when.date}`}`);
  const areas = AREAS.filter((a) => s.areas.includes(a));
  if (areas.length) parts.push(`area=${areas.join(',')}`);
  if (s.free) parts.push('free=1');
  return parts.join('&');
}

/** Pathname + search + hash with only the three filter params replaced. */
export function filtersUrl(href: string, s: FilterState): string {
  const u = new URL(href);
  for (const k of ['when', 'area', 'free']) u.searchParams.delete(k);
  const search = [u.searchParams.toString(), filtersToSearch(s)].filter(Boolean).join('&');
  return u.pathname + (search ? `?${search}` : '') + u.hash;
}

export function activeFilterCount(s: FilterState): number {
  return (s.when ? 1 : 0) + (s.areas.length ? 1 : 0) + (s.free ? 1 : 0);
}
