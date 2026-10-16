// AC-R1a-10 (and AC-M1-77: source links go through safeWebsite).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => false, publicEnv: {} }));
vi.mock('@/lib/data', () => ({ listSourcesPublic: async () => [] }));

import SourceGroups, { displayUrl, sourceLink } from './SourceGroups';

const mk = (n: number, status: 'active' | 'paused' | 'link_only', url = 'https://example.org/') =>
  Array.from({ length: n }, (_, i) => ({ name: `Example ${status} ${i + 1}`, homepageUrl: url.replace('example.org', `example.org/${status}${i}`), status }));

const fixture = [
  { name: 'Example Hall', homepageUrl: 'https://www.example.org/events/', status: 'active' as const },
  ...mk(3, 'active'),
  ...mk(2, 'paused'),
  ...mk(8, 'link_only'),
];
const html = renderToStaticMarkup(createElement(SourceGroups, { initial: fixture }));

describe('AC-R1a-10 SourceGroups', () => {
  it('renders three groups with counts 4, 2, 8 in order and their status labels', () => {
    const counts = [...html.matchAll(/<h2[^>]*>([^<]*)<span class="count">(\d+)<\/span><\/h2>/g)].map((m) => [m[1].trim(), m[2]]);
    expect(counts).toEqual([['Calendars we read', '4'], ['Not included yet', '2'], ['Link only', '8']]);
    expect(html).toContain('Read every morning');
    expect(html).toContain('Not included yet');
    expect(html).toContain('Link only');
    expect(html.indexOf('Calendars we read')).toBeLessThan(html.indexOf('>Not included yet'));
  });
  it('shows the proof line', () => {
    expect(html).toContain('4 read daily, 2 not yet, 8 link only. Every event on the list came from one of the first group.');
  });
  it('displays example.org/events for https://www.example.org/events/ and links the real url', () => {
    expect(html).toContain('example.org/events');
    expect(html).toContain('href="https://www.example.org/events/"');
  });
  it('a source with an http homepage renders its name unlinked', () => {
    const h = renderToStaticMarkup(createElement(SourceGroups, { initial: [{ name: 'Plain Http Source', homepageUrl: 'http://example.org/x', status: 'active' }] }));
    expect(h).toContain('Plain Http Source');
    expect(h).not.toContain('href="http://example.org/x"');
    expect(h).not.toMatch(/<a [^>]*>Plain Http Source/);
  });
});

describe('displayUrl', () => {
  it('drops scheme, www and trailing slash only for display', () => {
    expect(displayUrl('https://www.alibialeworks.com/truckee/')).toBe('alibialeworks.com/truckee');
    expect(displayUrl('https://example.org/')).toBe('example.org');
  });
});

const src = (homepageUrl: string) => ({ name: 'S', homepageUrl, status: 'active' as const });
describe('sourceLink (AC-M1-77)', () => {
  it('an https url links', () => expect(sourceLink(src('https://example.org/x'))).toEqual({ name: 'S', href: 'https://example.org/x' }));
  for (const bad of ['http://example.org/x', 'https://user:pw@example.org/x', 'javascript:alert(1)', 'ftp://example.org/x', 'not a url']) {
    it(`no href for ${bad}`, () => expect(sourceLink(src(bad))).toEqual({ name: 'S', href: null }));
  }
});
