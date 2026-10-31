// Classifier v5 (Spec_21Plus_Coverage c5: age separators, `music` title word, Events Manager labels; v4 plan 3.3; A15 adds source-free labels, $0 and description price phrases, and explicit kids/family phrases; Spec_Kids_Live c4
// adds kids title keywords, a kids-safe `club` exemption for the word-list check, and audience-authoritative families): fail-closed. Description text is read here, in memory, and never returned; every output
// that explains a tag is a closed reason code. When unsure, no tag.
import type { AgeKind, PriceKind } from '../types';
import { ageOf } from './ageGrammar';
import { negatedInSentence, normalizeForNegation } from './negation';
import { mapHints } from './categoryMaps';
import { capReasons, type ReasonCode } from './reasonCodes';

/** Whole-word title keywords. `kids` and `family` never come from the title (plan 3.3 step 1b). */
const TABLES: [string, RegExp][] = [
  ['music', /\b(?:concert|live music|music|band|dj|open mic|bluegrass|jazz|orchestra|symphony)(?:s|es)?\b/], // c5: + music, orchestra, symphony
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

/**
 * c4 (Spec_Kids_Live 5a): title words that say an event is made for kids. `family` still never comes from a title. Whole words on the
 * lowercased title; `camp` counts only with a kids/season prefix, an age band only when it tops out at 12 or under.
 */
const KIDS_TITLE = /\b(?:story ?times?|toddlers?|preschool(?:ers?)?|baby lapsit|lapsit|kids'?|kid's|children's|youth|tweens?|(?:kids|youth|day|summer|winter|spring break|holiday) camps?)(?![\w'])/g;
const KIDS_TITLE_AGES = /\bages?\s+(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/g;
const KIDS_TITLE_NEG = /\b(?:adults?|grown[- ]?ups?|no kids|kids?[- ]free|adults? only|grown[- ]ups? only|without (?:the )?kids|kids eat free|kids (?:under \d+ )?(?:eat|drink) free|parents'? night out|for parents)\b/;
/** Families whose adapter states the audience (DR-K3): kids/family only from `audience:*` hints, never from the title or description. */
const AUDIENCE_FAMILIES: ReadonlySet<string> = new Set(['rss_libcal', 'rec1_catalog']);
/** c4 kids-safe exemption for the word-list check only (`adultSignal` itself and `private.adult_signal` are unchanged). */
const KIDS_SAFE_CLUB = /\b(?:lego(?:\s*\/\s*duplo)?|duplo|builders?|kids'?|children's|chess|homework|reading|science|stem|steam|boys (?:&|and) girls|(?:kids'?|children's|teen|tween) book)\s+club\b/g;
const stripKidsSafe = (t: string) => t.replace(KIDS_SAFE_CLUB, ' ');

function titleKids(title: string): boolean {
  if (KIDS_TITLE_NEG.test(title)) return false;
  const ok = (i: number, len: number) => !negatedInSentence(title, i, i + len);
  for (const m of title.matchAll(KIDS_TITLE)) if (ok(m.index!, m[0].length)) return true;
  for (const m of title.matchAll(KIDS_TITLE_AGES)) if (+m[1] <= +m[2] && +m[2] <= 12 && ok(m.index!, m[0].length)) return true;
  return false;
}

/** Description positives for kids/family only (the closed list), each guarded by negation. */
const DESC_POSITIVES: { re: RegExp; cat: 'kids' | 'family'; ok?: (m: RegExpMatchArray) => boolean }[] = [
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
  // A15-3: explicit common phrasing
  { re: /\bfun for the whole family\b/g, cat: 'family' },
  { re: /\bfor (?:the whole|all the) family\b/g, cat: 'family' },
  { re: /\bfamilies (?:are )?welcome\b/g, cat: 'family' },
  { re: /\bfor families\b/g, cat: 'family' },
  { re: /\bkid[- ]friendly\b/g, cat: 'family' },
  { re: /\bfor children\b/g, cat: 'kids' },
  { re: /\bages?\s+(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/g, cat: 'kids', ok: (m) => +m[1] <= +m[2] && +m[2] <= 12 },
  { re: /\bages?\s+(\d{1,2})\s*(?:and|&)\s*under\b/g, cat: 'kids', ok: (m) => +m[1] <= 12 },
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
const FREE_NEGATIVES = /\bfree parking\b|\bgluten[- ]free\b|\bfree wi-?fi\b|\bkids? (?:under \d+|eat) free\b|\bfree (?:beer|drink|gift|swag|appetizer)s?\b|\bfree\s*\*|\bfree for (?:kids|children|members|students|seniors|veterans|military|locals|residents|under \d+)\b/g;
const FREE_STRONG = /\b(?:free admission|free entry|free event|free to attend|free show|no cover|free and open to the public|free of charge|at no cost|no cost to (?:attend|participate|join)|(?:admission|entry|entrance|attendance|tickets?|the event|this event) (?:is|are) free|no charge|(?:admission|entry|cost|price|tickets?)\s*:?\s*(?:free\b|\$0(?:\.00)?(?![\d.,])))/g;
const FREE_NEG_CUE = /\b(?:no|not|never|no longer|without)\b|\b(?:isn't|aren't|wasn't|won't|weren't)\b/;
/** Phrases that themselves mean free; matched whole, so the leading "no" is not a negation. */
const FREE_WHOLE_NO = /^no (?:cover|charge|cost)/;
/** A $0 is the whole price only when no range, subset qualifier, or other price follows. */
const ZERO_TAIL_BAD = /^\s*(?:[-–—]|to\b|through\b|thru\b|and\b|for\b|with\b|if\b|when\b|before\b|after\b|until\b|per\b|\/)/;
const TITLE_FREE = /(?:^|[:|–—]\s*|\s-\s)(?:an?\s+|our\s+)?free\b/;

/** Whether text states free once the negatives are removed, and whether a negative (or a negating prefix) covered a "free". */
function freeIn(text: string, mode: 'text' | 'desc' | 'title'): { free: boolean; blocked: boolean } {
  const stripped = text.replace(FREE_NEGATIVES, ' ');
  let blocked = stripped !== text && /\bfree\b/.test(text);
  if (mode === 'text') return { free: /\bfree\b/.test(stripped), blocked };
  if (mode === 'title') return { free: TITLE_FREE.test(stripped), blocked };
  const clauseBefore = (i: number) => stripped.slice(0, i).split(/[.;!?,\n]/).pop() ?? '';
  for (const m of stripped.matchAll(FREE_STRONG)) {
    const i = m.index!;
    if (FREE_NEG_CUE.test(clauseBefore(i))) { blocked = true; continue; }
    if (m[0].includes('$')) {
      const rest = stripped.slice(i + m[0].length);
      const others = (stripped.slice(0, i) + ' ' + rest).match(/\$\s?\d[\d,.]*/g) ?? [];
      if (ZERO_TAIL_BAD.test(rest) || others.some((o) => Number(o.replace(/[$,\s]/g, '')) !== 0)) { blocked = true; continue; }
    }
    return { free: true, blocked };
  }
  if (!blocked) for (const cl of stripped.split(/[.;!?,\n]/)) if (/\bfree\b/.test(cl) && FREE_NEG_CUE.test(cl) && !FREE_WHOLE_NO.test(cl.trim())) { blocked = true; break; }
  return { free: false, blocked };
}

function priceOf(item: ClassifyInput, description: string, sourceFree: boolean): { priceKind: PriceKind; priceMin?: number; priceMax?: number; reasons: ReasonCode[] } {
  const reasons: ReasonCode[] = [];
  const pt = (item.priceText ?? '').toLowerCase();
  const title = item.title.toLowerCase();
  let blocked = false;
  if (pt) {
    if (/\$/.test(pt)) {
      const nums: number[] = [];
      for (const m of pt.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s*[-–—]\s*\$?\s?(\d[\d,]*(?:\.\d+)?))?/g))
        for (const g of [m[1], m[2]]) if (g !== undefined) { const n = Number(g.replace(/,/g, '')); if (Number.isFinite(n)) nums.push(n); }
      if (nums.length > 0 && nums.every((n) => n === 0)) return { priceKind: 'free', reasons: ['price:text_free'] };
      reasons.push('price:text_paid');
      return nums.length ? { priceKind: 'paid', priceMin: Math.min(...nums), priceMax: Math.max(...nums), reasons } : { priceKind: 'paid', reasons };
    }
    const f = freeIn(pt, 'text');
    blocked ||= f.blocked;
    if (f.free) return { priceKind: 'free', reasons: ['price:text_free'] };
    if (/donation/.test(pt)) return { priceKind: 'donation', reasons: ['price:text_donation'] };
  }
  if (sourceFree) return { priceKind: 'free', reasons: ['price:source_free'] };   // after priceText: a stated price wins
  const desc = freeIn(description, 'desc');
  blocked ||= desc.blocked;
  if (desc.free) return { priceKind: 'free', reasons: ['price:desc_free'] };
  const t = freeIn(title, 'title');
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
  for (const { re, cat, ok } of DESC_POSITIVES) {
    for (const m of description.matchAll(re)) {
      if (ok && !ok(m)) continue;
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
  const { slugs, unmapped, sourceFree } = mapHints(item.family, (item.categoriesHint ?? []).map(String));
  if (slugs.length) { reasons.push('cat:source_map'); for (const s of slugs) cats.add(s); }
  const kw = TABLES.filter(([, re]) => re.test(title)).map(([s]) => s);
  if (kw.length) { reasons.push('cat:title_kw'); for (const s of kw) cats.add(s); }
  const audienceFamily = !!item.family && AUDIENCE_FAMILIES.has(item.family);
  if (!audienceFamily && titleKids(title)) { if (!reasons.includes('cat:title_kw')) reasons.push('cat:title_kw'); cats.add('kids'); }
  if (!audienceFamily) for (const [cat, code] of descCategories(description)) { reasons.push(code); cats.add(cat); }

  // 2. price
  const price = priceOf(item, description, sourceFree);
  reasons.push(...price.reasons);

  // 3. age
  const ageRes = ageOf({ ageText: item.ageText, title: item.title, description });
  let age = ageRes.age;
  const ageReasons = [...ageRes.reasons];

  // 4. final invariant (always last)
  const wl = adultSignal(stripKidsSafe(title)) || adultSignal(stripKidsSafe((item.venueName ?? '').toLowerCase()));
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
