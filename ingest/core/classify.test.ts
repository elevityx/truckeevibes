// Classifier v2 (plan 3.3). Description text is read here, in memory, and never returned. Synthetic titles only.
import { describe, expect, it } from 'vitest';
import { classify, adultSignal } from './classify';
import { REASON_CODES } from './reasonCodes';
import { CATEGORY_MAPS, mapHints } from './categoryMaps';
import { DESC_SENTINEL } from '../testing/fakes';

const c = (title: string, extra: Record<string, unknown> = {}, description?: string) => classify({ title, categoriesHint: [], ...extra }, description);

describe('categories (AC-R4b-01)', () => {
  it('(a) a mapped hint wins through the family map', () => {
    const r = c('Sample Evening', { categoriesHint: ['live-music'], family: 'tribe' });
    expect(r.categories).toContain('music');
    expect(r.reasons).toContain('cat:source_map');
  });
  it('(a) labels with spaces and ampersands map through their slug form', () => {
    expect(c('Sample', { categoriesHint: ['Food & Drink'], family: 'ics_civicplus' }).categories).toContain('food-drink');
    expect(c('Sample', { categoriesHint: ['Arts & Culture'], family: 'ics_civicplus' }).categories).toContain('arts');
  });
  it('(a) unmapped labels are dropped and reported', () => {
    const r = c('Sample', { categoriesHint: ['Mystery Label'], family: 'tribe' });
    expect(r.categories).toEqual([]);
    expect(r.unmapped).toEqual(['mystery label']);
  });
  it('an unknown family still maps the thirteen slugs', () => {
    expect(c('Sample', { categoriesHint: ['music'] }).categories).toContain('music');
  });
  it('(b) whole-word title keywords', () => {
    const r = c('Open Mic Night');
    expect(r.categories).toContain('music');
    expect(r.reasons).toContain('cat:title_kw');
  });
  it.each([
    ['Live Music on the Patio', 'music'], ['Brewery Tasting Dinner', 'food-drink'], ['Trail Run 10k', 'outdoors'],
    ['Gallery Opening', 'arts'], ['Holiday Craft Fair', 'markets'], ['Trivia Night', 'nightlife'],
    ['Woodworking Workshop', 'learning'], ['Tree Lighting', 'holiday'], ['Haunted Pumpkin Patch', 'halloween-fall'],
  ])('title %s -> %s', (title, cat) => {
    expect(c(title).categories).toContain(cat);
  });
  it('title keywords are whole words, and never produce kids or family', () => {
    expect(c('Partisan Bigband').categories).toEqual([]);
    for (const t of ['Family Trivia', 'Kids Storytime', 'Children Toddler Family Kids']) {
      expect(c(t).categories).not.toContain('family');
      expect(c(t).categories).not.toContain('kids');
    }
  });
  it("(c) description \"kids' storytime\" -> kids + cat:desc_kids", () => {
    const r = c('Sample Morning', {}, "Join us for kids' storytime in the library.");
    expect(r.categories).toContain('kids');
    expect(r.reasons).toContain('cat:desc_kids');
  });
  it('(c) family positives come from family-friendly / family event / all ages welcome', () => {
    for (const d of ['A family-friendly afternoon', 'This family event has crafts', 'All ages welcome'])
      expect(c('Sample Afternoon', {}, d).categories).toContain('family');
    expect(c('Sample Afternoon', {}, 'A family-friendly afternoon').reasons).toContain('cat:desc_family');
  });
  it('(c) other categories never come from the description', () => {
    const r = c('Sample', {}, 'a beer for every guest, live music and a band, wine tasting');
    expect(r.categories).toEqual([]);
  });
  it('(c) description positives are blocked by a negation in the 40 characters before', () => {
    expect(c('Sample', {}, 'This is not for kids.').categories).not.toContain('kids');
    expect(c('Sample', {}, 'No kids allowed at this one.').categories).not.toContain('kids');
    expect(c('Sample', {}, 'Kids are not allowed.').categories).not.toContain('kids');
  });
  it('description positives are also blocked by an adult phrase anywhere', () => {
    const r = c('Sample', {}, "Great for kids' storytime. Adults only after 8pm.");
    expect(r.categories).not.toContain('kids');
  });
  it('categories are deduped and sorted', () => {
    const r = c('Open Mic Night', { categoriesHint: ['music', 'live-music'], family: 'tribe' });
    expect(r.categories).toEqual([...r.categories].sort());
    expect(new Set(r.categories).size).toBe(r.categories.length);
  });
});

