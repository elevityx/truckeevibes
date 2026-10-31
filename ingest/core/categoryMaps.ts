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

// Visit Lake Tahoe (Tribe REST) category slugs (DR-A15-2: "Kids & Families" maps to family only, never kids).
const TRIBE_VLT: Record<string, string> = {
  'kids-families-events': 'family',
  'music-dance-events': 'music',
  'nightlife-events': 'nightlife',
  'food-wine-events': 'food-drink',
  'festivals-events': 'community',
  'sports-events': 'sports',
};

/** Source labels that state the price is free (DR-A15-1). Checked on the label and its slugForm, in every family. */
export const FREE_LABELS: ReadonlySet<string> = new Set(['free', 'free-event', 'free-events']);
/** Editorial or filtered labels: neither a slug nor "unmapped" (keeps the classify-report honest). */
export const IGNORED_LABELS: Record<string, ReadonlySet<string>> = {
  tribe: new Set(['featured-events', 'headliners-events', 'local-events', 'attractions-events', 'wellness', 'tahoe-blue-event-center']),
  rss_libcal: new Set(['storytime', 'storytimes', 'featured events', 'book clubs', 'adult literacy & esl']),
};

/**
 * LibCal (Spec_Kids_Live DR-K3): kids/family come only from the adapter's reserved `audience:*` hints (the organizer's audience labels),
 * never from a raw category label, so every COMMON key that resolves to kids or family is removed from this copy.
 */
function libcalMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const [k, v] of Object.entries(COMMON)) if (v !== 'kids' && v !== 'family') m[k] = v;
  return {
    ...m, steam: 'learning', stem: 'learning', 'computers & technology': 'learning', 'lifelong learning': 'learning', 'arts & crafts': 'arts',
    'audience:kids': 'kids', 'audience:family': 'family',
  };
}

/** Every family in `ingest/adapters/index.ts`. Each gets its own copy so a family can be extended alone. */
export const CATEGORY_MAPS: Record<string, Record<string, string>> = {
  tribe: { ...COMMON, ...TRIBE_VLT },
  ics_chambermaster: { ...COMMON },
  ics_civicplus: { ...COMMON },
  ics_eventsmanager: { ...COMMON },
  html_finalsite: { ...COMMON },
  wprest_crystalbay: { ...COMMON },
  rss_libcal: libcalMap(),
  // Rec1 catalog (Amendment K3): kids only from the reserved `audience:kids` hint (Rec1's own minimum age <= 12), as LibCal.
  rec1_catalog: libcalMap(),
  curated_dates: { ...COMMON },
  // `family`/`kids` only from Tahoe Donner's own Family Events / Kids Programming lists; `dining` and `live music` resolve through COMMON.
  html_tahoedonner: {
    ...COMMON, snowshoe: 'outdoors', 'downhill ski resort': 'outdoors', 'cross country ski center': 'outdoors', 'tahoe donner trails': 'outdoors',
    'family events': 'family', 'kids programming': 'kids',
  },
};

const slugForm = (l: string) => l.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Maps hint labels to our slugs. Unknown families use the common map. `sourceFree`: a label states the price is free. */
export function mapHints(family: string | undefined, hints: readonly string[]): { slugs: string[]; unmapped: string[]; sourceFree: boolean } {
  const map = (family && CATEGORY_MAPS[family]) || COMMON;
  const ignored = (family && IGNORED_LABELS[family]) || undefined;
  const slugs: string[] = [];
  const unmapped: string[] = [];
  let sourceFree = false;
  for (const raw of hints) {
    const label = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const f = slugForm(label);
    if (FREE_LABELS.has(label) || FREE_LABELS.has(f)) { sourceFree = true; continue; }
    if (ignored && (ignored.has(label) || ignored.has(f))) continue;
    // Reserved eligibility hints resolve only by their exact label, never through the slug form (PR #35 review P1).
    const hit = map[label] ?? (f.startsWith('audience-') ? undefined : map[f]);
    if (hit) slugs.push(hit);
    else unmapped.push(label);
  }
  return { slugs, unmapped, sourceFree };
}
