// A13 r6 (AC-M1-124 r6, AC-M1-125 r6, AC-M1-126): Tahoe Donner pure rules.
import { describe, expect, it } from 'vitest';
import { expandTd, membersOnly, normTd, parseTdDate, parseTdTime, TD_VENUES, tdVenue } from './tahoeDonner';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-10-19T12:00:00Z');

describe('normTd', () => {
  it('folds NFKC, dashes, quotes, whitespace and case', () => {
    expect(normTd('  Members–Only ’x’  \n  “Y”  ')).toBe(`members-only 'x' "y"`);
    expect(normTd('A B')).toBe('a b');
  });
});

describe('AC-M1-124 (r6) membersOnly', () => {
  const MEMBER_SUNDAYS_REAL = 'Close out the weekend with great food and exclusive member perks at the restaurant. Tahoe Donner members with valid Member ID Cards receive 20% off their entire food bill. Dine-in only.';
  it.each([
    ['Member Sundays', 'This event is for members only.'],
    ['Family Movie Night', 'Open to Tahoe Donner members only.'],
    ['Members Only Ski Day', ''],
    ['Member-Only Mixer', ''],
    ['OWNERS ONLY Open House', ''],
    ['Plain Title', 'This is a members only event.'],
    ['Plain Title', 'Members only event'],
    ['Plain Title', 'Tahoe Donner members only.'],
    ['Plain Title', 'Welcome.\nThis event is for members only'],
  ])('true: %s / %s', (t, d) => expect(membersOnly(t, d)).toBe(true));
  it.each([
    ['Member Sundays', 'This event is not members only; everyone is welcome.'],
    ['Member Sundays', 'Members only discounts are available; admission is open to everyone.'],
    ['Member Sundays', MEMBER_SUNDAYS_REAL],
    ['Member Sundays', 'This event is for members only and their guests.'],
    ['Membership Mixer', ''],
    ['Remembers Only', ''],
    ['Plain Title', 'Members only event pricing applies.'],
    ['Plain Title', ''],
  ])('false: %s / %s', (t, d) => expect(membersOnly(t, d)).toBe(false));
  it('a 6,000-char description whose sentence 40 is "Members only event." is true (no truncation before the check)', () => {
    const filler = Array.from({ length: 39 }, (_, i) => `Sentence number ${i + 1} is filler text for the sample event ${'x'.repeat(100)}.`);
    const d = `${filler.join(' ')} Members only event. ${'More filler words here. '.repeat(30)}`;
    expect(d.length).toBeGreaterThan(4500);
    expect(membersOnly('Plain Title', d)).toBe(true);
    expect(membersOnly('Plain Title', d.replace('Members only event.', 'Everyone is welcome.'))).toBe(false);
  });
});

