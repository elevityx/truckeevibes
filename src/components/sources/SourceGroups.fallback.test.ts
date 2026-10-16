// AC-R1b-CO1 (render half): an empty source list (read failed, no previous snapshot) renders no zero counts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => false }));
import SourceGroups from './SourceGroups';

const h = (initial: Parameters<typeof SourceGroups>[0]['initial']) => renderToStaticMarkup(createElement(SourceGroups, { initial })).replace(/<!-- -->/g, '');

describe('AC-R1b-CO1 SourceGroups with no rows', () => {
  it('omits the count line and shows "Loading the calendar list…" in each group, no zero counts', () => {
    const out = h([]);
    expect(out).not.toContain('read daily');
    expect(out).not.toContain('class="cnt"');
    expect(out.match(/Loading the calendar list…/g)).toHaveLength(3);
  });
  it('with rows the count line and counts return', () => {
    const out = h([{ name: 'Example', homepageUrl: 'https://example.org/', status: 'active' }]);
    expect(out).toContain('1 read daily, 0 not yet, 0 link only.');
    expect(out).not.toContain('Loading the calendar list');
  });
  it('a group with no rows says so once the list is known (R1b-1 #8)', () => {
    const out = h([{ name: 'Example', homepageUrl: 'https://example.org/', status: 'active' }]);
    expect(out.match(/No calendars listed right now\./g)).toHaveLength(2);
  });
});
