// Plan 3.3 step 3: the admission grammar. Synthetic titles only.
import { describe, expect, it } from 'vitest';
import { ageOf } from './ageGrammar';
import { REASON_CODES } from './reasonCodes';

const a = (title: string, extra: { ageText?: string; description?: string } = {}) => ageOf({ title, ...extra });

describe('adult positives in admission context (AC-R4b-03)', () => {
  it.each([
    ['21+ Comedy Night', '21_plus', 'age:21_admission'],
    ['Comedy Night (21 and over)', '21_plus', 'age:21_admission'],
    ['Ages 21 and up', '21_plus', 'age:21_admission'],
    ['Must be 21 with valid ID', '21_plus', 'age:21_admission'],
    ['Under 21 not permitted', '21_plus', 'age:21_admission'],
    ['Wine Night, 21 or older', '21_plus', 'age:21_admission'],
    ['Late Show 21 & over', '21_plus', 'age:21_admission'],
    ['Admission 18+', '18_plus', 'age:18_admission'],
    ['Guests must be 18 or older', '18_plus', 'age:18_admission'],
    ['Under 18 not allowed', '18_plus', 'age:18_admission'],
    ['Adults only Trivia', '18_plus', 'age:adult_phrase'],
    ['No minors', '18_plus', 'age:adult_phrase'],
    ['Must be of legal drinking age', '21_plus', 'age:adult_phrase'],
  ])('%s -> %s', (title, age, code) => {
    const r = a(title);
    expect(r.age).toBe(age);
    expect(r.reasons).toContain(code);
    expect(r.adult).toBe(true);
    expect(r.ambiguous).toBe(false);
  });
  it('"No kids please" is an adult statement with no specific age', () => {
    const r = a('No kids please');
    expect(r.adult).toBe(true);
    expect(r.age).toBe('unknown');
    expect(r.reasons).toContain('age:adult_phrase');
  });
  it('structured ageText counts, and so does a description phrase', () => {
    expect(a('Open Night', { ageText: '21+' }).age).toBe('21_plus');
    expect(a('Open Night', { description: 'Guests must be 21 to enter.' }).age).toBe('21_plus');
    expect(a('Open Night', { description: 'Kids are not allowed.' }).adult).toBe(true);
  });
  it('the 21 admission wins over an 18 phrase', () => {
    expect(a('21+ show, 18+ with parent').age).toBe('21_plus');
  });
});

describe('look-alikes never match (AC-R4b-04)', () => {
  it.each(['Route 21 Cleanup', '$21 Tasting', 'Class of 2021 Reunion', '18-hole Scramble', 'Ages 3–18 Swim', '21st Annual Fair', 'Table 18 Supper', 'Ages 3-18 Art'])('%s', (title) => {
    const r = a(title);
    expect(r.age).toBe('unknown');
    expect(r.adult).toBe(false);
    expect(r.ambiguous).toBe(false);
    expect(r.reasons).toEqual(['age:unknown']);
  });
});

describe('ambiguous 21/18 outside admission context (AC-R4b-04)', () => {
  it.each(['21+ local vendors', 'Celebrating 21+ years of music', '21+ vendors at the Market'])('%s', (title) => {
    const r = a(title);
    expect(r.age).toBe('unknown');
    expect(r.ambiguous).toBe(true);
    expect(r.adult).toBe(false);
    expect(r.reasons).toContain('age:ambiguous');
  });
  it('an explicit admission statement stands next to an ambiguous one', () => {
    const r = a('21+ local vendors', { description: 'Ages 21 and up only.' });
    expect(r.age).toBe('21_plus');
    expect(r.adult).toBe(true);
  });
});

describe('all ages and family', () => {
  it('all ages and family-friendly are read only when nothing adult is present', () => {
    expect(a('Concert, All Ages').age).toBe('all_ages');
    expect(a('Concert', { ageText: 'All ages' }).reasons).toContain('age:all_ages');
    expect(a('Pumpkin Day', { description: 'A family-friendly afternoon.' }).age).toBe('family');
    expect(a('Pumpkin Day', { description: 'A family-friendly afternoon.' }).reasons).toContain('age:family');
  });
  it('"not all ages" is not all ages', () => {
    expect(a('Show, not all ages').age).toBe('unknown');
  });
  it('an adult signal beats an all-ages phrase in the same text', () => {
    const r = a('All Ages Early Show. 21+ only after 9pm');
    expect(r.adult).toBe(true);
    expect(r.age).toBe('21_plus');
  });
});

