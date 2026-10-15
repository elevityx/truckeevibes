import { getSupabase } from '@/lib/supabase/client';
import { toDataError } from './errors';
import { DataError, type SourceClass, type SourceTrust } from './types';

// Every function wraps its errors with toDataError. The database enforces the admin gate on every RPC;
// nothing here is a security boundary.

export type CardKind = 'event' | 'possible_duplicate' | 'held_run' | 'source_budget';
export type CardDecision = 'approve' | 'reject' | 'merge' | 'distinct' | 'accept' | 'discard' | 'ack';

export interface QueueEvent {
  id: string; slug: string; title: string; summary: string; status: string; startsAt: string; endsAt: string | null;
  allDay: boolean; timeKnown: boolean; confidence: number | null; venue: string | null; address: string | null;
  town: string | null; area: string | null; categories: string[]; priceKind: string; age: string;
  organizerUrl: string | null; ticketUrl: string | null; lockedFields: string[];
}
export interface QueueSource { name: string; class: SourceClass; trust: SourceTrust; sourceUrl: string | null }
export interface QueueDuplicate { id: string; title: string; startsAt: string; status: string }
export interface HeldRun { runId: string; status: string; summary: unknown; itemCount: number; sample: string[] }
export interface QueueCard {
  id: string; kind: CardKind; createdAt: string; openedAt: string | null; sourceId: string | null;
  event: QueueEvent | null; sources: QueueSource[]; duplicates: QueueDuplicate[]; otherEvent: QueueDuplicate | null; heldRun: HeldRun | null;
}

export interface SourceRun { status: string; finishedAt: string; found: number; new: number; changed: number; errorCode: string | null }
export interface SourceHealthRow {
  slug: string; name: string; enabled: boolean; trust: SourceTrust; strictAuto: boolean; maxCards7d: number | null;
  ingestDisposition: string; termsRecheckAt: string | null; cadence: string; consecutiveFailures: number;
  lastSuccessAt: string | null; lastRuns: SourceRun[]; openCards7d: number; openCards14d: number; heldRunsPending: number;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- PostgREST jsonb rows, mapped field by field below
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

function mapDup(d: Raw): QueueDuplicate {
  return { id: d.id, title: d.title, startsAt: d.starts_at, status: d.status };
}

function mapCard(r: Raw): QueueCard {
  const ev = r.event as Raw | null | undefined;
  const h = r.held_run as Raw | null | undefined;
  return {
    id: r.id, kind: r.kind, createdAt: r.created_at, openedAt: r.opened_at ?? null, sourceId: r.source_id ?? null,
    event: ev
      ? {
          id: ev.id, slug: ev.slug, title: ev.title, summary: ev.summary, status: ev.status, startsAt: ev.starts_at,
          endsAt: ev.ends_at ?? null, allDay: !!ev.all_day, timeKnown: !!ev.time_known, confidence: numOrNull(ev.confidence),
          venue: ev.venue ?? null, address: ev.address ?? null, town: ev.town ?? null, area: ev.area ?? null,
          categories: arr<string>(ev.categories), priceKind: ev.price_kind, age: ev.age,
          organizerUrl: ev.organizer_url ?? null, ticketUrl: ev.ticket_url ?? null, lockedFields: arr<string>(ev.locked_fields),
        }
      : null,
    sources: arr<Raw>(r.sources).map((s) => ({ name: s.name, class: s.class, trust: s.trust, sourceUrl: s.source_url ?? null })),
    duplicates: arr<Raw>(r.duplicates).map(mapDup),
    otherEvent: r.other_event ? mapDup(r.other_event as Raw) : null,
    heldRun: h ? { runId: h.run_id, status: h.status, summary: h.summary, itemCount: num(h.item_count), sample: arr<string>(h.sample) } : null,
  };
}

async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = args === undefined ? await getSupabase().rpc(fn) : await getSupabase().rpc(fn, args);
    if (error) throw error;
    return data;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminQueue(kind: CardKind | null = null, limit = 50): Promise<QueueCard[]> {
  const p_limit = Math.min(100, Math.max(1, Math.trunc(limit)));
  return arr<Raw>(await call('admin_queue', { p_kind: kind, p_limit })).map(mapCard);
}

/** Owner minutes over the rolling last 7 days (the weekly report's figure). A non-numeric reply throws; it never shows a fake 0. */
export async function adminOwnerMinutes7d(): Promise<number> {
  const data = await call('admin_owner_minutes_7d');
  const n = data === null || data === undefined || data === '' ? NaN : Number(data);
  if (!Number.isFinite(n)) throw new DataError('unknown');
  return n;
}

export async function adminCardOpen(card: string): Promise<void> {
  await call('admin_card_open', { p_card: card });
}

/** reviewSeconds is sent as an integer clamped to 0..600 (the column is smallint with that check). */
export async function adminDecideCard(card: string, decision: CardDecision, reason: string | null | undefined, reviewSeconds: number): Promise<void> {
  const secs = Number.isFinite(reviewSeconds) ? Math.min(600, Math.max(0, Math.round(reviewSeconds))) : 0;
  await call('admin_decide_card', { p_card: card, p_decision: decision, p_reason: reason ?? null, p_review_seconds: secs });
}

export interface EventPatch {
  title?: string; summary?: string; starts_at?: string; ends_at?: string | null; all_day?: boolean; start_date?: string | null;
  end_date?: string | null; time_known?: boolean; venue_id?: string | null; categories?: string[]; price_kind?: string;
  price_min?: number | null; price_max?: number | null; age?: string; organizer_url?: string | null; ticket_url?: string | null;
}

export async function adminUpdateEvent(event: string, patch: EventPatch): Promise<void> {
  await call('admin_update_event', { p_event: event, p_patch: patch });
}

export async function adminSetEventStatus(event: string, status: 'hidden' | 'published' | 'rejected', reason: string | null): Promise<void> {
  await call('admin_set_event_status', { p_event: event, p_status: status, p_reason: reason });
}

export async function adminUnlockField(event: string, field: string): Promise<void> {
  await call('admin_unlock_field', { p_event: event, p_field: field });
}

export async function adminAddSuppression(kind: 'host' | 'url_prefix' | 'event', value: string, reason: string | null): Promise<void> {
  await call('admin_add_suppression', { p_kind: kind, p_value: value, p_reason: reason });
}

/** Owner time that is not tied to a card (a takedown, a source decision). */
export async function adminLogActivity(kind: 'featured' | 'takedown' | 'source_decision' | 'other', seconds: number): Promise<void> {
  await call('admin_log_activity', { p_kind: kind, p_seconds: seconds });
}

export async function adminSourceHealth(): Promise<SourceHealthRow[]> {
  return arr<Raw>(await call('admin_source_health')).map((r) => ({
    slug: r.slug, name: r.name, enabled: !!r.enabled, trust: r.trust, strictAuto: !!r.strict_auto, maxCards7d: numOrNull(r.max_cards_7d),
    ingestDisposition: r.ingest_disposition, termsRecheckAt: r.terms_recheck_at ?? null, cadence: String(r.cadence),
    consecutiveFailures: num(r.consecutive_failures), lastSuccessAt: r.last_success_at ?? null,
    lastRuns: arr<Raw>(r.last_runs).map((x) => ({
      status: x.status, finishedAt: x.finished_at, found: num(x.found), new: num(x.new), changed: num(x.changed), errorCode: x.error_code ?? null,
    })),
    openCards7d: num(r.open_cards_7d), openCards14d: num(r.open_cards_14d), heldRunsPending: num(r.held_runs_pending),
  }));
}
