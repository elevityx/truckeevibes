// Sentence-scoped negation for kids/family positives (spec Amendment R4b-2). A positive found in a description or age text counts
// only if its sentence has no negation cue, before or after the match. Pure; reads text in memory and returns a boolean.

/** The one normalization both callers use: line breaks become `|` breaks first, then lowercase, curly quotes, single spaces. */
export function normalizeForNegation(s: string | null | undefined): string {
  return (s ?? '').replace(/\r\n|\r|\n/g, ' | ').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Idioms that contain a cue word but are not negations. Each alternative ends in `\b`. */
const EXEMPT = /\b(?:(?:don't|do not|won't want to|wouldn't want to|never) miss|not to be missed|no (?:cost|charge|cover|registration|experience)(?: (?:needed|required|necessary))?|no tickets? (?:needed|required)|no matter|not only)\b/g;

const CUES = [
  /\b(?:not|no|never|without|nor|cannot)\b/,
  /\b[a-z]+n't\b/,
  /\b(?:at|stay|stays|staying) home\b/,
  /\b(?:babysitter|sitter|unsuitable|inappropriate)\b/,
  /\bwill be bored\b/,
  /\bw\/o\b/,
  /\bsans\b/,
  /\bminus\b/,
  /\b(?:kid|kids|child|children|toddler)s?[- ]free\b/,
  /\bbreak from\b/,
  /\baway from\b/,
];

/** A break is a single `.` (not part of a run of dots), `!`, `;`, `•`, `|`. `?` and `…` are not breaks. */
function isBreak(t: string, i: number): boolean {
  const c = t[i];
  if (c === '!' || c === ';' || c === '•' || c === '|') return true;
  if (c === '.') return t[i - 1] !== '.' && t[i + 1] !== '.';
  return false;
}

/** The text between the nearest break before `start` and the first break at or after `end`. `text` is already normalized. */
export function sentenceAround(text: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !isBreak(text, s - 1)) s--;
  let e = end;
  while (e < text.length && !isBreak(text, e)) e++;
  return text.slice(s, e);
}

export function negatedInSentence(text: string, start: number, end: number): boolean {
  const sentence = sentenceAround(text, start, end).replace(EXEMPT, ' ');
  return CUES.some((re) => re.test(sentence));
}
