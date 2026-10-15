// S1.4 / S1.12 admin queue + health wrappers against a mocked Supabase client (RPC names, args, mapping, error mapping).
// Interface assumptions: functions are named adminQueue, adminCardOpen, adminDecideCard, adminUpdateEvent, adminSetEventStatus,
// adminUnlockField, adminSourceHealth, adminAddSuppression, adminLogActivity; adminDecideCard(card, decision, reason, reviewSeconds).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({ getSupabase: () => ({ rpc }) }));

import * as q from './adminQueue';
import { DataError } from './types';

const CARD = '00000000-0000-4000-8000-0000000000c1';
const EV = '00000000-0000-4000-8000-0000000000e1';

beforeEach(() => rpc.mockReset());

describe('adminQueue', () => {
  it('defaults to all kinds, 50 cards', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await q.adminQueue();
    expect(rpc).toHaveBeenCalledWith('admin_queue', { p_kind: null, p_limit: 50 });
  });
  it('passes a kind and clamps the limit to 1..100', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await q.adminQueue('held_run', 500);
    expect(rpc).toHaveBeenLastCalledWith('admin_queue', { p_kind: 'held_run', p_limit: 100 });
    await q.adminQueue('event', 0);
    expect(rpc).toHaveBeenLastCalledWith('admin_queue', { p_kind: 'event', p_limit: 1 });
  });
  it('maps an event card to camelCase', async () => {
    rpc.mockResolvedValue({
      data: [{
        id: CARD, kind: 'event', created_at: '2026-11-05T01:00:00Z', opened_at: null, source_id: 's1',
        event: {
          id: EV, slug: 'x', title: 'T', summary: 'S', status: 'pending', starts_at: '2026-11-06T02:00:00Z', ends_at: null,
          all_day: false, time_known: true, confidence: 0.7, venue: 'V', address: 'A', town: 'Truckee', area: 'truckee',
          categories: ['music'], price_kind: 'free', age: 'all_ages', organizer_url: 'https://o.test/', ticket_url: null,
          locked_fields: ['title'],
        },
        sources: [{ name: 'Alibi', class: 'venue', trust: 'review', source_url: 'https://a.test/e' }],
        duplicates: [{ id: 'd1', title: 'Dup', starts_at: '2026-11-06T02:00:00Z', status: 'published' }],
        other_event: null, held_run: null,
      }],
      error: null,
    });
    const [c] = await q.adminQueue();
    expect(c.id).toBe(CARD);
    expect(c.kind).toBe('event');
    expect(c.createdAt).toBe('2026-11-05T01:00:00Z');
    expect(c.openedAt).toBeNull();
    expect(c.event?.startsAt).toBe('2026-11-06T02:00:00Z');
    expect(c.event?.priceKind).toBe('free');
    expect(c.event?.lockedFields).toEqual(['title']);
    expect(c.event?.confidence).toBe(0.7);
    expect(c.sources).toEqual([{ name: 'Alibi', class: 'venue', trust: 'review', sourceUrl: 'https://a.test/e' }]);
    expect(c.duplicates).toEqual([{ id: 'd1', title: 'Dup', startsAt: '2026-11-06T02:00:00Z', status: 'published' }]);
    expect(c.otherEvent).toBeNull();
    expect(c.heldRun).toBeNull();
  });
  it('maps a held_run card (no event)', async () => {
    rpc.mockResolvedValue({
      data: [{
        id: CARD, kind: 'held_run', created_at: 'c', opened_at: 'o', source_id: 's1', event: null, sources: [], duplicates: [], other_event: null,
        held_run: { run_id: 'r1', status: 'pending', summary: { reason: 'drop' }, item_count: 12, sample: ['A', 'B'] },
      }],
      error: null,
    });
    const [c] = await q.adminQueue('held_run');
    expect(c.event).toBeNull();
    expect(c.heldRun).toEqual({ runId: 'r1', status: 'pending', summary: { reason: 'drop' }, itemCount: 12, sample: ['A', 'B'] });
    expect(c.openedAt).toBe('o');
  });
  it('tolerates missing arrays and null data', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await q.adminQueue()).toEqual([]);
    rpc.mockResolvedValue({ data: [{ id: CARD, kind: 'source_budget', created_at: 'c', opened_at: null, source_id: 's' }], error: null });
    const [c] = await q.adminQueue();
    expect(c.sources).toEqual([]);
    expect(c.duplicates).toEqual([]);
    expect(c.event).toBeNull();
  });
});

describe('adminCardOpen / adminDecideCard', () => {
  beforeEach(() => rpc.mockResolvedValue({ data: null, error: null }));

  it('admin_card_open takes p_card', async () => {
    await q.adminCardOpen(CARD);
    expect(rpc).toHaveBeenCalledWith('admin_card_open', { p_card: CARD });
  });
  it('admin_decide_card sends the four named args', async () => {
    await q.adminDecideCard(CARD, 'reject', 'not local', 42);
    expect(rpc).toHaveBeenCalledWith('admin_decide_card', { p_card: CARD, p_decision: 'reject', p_reason: 'not local', p_review_seconds: 42 });
  });
  it('a missing reason is sent as null', async () => {
    await q.adminDecideCard(CARD, 'approve', undefined, 3);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_reason: null });
  });
  it('review seconds are an integer clamped to 0..600 (the column is integer)', async () => {
    for (const [given, sent] of [[12.6, 13], [-5, 0], [9999, 600], [Number.NaN, 0]] as const) {
      rpc.mockClear();
      await q.adminDecideCard(CARD, 'ack', null, given);
      expect(rpc.mock.calls[0][1].p_review_seconds).toBe(sent);
    }
  });
  it.each(['approve', 'reject', 'merge', 'distinct', 'accept', 'discard', 'ack'] as const)('passes decision %s through', async (d) => {
    await q.adminDecideCard(CARD, d, null, 1);
    expect(rpc.mock.calls[0][1].p_decision).toBe(d);
  });
});