describe('category maps', () => {
  it('cover every adapter family with identity for the 13 slugs', () => {
    for (const fam of ['tribe', 'ics_chambermaster', 'ics_civicplus', 'ics_eventsmanager']) {
      const m = CATEGORY_MAPS[fam];
      expect(m, fam).toBeDefined();
      for (const s of ['music', 'food-drink', 'outdoors', 'family', 'kids', 'arts', 'markets', 'sports', 'nightlife', 'learning', 'community', 'holiday', 'halloween-fall'])
        expect(m[s]).toBe(s);
      expect(m['concerts']).toBe('music');
      expect(m['children']).toBe('kids');
      expect(m['recreation']).toBe('outdoors');
      expect(m['workshops']).toBe('learning');
      expect(m['fall']).toBe('halloween-fall');
    }
  });
});

describe('price (AC-R4b-02)', () => {
  it('structured text: free, paid with min/max, donation', () => {
    const f = c('Sample', { priceText: 'Free' });
    expect([f.priceKind, f.reasons.includes('price:text_free')]).toEqual(['free', true]);
    const p = c('Sample', { priceText: '$10 - $25' });
    expect([p.priceKind, p.priceMin, p.priceMax, p.reasons.includes('price:text_paid')]).toEqual(['paid', 10, 25, true]);
    expect(c('Sample', { priceText: '$10–$20' })).toMatchObject({ priceKind: 'paid', priceMin: 10, priceMax: 20 });
    expect(c('Sample', { priceText: '$10–20' })).toMatchObject({ priceKind: 'paid', priceMin: 10, priceMax: 20 });
    const d = c('Sample', { priceText: 'By donation' });
    expect([d.priceKind, d.reasons.includes('price:text_donation')]).toEqual(['donation', true]);
    expect(c('Sample', { priceText: 'Free with $5 parking' }).priceKind).toBe('paid');
  });
  it('strong description phrases make it free', () => {
    for (const d of ['Free admission for everyone.', 'Free entry.', 'This is a free event.', 'Free to attend.', 'A free show.', 'No cover.', 'Free and open to the public.']) {
      const r = c('Sample Evening', {}, d);
      expect([d, r.priceKind]).toEqual([d, 'free']);
      expect(r.reasons).toContain('price:desc_free');
    }
  });
  it('a title starting with Free is free', () => {
    const r = c('Free Yoga');
    expect(r.priceKind).toBe('free');
    expect(r.reasons).toContain('price:title_free');
  });
  it.each([
    ['title', 'Free Parking Available'], ['title', 'Gluten-Free Menu Night'], ['title', 'Sample with free wifi'],
    ['desc', 'free parking for all'], ['desc', 'a gluten-free menu'], ['desc', 'free wifi on site'], ['desc', 'kids eat free'], ['desc', 'kids under 12 free'],
    ['desc', 'free beer with ticket'], ['desc', 'free swag bag'],
  ])('negative (%s): %s is not free and says why', (where, text) => {
    const r = where === 'title' ? c(text) : c('Sample Evening', {}, text);
    expect(r.priceKind).toBe('unknown');
    expect(r.reasons).toContain('price:neg_blocked');
  });
  it('a negative does not hide a real free statement', () => {
    expect(c('Sample', {}, 'Free admission. Free parking too.').priceKind).toBe('free');
  });
  it('nothing known is unknown, with a code', () => {
    const r = c('Sample');
    expect(r.priceKind).toBe('unknown');
    expect(r.reasons).toContain('price:unknown');
  });
  it('a $ amount beats a description free phrase', () => {
    expect(c('Sample', { priceText: '$15' }, 'free admission for kids').priceKind).toBe('paid');
  });
});

