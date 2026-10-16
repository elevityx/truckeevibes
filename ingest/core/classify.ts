// Classifier v2 (plan 3.3): fail-closed. Description text is read here, in memory, and never returned; every output
// that explains a tag is a closed reason code. When unsure, no tag.
import type { AgeKind, PriceKind } from '../types';
import { ageOf } from './ageGrammar';
import { negatedInSentence, normalizeForNegation } from './negation';
import { mapHints } from './categoryMaps';
import { capReasons, type ReasonCode } from './reasonCodes';

/** Whole-word title keywords. `kids` and `family` never come from the title (plan 3.3 step 1b). */
const TABLES: [string, RegExp][] = [
  ['music', /\b(?:concert|live music|band|dj|open mic|bluegrass|jazz)(?:s|es)?\b/],
  ['food-drink', /\b(?:beer|brew|brewery|breweries|brewing|wine|tasting|dinner|brunch|food truck)(?:s|es)?\b/],
  ['outdoors', /\b(?:hike|hiking|trail|paddle|paddling|ski|skiing|snowshoe|bike|biking|run|running|race)(?:s|es)?\b/],
  ['arts', /\b(?:art|gallery|theater|theatre|film|dance|craft)(?:s|es)?\b/],
  ['markets', /\b(?:market|fair|bazaar|craft fair)(?:s|es)?\b/],
  ['sports', /\b(?:race|tournament|game|match|5k|10k)(?:s|es)?\b/],
  ['nightlife', /\b(?:trivia|karaoke|comedy|party|night)(?:s|es)?\b/],
  ['learning', /\b(?:class|workshop|lecture|talk|lesson)(?:s|es)?\b/],
  ['holiday', /\b(?:christmas|holiday|santa|tree lighting|menorah|lights)(?:s|es)?\b/],
  ['halloween-fall', /\b(?:halloween|haunted|trick or treat|pumpkin|harvest|oktoberfest|costume)(?:s|es)?\b/],
];

/** Description positives for kids/family only (the closed list), each guarded by negation. */
const DESC_POSITIVES: { re: RegExp; cat: 'kids' | 'family' }[] = [
  { re: /\bfor kids\b/g, cat: 'kids' },
  { re: /\bchildren's\b/g, cat: 'kids' },
  // A bare "kids" is usually the object being excluded, so only constructive forms count.
  { re: /\bkids'(?!\w)/g, cat: 'kids' },
  { re: /\bkids\s+(?:welcome|activities|activity|zone|area|crafts?|games|programs?|menu|tickets?|ages|of all ages|under\s+\d+|eat free|\d+\s*(?:and|&)\s*under)\b/g, cat: 'kids' },
  { re: /\bbring\s+(?:the|your)\s+kids\b/g, cat: 'kids' },
  { re: /\bstorytime\b/g, cat: 'kids' },
  { re: /\btoddlers?\b/g, cat: 'kids' },
  { re: /\bfamily[- ]friendly\b/g, cat: 'family' },
  { re: /\bfamily event\b/g, cat: 'family' },
  { re: /\ball ages welcome\b/g, cat: 'family' },
];

/** TS mirror of `private.adult_signal` (20261020000200_ingest_rpcs.sql:37-40), same word list. Expects lowercase text. */
const ADULT_WORDS = /\b(?:21|18|bar|bars|pub|pubs|crawl|cocktail|cocktails|happy hour|brewery|breweries|brewing|brewpub|taproom|tap room|alehouse|ale works|ale house|winery|wine|wines|beer|beers|saloon|tavern|lounge|cantina|casino|nightclub|club|burlesque|drag|speakeasy|distillery|spirits|tequila|whiskey|whisky|margarita|mimosa|bottomless)\b/;
export function adultSignal(t: string | null | undefined): boolean {
  return t ? ADULT_WORDS.test(t) : false;
}

export interface ClassifyInput {
  title: string;
  categoriesHint?: string[];
  priceText?: string | null;
  ageText?: string | null;
  venueName?: string | null;
  family?: string;
}
export interface Classified {
  categories: string[];
  priceKind: PriceKind;
  priceMin?: number;
  priceMax?: number;
  age: AgeKind;
  reasons: ReasonCode[];
  /** Source labels with no map entry (lowercased). For the classify-report only; never submitted. */
  unmapped: string[];
}

// ---- price -----------------------------------------------------------------------------------------------------------
const FREE_NEGATIVES = /\bfree parking\b|\bgluten[- ]free\b|\bfree wi-?fi\b|\bkids? (?:under \d+|eat) free\b|\bfree (?:beer|drink|gift|swag|appetizer)s?\b/g;
const FREE_STRONG = /\b(?:free admission|free entry|free event|free to attend|free show|no cover|free and open to the public)\b/;

/** `{ free, blocked }`: whether text states free once the negatives are removed, and whether a negative covered a "free". */
function freeIn(text: string, strong: boolean, titleStart = false): { free: boolean; blocked: boolean } {
  const stripped = text.replace(FREE_NEGATIVES, ' ');
  const blocked = stripped !== text && /\bfree\b/.test(text);
  const free = strong ? FREE_STRONG.test(stripped) : titleStart ? /^\s*free\b/.test(stripped) : /\bfree\b/.test(stripped);
  return { free, blocked };
}

function priceOf(item: ClassifyInput, description: string): { priceKind: PriceKind; priceMin?: number; priceMax?: number; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  const pt = (item.priceText ?? '').toLowerCase();
  const title = item.title.toLowerCase();
  let blocked = false;
  if (pt) {
    if (/\$/.test(pt)) {
      const nums: number[] = [];
      for (const m of pt.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s*[-–—]\s*\$?\s?(\d[\d,]*(?:\.\d+)?))?/g))
        for (const g of [m[1], m[2]]) if (g !== undefined) { const n = Number(g.replace(/,/g, '')); if (Number.isFinite(n)) nums.push(n); }
      reasons.push('price:text_paid');
      return nums.length ? { priceKind: 'paid', priceMin: Math.min(...nums), priceMax: Math.max(...nums), reasons } : { priceKind: 'paid', reasons };
    }
    const f = freeIn(pt, false);
    blocked ||= f.blocked;
    if (f.free) return { priceKind: 'free', reasons: ['price:text_free'] };
    if (/donation/.test(pt)) return { priceKind: 'donation', reasons: ['price:text_donation'] };
  }
  const desc = freeIn(description, true);
  blocked ||= desc.blocked;
  if (desc.free) return { priceKind: 'free', reasons: ['price:desc_free'] };
  const t = freeIn(title, false, true);
  blocked ||= t.blocked;
  if (t.free) return { priceKind: 'free', reasons: ['price:title_free'] };
  if (blocked) reasons.push('price:neg_blocked');
  reasons.push('price:unknown');
  return { priceKind: 'unknown', reasons };
}

