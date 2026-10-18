// AC-R1b-11
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EventGlyph from './EventGlyph';

const svg = (cats: string[]) => renderToStaticMarkup(createElement(EventGlyph, { categories: cats }));
const CATS = ['music', 'food-drink', 'outdoors', 'family', 'arts', 'community', 'markets', 'sports', 'nightlife', 'learning', 'holiday', 'halloween-fall', 'schools'];

describe('AC-R1b-11 EventGlyph', () => {
  it('returns a distinct glyph for each of the 13 glyph categories (12 + schools, A12)', () => {
    const all = CATS.map((c) => svg([c]));
    expect(new Set(all).size).toBe(13);
  });
  it('kids uses the family glyph', () => expect(svg(['kids'])).toBe(svg(['family'])));
  it('twentyone (the 21+ tile) has its own glyph, distinct from nightlife', () => {
    expect(svg(['twentyone'])).not.toBe(svg(['nightlife']));
    expect(svg(['twentyone'])).not.toBe(svg([]));
    expect(CATS.map((c) => svg([c]))).not.toContain(svg(['twentyone']));
  });
  it('an empty list or an unknown slug gives the calendar fallback, distinct from every category', () => {
    expect(svg([])).toBe(svg(['no-such-category']));
    expect(CATS.map((c) => svg([c]))).not.toContain(svg([]));
  });
});
