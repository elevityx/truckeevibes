// Admission grammar (plan 3.3 step 3). Reads structured age text, the title and the description in memory; returns codes only.
import type { AgeKind } from '../types';
import { negatedInSentence, normalizeForNegation } from './negation';
import type { ReasonCode } from './reasonCodes';

export interface AgeInput { ageText?: string | null; title: string; description?: string | null }
export interface AgeResult { age: AgeKind; reasons: ReasonCode[]; adult: boolean; ambiguous: boolean }

const norm = normalizeForNegation;

/** Words that follow "21+" when it is not an admission rule ("21+ local vendors", "21+ years of music"). */
const NOT_ADMISSION_NEXT = /^(?:years?|yrs?|vendors?|local|locals|artists?|makers?|exhibitors?|businesses|brands?|breweries|wineries|restaurants|sponsors?|members?|participants?|performers?|musicians?|bands?|merchants?|booths?|crafters?)\b/;
/** Words that make a following phrase an admission rule. */
const ADMISSION_NEXT = /^(?:only|show|event|night|admission|entry|with\s+(?:a\s+)?(?:valid\s+)?id|id\b|to\s+enter|required)/;
const ADMISSION_PREV = /(?:\bages?|\badmission|\bentry|\bevent is|\bshow is|\bguests? must be|\bmust be|\bage limit:?|\brestricted to)\s*$/;

const BAR_RULE_NEXT = /^(?:to\s+(?:drink|purchase|buy|consume)|for\s+(?:alcohol|drinks?|beer|wine|the bar)|wristband|bar area|beer garden)\b/;

type Context = 'admission' | 'ambiguous' | 'bar_rule';

