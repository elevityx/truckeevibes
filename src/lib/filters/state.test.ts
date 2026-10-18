// AC-M1-42: filter state <-> URL. Interface assumption (modeled on TL layer.ts): parseFilters accepts a search string with or
// without the leading '?'; filtersToSearch has no leading '?' and returns '' for the empty state; filtersUrl(href, s) returns
// pathname + search + hash, replacing only the three filter params.
import { describe, expect, it } from 'vitest';
import { CATEGORY_SLUGS } from '@/lib/categories';
import { AREAS, EMPTY_FILTERS, activeFilterCount, filtersToSearch, filtersUrl, pageUrl, parseFilters, type FilterState } from './state';

const WHENS = ['today', 'tonight', 'tomorrow', 'weekend', '7d', { date: '2026-11-05' }, null] as const;
const SUBSETS = [[], ['truckee'], ['donner_lake', 'truckee'], [...AREAS]];

describe('parseFilters / filtersToSearch (AC-M1-42)', () => {
  it('empty search is the empty state; the empty state serializes to ""', () => {
    const empty: FilterState = { when: null, areas: [], cats: [], free: false, kids: false, q: '' };
    expect(parseFilters('')).toEqual(empty);
    expect(parseFilters('?')).toEqual(empty);
    expect(filtersToSearch(empty)).toBe('');
  });

  it('round-trips every When x area subset x free', () => {
    for (const when of WHENS) {
      for (const areas of SUBSETS) {
        for (const free of [false, true]) {
          const s: FilterState = { when, areas: [...areas].sort((a, b) => AREAS.indexOf(a) - AREAS.indexOf(b)), cats: [], free, kids: false, q: '' };
          expect(parseFilters(filtersToSearch(s))).toEqual(s);
          expect(parseFilters('?' + filtersToSearch(s))).toEqual(s);
        }
      }
    }
  });

  it('serializes in the fixed order when, area (area sort order), free', () => {
    const s = parseFilters('?when=weekend&area=donner_lake,truckee&free=1');
    expect(filtersToSearch(s)).toBe('when=weekend&area=truckee,donner_lake&free=1');
    // parameter order in the input does not matter
    expect(filtersToSearch(parseFilters('free=1&area=donner_lake,truckee&when=weekend'))).toBe(
      'when=weekend&area=truckee,donner_lake&free=1',
    );
  });

  it('truckee sorts before donner_lake in AREAS, and AREAS is the seven seeded slugs', () => {
    expect(AREAS.indexOf('truckee')).toBeGreaterThanOrEqual(0);
    expect(AREAS.indexOf('truckee')).toBeLessThan(AREAS.indexOf('donner_lake'));
    expect([...AREAS].sort()).toEqual(
      ['donner_lake', 'incline_crystal_bay', 'kings_beach_north_shore', 'olympic_valley_northstar', 'reno_carson', 'tahoe_city_west_shore', 'truckee'],
    );
    expect(new Set(AREAS).size).toBe(AREAS.length);
  });

  it('drops unknown areas but keeps the valid ones; dedupes', () => {
    expect(parseFilters('area=nowhere').areas).toEqual([]);
    expect(parseFilters('area=nowhere,truckee,truckee').areas).toEqual(['truckee']);
    expect(parseFilters('area=').areas).toEqual([]);
  });

  it('accepts date:YYYY-MM-DD only when it is a real calendar date', () => {
    expect(parseFilters('when=date:2026-11-05').when).toEqual({ date: '2026-11-05' });
    expect(parseFilters('when=date:2026-13-40').when).toBeNull();
    expect(parseFilters('when=date:2026-02-30').when).toBeNull();
    expect(parseFilters('when=date:2026-1-5').when).toBeNull();
    expect(parseFilters('when=date:').when).toBeNull();
    expect(parseFilters('when=date:2026-11-05T00:00').when).toBeNull();
  });

  it('drops an unknown when value and ignores case-variants and junk', () => {
    expect(parseFilters('when=next-year').when).toBeNull();
    expect(parseFilters('when=TODAY').when).toBeNull();
    expect(parseFilters('when=').when).toBeNull();
    expect(parseFilters('when=<script>').when).toBeNull();
  });

  it('free is true only for free=1', () => {
    expect(parseFilters('free=1').free).toBe(true);
    for (const v of ['0', 'true', 'yes', '', '2']) expect(parseFilters(`free=${v}`).free).toBe(false);
  });

  it('uses the first value when a parameter repeats, and ignores unrelated params', () => {
    expect(parseFilters('when=today&when=tonight').when).toBe('today');
    expect(parseFilters('event=abc&utm_source=x')).toEqual({ when: null, areas: [], cats: [], free: false, kids: false, q: '' });
  });

  it('a parsed state never carries an unknown field', () => {
    expect(Object.keys(parseFilters('when=today&area=truckee&free=1&evil=1')).sort()).toEqual(['areas', 'cats', 'free', 'kids', 'q', 'when']);
  });
});

