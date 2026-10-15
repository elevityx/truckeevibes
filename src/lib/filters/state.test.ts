// AC-M1-42: filter state <-> URL. Interface assumption (modeled on TL layer.ts): parseFilters accepts a search string with or
// without the leading '?'; filtersToSearch has no leading '?' and returns '' for the empty state; filtersUrl(href, s) returns
// pathname + search + hash, replacing only the three filter params.
import { describe, expect, it } from 'vitest';
import { AREAS, filtersToSearch, filtersUrl, parseFilters, type FilterState } from './state';

const WHENS = ['today', 'tonight', 'tomorrow', 'weekend', '7d', { date: '2026-11-05' }, null] as const;
const SUBSETS = [[], ['truckee'], ['donner_lake', 'truckee'], [...AREAS]];

describe('parseFilters / filtersToSearch (AC-M1-42)', () => {
  it('empty search is the empty state; the empty state serializes to ""', () => {
    const empty: FilterState = { when: null, areas: [], free: false };
    expect(parseFilters('')).toEqual(empty);
    expect(parseFilters('?')).toEqual(empty);
    expect(filtersToSearch(empty)).toBe('');
  });

  it('round-trips every When x area subset x free', () => {
    for (const when of WHENS) {
      for (const areas of SUBSETS) {
        for (const free of [false, true]) {
          const s: FilterState = { when, areas: [...areas].sort((a, b) => AREAS.indexOf(a) - AREAS.indexOf(b)), free };
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
    expect(parseFilters('event=abc&utm_source=x')).toEqual({ when: null, areas: [], free: false });
  });

  it('a parsed state never carries an unknown field', () => {
    expect(Object.keys(parseFilters('when=today&area=truckee&free=1&evil=1')).sort()).toEqual(['areas', 'free', 'when']);
  });
});

describe('filtersUrl', () => {
  it('writes only the filter params and keeps path, other params and hash', () => {
    const u = filtersUrl('https://truckeevibes.com/?event=abc#top', { when: 'weekend', areas: ['truckee'], free: true });
    const url = new URL(u, 'https://truckeevibes.com');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('event')).toBe('abc');
    expect(url.hash).toBe('#top');
    expect(parseFilters(url.search)).toEqual({ when: 'weekend', areas: ['truckee'], free: true });
  });

  it('the empty state removes the three params and leaves a bare path', () => {
    expect(filtersUrl('https://truckeevibes.com/?when=today&area=truckee&free=1', { when: null, areas: [], free: false })).toBe('/');
    const keep = filtersUrl('https://truckeevibes.com/?when=today&event=abc', { when: null, areas: [], free: false });
    expect(keep).toBe('/?event=abc');
  });

  it('replaces previous filter values instead of appending', () => {
    const u = filtersUrl('https://truckeevibes.com/?when=today&area=truckee', { when: 'tonight', areas: [], free: false });
    expect(parseFilters(new URL(u, 'https://x.test').search)).toEqual({ when: 'tonight', areas: [], free: false });
  });

  it('a date filter round-trips through the URL', () => {
    const u = filtersUrl('https://truckeevibes.com/', { when: { date: '2026-11-05' }, areas: [], free: false });
    expect(parseFilters(new URL(u, 'https://x.test').search).when).toEqual({ date: '2026-11-05' });
  });
});
