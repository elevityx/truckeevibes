// AC-R1b-05: the desktop rail on the visual fixture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '@/components/list/snapshot';
import { firstPaint } from '@/lib/data/firstPaint';
import { EMPTY_FILTERS } from '@/lib/filters/state';
import Rail from './Rail';

const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
const { counts } = firstPaint(snap, 'all');
const html = renderToStaticMarkup(createElement(Rail, { counts, filters: EMPTY_FILTERS, onChange: () => {} }));
const doc = html.replace(/<!-- -->/g, '');
const items = (section: string) => {
  const m = new RegExp(`<h3[^>]*>${section}</h3><ul[^>]*>(.*?)</ul>`).exec(doc)!;
  return [...m[1].matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((x) => x[1].replace(/<input[^>]*>/g, '').replace(/<span class="bx"[^>]*><\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
};

describe('AC-R1b-05 Rail', () => {
  it('Area: the 7 areas with live counts, including 0', () => {
    expect(items('Area')).toEqual([
      'Truckee 22', 'Donner Lake 0', 'Tahoe City & West Shore 0', 'Olympic Valley & Northstar 0', 'Kings Beach & North Shore 0', 'Incline & Crystal Bay 13', 'Reno & Carson 0',
    ]);
  });
  it('Area checkboxes reflect the filter', () => {
    const on = renderToStaticMarkup(createElement(Rail, { counts, filters: { ...EMPTY_FILTERS, areas: ['truckee'] }, onChange: () => {} }));
    expect(on.match(/checked=""/g)).toHaveLength(1);
  });
  it('Kind: 13 entries sorted by count then label order', () => {
    const k = items('Kind');
    expect(k).toHaveLength(13);
    expect(k[0]).toBe('Food & drink 23');
    expect(k).toContain('Family 0');
    expect(k).toContain('Kids 0');
    expect(k.slice(0, 4)).toEqual(['Food & drink 23', 'Nightlife 22', 'Arts 11', 'Music 10']);
  });
  it('Calendars we read lists the active names and links All sources', () => {
    expect(doc).toContain('Calendars we read');
    expect(doc).toContain('Example Source A · Example Source B · Example Source C · Example Source D');
    expect(doc).toMatch(/<a href="\/sources\/">All sources<\/a>/);
  });
  it('carries the land acknowledgement', () => expect(doc).toContain('Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.'));
});
