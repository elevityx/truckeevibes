// AC-R1b-08: the six states' exact copy.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { EMPTY_FILTERS } from '@/lib/filters/state';
import { EmptyState, ErrorState, LoadingState, NoResultsState, noResultsCopy } from './ListStates';

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-10-15T15:00:00Z');
const text = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const noop = () => {};
const row = (o: Partial<VibeEvent> = {}) => ({ id: 'a', startsAt: '2026-10-17T01:00:00Z', priceKind: 'unknown', ...o }) as VibeEvent;

describe('AC-R1b-08 states', () => {
  it('Loading: skeleton rows and a status line', () => {
    const h = text(createElement(LoadingState, { calendars: 4 }));
    expect(h).toContain('role="status"');
    expect(h).toContain('Checking 4 calendars…');
    expect(h.match(/class="drow sk-row"/g)).toHaveLength(4);
  });
  it('Empty: copy, button and the last-checked line from builtAt', () => {
    const h = text(createElement(EmptyState, { builtAt: '2026-10-15T13:04:00Z', now: NOW, tz: TZ }));
    expect(h).toContain('Nothing listed yet');
    expect(h).toContain('The calendars we read have nothing for the next 30 days. That usually means our morning read failed, not that the town is quiet. Organizers: add your calendar.');
    expect(h).toMatch(/<a class="btn" href="\/sources\/#add">Add your calendar<\/a>/);
    expect(h).toContain('Last checked today, 6:04 am Pacific.');
    expect(text(createElement(EmptyState, { builtAt: '2026-10-14T13:04:00Z', now: NOW, tz: TZ }))).toContain('Last checked Wed Oct 14, 6:04 am Pacific.');
    expect(text(createElement(EmptyState, { builtAt: null, now: NOW, tz: TZ }))).not.toContain('Last checked');
  });
  it('No results for when=date:2026-10-17&free=1', () => {
    const f = { when: { date: '2026-10-17' }, areas: [], free: true };
    const h = text(createElement(NoResultsState, { filters: f, listEvents: [row()], now: NOW, tz: TZ, onShow7d: noop, onClear: noop }));
    expect(h).toContain('Nothing listed for Saturday yet');
    expect(h).toContain('Try Next 7 days, or turn off Free: every event we have this month is missing a price, so Free hides all of them.');
    expect(h).toContain('>Show Next 7 days<');
    expect(h).toContain('>Clear filters (2)<');
  });
  it('No results clauses', () => {
    const c = (f: Partial<typeof EMPTY_FILTERS>, evs: VibeEvent[] = [row()]) => noResultsCopy({ ...EMPTY_FILTERS, ...f }, evs, NOW, TZ);
    expect(c({ when: '7d', free: true })).toMatchObject({ title: 'Nothing matches yet', body: 'Turn off Free: every event we have this month is missing a price, so Free hides all of them.', showSeven: false });
    expect(c({ when: '7d', free: true }, [row({ priceKind: 'free' })]).body).toBe('Try clearing a filter.');
    expect(c({ areas: ['truckee'], when: '7d' }).body).toBe('Clear the area filter.');
    expect(c({ areas: ['truckee'], when: 'weekend' }).body).toBe('Try Next 7 days.');
    expect(c({ when: 'tomorrow' }).title).toBe('Nothing listed for Friday yet');
    expect(c({ when: 'today' }).title).toBe('Nothing listed for Thursday yet');
  });
  it('Error with an empty snapshot', () => {
    const h = text(createElement(ErrorState, { builtAt: null, now: NOW, tz: TZ, hasRows: false, onRetry: noop, onShowSnapshot: noop }));
    expect(h).toContain("Couldn't load the list");
    expect(h).toContain('Check your connection and try again. If it keeps failing, the fault is ours: the last good list is from the last update.');
    expect(h).toContain('>Try again<');
    expect(h).not.toContain('Show the list');
  });
  it('Error with snapshot rows offers the snapshot', () => {
    const today = text(createElement(ErrorState, { builtAt: '2026-10-15T13:04:00Z', now: NOW, tz: TZ, hasRows: true, onRetry: noop, onShowSnapshot: noop }));
    expect(today).toContain('the last good list is from this morning.');
    expect(today).toContain("Show this morning's list");
    const old = text(createElement(ErrorState, { builtAt: '2026-10-14T13:04:00Z', now: NOW, tz: TZ, hasRows: true, onRetry: noop, onShowSnapshot: noop }));
    expect(old).toContain('the last good list is from Wed Oct 14.');
    expect(old).toContain('Show the list from Wed Oct 14');
  });
});
