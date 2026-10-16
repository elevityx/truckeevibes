import { CATEGORY_SLUGS } from '@/lib/categories';
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

/** Short area names for the phone chip row ("Incline 13"). */
export const AREA_SHORT: Record<string, string> = {
  truckee: 'Truckee',
  donner_lake: 'Donner',
  tahoe_city_west_shore: 'Tahoe City',
  olympic_valley_northstar: 'Olympic Valley',
  kings_beach_north_shore: 'Kings Beach',
  incline_crystal_bay: 'Incline',
  reno_carson: 'Reno',
};

export interface FilterState {
  when: When | null;
  areas: Area[];
  /** Category slugs (CATEGORY_LABELS order); any overlap matches, empty = all. */
  cats: string[];
  free: boolean;
  kids: boolean;
  /** Search text: trimmed, whitespace collapsed, at most 60 characters. */
  q: string;
}

export const EMPTY_FILTERS: FilterState = { when: null, areas: [], cats: [], free: false, kids: false, q: '' };

export const Q_MAX = 60;

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

/** Trim, collapse inner whitespace, cut to 60 characters (and trim again if the cut leaves a trailing space). */
export function cleanQuery(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, Q_MAX).trim();
}

/** Accepts a search string with or without the leading "?". Unknown values are dropped. */
export function parseFilters(search: string): FilterState {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const picked = new Set((p.get('area') ?? '').split(',').filter(Boolean));
  const cats = new Set((p.get('cat') ?? '').split(',').filter(Boolean));
  return {
    when: parseWhen(p.get('when')),
    areas: AREAS.filter((a) => picked.has(a)),
    cats: CATEGORY_SLUGS.filter((c) => cats.has(c)),
    free: p.get('free') === '1',
    kids: p.get('kids') === '1',
    q: cleanQuery(p.get('q')),
  };
}

/** Stable order: when, area (AREAS order), cat (CATEGORY_LABELS order), free, kids, q. No leading "?"; the empty state is ''. */
export function filtersToSearch(s: FilterState): string {
  const parts: string[] = [];
  if (s.when) parts.push(`when=${typeof s.when === 'string' ? s.when : `date:${s.when.date}`}`);
  const areas = AREAS.filter((a) => s.areas.includes(a));
  if (areas.length) parts.push(`area=${areas.join(',')}`);
  const cats = CATEGORY_SLUGS.filter((c) => s.cats.includes(c));
  if (cats.length) parts.push(`cat=${cats.join(',')}`);
  if (s.free) parts.push('free=1');
  if (s.kids) parts.push('kids=1');
  const q = cleanQuery(s.q);
  if (q) parts.push(new URLSearchParams({ q }).toString());
  return parts.join('&');
}

const KEYS = ['when', 'area', 'cat', 'free', 'kids', 'q'];

function rebuild(href: string, s: FilterState, drop: readonly string[], tail: string[]): string {
  const u = new URL(href);
  for (const k of drop) u.searchParams.delete(k);
  const search = [u.searchParams.toString(), filtersToSearch(s), ...tail].filter(Boolean).join('&');
  return u.pathname + (search ? `?${search}` : '') + u.hash;
}

/** Pathname + search + hash with only the six filter params replaced. */
export function filtersUrl(href: string, s: FilterState): string {
  return rebuild(href, s, KEYS, []);
}

/** filtersUrl plus the open event (`event=<id>`, after the filters; null removes it). Filter values keep their literal form (`when=date:2026-10-17`). */
export function pageUrl(href: string, s: FilterState, eventId: string | null): string {
  return rebuild(href, s, [...KEYS, 'event'], eventId ? [`event=${encodeURIComponent(eventId)}`] : []);
}

/** Each non-empty key counts one (q counts 1). */
export function activeFilterCount(s: FilterState): number {
  return (s.when ? 1 : 0) + (s.areas.length ? 1 : 0) + (s.cats.length ? 1 : 0) + (s.free ? 1 : 0) + (s.kids ? 1 : 0) + (cleanQuery(s.q) ? 1 : 0);
}
