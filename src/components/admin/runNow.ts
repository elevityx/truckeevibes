// Sources V2 (§10): the Run now and Read request views of a source row, and their texts. Pure: the clock is an argument.
// "Being read" and "retry" come from requestGrant (the database matched it to the current request by generation), never from
// comparing timestamps.
import type { DispatchOutcome } from '@/lib/data/adminJobs';
import type { SourceHealthRow } from '@/lib/data/adminQueue';
import { userMessage } from '@/lib/data/errors';
import type { DataError } from '@/lib/data/types';
import { dayLabel, localTime } from '@/lib/time/pacific';
import { ago } from './format';
import { offReason } from './sourceHealth';

const PT = 'America/Los_Angeles';
const MIN = 60_000;

export const RUN_NOW_TTL_MS = 24 * 60 * MIN; // SQL interval '24 hours'
export const FLOOR_MS = 30 * MIN; // SQL interval '30 minutes' (the grant life)
export const READ_TTL_MS = 7 * 24 * 60 * MIN; // SQL interval '7 days'
export const REQUEUE_MS = 5 * MIN; // UI only: the "Queued" lock after a click

export const SETUP_NOTE =
  'Run now needs setup: the owner adds a GitHub token (GITHUB_DISPATCH_TOKEN) to the Cloudflare Pages project, then a Pages build. Until then each source is read on its normal schedule.';
export const PUBLIC_NOTICE =
  'Published events show on the live list as soon as the run finishes; the build snapshot (first paint, and the fallback when the live read fails) updates at the next Pages build.';

export type Setup = 'loading' | 'configured' | 'needs_setup';
export interface RunNowView {
  show: boolean; status: string | null; button: { label: string; disabled: boolean; aria: string } | null; cancel: 'Cancel' | 'Dismiss' | null;
}
export interface ReadRequestView {
  lastRead: string; nextAllowed: string; status: string | null; button: { label: 'Request read'; disabled: boolean } | null;
  cancel: 'Cancel' | 'Dismiss' | null;
}

const t = (iso: string) => Date.parse(iso);
const at = (ms: number) => localTime(ms, PT);
const when = (iso: string) => `${dayLabel(iso, PT)} ${at(t(iso))}`;

export function runNowView(r: SourceHealthRow, setup: Setup, now: number): RunNowView {
  if (r.manualOnly) return { show: false, status: null, button: null, cancel: null };
  const pending = r.forceDueAt !== null && now - t(r.forceDueAt) < RUN_NOW_TTL_MS;
  const expired = r.forceDueAt !== null && !pending;
  const inFloor = r.lastGrantAt !== null && now - t(r.lastGrantAt) < FLOOR_MS;
  const reading = pending && !!r.requestGrant?.live;
  const retry = pending && !!r.requestGrant && !r.requestGrant.live;
  const served = r.forceDueServedAt !== null && now - t(r.forceDueServedAt) < RUN_NOW_TTL_MS;
  const schedulable = r.enabled && r.trust !== 'link_only';

  if (!schedulable) {
    return pending
      ? { show: true, status: 'Run now on hold: the source is off or link-only', button: null, cancel: 'Cancel' }
      : { show: false, status: null, button: null, cancel: null };
  }

  let status: string | null = null;
  if (reading) status = `Being read now (started ${ago(r.requestGrant!.issuedAt, now)})`;
  else if (retry) status = `Queued again: the read ${ago(r.requestGrant!.issuedAt, now)} recorded no result; the next Ingest run retries it`;
  else if (pending) status = `Queued for the next Ingest run · requested ${ago(r.forceDueAt, now)}`;
  else if (expired) status = `Run now from ${ago(r.forceDueAt, now)} was not read within 24 h (no Ingest run read it; see Jobs)`;
  else if (served) {
    const last = r.lastRuns[0];
    const result = last && t(last.finishedAt) >= t(r.forceDueServedAt!) ? `: ${last.status}, ${last.found} found` : '';
    status = `Run now done ${ago(r.forceDueServedAt, now)}${result}`;
  }

  const off = (label: string) => ({ label, disabled: true, aria: `Run now for ${r.name}: ${label}` });
  let button: RunNowView['button'];
  if (r.termsRecheckAt === null || t(r.termsRecheckAt) <= now) button = off('terms lapsed');
  else if (setup === 'loading') button = off('Checking…');
  else if (setup === 'needs_setup') button = { label: 'needs setup', disabled: true, aria: `Run now for ${r.name} needs setup` };
  else if (inFloor) button = off(`Run now at ${at(t(r.lastGrantAt!) + FLOOR_MS)}`);
  else if (pending && now - t(r.forceDueAt!) < REQUEUE_MS) button = off('Queued');
  else button = { label: 'Run now', disabled: false, aria: `Run now for ${r.name}` };

  return { show: true, status, button, cancel: pending ? 'Cancel' : expired ? 'Dismiss' : null };
}