describe('AC-M1-125 (r6) parseTdDate and expandTd', () => {
  it('day, range, weekly', () => {
    expect(parseTdDate('Nov 28, 2026')).toEqual({ kind: 'day', date: '2026-11-28' });
    expect(parseTdDate('Dec 30, 2026 - Jan 02, 2027')).toEqual({ kind: 'range', from: '2026-12-30', to: '2027-01-02' });
    expect(parseTdDate('Every Fri Sep - Dec')).toEqual({ kind: 'weekly', dow: 5, fromMonth: 9, toMonth: 12 });
    expect(parseTdDate('Every Thu Oct - Nov')).toEqual({ kind: 'weekly', dow: 4, fromMonth: 10, toMonth: 11 });
  });
  it.each(['Every Funday Sep - Dec', 'TBD', 'Nov 31, 2026', '', 'Nov 28', 'Dec 03, 2026 - Dec 01, 2026', `Nov 28, 2026 ${'x'.repeat(80)}`, 'Foo 28, 2026'])('unparsed: %s', (s) => {
    expect(parseTdDate(s)).toBeUndefined();
  });
  it('a day inside the window yields one date; the weekly form is series_unsupported whatever the body says', () => {
    expect(expandTd({ kind: 'day', date: '2026-11-28' }, NOW, TZ)).toEqual(['2026-11-28']);
    expect(expandTd({ kind: 'weekly', dow: 4, fromMonth: 10, toMonth: 11 }, NOW, TZ)).toBe('series_unsupported');
    expect(expandTd.length).toBe(3);
  });
  it('a 31-day range is long_range; 3 and 4 day ranges yield every date; 5 days is long_range', () => {
    expect(expandTd(parseTdDate('Oct 01, 2026 - Oct 31, 2026')!, NOW, TZ)).toBe('long_range');
    expect(expandTd(parseTdDate('Oct 29, 2026 - Oct 31, 2026')!, NOW, TZ)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31']);
    expect(expandTd(parseTdDate('Dec 30, 2026 - Jan 02, 2027')!, NOW, TZ)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(expandTd(parseTdDate('Oct 29, 2026 - Nov 02, 2026')!, NOW, TZ)).toBe('long_range');
  });
  it('window = [local today - 1, local today + 120]', () => {
    expect(expandTd({ kind: 'day', date: '2026-10-17' }, NOW, TZ)).toBe('out_of_window');
    expect(expandTd({ kind: 'day', date: '2026-10-18' }, NOW, TZ)).toEqual(['2026-10-18']);
    expect(expandTd({ kind: 'day', date: '2027-02-16' }, NOW, TZ)).toEqual(['2027-02-16']);
    expect(expandTd({ kind: 'day', date: '2027-02-17' }, NOW, TZ)).toBe('out_of_window');
    expect(expandTd(parseTdDate('Oct 16, 2026 - Oct 19, 2026')!, NOW, TZ)).toEqual(['2026-10-18', '2026-10-19']);
  });
});

describe('AC-M1-126 parseTdTime', () => {
  it.each([
    ['5PM', '17:00', undefined], ['5-8:30PM', '17:00', '20:30'], ['11AM-5PM', '11:00', '17:00'], ['5:30-8PM', '17:30', '20:00'],
    ['Lifts open at 11:30AM', '11:30', undefined], ['11-1PM', '11:00', '13:00'], ['6:15PM', '18:15', undefined], ['9AM', '09:00', undefined],
    ['12PM', '12:00', undefined], ['12AM', '00:00', undefined], ['5 - 8:30 PM', '17:00', '20:30'],
  ])('%s', (s, start, end) => {
    const t = parseTdTime(s)!;
    expect(t.start).toBe(start);
    expect(t.end).toBe(end);
  });
  it('an end that is not after the start is dropped', () => expect(parseTdTime('8PM-8PM')).toEqual({ start: '20:00' }));
  it.each(['Evening', '', '13PM', '0PM', `${'a'.repeat(70)} at 5PM`, '5:75PM'])('no_time: %s', (s) => expect(parseTdTime(s)).toBeUndefined());
});

describe('venue directory (r4: addresses only, no access column)', () => {
  it('maps normalized venue text; unknown text is undefined', () => {
    expect(tdVenue('The Lodge Pavilion')).toMatchObject({ name: 'The Lodge Restaurant & Pub', address: '12850 Northwoods Blvd, Truckee, CA 96161' });
    expect(tdVenue('  THE LODGE RESTAURANT & PUB ')).toMatchObject({ name: 'The Lodge Restaurant & Pub' });
    expect(tdVenue('Downhill Ski Resort')).toMatchObject({ address: '11603 Slalom Way, Truckee, CA 96161', hints: ['downhill ski resort'] });
    expect(tdVenue('Cross Country Ski Center')).toMatchObject({ hints: ['cross country ski center'] });
    expect(tdVenue('Alder Creek Cafe')).toMatchObject({ name: 'Alder Creek Adventure Center' });
    expect(tdVenue('Northwoods Clubhouse')).toMatchObject({ name: 'Tahoe Donner Northwoods Clubhouse', address: '11509 Northwoods Blvd, Truckee, CA 96161' });
    expect(tdVenue('Golf Course')).toBeUndefined();
    expect(Object.values(TD_VENUES).every((v) => !('access' in v))).toBe(true);
  });
});