// ---- categories ------------------------------------------------------------------------------------------------------
function descCategories(description: string): Map<'kids' | 'family', ReasonCode> {
  const out = new Map<'kids' | 'family', ReasonCode>();
  if (!description) return out;
  if (ageOf({ title: '', description }).adult) return out;
  for (const { re, cat } of DESC_POSITIVES) {
    for (const m of description.matchAll(re)) {
      if (negatedInSentence(description, m.index!, m.index! + m[0].length)) continue;
      out.set(cat, cat === 'kids' ? 'cat:desc_kids' : 'cat:desc_family');
      break;
    }
  }
  return out;
}

export function classify(item: ClassifyInput, descriptionText?: string): Classified {
  const description = normalizeForNegation(descriptionText);
  const title = item.title.toLowerCase();
  const reasons: ReasonCode[] = [];
  const cats = new Set<string>();

  // 1. categories: (a) source map, (b) whole-word title keywords, (c) description positives for kids/family
  const { slugs, unmapped } = mapHints(item.family, (item.categoriesHint ?? []).map(String));
  if (slugs.length) { reasons.push('cat:source_map'); for (const s of slugs) cats.add(s); }
  const kw = TABLES.filter(([, re]) => re.test(title)).map(([s]) => s);
  if (kw.length) { reasons.push('cat:title_kw'); for (const s of kw) cats.add(s); }
  for (const [cat, code] of descCategories(description)) { reasons.push(code); cats.add(cat); }

  // 2. price
  const price = priceOf(item, description);
  reasons.push(...price.reasons);

  // 3. age
  const ageRes = ageOf({ ageText: item.ageText, title: item.title, description });
  let age = ageRes.age;
  const ageReasons = [...ageRes.reasons];

  // 4. final invariant (always last)
  const wl = adultSignal(title) || adultSignal((item.venueName ?? '').toLowerCase());
  const explicit = ageRes.adult || ageRes.ambiguous;
  if (explicit || wl) {
    const positive = cats.has('kids') || cats.has('family') || age === 'all_ages' || age === 'family';
    cats.delete('kids');
    cats.delete('family');
    for (const [code, cat] of [['cat:desc_kids', 'kids'], ['cat:desc_family', 'family']] as const) { const i = reasons.indexOf(code); if (i >= 0 && !cats.has(cat)) reasons.splice(i, 1); }
    if (age === 'all_ages' || age === 'family') {
      age = 'unknown';
      for (const c of ['age:all_ages', 'age:family'] as const) { const i = ageReasons.indexOf(c); if (i >= 0) ageReasons.splice(i, 1); }
    }
    if (positive && !ageRes.adult && age === 'unknown' && !ageReasons.includes('age:ambiguous')) {
      const i = ageReasons.indexOf('age:unknown');
      if (i >= 0) ageReasons.splice(i, 1);
      ageReasons.push('age:ambiguous');
    }
    if (explicit) ageReasons.push('conflict:adult');
    if (wl) ageReasons.push('conflict:adult_signal');
  }
  reasons.push(...ageReasons);

  const out: Classified = { categories: [...cats].sort(), priceKind: price.priceKind, age, reasons: capReasons(reasons), unmapped: [...new Set(unmapped)] };
  if (price.priceMin !== undefined) out.priceMin = price.priceMin;
  if (price.priceMax !== undefined) out.priceMax = price.priceMax;
  return out;
}
