// S1.8 classify: keyword tables in code; description text is used only here and never returned.
import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import { DESC_SENTINEL } from '../testing/fakes';

const base = { title: 'Sample', categoriesHint: [] as string[] };

describe('classify', () => {
  it.each([
    ['Live Music on the Patio', 'music'], ['Brewery Tasting Dinner', 'food-drink'], ['Trail Run 10k', 'outdoors'],
    ['Kids Storytime', 'family'], ['Gallery Opening', 'arts'], ['Holiday Craft Fair', 'markets'], ['Trivia Night', 'nightlife'],
    ['Woodworking Workshop', 'learning'], ['Tree Lighting', 'holiday'], ['Haunted Pumpkin Patch', 'halloween-fall'],
  ])('%s -> %s', (title, cat) => {
    expect(classify({ ...base, title }).categories).toContain(cat);
  });
  it('price: free, paid with min/max, donation', () => {
    expect(classify({ ...base, priceText: 'Free' }).priceKind).toBe('free');
    const p = classify({ ...base, priceText: '$10 - $25' });
    expect([p.priceKind, p.priceMin, p.priceMax]).toEqual(['paid', 10, 25]);
    expect(classify({ ...base, priceText: 'By donation' }).priceKind).toBe('donation');
    expect(classify({ ...base, priceText: 'Free with $5 parking' }).priceKind).toBe('paid'); // "free" but has a $ amount
  });
  it('age: 21+, 18+, all ages, family', () => {
    expect(classify({ ...base, title: 'Late Show 21+' }).age).toBe('21_plus');
    expect(classify({ ...base, title: 'Show 18+' }).age).toBe('18_plus');
    expect(classify({ ...base, title: 'Concert, All Ages' }).age).toBe('all_ages');
    expect(classify({ ...base, title: 'Kids Day' }).age).toBe('family');
  });
  it('uses description text for classification but never returns it', () => {
    const r = classify({ ...base, title: 'Sample Evening' }, `${DESC_SENTINEL} live music and a band`);
    expect(r.categories).toContain('music');
    expect(JSON.stringify(r)).not.toContain(DESC_SENTINEL);
  });
});
