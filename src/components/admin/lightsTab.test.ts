// AC-W3-23 (Spec_Vibes_Widget W3.4): pure helpers of the admin Lights tab.
import { describe, expect, it } from 'vitest';
import { DataError } from '@/lib/data/types';
import type { LightsHold, LightsEventRow } from '@/lib/data/adminLights';
import { acceptPayload, acceptErrorMessage, canShowAnyway, currentPair, holdSummary, STALE_SET_MESSAGE } from './lightsTab';

const hold: LightsHold = {
  region: 'truckee', season: 'halloween', year: 2026, observations: 2,
  firstObsAt: '2026-10-17T17:30:00Z', lastObsAt: '2026-10-17T17:45:00Z',
  removalSet: [
    { id: '00000000-0000-4000-8000-000000000003', title: 'House C', startsAt: '2026-10-30T02:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000001', title: 'House A', startsAt: '2026-10-28T02:00:00Z' },
  ],
};
const ev = (over: Partial<LightsEventRow> = {}): LightsEventRow => ({
  id: 'e1', title: 'Glow Walk', startsAt: '2026-10-30T02:00:00Z', lightsInclude: 'auto', shown: false, coveredLive: false, vetoed: false, ...over,
});

describe('AC-W3-23 accept payload', () => {
  it('equals the displayed set exactly (same ids, nothing added or dropped)', () => {
    expect(acceptPayload(hold)).toEqual({
      region: 'truckee', season: 'halloween', year: 2026,
      ids: ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001'],
    });
  });
  it('holdSummary shows the count, observations and the titles in display order', () => {
    const s = holdSummary(hold);
    expect(s.count).toBe(2);
    expect(s.observations).toBe(2);
    expect(s.titles).toEqual(['House C', 'House A']);
    expect(acceptPayload(hold).ids).toEqual(hold.removalSet.map((r) => r.id));
  });
});

describe('AC-W3-23 stale set', () => {
  it('maps the stale_set error to "The held set changed. Reload."', () => {
    expect(STALE_SET_MESSAGE).toBe('The held set changed. Reload.');
    expect(acceptErrorMessage(new DataError('stale', 'stale_set'))).toBe('The held set changed. Reload.');
    expect(acceptErrorMessage({ message: 'stale_set', code: '22023' })).toBe('The held set changed. Reload.');
  });
  it('other errors keep the normal user message', () => {
    expect(acceptErrorMessage(new DataError('network'))).toBe("Can't reach the server. Check your connection.");
    expect(acceptErrorMessage(new DataError('not_found'))).not.toBe('The held set changed. Reload.');
  });
});

describe('AC-W3-23 Show on Lights anyway', () => {
  it('is offered only for vetoed rows', () => {
    expect(canShowAnyway(ev({ vetoed: true }))).toBe(true);
    expect(canShowAnyway(ev({ vetoed: false }))).toBe(false);
    expect(canShowAnyway(ev({ vetoed: false, coveredLive: true }))).toBe(false);
    expect(canShowAnyway(ev({ vetoed: false, shown: true, lightsInclude: 'yes' }))).toBe(false);
  });
});

describe('currentPair (the tab opens on the pair Lights is showing, Pacific dates)', () => {
  it.each([
    ['2026-10-17T18:00:00Z', 'halloween', 2026], ['2026-11-02T12:00:00Z', 'christmas', 2026], ['2026-12-24T12:00:00Z', 'christmas', 2026],
    ['2027-01-06T12:00:00Z', 'christmas', 2026], ['2027-01-08T12:00:00Z', 'halloween', 2027], ['2026-11-01T07:30:00Z', 'halloween', 2026],
  ])('%s -> %s %s', (iso, season, year) => {
    expect(currentPair(new Date(iso))).toEqual({ season, year });
  });
});
