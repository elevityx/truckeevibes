// S1.3 / S1.11 public data wrappers against a mocked Supabase client.
// Interface assumptions: listEventsWithMeta(days) -> { events, truncated }; listEvents(days) -> VibeEvent[] (its `.events`);
// truncation is logged with console.warn; listSources() is the S1.11 name for the list_sources_public wrapper.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({ getSupabase: () => ({ rpc }) }));

import { DataError } from './types';
import { listEvents, listEventsWithMeta, listSources } from './public';

function row(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, slug: `e-${i}`, title: `Event ${i}`, summary: 'S',
    starts_at: '2026-11-06T02:00:00+00:00', ends_at: null, all_day: false, start_date: null, end_date: null, time_known: true,
    venue: 'V', address: 'A', town: 'Truckee', area: 'truckee', lat: 39.3, lng: -120.2, categories: ['music'],
    price_kind: 'free', price_min: null, price_max: null, age: 'all_ages', featured: false, url: 'https://e.test/',
    ticket_url: null, sources: ['Alibi'], ...over,
  };
}

beforeEach(() => {
  rpc.mockReset();
  vi.restoreAllMocks();
});

describe('listEvents', () => {
  it('calls list_events with p_days = 120 by default and maps every column to camelCase', async () => {
    rpc.mockResolvedValue({ data: [row(1, { ends_at: '2026-11-06T04:00:00+00:00', price_min: 5, price_max: 10, ticket_url: 'https://t.test/' })], error: null });
    const events = await listEvents();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_events', { p_days: 120 });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000001', slug: 'e-1', title: 'Event 1', summary: 'S',
      startsAt: '2026-11-06T02:00:00+00:00', endsAt: '2026-11-06T04:00:00+00:00', allDay: false, startDate: null, endDate: null,
      timeKnown: true, venue: 'V', address: 'A', town: 'Truckee', area: 'truckee', lat: 39.3, lng: -120.2,
      categories: ['music'], priceKind: 'free', priceMin: 5, priceMax: 10, age: 'all_ages', featured: false,
      url: 'https://e.test/', ticketUrl: 'https://t.test/', sources: ['Alibi'],
    });
  });

  it('passes a custom day window through', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await listEvents(30);
    expect(rpc).toHaveBeenCalledWith('list_events', { p_days: 30 });
  });

  it('exposes only the declared columns (no confidence / field_sources / lights_* even if a row carried them)', async () => {
    rpc.mockResolvedValue({ data: [row(1, { confidence: 0.9, field_sources: { a: 1 }, lights_event_id: 'x', status: 'published' })], error: null });
    const [e] = await listEvents();
    expect(Object.keys(e).sort()).toEqual(
      ['address', 'age', 'allDay', 'area', 'categories', 'endDate', 'endsAt', 'featured', 'id', 'lat', 'lng', 'priceKind', 'priceMax', 'priceMin',
        'slug', 'sources', 'startDate', 'startsAt', 'summary', 'ticketUrl', 'timeKnown', 'title', 'town', 'url', 'venue'].sort(),
    );
  });

  it('treats null / non-array data as an empty list', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await listEvents()).toEqual([]);
  });
});

describe('truncation (2,000-row cap)', () => {
  it('under the cap: one call, truncated = false', async () => {
    rpc.mockResolvedValue({ data: Array.from({ length: 1999 }, (_, i) => row(i)), error: null });
    const r = await listEventsWithMeta();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(r.truncated).toBe(false);
    expect(r.events).toHaveLength(1999);
  });

  it('exactly 2,000 rows: retries once with p_days = 60, sets truncated, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 2000 }, (_, i) => row(i)), error: null })
      .mockResolvedValueOnce({ data: Array.from({ length: 700 }, (_, i) => row(i)), error: null });
    const r = await listEventsWithMeta();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(['list_events', { p_days: 120 }]);
    expect(rpc.mock.calls[1]).toEqual(['list_events', { p_days: 60 }]);
    expect(r.truncated).toBe(true);
    expect(r.events).toHaveLength(700);
    expect(warn).toHaveBeenCalled();
  });

  it('listEvents returns the retried rows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 2000 }, (_, i) => row(i)), error: null })
      .mockResolvedValueOnce({ data: [row(1)], error: null });
    expect(await listEvents()).toHaveLength(1);
  });

  it('does not retry a short window that is already 60 days or less', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: Array.from({ length: 2000 }, (_, i) => row(i)), error: null });
    const r = await listEventsWithMeta(60);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(r.truncated).toBe(true);
  });
});

describe('error mapping', () => {
  it('an RPC error becomes a DataError (never a raw PostgREST error)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'rate_limited' } });
    const err = await listEvents().catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.code).toBe('rate_limited');
  });
  it('a fetch failure (TypeError) maps to network', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await listEvents().catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.code).toBe('network');
  });
  it('an unknown error maps to unknown and leaks no message', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'relation "x" does not exist' } });
    const err = await listEvents().catch((e) => e);
    expect(err.code).toBe('unknown');
    expect(String(err.message)).not.toContain('relation');
  });
  it('a failed retry surfaces as a DataError', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 2000 }, (_, i) => row(i)), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'network' } });
    const err = await listEvents().catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.code).toBe('network');
  });
});

describe('listSources', () => {
  it('calls list_sources_public with no args and maps the three columns', async () => {
    rpc.mockResolvedValue({ data: [{ name: 'Alibi', homepage_url: 'https://alibialeworks.com', status: 'active' }], error: null });
    expect(await listSources()).toEqual([{ name: 'Alibi', homepageUrl: 'https://alibialeworks.com', status: 'active' }]);
    expect(rpc).toHaveBeenCalledWith('list_sources_public');
  });
});
