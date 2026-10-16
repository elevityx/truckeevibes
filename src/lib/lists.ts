import type { VibeEvent } from '@/lib/data/types';

export type ListSlug = 'all' | 'art' | 'music' | '21-plus' | 'kids' | 'family' | 'outdoors' | 'food-drink';

export interface ListDef {
  slug: ListSlug;
  path: string;
  label: string;
  /** The h1 of the list page; empty for the home list. */
  title: string;
  /** An EventGlyph category key (null = the calendar glyph). */
  glyph: string | null;
  lede: string;
  /** false = the list shows a "Soon" tile instead of a count. */
  ready: boolean;
  match(e: VibeEvent): boolean;
}

const ADULT = new Set(['18_plus', '21_plus']);
const has = (e: VibeEvent, c: string) => e.categories.includes(c);

/** W6 SSOT: the lists, in tile order. Tiles, the Lists menu, the list pages and the sitemap all read this. */
export const LISTS: readonly ListDef[] = [
  { slug: 'all', path: '/', label: 'All', title: '', glyph: null, lede: '', ready: true, match: () => true },
  {
    slug: 'art', path: '/art/', label: 'Art', title: 'Art around Truckee', glyph: 'arts', ready: true,
    lede: 'Gallery nights, theater, film and classes where you make something. The facts, and a link to the organizer.',
    match: (e) => has(e, 'arts'),
  },
  {
    slug: 'music', path: '/music/', label: 'Music', title: 'Music around Truckee', glyph: 'music', ready: true,
    lede: 'Live sets, open mics and bluegrass nights, with the facts and a link to the organizer. The ones we would go to wear the Our pick tag.',
    match: (e) => has(e, 'music'),
  },
  {
    slug: '21-plus', path: '/21-plus/', label: '21+', title: '21+ around Truckee', glyph: 'nightlife', ready: true,
    lede: 'Shows and nights out that card at the door. Only events the organizer lists as 21 and over.',
    match: (e) => e.age === '21_plus',
  },
  {
    slug: 'kids', path: '/kids/', label: 'Kids', title: "Kids' events around Truckee", glyph: 'family', ready: false,
    lede: 'Storytimes, camps and things made for kids. Tagged only when the organizer says so.',
    match: (e) => has(e, 'kids') && !ADULT.has(e.age),
  },
  {
    slug: 'family', path: '/family/', label: 'Family friendly', title: 'Family friendly around Truckee', glyph: 'family', ready: true,
    lede: 'Things the whole family can do together. Nothing here is listed as adults only.',
    match: (e) => (has(e, 'family') || has(e, 'kids') || e.age === 'all_ages' || e.age === 'family') && !ADULT.has(e.age),
  },
  {
    slug: 'outdoors', path: '/outdoors/', label: 'Outdoors', title: 'Outdoors around Truckee', glyph: 'outdoors', ready: true,
    lede: 'Trail days, races, paddles and ski events around the lake and the summit.',
    match: (e) => has(e, 'outdoors'),
  },
  {
    slug: 'food-drink', path: '/food-drink/', label: 'Food & drink', title: 'Food & drink around Truckee', glyph: 'food-drink', ready: true,
    lede: 'Tastings, brunches, trivia nights and pints with a cause, at local spots.',
    match: (e) => has(e, 'food-drink'),
  },
];

export function listBySlug(s: string): ListDef | null {
  return LISTS.find((l) => l.slug === s) ?? null;
}

export function countLists(events: readonly VibeEvent[]): Record<ListSlug, number> {
  const out = {} as Record<ListSlug, number>;
  for (const l of LISTS) out[l.slug] = events.filter((e) => l.match(e)).length;
  return out;
}