describe('reason hygiene', () => {
  it('every reason is a known code', () => {
    for (const t of ['21+ Comedy Night', 'Route 21', '21+ vendors', 'All Ages', 'No minors', 'Plain'])
      for (const c of a(t).reasons) expect(REASON_CODES).toContain(c);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// R4b-2 (AC-R4b-20, 21, 22, 23, 25)
// ---------------------------------------------------------------------------------------------------------------------
const d = (description: string, title = 'Comedy Night') => ageOf({ title, description });

describe('negated all-ages / family-friendly (AC-R4b-20)', () => {
  it.each(['This show is not suitable for all ages.', 'Not for all ages.', "This show isn't family-friendly.", 'This is not exactly family-friendly.'])('%s', (t) => {
    const r = d(t);
    expect(r.age).toBe('unknown');
    expect(r.reasons).not.toContain('age:all_ages');
    expect(r.reasons).not.toContain('age:family');
  });
  it('"Adult content, all ages admitted but not recommended" -> unknown + adult phrase', () => {
    const r = d('Adult content, all ages admitted but not recommended');
    expect(r.age).toBe('unknown');
    expect(r.reasons).toContain('age:adult_phrase');
  });
  it('controls', () => {
    expect(d('All ages welcome!').age).toBe('all_ages');
    expect(d('A family-friendly afternoon.').age).toBe('family');
  });
});

describe('bar rule (AC-R4b-21)', () => {
  it.each(['all ages welcome, 21+ to drink', 'All ages. 21+ to purchase alcohol.'])('%s -> all_ages, no 21 admission, not ambiguous', (t) => {
    const r = d(t);
    expect(r.age).toBe('all_ages');
    expect(r.reasons).toContain('age:all_ages');
    expect(r.reasons).not.toContain('age:21_admission');
    expect(r.reasons).not.toContain('age:ambiguous');
    expect(r.adult).toBe(false);
    expect(r.ambiguous).toBe(false);
  });
  it('an all-ages phrase in any text of the item neutralizes it (ageText)', () => {
    const r = ageOf({ title: 'Comedy Night', ageText: 'All ages', description: '21+ to drink.' });
    expect(r.age).toBe('all_ages');
    expect(r.ambiguous).toBe(false);
  });
  it('no all-ages phrase: ambiguous, no 21 claim', () => {
    const r = d('Live music from 8. 21+ to drink. Kids menu available.');
    expect(r.age).toBe('unknown');
    expect(r.ambiguous).toBe(true);
    expect(r.adult).toBe(false);
    expect(r.reasons).toContain('age:ambiguous');
    expect(r.reasons).not.toContain('age:21_admission');
  });
  it('a negated all-ages phrase does not neutralize it', () => {
    const r = d("This isn't an all-ages show. 21+ to drink.");
    expect(r.ambiguous).toBe(true);
    expect(r.age).toBe('unknown');
  });
  it('other bar-rule continuations', () => {
    for (const t of ['21+ for alcohol', '21+ wristband required', '21+ beer garden', '21+ to buy drinks']) expect(d(`Open to everyone. ${t}`).adult, t).toBe(false);
  });
  it('controls: 21+ only, and 21+ local vendors', () => {
    expect(d('21+ only').age).toBe('21_plus');
    expect(d('21+ local vendors').ambiguous).toBe(true);
  });
});

describe('ranges are not minimums (AC-R4b-22)', () => {
  it.each(['Youth Night: ages 21 and under', 'Ages 18 to 24 meetup', 'Ages 18 and under swim', 'Ages 18 through 24', 'Ages 21 - 30', 'Ages 18 or younger'])('%s', (t) => {
    const r = ageOf({ title: t });
    expect(r.adult).toBe(false);
    expect(r.ambiguous).toBe(false);
    expect(r.age).toBe('unknown');
    expect(r.reasons).not.toContain('age:21_admission');
    expect(r.reasons).not.toContain('age:18_admission');
  });
  it('control: Ages 21 and up', () => { expect(ageOf({ title: 'Ages 21 and up' }).age).toBe('21_plus'); });
});

describe('new adult positives (AC-R4b-23)', () => {
  it('Adults-only', () => {
    const r = d('Adults-only wine walk');
    expect([r.age, r.reasons.includes('age:adult_phrase')]).toEqual(['18_plus', true]);
  });
  it.each(['Must be 21 or over', '21 or over', '21 years and older', '21 yrs and up', '21 yrs+', '21 yrs+ only', '21 years or older', 'Must be over 21', 'Over 21 only', 'No one under 21 admitted'])('%s -> 21_plus', (t) => {
    const r = d(t);
    expect(r.age).toBe('21_plus');
    expect(r.adult).toBe(true);
  });
  it.each(['Must be 21 or over', '21 or over', '21 years and older', '21 yrs and up', '21 yrs+'])('%s -> age:21_admission', (t) => { expect(d(t).reasons).toContain('age:21_admission'); });
  it.each(['Nobody under 18'])('%s -> 18_plus', (t) => { expect(d(t).age).toBe('18_plus'); });
  it.each(['over 21 vendors', '21 years+ of music'])('%s -> ambiguous', (t) => {
    const r = d(t);
    expect(r.ambiguous).toBe(true);
    expect(r.age).toBe('unknown');
  });
  it.each(['An adult event', 'Rated R', 'Adults night', 'An adult show', 'For adults', 'Mature audiences', 'Adult humor', 'Adult themes'])('%s -> unknown + adult phrase', (t) => {
    const r = d(t);
    expect(r.age).toBe('unknown');
    expect(r.reasons).toContain('age:adult_phrase');
    expect(r.adult).toBe(true);
  });
  it('look-alikes still do not match', () => {
    for (const t of ['Over 2100 attended', 'Rated Rad', 'Route 21 over there']) expect(d(t).adult, t).toBe(false);
  });
});

describe('line breaks (AC-R4b-25)', () => {
  it('"Not for everyone\\nAll ages welcome" -> all_ages', () => {
    expect(d('Not for everyone\nAll ages welcome').age).toBe('all_ages');
    expect(d('Not for everyone All ages welcome').age).toBe('unknown');
  });
});