/** `years` is true for the "21 yrs+" form: it has no "starts the text" fallback ("21 years+ of music" is a count). */
function admission(text: string, start: number, end: number, years = false): Context {
  const before = text.slice(0, start);
  const after = text.slice(end).replace(/^[\s]+/, '');
  if (/(?:[$#]|\d\s*\/)[\s*]*$/.test(before)) return 'ambiguous'; // c5: a price, a number or a date ("$ 21+", "# *21+*", "9/ 21+") is never an admission
  if (BAR_RULE_NEXT.test(after)) return 'bar_rule';
  if (NOT_ADMISSION_NEXT.test(after)) return 'ambiguous';
  if (!years && before.replace(/[^a-z0-9]/g, '') === '') return 'admission'; // starts the title / the text
  if (ADMISSION_PREV.test(before)) return 'admission';
  if (ADMISSION_NEXT.test(after)) return 'admission';
  if (!years && /\*$/.test(before) && /^\*/.test(after)) return 'admission'; // c5: a "*21+*" wrapper
  if (after === '' || (!years && /^[)\]\-–—,.;:!•·]/.test(after))) return 'admission'; // closes the text or sits in a bracket / after a separator (c5: also • ·)
  if (!years && /[(\[\-–—,:•·]\s*$/.test(before)) return 'admission';
  return 'ambiguous';
}

type Found = { admission: boolean; ambiguous: boolean; bar: boolean };

function numberPhrases(text: string, n: 18 | 21): Found {
  const out: Found = { admission: false, ambiguous: false, bar: false };
  const record = (s: number, e: number, years = false) => {
    const c = admission(text, s, e, years);
    if (c === 'admission') out.admission = true; else if (c === 'bar_rule') out.bar = true; else out.ambiguous = true;
  };
  const yearsWord = /\b(?:years?|yrs?)\b/;
  // These need the admission context; they can be a count ("21+ years", "over 21 vendors").
  for (const m of text.matchAll(new RegExp(`(?<![\\w$./])${n}\\s*(?:years?|yrs?)?\\s?\\+`, 'g'))) record(m.index!, m.index! + m[0].length, yearsWord.test(m[0]));
  for (const m of text.matchAll(new RegExp(`(?<![\\w$./])${n}(?:\\s*|-)(?:(?:years?|yrs?)(?:\\s*|-))?(?:and|&)(?:\\s*|-)(?:over|up|older)\\b`, 'g'))) record(m.index!, m.index! + m[0].length, yearsWord.test(m[0]));
  for (const m of text.matchAll(new RegExp(`\\bover\\s+${n}\\b`, 'g'))) record(m.index!, m.index! + m[0].length);
  // These carry their own context.
  const own = [
    `\\bages?\\s+${n}\\b(?!\\s*(?:[-–—]|to|through|thru)\\s*\\d|\\s*(?:and|&|or)\\s*(?:under|younger|below))`,
    `\\bmust be ${n}\\b`,
    `(?<![\\w$.])${n}\\s+(?:years?\\s+)?or\\s+(?:older|over)\\b`,
    `\\bunder ${n}\\s+(?:not|aren't|are not)\\s+(?:be\\s+)?(?:permitted|allowed|admitted)`,
    `\\bno(?:\\s*one|body)\\s+under\\s+${n}\\b`,
  ];
  for (const p of own) if (new RegExp(p).test(text)) out.admission = true;
  // c5 (Spec_21Plus_Coverage r2/r3): two more own-context phrasings. Each is matched whole (with its optional "years of age and older"
  // tail), then judged on what follows: a unit other than years ("at least 21 months") is ambiguous, a drinking-only rule ("… to drink")
  // is a bar rule. A bar rule found by either phrasing vetoes an admission from an overlapping match of the other (review F1).
  const NOT_YEARS = /^(?:months?|mos?|weeks?|days?|inch(?:es)?|lbs?|pounds?|cm|ft|feet)\b/;
  const TAIL = `(?:\\s+years?(?:\\s+(?:old|of\\s+age))?)?(?:\\s+(?:and|or)\\s+(?:over|up|older))?`;
  const hits: { s: number; e: number; c: 'admission' | 'bar' | 'ambiguous' }[] = [];
  for (const re of [new RegExp(`\\bmust be at least ${n}\\b${TAIL}`, 'g'),
    new RegExp(`(?<![\\w$./])${n}\\s+years?\\s+of\\s+age\\s+(?:and|or)\\s+(?:over|up|older)\\b`, 'g')]) {
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index! + m[0].length).replace(/^\s+/, '');
      hits.push({ s: m.index!, e: m.index! + m[0].length, c: NOT_YEARS.test(after) ? 'ambiguous' : BAR_RULE_NEXT.test(after) ? 'bar' : 'admission' });
    }
  }
  for (const h of hits) {
    const vetoed = h.c === 'admission' && hits.some((o) => o.c !== 'admission' && o.s < h.e && h.s < o.e);
    if (h.c === 'bar') out.bar = true; else if (h.c === 'ambiguous' || vetoed) out.ambiguous = true; else out.admission = true;
  }
  return out;
}

const ADULT_PHRASES: { re: RegExp; age: AgeKind }[] = [
  { re: /\badults?[- ]only\b/, age: '18_plus' },
  { re: /\bno\s+minors\b/, age: '18_plus' },
  { re: /\bmust be an adult\b/, age: '18_plus' },
  { re: /\bmust be (?:of )?legal drinking age\b/, age: '21_plus' },
  { re: /\bno\s+(?:kids|children)\b/, age: 'unknown' },
  { re: /\b(?:kids|children|minors)\s+(?:are\s+)?not\s+(?:permitted|allowed|admitted)\b/, age: 'unknown' },
  { re: /\badult\s+(?:event|content|humou?r|themes)\b/, age: 'unknown' },
  { re: /\bmature\s+(?:content|themes|audiences?)\b/, age: 'unknown' },
  { re: /\brated\s+r\b/, age: 'unknown' },
  { re: /\badults?\s+(?:show|night)\b/, age: 'unknown' },
  { re: /\bfor\s+adults\b/, age: 'unknown' },
];
const RANK: Record<string, number> = { '21_plus': 3, '18_plus': 2, unknown: 1 };

/** The adult statement in text, regardless of admission context (used by classify for description negation). */
export function adultPhrase(text: string): AgeKind | null {
  const t = norm(text);
  let found: AgeKind | null = null;
  for (const { re, age } of ADULT_PHRASES) if (re.test(t)) { if (age === '21_plus') return age; found = found === '18_plus' ? found : age; }
  return found;
}

export function ageOf(input: AgeInput): AgeResult {
  const texts = [norm(input.ageText), norm(input.title), norm(input.description)].filter(Boolean);
  let a21 = false;
  let a18 = false;
  let ambiguous = false;
  let bar = false;
  let phraseAge: AgeKind | null = null;
  let allAges = false;
  let familyFriendly = false;
  for (const t of texts) {
    const f21 = numberPhrases(t, 21);
    const f18 = numberPhrases(t, 18);
    a21 ||= f21.admission;
    a18 ||= f18.admission;
    ambiguous ||= f21.ambiguous || f18.ambiguous;
    bar ||= f21.bar || f18.bar;
    const p = adultPhrase(t);
    if (p !== null && (phraseAge === null || RANK[p] > RANK[phraseAge])) phraseAge = p;
    for (const m of t.matchAll(/\ball[- ]ages\b/g)) if (!negatedInSentence(t, m.index!, m.index! + m[0].length)) allAges = true;
    for (const m of t.matchAll(/\bfamily[- ]friendly\b/g)) if (!negatedInSentence(t, m.index!, m.index! + m[0].length)) familyFriendly = true;
  }
  // A bar rule ("21+ to drink") is neutral next to an un-negated all-ages / family-friendly phrase; otherwise it is ambiguous.
  if (bar && !allAges && !familyFriendly) ambiguous = true;
  const reasons: ReasonCode[] = [];
  const phrase = phraseAge !== null;
  const adult = a21 || a18 || phrase;
  if (a21) reasons.push('age:21_admission');
  if (a18) reasons.push('age:18_admission');
  if (phrase) reasons.push('age:adult_phrase');
  if (ambiguous) reasons.push('age:ambiguous');
  let age: AgeKind = 'unknown';
  if (a21) age = '21_plus';
  else if (a18) age = '18_plus';
  else if (phrase) age = phraseAge as AgeKind;
  else if (!ambiguous && allAges) { age = 'all_ages'; reasons.push('age:all_ages'); }
  else if (!ambiguous && familyFriendly) { age = 'family'; reasons.push('age:family'); }
  if (!adult && !ambiguous && age === 'unknown') reasons.push('age:unknown');
  // an adult statement next to an all-ages phrase: the adult statement stands (the positive is not recorded)
  return { age, reasons, adult, ambiguous };
}
