// Admission grammar (plan 3.3 step 3). Reads structured age text, the title and the description in memory; returns codes only.
import type { AgeKind } from '../types';
import type { ReasonCode } from './reasonCodes';

export interface AgeInput { ageText?: string | null; title: string; description?: string | null }
export interface AgeResult { age: AgeKind; reasons: ReasonCode[]; adult: boolean; ambiguous: boolean }

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/** Words that follow "21+" when it is not an admission rule ("21+ local vendors", "21+ years of music"). */
const NOT_ADMISSION_NEXT = /^(?:years?|yrs?|vendors?|local|locals|artists?|makers?|exhibitors?|businesses|brands?|breweries|wineries|restaurants|sponsors?|members?|participants?|performers?|musicians?|bands?|merchants?|booths?|crafters?)\b/;
/** Words that make a following phrase an admission rule. */
const ADMISSION_NEXT = /^(?:only|show|event|night|admission|entry|with\s+(?:a\s+)?(?:valid\s+)?id|id\b|to\s+enter|required)/;
const ADMISSION_PREV = /(?:\bages?|\badmission|\bentry|\bevent is|\bshow is|\bguests? must be|\bmust be|\bage limit:?|\brestricted to)\s*$/;

function admission(text: string, start: number, end: number): 'admission' | 'ambiguous' {
  const before = text.slice(0, start);
  const after = text.slice(end).replace(/^[\s]+/, '');
  if (NOT_ADMISSION_NEXT.test(after)) return 'ambiguous';
  if (before.replace(/[^a-z0-9]/g, '') === '') return 'admission'; // starts the title / the text
  if (ADMISSION_PREV.test(before)) return 'admission';
  if (ADMISSION_NEXT.test(after)) return 'admission';
  if (after === '' || /^[)\]\-–—,.;:!]/.test(after)) return 'admission'; // closes the text or sits in a bracket / after a separator
  if (/[(\[\-–—,:]\s*$/.test(before)) return 'admission';
  return 'ambiguous';
}

type Found = { admission: boolean; ambiguous: boolean };

function numberPhrases(text: string, n: 18 | 21): Found {
  const out: Found = { admission: false, ambiguous: false };
  const record = (s: number, e: number) => { if (admission(text, s, e) === 'admission') out.admission = true; else out.ambiguous = true; };
  // "21+" and "21 and over" need the admission context; they can be a count ("21+ years").
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${n}\\s?\\+`, 'g'))) record(m.index!, m.index! + m[0].length);
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${n}\\s*(?:and|&)\\s*(?:over|up|older)\\b`, 'g'))) record(m.index!, m.index! + m[0].length);
  // These carry their own context.
  const own = [
    `\\bages?\\s+${n}\\b(?!\\s*[-–—]\\s*\\d)`,
    `\\bmust be ${n}\\b`,
    `(?<![\\w$.])${n}\\s+or\\s+older\\b`,
    `\\bunder ${n}\\s+(?:not|aren't|are not)\\s+(?:be\\s+)?(?:permitted|allowed|admitted)`,
  ];
  for (const p of own) if (new RegExp(p).test(text)) out.admission = true;
  return out;
}

const ADULT_PHRASES: { re: RegExp; age: AgeKind }[] = [
  { re: /\badults?\s+only\b/, age: '18_plus' },
  { re: /\bno\s+minors\b/, age: '18_plus' },
  { re: /\bmust be an adult\b/, age: '18_plus' },
  { re: /\bmust be (?:of )?legal drinking age\b/, age: '21_plus' },
  { re: /\bno\s+(?:kids|children)\b/, age: 'unknown' },
  { re: /\b(?:kids|children|minors)\s+(?:are\s+)?not\s+(?:permitted|allowed|admitted)\b/, age: 'unknown' },
];
const RANK: Record<string, number> = { '21_plus': 3, '18_plus': 2, unknown: 1 };
const NEGATED = /\b(?:not|no)\s+(?:an?\s+)?$/;

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
  let phraseAge: AgeKind | null = null;
  let allAges = false;
  let familyFriendly = false;
  for (const t of texts) {
    const f21 = numberPhrases(t, 21);
    const f18 = numberPhrases(t, 18);
    a21 ||= f21.admission;
    a18 ||= f18.admission;
    ambiguous ||= f21.ambiguous || f18.ambiguous;
    const p = adultPhrase(t);
    if (p !== null && (phraseAge === null || RANK[p] > RANK[phraseAge])) phraseAge = p;
    for (const m of t.matchAll(/\ball ages\b/g)) if (!NEGATED.test(t.slice(Math.max(0, m.index! - 12), m.index!))) allAges = true;
    for (const m of t.matchAll(/\bfamily[- ]friendly\b/g)) if (!NEGATED.test(t.slice(Math.max(0, m.index! - 12), m.index!))) familyFriendly = true;
  }
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