describe('error mapping', () => {
  const cases: Array<[string, unknown, string]> = [
    ['not_pending', { message: 'not_pending' }, 'not_pending'],
    ['stale held run', { message: 'stale' }, 'stale'],
    ['forbidden', { message: 'forbidden', code: '42501' }, 'forbidden'],
    ['not_found', { message: 'not_found' }, 'not_found'],
    ['invalid_input', { message: 'invalid_input' }, 'invalid_input'],
    ['source_not_permitted', { message: 'source_not_permitted' }, 'source_not_permitted'],
    ['anything else', { message: 'duplicate key value violates' }, 'unknown'],
  ];
  it.each(cases)('decide: %s', async (_n, error, code) => {
    rpc.mockResolvedValue({ data: null, error });
    const err = await q.adminDecideCard(CARD, 'accept', null, 5).catch((e) => e);
    expect(err).toBeInstanceOf(DataError);
    expect(err.code).toBe(code);
  });
  it('every wrapper wraps errors (a TypeError becomes network)', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    const calls = [
      () => q.adminQueue(), () => q.adminCardOpen(CARD), () => q.adminSourceHealth(), () => q.adminUnlockField(EV, 'title'),
      () => q.adminSetEventStatus(EV, 'hidden', 'r'), () => q.adminUpdateEvent(EV, { title: 'x' }),
      () => q.adminAddSuppression('host', 'x.test', 'r'), () => q.adminLogActivity('takedown', 30),
    ];
    for (const c of calls) {
      const err = await c().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DataError);
      expect((err as DataError).code).toBe('network');
    }
  });
});

describe('event admin RPCs', () => {
  beforeEach(() => rpc.mockResolvedValue({ data: null, error: null }));
  it('names and args match S1.4', async () => {
    await q.adminUpdateEvent(EV, { title: 'New' });
    expect(rpc).toHaveBeenLastCalledWith('admin_update_event', { p_event: EV, p_patch: { title: 'New' } });
    await q.adminSetEventStatus(EV, 'hidden', 'dup');
    expect(rpc).toHaveBeenLastCalledWith('admin_set_event_status', { p_event: EV, p_status: 'hidden', p_reason: 'dup' });
    await q.adminUnlockField(EV, 'title');
    expect(rpc).toHaveBeenLastCalledWith('admin_unlock_field', { p_event: EV, p_field: 'title' });
    await q.adminAddSuppression('host', 'x.test', 'source request');
    expect(rpc).toHaveBeenLastCalledWith('admin_add_suppression', { p_kind: 'host', p_value: 'x.test', p_reason: 'source request' });
    await q.adminLogActivity('source_decision', 45);
    expect(rpc).toHaveBeenLastCalledWith('admin_log_activity', { p_kind: 'source_decision', p_seconds: 45 });
  });
});

describe('adminSourceHealth', () => {
  it('calls admin_source_health with no args and maps a row to SourceHealthRow', async () => {
    rpc.mockResolvedValue({
      data: [{
        slug: 'tdrpd', name: 'TDRPD', enabled: true, trust: 'auto', strict_auto: false, max_cards_7d: null,
        ingest_disposition: 'permitted', terms_recheck_at: '2027-10-14T00:00:00Z', cadence: '168h',
        consecutive_failures: 0, last_success_at: '2026-11-01T12:00:00Z',
        last_runs: [{ status: 'ok', finished_at: '2026-11-01T12:00:00Z', found: 0, new: 0, changed: 0, error_code: null }],
        open_cards_7d: 2, open_cards_14d: 3, held_runs_pending: 1,
      }],
      error: null,
    });
    const rows = await q.adminSourceHealth();
    expect(rpc).toHaveBeenCalledWith('admin_source_health');
    expect(rows).toEqual([{
      slug: 'tdrpd', name: 'TDRPD', enabled: true, trust: 'auto', strictAuto: false, maxCards7d: null, ingestDisposition: 'permitted',
      termsRecheckAt: '2027-10-14T00:00:00Z', cadence: '168h', consecutiveFailures: 0, lastSuccessAt: '2026-11-01T12:00:00Z',
      lastRuns: [{ status: 'ok', finishedAt: '2026-11-01T12:00:00Z', found: 0, new: 0, changed: 0, errorCode: null }],
      openCards7d: 2, openCards14d: 3, heldRunsPending: 1,
    }]);
  });
  it('PostgREST returns count(*) as a number or numeric string; both become numbers', async () => {
    rpc.mockResolvedValue({
      data: [{ slug: 's', name: 'S', enabled: false, trust: 'review', strict_auto: false, max_cards_7d: 3, ingest_disposition: 'unknown',
        terms_recheck_at: null, cadence: '24h', consecutive_failures: 0, last_success_at: null, last_runs: [],
        open_cards_7d: '4', open_cards_14d: 5, held_runs_pending: '0' }],
      error: null,
    });
    const [r] = await q.adminSourceHealth();
    expect(r.openCards7d).toBe(4);
    expect(r.openCards14d).toBe(5);
    expect(r.heldRunsPending).toBe(0);
    expect(r.lastRuns).toEqual([]);
  });
});
