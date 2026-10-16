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
