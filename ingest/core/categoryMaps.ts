// Per-family maps from a source's own category label or slug to our slugs (plan 3.3 step 1a). Keys are lowercased.
// Unmapped labels are dropped by `classify` and counted per source in the classify-report.
export const OUR_SLUGS = [
  'music', 'food-drink', 'outdoors', 'family', 'kids', 'arts', 'markets', 'sports', 'nightlife', 'learning', 'community', 'holiday', 'halloween-fall', 'schools',
] as const;

const GROUPS: Record<string, string[]> = {
  music: ['live-music', 'concerts', 'music'],
  arts: ['arts-culture', 'arts-and-culture', 'art', 'arts', 'theater', 'theatre', 'film'],
  family: ['family', 'family-friendly'],
  kids: ['kids', 'children', 'youth'],
  outdoors: ['outdoor', 'outdoors', 'recreation', 'sports-recreation'],
  'food-drink': ['food', 'food-drink', 'food-and-drink', 'dining', 'wine', 'beer'],
  community: ['festivals', 'community'],
  markets: ['markets', 'farmers-market'],
  learning: ['classes', 'workshops', 'education'],
  nightlife: ['nightlife'],
  holiday: ['holiday', 'holidays'],
  'halloween-fall': ['halloween', 'fall'],
};

function build(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const s of OUR_SLUGS) m[s] = s;
  for (const [slug, labels] of Object.entries(GROUPS)) for (const l of labels) m[l] = slug;
  return m;
}

const COMMON = build();

/** Every family in `ingest/adapters/index.ts`. Each gets its own copy so a family can be extended alone. */
export const CATEGORY_MAPS: Record<string, Record<string, string>> = {
  tribe: { ...COMMON },
  ics_chambermaster: { ...COMMON },
  ics_civicplus: { ...COMMON },
  ics_eventsmanager: { ...COMMON },
  html_finalsite: { ...COMMON },
};

const slugForm = (l: string) => l.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Maps hint labels to our slugs. Unknown families use the common map. */
export function mapHints(family: string | undefined, hints: readonly string[]): { slugs: string[]; unmapped: string[] } {
  const map = (family && CATEGORY_MAPS[family]) || COMMON;
  const slugs: string[] = [];
  const unmapped: string[] = [];
  for (const raw of hints) {
    const label = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const hit = map[label] ?? map[slugForm(label)];
    if (hit) slugs.push(hit);
    else unmapped.push(label);
  }
  return { slugs, unmapped };
}