describe('final invariant (AC-R4b-05)', () => {
  const noKidsFamily = (r: ReturnType<typeof c>) => { expect(r.categories).not.toContain('kids'); expect(r.categories).not.toContain('family'); expect(['all_ages', 'family']).not.toContain(r.age); };
  it.each([
    '21+ Comedy Night', 'Comedy Night (21 and over)', 'Ages 21 and up', 'Must be 21 with valid ID', 'Under 21 not permitted',
    'Admission 18+', 'Guests must be 18 or older', 'Adults only Trivia', 'No minors', 'No kids please',
  ])('adult positive %s never carries kids/family even with a kids hint', (title) => {
    const r = c(title, { categoriesHint: ['kids', 'family'], family: 'tribe' }, "A family-friendly kids' storytime. All ages welcome.");
    noKidsFamily(r);
    expect(r.reasons).toContain('conflict:adult');
    expect(['21_plus', '18_plus', 'unknown']).toContain(r.age);
  });
  it('review case: "Family Trivia — adults only; no children"', () => {
    const r = c('Family Trivia — adults only; no children', { categoriesHint: ['family'], family: 'tribe' });
    noKidsFamily(r);
    expect(r.age).toBe('18_plus');
    expect(r.reasons).toEqual(expect.arrayContaining(['age:adult_phrase', 'conflict:adult']));
  });
  it('review case: "21+ local vendors at the Family Market"', () => {
    const r = c('21+ local vendors at the Family Market', { categoriesHint: ['family'], family: 'tribe' });
    noKidsFamily(r);
    expect(r.age).toBe('unknown');
    expect(r.reasons).toEqual(expect.arrayContaining(['age:ambiguous', 'conflict:adult']));
  });
  it('ambiguous rows -> unknown, age:ambiguous, no kids/family', () => {
    for (const t of ['21+ local vendors', 'Celebrating 21+ years of music']) {
      const r = c(t, { categoriesHint: ['kids'], family: 'tribe' });
      noKidsFamily(r);
      expect(r.age).toBe('unknown');
      expect(r.reasons).toContain('age:ambiguous');
    }
  });
  it('word-list hit on the title: family-friendly description + "Brewery Night" -> no family', () => {
    const r = c('Brewery Night', {}, 'A family-friendly evening.');
    noKidsFamily(r);
    expect(r.reasons).toContain('conflict:adult_signal');
    expect(r.age).toBe('unknown');
  });
  it('word-list hit on the venue name', () => {
    const r = c('Kids Craft Day', { venueName: 'Example Taproom', categoriesHint: ['kids'], family: 'tribe' });
    noKidsFamily(r);
    expect(r.reasons).toContain('conflict:adult_signal');
  });
  it('word-list + all-ages age: demoted to unknown with age:ambiguous', () => {
    const r = c('Wine Walk, All Ages', { categoriesHint: ['family'], family: 'tribe' });
    noKidsFamily(r);
    expect(r.age).toBe('unknown');
    expect(r.reasons).toContain('age:ambiguous');
    expect(r.reasons).not.toContain('age:all_ages');
  });
  it('an unambiguous adult age stands when a kids/family positive collides', () => {
    const r = c('21+ Pumpkin Brew Night', { categoriesHint: ['family'], family: 'tribe' });
    noKidsFamily(r);
    expect(r.age).toBe('21_plus');
  });
  it('a clean kids event keeps kids/family and its age', () => {
    const r = c('Pumpkin Patch Day', { categoriesHint: ['kids', 'family'], family: 'tribe', ageText: 'All ages' });
    expect(r.categories).toEqual(expect.arrayContaining(['kids', 'family', 'halloween-fall']));
    expect(r.age).toBe('all_ages');
    expect(r.reasons).not.toContain('conflict:adult');
  });
  it('adultSignal mirrors the SQL word list on lowercase text', () => {
    for (const t of ['happy hour', 'ale works', 'the tap room', 'wine', 'burlesque', 'club', 'tequila', 'route 21']) expect(adultSignal(t), t).toBe(true);
    for (const t of ['winnow', 'clubhouse', 'barn dance', 'storytime', 'barrel', '']) expect(adultSignal(t), t).toBe(false);
    expect(adultSignal(undefined)).toBe(false);
  });
});