export function readRequestView(r: SourceHealthRow, now: number): ReadRequestView {
  const last = r.lastRuns[0];
  const lastRead = last ? `last manual read ${ago(last.finishedAt, now)} (${last.status}, ${last.found} found)` : 'never read';
  const future = r.nextDueAt !== null && t(r.nextDueAt) > now;
  const nextAllowed = future ? `next read allowed after ${when(r.nextDueAt!)}` : 'next read allowed now';
  const pending = r.readRequestedAt !== null && now - t(r.readRequestedAt) < READ_TTL_MS;
  const expired = r.readRequestedAt !== null && !pending;
  const served = r.readRequestServedAt !== null && now - t(r.readRequestServedAt) < READ_TTL_MS;
  const readable = future ? ` · readable after ${when(r.nextDueAt!)}` : '';
  const request = { label: 'Request read' as const, disabled: false };
  const base = { lastRead, nextAllowed };

  if (!r.enabled) {
    const why = offReason(r);
    return { ...base, status: why ? `Off: ${why}` : 'Off', button: null, cancel: pending ? 'Cancel' : null };
  }
  if (pending && r.requestGrant?.live) return { ...base, status: 'Being read now', button: null, cancel: 'Cancel' };
  if (pending && r.requestGrant) {
    return {
      ...base, status: `Read requested ${ago(r.readRequestedAt, now)} · the read ${ago(r.requestGrant.issuedAt, now)} recorded no result${readable}`,
      button: null, cancel: 'Cancel',
    };
  }
  if (pending) return { ...base, status: `Read requested ${ago(r.readRequestedAt, now)}${readable}`, button: null, cancel: 'Cancel' };
  if (expired) return { ...base, status: `Read request from ${ago(r.readRequestedAt, now)} expired unread`, button: request, cancel: 'Dismiss' };
  if (served) return { ...base, status: `Read done ${ago(r.readRequestServedAt, now)} (requested)`, button: request, cancel: null };
  return { ...base, status: null, button: request, cancel: null };
}

const QUEUED = 'Queued for the next scheduled Ingest.';

export function dispatchText(o: DispatchOutcome, name: string): string {
  let s: string;
  switch (o.outcome) {
    case 'ok': s = `Ingest is starting; ${name} will be read in a few minutes.`; break;
    case 'not_configured':
    case 'unavailable': s = 'Queued for the next scheduled Ingest, within a few hours (instant start needs setup).'; break;
    case 'rejected':
      s = o.reason === 'token_refused' ? `${QUEUED} Instant start failed: GitHub refused the token (see the Owner Queue).`
        : o.reason === 'workflow_not_found' ? `${QUEUED} Instant start failed: GitHub did not find the Ingest workflow.`
          : `${QUEUED} Instant start failed: GitHub refused the main branch.`;
      break;
    default: s = `${QUEUED} Instant start unconfirmed (GitHub did not answer); the run may still start.`;
  }
  return `${s} ${PUBLIC_NOTICE}`;
}

function commonError(e: DataError): string | null {
  if (e.code === 'invalid_input' && e.detail === 'disabled') return 'Turn the source on first.';
  if (e.code === 'invalid_input' && e.detail === 'not_permitted') return 'This source has no current permission record.';
  if (e.code === 'not_found') return 'That source no longer exists.';
  return null;
}

export function runNowErrorText(e: DataError, r: SourceHealthRow): string {
  if (e.code === 'rate_limited' && e.detail === 'too_soon') {
    return r.lastGrantAt
      ? `Read in the last 30 minutes. Run now opens at ${at(t(r.lastGrantAt) + FLOOR_MS)}.`
      : 'Read in the last 30 minutes. Run now opens in a few minutes.';
  }
  if (e.code === 'invalid_input' && e.detail === 'manual_only') return 'This source is read on command only.';
  if (e.code === 'invalid_input' && e.detail === 'link_only') return 'Link-only sources are never read.';
  return commonError(e) ?? userMessage(e);
}

export function readRequestErrorText(e: DataError): string {
  if (e.code === 'invalid_input' && e.detail === 'not_manual') return 'Only read-on-command sources take a read request.';
  return commonError(e) ?? userMessage(e);
}
