// AC-R4b-18: a kids/family positive counts only when its sentence has no negation cue, before or after the match.
import { describe, expect, it } from 'vitest';
import { negatedInSentence, normalizeForNegation, sentenceAround } from './negation';

/** Negation of the first occurrence of `word` (lowercase) in `text`, after the shared normalization. */
const neg = (text: string, word = 'kids') => {
  const t = normalizeForNegation(text);
  const i = t.indexOf(word);
  expect(i, `${word} in ${text}`).toBeGreaterThanOrEqual(0);
  return negatedInSentence(t, i, i + word.length);
};

describe('negated (AC-R4b-18)', () => {
  it.each([
    'Leave the kids at home and join us for a raunchy evening.', 'A night out without the kids.', 'Kids are not welcome at this one.', 'Kids not welcome.',
    "This show isn't for kids.", 'Kids will be bored.', 'Great for kids, but not after 9.', 'Grab a babysitter, kids stay home.',
    'A night out w/o the kids.', 'A kids-free evening.', 'Date night minus the kids.', 'Sans kids, please.', 'Need a break from the kids? Join us.',
    "Bring the kids? No — this one's for grown-ups.", 'Kids... not this time.', 'Kids? Not tonight!', 'No costumes required, kids welcome.',
    'Get away from it all, kids included.', 'Never bring the kids.', 'Kids cannot attend.',
  ])('%s', (t) => { expect(neg(t)).toBe(true); });
  it("Children's tickets not available.", () => { expect(neg("Children's tickets not available.", 'children')).toBe(true); });
  it('Child-free night.', () => { expect(neg('Child-free night.', 'child')).toBe(true); });
  it('Toddler-free zone', () => { expect(neg('A toddler-free zone.', 'toddler')).toBe(true); });
});

describe('not negated (AC-R4b-18)', () => {
  it.each([
    "Kids' storytime at the library.", 'Free craft fun for kids and parents.', 'No registration needed, great for kids.',
    "Looking for kids' fun? Don't miss our fair.", 'There is no parking on site. Great for kids!', 'Kids welcome!',
    'No cover, no charge, kids welcome.', 'No tickets required for kids.', 'Not only fun for kids but for everyone.', 'No matter your age, kids are welcome.',
  ])('%s', (t) => { expect(neg(t)).toBe(false); });
  it("Don't miss this family-friendly fair.", () => { expect(neg("Don't miss this family-friendly fair.", 'family-friendly')).toBe(false); });
  it("You won't want to miss this family-friendly fair.", () => { expect(neg("You won't want to miss this family-friendly fair.", 'family-friendly')).toBe(false); });
  it('curly apostrophes are normalized', () => { expect(neg('Don’t miss this family-friendly fair.', 'family-friendly')).toBe(false); expect(neg('This show isn’t for kids.')).toBe(true); });
  it('the exemption ends at a word boundary: "no coverage" is still a cue', () => { expect(neg('No coverage of kids events.')).toBe(true); });
});

describe('sentence scope', () => {
  it('breaks are . ! ; bullet | and line breaks, not ? or an ellipsis', () => {
    const t = normalizeForNegation('No parking. Great for kids! Fun; fun\nKids rule • yes | ok? Kids... wow');
    const at = (w: string, n = 0) => { let i = -1; for (let k = 0; k <= n; k++) i = t.indexOf(w, i + 1); return i; };
    expect(sentenceAround(t, at('great'), at('great') + 5).trim()).toBe('great for kids');
    expect(sentenceAround(t, at('kids', 1), at('kids', 1) + 4).trim()).toBe('kids rule');
    expect(sentenceAround(t, at('ok'), at('ok') + 2).trim()).toBe('ok? kids... wow');
  });
  it('a negation in another sentence is ignored, in either direction', () => {
    expect(neg('Kids welcome. Not on Mondays.')).toBe(false);
    expect(neg('Not on Mondays. Kids welcome.')).toBe(false);
  });
  it('line breaks survive normalization as breaks', () => {
    expect(normalizeForNegation('A\r\nB\nC\rD')).toBe('a | b | c | d');
  });
});
