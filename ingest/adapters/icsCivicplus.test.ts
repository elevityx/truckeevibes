// S1.9 icsCivicplus (AC-M1-23's "empty calendars are valid" is a DB rule; here: ok with 0 items).
import { describe, expect, it } from 'vitest';
import { adapter } from './icsCivicplus';
import { fakePolite, fixture, source } from '../testing/fakes';

const NOW = new Date('2026-10-15T12:00:00Z');
const ctx = (net: ReturnType<typeof fakePolite>, catIds: number[]) =>
  ({ source: source({ slug: 'parks-sample', family: 'ics_civicplus', config: { base: 'https://parks.example.test', catIds }, allowed_hosts: ['parks.example.test'] }), fetch: net.fetch as never, now: NOW });

describe('icsCivicplus', () => {
  it('requests one iCalendar.aspx feed per catID', async () => {
    const net = fakePolite((u) => ({ body: fixture(u.searchParams.get('catID') === '14' ? 'civicplus/cat_one.ics' : 'civicplus/empty.ics') }));
    const r = await adapter.fetch(ctx(net, [14, 23]));
    expect(net.urls()).toEqual([
      'https://parks.example.test/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar',
      'https://parks.example.test/common/modules/iCalendar/iCalendar.aspx?catID=23&feed=calendar',
    ]);
    expect(net.calls.every((c) => c.kind === 'feed')).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].startsAt).toBe('2026-10-24T17:00:00Z');
  });
  it('all calendars empty -> ok with 0 items', async () => {
    const net = fakePolite(() => ({ body: fixture('civicplus/empty.ics') }));
    const r = await adapter.fetch(ctx(net, [14, 23, 24]));
    expect(r).toMatchObject({ status: 'ok', items: [] });
  });
});

// A8-1: parser version bumped so source_event_versions shows which parser stored a row.
describe('icsCivicplus parser version', () => {
  it('is ics_civicplus.2', () => { expect(adapter.version).toBe('ics_civicplus.2'); });
});
