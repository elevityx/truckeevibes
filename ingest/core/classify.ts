// Keyword classification (spec S1.8). Tables are public-safe. Description text is read here, in memory, and never returned.
import type { AgeKind, PriceKind } from '../types';

const TABLES: [string, RegExp][] = [
  ['music', /\b(?:concert|live music|band|dj|open mic|bluegrass|jazz)/],
  ['food-drink', /\b(?:beer|brew|wine|tasting|dinner|brunch|food truck)/],
  ['outdoors', /\b(?:hike|trail|paddle|ski|snowshoe|bike|run|race)/],
  ['family', /\b(?:kids|family|children|storytime|toddler)/],
  ['arts', /\b(?:art|gallery|theater|theatre|film|dance|craft)/],
  ['markets', /\b(?:market|fair|bazaar|craft fair)/],
  ['sports', /\b(?:race|tournament|game|match|5k|10k)/],
  ['nightlife', /\b(?:trivia|karaoke|comedy|party|night)/],
  ['learning', /\b(?:class|workshop|lecture|talk|lesson)/],
  ['holiday', /\b(?:christmas|holiday|santa|tree lighting|menorah|lights)/],
  ['halloween-fall', /\b(?:halloween|haunted|trick or treat|pumpkin|harvest|oktoberfest|costume)/],
];
const SLUGS = new Set(TABLES.map(([s]) => s));

export interface ClassifyInput { title: string; categoriesHint?: string[]; priceText?: string | null; ageText?: string | null }
export interface Classified {
  categories: string[];
  priceKind: PriceKind;
  priceMin?: number;
  priceMax?: number;
  age: AgeKind;
  descriptionFacts: string[];
}

function priceOf(priceText: string | null | undefined): Pick<Classified, 'priceKind' | 'priceMin' | 'priceMax'> {
  const p = (priceText ?? '').toLowerCase();
  if (!p) return { priceKind: 'unknown' };
  if (/\$/.test(p)) {
    const nums = [...p.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
    if (nums.length) return { priceKind: 'paid', priceMin: Math.min(...nums), priceMax: Math.max(...nums) };
    return { priceKind: 'paid' };
  }
  if (/\bfree\b/.test(p)) return { priceKind: 'free' };
  if (/donation/.test(p)) return { priceKind: 'donation' };
  return { priceKind: 'unknown' };
}

function ageOf(text: string): AgeKind {
  if (/21\+|21 and over/.test(text)) return '21_plus';
  if (/18\+/.test(text)) return '18_plus';
  if (/all ages/.test(text)) return 'all_ages';
  if (/kids|family/.test(text)) return 'family';
  return 'unknown';
}

export function classify(item: ClassifyInput, descriptionText?: string): Classified {
  const hints = (item.categoriesHint ?? []).map((h) => String(h).toLowerCase().trim()).filter(Boolean);
  const text = [item.title, ...hints.map((h) => h.replace(/[-_]/g, ' ')), item.ageText ?? '', descriptionText ?? ''].join(' \n ').toLowerCase();
  const categories = new Set<string>();
  for (const h of hints) if (SLUGS.has(h)) categories.add(h);
  for (const [slug, re] of TABLES) if (re.test(text)) categories.add(slug);
  const price = priceOf(item.priceText);
  const age = ageOf(text);
  const facts: string[] = [];
  if (price.priceKind === 'free') facts.push('free');
  if (age !== 'unknown') facts.push(age);
  return { categories: [...categories].sort(), ...price, age, descriptionFacts: facts };
}