describe('reasons (AC-R4b-06)', () => {
  const titles = ['21+ Comedy Night', 'Family Trivia — adults only; no children', 'Free Yoga', 'Brewery Night', 'Open Mic Night', 'Sample', '21+ local vendors', 'Kids Craft Day'];
  it('every reason is in REASON_CODES, there are at most 16, none has a character outside [a-z0-9_:]', () => {
    for (const t of titles) {
      const r = c(t, { categoriesHint: ['kids', 'live-music', 'zzz'], family: 'tribe', priceText: 'Free', ageText: 'All ages', venueName: 'Example Taproom' }, "kids' storytime free admission adults only family-friendly");
      expect(r.reasons.length).toBeLessThanOrEqual(16);
      expect(new Set(r.reasons).size).toBe(r.reasons.length);
      for (const code of r.reasons) { expect(REASON_CODES).toContain(code); expect(code).toMatch(/^[a-z0-9_:]+$/); }
    }
  });
  it('caps at 16 even when the input could produce more', () => {
    expect(c('x').reasons.length).toBeLessThanOrEqual(16);
  });
});

describe('descriptions never leave', () => {
  it('uses description text but never returns it', () => {
    const r = c('Sample Evening', {}, `${DESC_SENTINEL} kids' storytime free admission`);
    expect(r.categories).toContain('kids');
    expect(JSON.stringify(r)).not.toContain(DESC_SENTINEL);
    expect('descriptionFacts' in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// R4b-2 (AC-R4b-19, 20, 21, 23, 25)
// ---------------------------------------------------------------------------------------------------------------------
describe('negated kids/family positives (AC-R4b-19)', () => {
  const noKidsReasons = (r: ReturnType<typeof c>) => { expect(r.categories).not.toContain('kids'); expect(r.categories).not.toContain('family'); expect(r.reasons).not.toContain('cat:desc_kids'); expect(r.reasons).not.toContain('cat:desc_family'); };
  it.each([
    'Leave the kids at home and join us for a raunchy evening.', 'A night out without the kids.', 'Kids are not welcome at this one.', 'Kids not welcome.',
    "This show isn't for kids.", 'Kids will be bored.', "Children's tickets not available.", 'Babysitter recommended. Kids will be bored.',
    'A night out w/o the kids.', 'A kids-free evening.', 'Child-free night.', 'Date night minus the kids.', 'Sans kids, please.', 'Need a break from the kids? Join us.',
    "Bring the kids? No — this one's for grown-ups.", 'Kids... not this time.', 'Kids? Not tonight!', 'No costumes required, kids welcome.', 'Kids are welcome to watch.',
  ])('%s', (d) => { noKidsReasons(c('Comedy Night', {}, d)); });
  it('Rated R humor + children\'s tickets not available -> no kids, adult phrase and conflict', () => {
    const r = c('Comedy Night', {}, "Rated R humor. Children's tickets not available.");
    noKidsReasons(r);
    expect(r.reasons).toEqual(expect.arrayContaining(['age:adult_phrase', 'conflict:adult']));
  });
  it('title Evening Social + "Grab a babysitter, kids stay home. Cash bar." -> no categories', () => {
    expect(c('Evening Social', {}, 'Grab a babysitter, kids stay home. Cash bar.').categories).toEqual([]);
  });
  it.each([
    ["Kids' storytime at the library.", 'kids', 'cat:desc_kids'], ['Kids welcome!', 'kids', 'cat:desc_kids'], ['Bring the kids!', 'kids', 'cat:desc_kids'],
    ['Kids menu and crafts.', 'kids', 'cat:desc_kids'], ['There is no parking on site. Great for kids!', 'kids', 'cat:desc_kids'],
    ["Don't miss this family-friendly fair.", 'family', 'cat:desc_family'], ['Kids activities all day.', 'kids', 'cat:desc_kids'], ['Kids under 12 welcome.', 'kids', 'cat:desc_kids'],
    ['Bring your kids to the fair.', 'kids', 'cat:desc_kids'], ["Kids' crafts at noon.", 'kids', 'cat:desc_kids'],
  ])('control: %s', (d, cat, code) => {
    const r = c('Comedy Night', {}, d);
    expect(r.categories).toContain(cat);
    expect(r.reasons).toContain(code);
  });
  it('a bare "kids" is not a positive', () => {
    expect(c('Comedy Night', {}, 'Kids ate pizza.').categories).not.toContain('kids');
  });
});

describe('negated all-ages / family-friendly (AC-R4b-20)', () => {
  it.each(['This show is not suitable for all ages.', 'Not for all ages.', "This show isn't family-friendly.", 'This is not exactly family-friendly.'])('%s', (d) => {
    const r = c('Comedy Night', {}, d);
    expect(r.age).toBe('unknown');
    expect(r.reasons).not.toContain('age:all_ages');
    expect(r.reasons).not.toContain('age:family');
    expect(r.categories).not.toContain('family');
    expect(r.reasons).not.toContain('cat:desc_family');
  });
  it('"Adult content, all ages admitted but not recommended" -> unknown, adult phrase, conflict', () => {
    const r = c('Comedy Night', {}, 'Adult content, all ages admitted but not recommended');
    expect(r.age).toBe('unknown');
    expect(r.reasons).toEqual(expect.arrayContaining(['age:adult_phrase', 'conflict:adult']));
  });
  it('controls', () => {
    expect(c('Comedy Night', {}, 'All ages welcome!').age).toBe('all_ages');
    expect(c('Comedy Night', {}, 'A family-friendly afternoon.').age).toBe('family');
  });
});

describe('bar rule (AC-R4b-21)', () => {
  it('no all-ages phrase: unknown, age:ambiguous, conflict:adult, no kids, no 21 claim', () => {
    const r = c('Live Music Friday', { venueName: 'Example Grill' }, 'Live music from 8. 21+ to drink. Kids menu available.');
    expect(r.age).toBe('unknown');
    expect(r.reasons).toEqual(expect.arrayContaining(['age:ambiguous', 'conflict:adult']));
    expect(r.reasons).not.toContain('age:21_admission');
    expect(r.categories).not.toContain('kids');
  });
});

describe('adult positives with a kids description (AC-R4b-23)', () => {
  it('"Adults-only show, kids stay home" -> no kids', () => {
    const r = c('Comedy Night', {}, 'Adults-only show, kids stay home. Kids welcome!');
    expect(r.categories).not.toContain('kids');
    expect(r.age).toBe('18_plus');
  });
});

describe('line breaks are sentence breaks (AC-R4b-25)', () => {
  it('newlines separate thoughts; the same text on one line is negated by "no"', () => {
    const d = 'No outside food or drink\nKids craft table 2–4pm\nLive music 6pm';
    const a = c('Fall Fair', {}, d);
    expect(a.categories).toContain('kids');
    expect(a.reasons).toContain('cat:desc_kids');
    expect(c('Fall Fair', {}, d.replace(/\n/g, ' ')).categories).not.toContain('kids');
  });
});

describe('AC-M1-162 category maps: VLT labels, source-free labels, ignored labels', () => {
  it('tribe maps the six VLT slugs; other families do not', () => {
    const m = CATEGORY_MAPS.tribe;
    expect([m['kids-families-events'], m['music-dance-events'], m['nightlife-events'], m['food-wine-events'], m['festivals-events'], m['sports-events']])
      .toEqual(['family', 'music', 'nightlife', 'food-drink', 'community', 'sports']);
    expect(Object.values(m)).not.toContain('kids-families-events');
    for (const [k, v] of Object.entries(m)) if (k.endsWith('-events')) expect(v).not.toBe('kids');
  });
  it('free / editorial / filtered labels are neither slugs nor unmapped', () => {
    expect(mapHints('tribe', ['free-events', 'featured-events', 'headliners-events', 'local-events', 'attractions-events', 'wellness', 'tahoe-blue-event-center']))
      .toEqual({ slugs: [], unmapped: [], sourceFree: true });
  });
  it('Free and Free Events state free in any family', () => {
    expect(mapHints('ics_eventsmanager', ['Free']).sourceFree).toBe(true);
    expect(mapHints('ics_eventsmanager', ['Free Events']).sourceFree).toBe(true);
    expect(mapHints('tribe', ['music']).sourceFree).toBe(false);
  });
  it('the VLT slugs stay unmapped outside tribe, and the spelled-out label is not mapped', () => {
    expect(mapHints('ics_eventsmanager', ['kids-families-events'])).toMatchObject({ slugs: [], unmapped: ['kids-families-events'] });
    expect(mapHints('tribe', ['Kids & Families Events'])).toMatchObject({ slugs: [], unmapped: ['kids & families events'] });
  });
});

describe('AC-M1-163 price: $0, source label, description and title forms', () => {
  const P = (extra: Record<string, unknown>, d?: string, title = 'Sample Evening') => c(title, extra, d);
  const T = { family: 'tribe', categoriesHint: ['free-events'] };
  it('text $0', () => {
    for (const t of ['$0', '$0.00', '$0 - $0']) expect(P({ priceText: t })).toMatchObject({ priceKind: 'free', reasons: expect.arrayContaining(['price:text_free']) });
    expect(P({ priceText: '$0 - $25' })).toMatchObject({ priceKind: 'paid', priceMin: 0, priceMax: 25 });
    expect(P({ priceText: '$0 - $25' }).reasons).toContain('price:text_paid');
  });
  it('source label', () => {
    expect(P(T)).toMatchObject({ priceKind: 'free' });
    expect(P(T).reasons).toContain('price:source_free');
    const paid = P({ ...T, priceText: '$15' });
    expect(paid).toMatchObject({ priceKind: 'paid', priceMin: 15, priceMax: 15 });
    expect(paid.reasons).not.toContain('price:source_free');
    expect(P({ ...T, priceText: 'By donation' }).priceKind).toBe('donation');
    const f = P({ ...T, priceText: 'Free' });
    expect(f.priceKind).toBe('free');
    expect(f.reasons).toContain('price:text_free');
    const e = P({ family: 'ics_eventsmanager', categoriesHint: ['Free'] });
    expect(e.priceKind).toBe('free');
    expect(e.reasons).toContain('price:source_free');
  });
  it.each(['Admission is free.', 'Entry is free for everyone.', 'Free of charge.', 'There is no cost to attend.', 'Tickets: $0', 'Admission: Free'])('description positive: %s', (d) => {
    const r = P({}, d);
    expect(r.priceKind).toBe('free');
    expect(r.reasons).toContain('price:desc_free');
  });
  it.each([
    ['This is not a free event.', true], ['Admission is free for kids under 5.', true],
    ['Tickets are free for members; $20 general.', false], ['No cost for parking.', false], ['Tickets: $0.50 service fee', false],
  ] as const)('description negative: %s', (d, blocked) => {
    const r = P({}, d);
    expect(r.priceKind).toBe('unknown');
    if (blocked) expect(r.reasons).toContain('price:neg_blocked');
  });
  it('titles', () => {
    for (const t of ['Example Workplace: A Free Lunch & Learn', 'Example Series - Free Yoga']) {
      const r = P({}, undefined, t);
      expect([t, r.priceKind, r.reasons.includes('price:title_free')]).toEqual([t, 'free', true]);
    }
    const star = P({}, undefined, 'Free* Private Chef Dinner');
    expect(star.priceKind).toBe('unknown');
    expect(star.reasons).toContain('price:neg_blocked');
    for (const t of ['Example Band: Free Parking Night', 'Gluten-Free Baking: Example', 'Freestyle Ski Demo']) expect([t, P({}, undefined, t).priceKind]).toEqual([t, 'unknown']);
  });
  it('a veto keeps price', () => {
    const r = classify({ title: 'Sample Evening', categoriesHint: ['kids-families-events', 'free-events'], venueName: 'Example Taproom', family: 'tribe' });
    expect(r.priceKind).toBe('free');
    expect(r.reasons).toContain('price:source_free');
    expect(r.categories).not.toContain('family');
    expect(r.reasons).toContain('conflict:adult_signal');
  });
});

describe('AC-M1-164 explicit kids/family description phrases', () => {
  const D = (d: string) => c('Sample Afternoon', {}, d);
  it.each(['Fun for the whole family.', 'Families welcome.', 'Families are welcome.', 'A kid-friendly afternoon.', 'Something for the whole family.'])('family: %s', (d) => {
    const r = D(d);
    expect(r.categories).toContain('family');
    expect(r.reasons).toContain('cat:desc_family');
  });
  it.each(['For children ages 3-5.', 'Ages 4 to 10.', 'Ages 8 and under.'])('kids: %s', (d) => {
    const r = D(d);
    expect(r.categories).toContain('kids');
    expect(r.reasons).toContain('cat:desc_kids');
  });
  it.each(['Not for children.', 'Kid-friendly? Sorry, not this one.', 'Ages 13-17.', 'Ages 21 to 99.', 'Ages 5-15.', 'Family-owned since 1990.', 'The whole family of brews on tap.'])('neither: %s', (d) => {
    const r = D(d);
    expect(r.categories).not.toContain('kids');
    expect(r.categories).not.toContain('family');
  });
  it('titles never yield family', () => {
    expect(c('Family Fun Day').categories).not.toContain('family');
  });
});

describe('AC-M1-165 shared adult veto unchanged over VLT family', () => {
  const V = { categoriesHint: ['kids-families-events'], family: 'tribe' };
  const none = (r: ReturnType<typeof classify>) => { expect(r.categories).not.toContain('family'); expect(r.categories).not.toContain('kids'); };
  it('venue word list', () => {
    const r = c('Sample Evening', { ...V, venueName: 'Example Brewing Taproom' });
    none(r);
    expect(r.reasons).toContain('conflict:adult_signal');
  });
  it('21+ in the description', () => {
    const r = c('Sample Evening', V, 'Fun for the whole family. 21+ only.');
    none(r);
    expect(r.age).toBe('21_plus');
    expect(r.reasons).toContain('conflict:adult');
  });
  it('adult title word', () => { none(c('Example Saloon Night', V)); });
  it('for adults', () => {
    const r = c('Sample Evening', V, 'For adults.');
    none(r);
    expect(r.reasons).toContain('age:adult_phrase');
  });
  it('control', () => {
    const r = c('Sample Evening', { ...V, venueName: 'Example Park' });
    expect(r.categories).toContain('family');
    expect(r.reasons).toContain('cat:source_map');
  });
});

describe('AC-M1-174 free-evidence guards', () => {
  const D = (d: string) => c('Sample Evening', {}, d);
  it.each(['No tickets are free.', 'This is not a free event.', 'Admission is never free.', 'Entry isn\'t free, tickets are not free.'])('negated: %s', (d) => {
    const r = D(d);
    expect(r.priceKind).toBe('unknown');
    expect(r.reasons).toContain('price:neg_blocked');
  });
  it.each(['No cover', 'No cover charge.', 'There is no cost to attend.', 'No charge.', 'Admission $0', 'Tickets: $0', 'Tickets: $0.00'])('free: %s', (d) => {
    const r = D(d);
    expect(r.priceKind).toBe('free');
    expect(r.reasons).toContain('price:desc_free');
  });
  it.each(['Tickets: $0 - $25', 'Tickets: $0–25', 'Tickets: $0 to $25', 'Tickets: $0 for children; $25 general admission.', 'Admission $0 with a member card.', 'Admission $0. Parking $10.'])('$0 not whole price: %s', (d) => {
    expect(D(d).priceKind).toBe('unknown');
  });
  it('same-clause only: a negation in an earlier sentence does not block', () => {
    expect(D('Not to be missed. Admission is free.').priceKind).toBe('free');
  });
});

describe('A13 html_tahoedonner map and members-only', () => {
  it('maps the Tahoe Donner labels', () => {
    const m = CATEGORY_MAPS.html_tahoedonner;
    expect(m).toBeDefined();
    for (const [k, v] of Object.entries({ snowshoe: 'outdoors', 'downhill ski resort': 'outdoors', 'cross country ski center': 'outdoors', 'tahoe donner trails': 'outdoors', 'family events': 'family', 'kids programming': 'kids', dining: 'food-drink' })) expect(m[k], k).toBe(v);
    expect(m['recreation programs']).toBeUndefined();
    const r = c('Sample Dinner', { categoriesHint: ['dining', 'recreation programs', 'live music'], family: 'html_tahoedonner' });
    expect(r.categories).toEqual(expect.arrayContaining(['food-drink', 'music']));
    expect(r.unmapped).toEqual(['recreation programs']);
  });
  it('members-only is no source label: no family maps it, and it is not one of OUR_SLUGS', () => {
    for (const [f, m] of Object.entries(CATEGORY_MAPS)) expect(Object.values(m).includes('members-only'), f).toBe(false);
    expect(c('Sample', { categoriesHint: ['members-only'], family: 'tribe' }).categories).not.toContain('members-only');
    expect(c('Sample', { categoriesHint: ['members-only'], family: 'html_tahoedonner' }).categories).not.toContain('members-only');
  });
});