describe('filtersUrl', () => {
  it('writes only the filter params and keeps path, other params and hash', () => {
    const u = filtersUrl('https://truckeevibes.com/?event=abc#top', { when: 'weekend', areas: ['truckee'], cats: [], free: true, kids: false, q: '' });
    const url = new URL(u, 'https://truckeevibes.com');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('event')).toBe('abc');
    expect(url.hash).toBe('#top');
    expect(parseFilters(url.search)).toEqual({ when: 'weekend', areas: ['truckee'], cats: [], free: true, kids: false, q: '' });
  });

  it('the empty state removes the three params and leaves a bare path', () => {
    expect(filtersUrl('https://truckeevibes.com/?when=today&area=truckee&free=1', { when: null, areas: [], cats: [], free: false, kids: false, q: '' })).toBe('/');
    const keep = filtersUrl('https://truckeevibes.com/?when=today&event=abc', { when: null, areas: [], cats: [], free: false, kids: false, q: '' });
    expect(keep).toBe('/?event=abc');
  });

  it('replaces previous filter values instead of appending', () => {
    const u = filtersUrl('https://truckeevibes.com/?when=today&area=truckee', { when: 'tonight', areas: [], cats: [], free: false, kids: false, q: '' });
    expect(parseFilters(new URL(u, 'https://x.test').search)).toEqual({ when: 'tonight', areas: [], cats: [], free: false, kids: false, q: '' });
  });

  it('a date filter round-trips through the URL', () => {
    const u = filtersUrl('https://truckeevibes.com/', { when: { date: '2026-11-05' }, areas: [], cats: [], free: false, kids: false, q: '' });
    expect(parseFilters(new URL(u, 'https://x.test').search).when).toEqual({ date: '2026-11-05' });
  });
});

describe('AC-R1c-01 six-key filter state', () => {
  const states: FilterState[] = [];
  for (const when of WHENS) for (const cats of [[], ['music'], ['music', 'arts']]) for (const kids of [false, true]) for (const q of ['', 'Trivia night']) {
    states.push({
      when, areas: when === 'today' ? ['truckee', 'donner_lake'] : [], free: when === '7d',
      cats: CATEGORY_SLUGS.filter((c) => cats.includes(c)), kids, q,
    });
  }
  states.push({ when: null, areas: [...AREAS], cats: [...CATEGORY_SLUGS], free: true, kids: true, q: 'caf\u00e9 & s\u00f8ng=1' });
  it('covers 30+ states including every key', () => {
    expect(states.length).toBeGreaterThanOrEqual(30);
  });
  it('parseFilters(filtersToSearch(s)) deep-equals s', () => {
    for (const s of states) expect(parseFilters(filtersToSearch(s))).toEqual(s);
  });
  it('cat keeps known slugs only, kids=1 and q are cleaned (spec example)', () => {
    expect(parseFilters('?cat=music,bogus&kids=1&q=%20Trivia%20%20night%20')).toEqual({ ...EMPTY_FILTERS, cats: ['music'], kids: true, q: 'Trivia night' });
  });
  it('cat output is in CATEGORY_LABELS order whatever the input order', () => {
    expect(parseFilters('cat=arts,music').cats).toEqual(['music', 'arts']);
    expect(filtersToSearch({ ...EMPTY_FILTERS, cats: ['arts', 'music'] })).toBe('cat=music,arts');
  });
  it('a 61-character q is cut to 60', () => {
    expect(parseFilters(`q=${'a'.repeat(61)}`).q).toBe('a'.repeat(60));
    expect(parseFilters('q=' + 'a'.repeat(59) + '%20bb').q).toBe('a'.repeat(59));
  });
  it('kids is true only for kids=1; an empty q is the empty string', () => {
    expect(parseFilters('kids=1').kids).toBe(true);
    for (const v of ['0', 'true', '']) expect(parseFilters(`kids=${v}`).kids).toBe(false);
    expect(parseFilters('q=%20%20').q).toBe('');
  });
  it('serialized order is when, area, cat, free, kids, q', () => {
    const s: FilterState = { when: 'weekend', areas: ['truckee'], cats: ['music'], free: true, kids: true, q: 'dj' };
    expect(filtersToSearch(s)).toBe('when=weekend&area=truckee&cat=music&free=1&kids=1&q=dj');
  });
  it('q is URLSearchParams-encoded', () => {
    expect(filtersToSearch({ ...EMPTY_FILTERS, q: 'a b&c' })).toBe('q=a+b%26c');
  });
  it('filtersUrl replaces exactly the six keys and keeps the rest', () => {
    const u = filtersUrl('https://truckeevibes.com/?when=today&area=truckee&cat=music&free=1&kids=1&q=x&event=abc#top', EMPTY_FILTERS);
    expect(u).toBe('/?event=abc#top');
    expect(filtersUrl('https://truckeevibes.com/?q=old', { ...EMPTY_FILTERS, q: 'new' })).toBe('/?q=new');
  });
  it('activeFilterCount counts each non-empty key once (q counts 1)', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ when: '7d', areas: ['truckee', 'donner_lake'], cats: ['music', 'arts'], free: true, kids: true, q: 'x' })).toBe(6);
  });
});

describe('pageUrl (filters + the open event)', () => {
  it('keeps the date colon literal and puts event last', () => {
    const f = { ...EMPTY_FILTERS, when: { date: '2026-10-17' } } as FilterState;
    expect(pageUrl('https://truckeevibes.com/', f, null)).toBe('/?when=date:2026-10-17');
    expect(pageUrl('https://truckeevibes.com/?when=today', f, 'abc-1')).toBe('/?when=date:2026-10-17&event=abc-1');
  });
  it('replaces a previous event and drops it for null; other params and the hash stay', () => {
    expect(pageUrl('https://truckeevibes.com/?utm=x&event=old#top', EMPTY_FILTERS, 'new')).toBe('/?utm=x&event=new#top');
    expect(pageUrl('https://truckeevibes.com/?event=old', EMPTY_FILTERS, null)).toBe('/');
  });
});

describe('AC-M1-119 the schools category (A12)', () => {
  it('CATEGORY_SLUGS has 14 entries and schools is last', () => {
    expect(CATEGORY_SLUGS).toHaveLength(14);
    expect(CATEGORY_SLUGS[13]).toBe('schools');
  });
  it('cat=schools parses to [schools]', () => expect(parseFilters('cat=schools').cats).toEqual(['schools']));
});
