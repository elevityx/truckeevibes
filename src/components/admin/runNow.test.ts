// AC-SV2-32 / AC-SV2-33 (Spec_Sources_V2 §10): the Run now and Read request views, the dispatch and error texts.
// Expected strings that depend on ago()/localTime()/dayLabel() are computed with those same helpers.
import { describe, expect, it } from 'vitest';
import type { SourceHealthRow } from '@/lib/data/adminQueue';
import { DataError } from '@/lib/data/types';
import { userMessage } from '@/lib/data/errors';
import { dayLabel, localTime } from '@/lib/time/pacific';
import { ago } from './format';
import {
  FLOOR_MS, PUBLIC_NOTICE, READ_TTL_MS, REQUEUE_MS, RUN_NOW_TTL_MS, SETUP_NOTE, dispatchText, readRequestErrorText, readRequestView,
  runNowErrorText, runNowView,
} from './runNow';

const PT = 'America/Los_Angeles';
const NOW = Date.parse('2026-11-05T18:00:00Z');
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const at = (ms: number) => new Date(NOW - ms).toISOString(); // `ms` ago
const later = (ms: number) => new Date(NOW + ms).toISOString();

function row(over: Partial<SourceHealthRow> = {}): SourceHealthRow {
  return {
    slug: 'alibi-truckee', name: 'Alibi Ale Works', enabled: true, trust: 'auto', strictAuto: false, maxCards7d: null,
    ingestDisposition: 'permitted', termsRecheckAt: later(300 * D), cadence: '24h', consecutiveFailures: 0, lastSuccessAt: at(5 * H),
    lastRuns: [{ status: 'ok', finishedAt: at(5 * H), found: 7, new: 0, changed: 0, errorCode: null }],
    openCards7d: 0, openCards14d: 0, heldRunsPending: 0,
    manualOnly: false, automationRestricted: false, nextDueAt: later(10 * H), lastGrantAt: at(5 * H), forceDueAt: null,
    forceDueServedAt: null, readRequestedAt: null, readRequestServedAt: null, requestGrant: null, ...over,
  };
}
const manual = (over: Partial<SourceHealthRow> = {}) =>
  row({ slug: 'bar-of-america', name: 'Bar of America', manualOnly: true, automationRestricted: true, trust: 'review', ...over });

describe('constants (Overview SSOT)', () => {
  it('match the SQL intervals', () => {
    expect(RUN_NOW_TTL_MS).toBe(24 * H);
    expect(FLOOR_MS).toBe(30 * MIN);
    expect(READ_TTL_MS).toBe(7 * D);
    expect(REQUEUE_MS).toBe(5 * MIN);
  });
  it('SETUP_NOTE and PUBLIC_NOTICE are the exact sentences', () => {
    expect(SETUP_NOTE).toBe(
      'Run now needs setup: the owner adds a GitHub token (GITHUB_DISPATCH_TOKEN) to the Cloudflare Pages project, then a Pages build. Until then each source is read on its normal schedule.',
    );
    expect(PUBLIC_NOTICE).toBe(
      'Published events show on the live list as soon as the run finishes; the build snapshot (first paint, and the fallback when the live read fails) updates at the next Pages build.',
    );
  });
});

describe('runNowView: visibility', () => {
  it('manual-only rows never show Run now', () => {
    expect(runNowView(manual({ forceDueAt: at(MIN) }), 'configured', NOW)).toEqual({ show: false, status: null, button: null, cancel: null });
  });
  it('link_only and disabled rows are hidden when nothing is pending', () => {
    for (const r of [row({ trust: 'link_only' }), row({ enabled: false })]) {
      const v = runNowView(r, 'configured', NOW);
      expect(v.show).toBe(false);
      expect(v.button).toBeNull();
    }
  });
  it('link_only and disabled rows with a pending stamp show "on hold" + Cancel, no button', () => {
    for (const r of [row({ trust: 'link_only', forceDueAt: at(H) }), row({ enabled: false, forceDueAt: at(H) })]) {
      expect(runNowView(r, 'configured', NOW)).toEqual({
        show: true, status: 'Run now on hold: the source is off or link-only', button: null, cancel: 'Cancel',
      });
    }
  });
});

describe('runNowView: status (first match)', () => {
  it('1. reading: pending + a live request grant -> Being read now', () => {
    const r = row({ forceDueAt: at(10 * MIN), lastGrantAt: at(2 * MIN), requestGrant: { issuedAt: at(2 * MIN), live: true } });
    expect(runNowView(r, 'configured', NOW).status).toBe(`Being read now (started ${ago(at(2 * MIN), NOW)})`);
  });
  it('2. retry: pending + an expired unused request grant -> Queued again', () => {
    const r = row({ forceDueAt: at(2 * H), lastGrantAt: at(H), requestGrant: { issuedAt: at(H), live: false } });
    expect(runNowView(r, 'configured', NOW).status).toBe(
      `Queued again: the read ${ago(at(H), NOW)} recorded no result; the next Ingest run retries it`,
    );
  });
  it('"being read" comes from requestGrant, never from timestamps (a recent lastGrantAt alone is not reading)', () => {
    const r = row({ forceDueAt: at(10 * MIN), lastGrantAt: at(2 * MIN), requestGrant: null });
    expect(runNowView(r, 'configured', NOW).status).toBe(`Queued for the next Ingest run · requested ${ago(at(10 * MIN), NOW)}`);
  });
  it('3. pending -> Queued for the next Ingest run', () => {
    const r = row({ forceDueAt: at(40 * MIN) });
    expect(runNowView(r, 'configured', NOW).status).toBe(`Queued for the next Ingest run · requested ${ago(at(40 * MIN), NOW)}`);
  });
  it('4. expired (> 24 h) -> not read within 24 h', () => {
    const r = row({ forceDueAt: at(25 * H) });
    expect(runNowView(r, 'configured', NOW).status).toBe(
      `Run now from ${ago(at(25 * H), NOW)} was not read within 24 h (no Ingest run read it; see Jobs)`,
    );
  });
  it('5. served -> Run now done, with the run result when the newest run finished at or after the serve', () => {
    const r = row({
      forceDueServedAt: at(20 * MIN),
      lastRuns: [{ status: 'ok', finishedAt: at(20 * MIN), found: 12, new: 1, changed: 0, errorCode: null }],
    });
    expect(runNowView(r, 'configured', NOW).status).toBe(`Run now done ${ago(at(20 * MIN), NOW)}: ok, 12 found`);
  });
  it('5. served, newest run older than the serve -> no result suffix', () => {
    const r = row({
      forceDueServedAt: at(20 * MIN),
      lastRuns: [{ status: 'ok', finishedAt: at(3 * H), found: 12, new: 1, changed: 0, errorCode: null }],
    });
    expect(runNowView(r, 'configured', NOW).status).toBe(`Run now done ${ago(at(20 * MIN), NOW)}`);
  });
  it('served is shown only once forceDueServedAt is set (a recent run alone is not "done")', () => {
    const r = row({ lastRuns: [{ status: 'ok', finishedAt: at(MIN), found: 3, new: 0, changed: 0, errorCode: null }] });
    expect(runNowView(r, 'configured', NOW).status).toBeNull();
  });
  it('served is never shown while a newer stamp is pending', () => {
    const r = row({ forceDueAt: at(10 * MIN), forceDueServedAt: at(3 * H) });
    expect(runNowView(r, 'configured', NOW).status).toBe(`Queued for the next Ingest run · requested ${ago(at(10 * MIN), NOW)}`);
  });
  it('served older than 24 h -> null', () => {
    expect(runNowView(row({ forceDueServedAt: at(25 * H) }), 'configured', NOW).status).toBeNull();
  });
  it('6. nothing -> null', () => {
    expect(runNowView(row(), 'configured', NOW).status).toBeNull();
  });
});

describe('runNowView: button (first match)', () => {
  it('terms lapsed wins over every setup state', () => {
    for (const setup of ['loading', 'configured', 'needs_setup'] as const) {
      const b = runNowView(row({ termsRecheckAt: at(MIN) }), setup, NOW).button;
      expect(b).toMatchObject({ label: 'terms lapsed', disabled: true });
    }
  });
  it('loading -> Checking… (disabled)', () => {
    expect(runNowView(row(), 'loading', NOW).button).toMatchObject({ label: 'Checking…', disabled: true });
  });
  it('needs_setup -> "needs setup" (disabled), aria names the source (SC2)', () => {
    expect(runNowView(row(), 'needs_setup', NOW).button).toEqual({
      label: 'needs setup', disabled: true, aria: 'Run now for Alibi Ale Works needs setup',
    });
  });
  it('needs_setup wins over the floor', () => {
    expect(runNowView(row({ lastGrantAt: at(5 * MIN) }), 'needs_setup', NOW).button).toMatchObject({ label: 'needs setup', disabled: true });
  });
  it('inside the 30-min floor -> "Run now at HH:MM" (PT, last grant + 30 min), disabled', () => {
    const g = at(10 * MIN);
    const b = runNowView(row({ lastGrantAt: g }), 'configured', NOW).button;
    expect(b).toMatchObject({ label: `Run now at ${localTime(Date.parse(g) + 30 * MIN, PT)}`, disabled: true });
  });
  it('the floor wins over Queued', () => {
    const g = at(MIN);
    const b = runNowView(row({ lastGrantAt: g, forceDueAt: at(MIN) }), 'configured', NOW).button;
    expect(b).toMatchObject({ label: `Run now at ${localTime(Date.parse(g) + 30 * MIN, PT)}`, disabled: true });
  });
  it('pending and stamped < 5 min ago -> Queued (disabled)', () => {
    expect(runNowView(row({ forceDueAt: at(4 * MIN) }), 'configured', NOW).button).toMatchObject({ label: 'Queued', disabled: true });
  });
  it('pending and stamped >= 5 min ago -> Run now again (re-stamp), enabled', () => {
    expect(runNowView(row({ forceDueAt: at(6 * MIN) }), 'configured', NOW).button).toEqual({
      label: 'Run now', disabled: false, aria: 'Run now for Alibi Ale Works',
    });
  });
  it('otherwise -> Run now (enabled)', () => {
    expect(runNowView(row(), 'configured', NOW).button).toEqual({ label: 'Run now', disabled: false, aria: 'Run now for Alibi Ale Works' });
    expect(runNowView(row({ lastGrantAt: at(31 * MIN) }), 'configured', NOW).button).toMatchObject({ label: 'Run now', disabled: false });
    expect(runNowView(row({ lastGrantAt: null }), 'configured', NOW).button).toMatchObject({ label: 'Run now', disabled: false });
  });
});

describe('runNowView: cancel', () => {
  it('pending -> Cancel, expired -> Dismiss, else null; in every setup state', () => {
    for (const setup of ['loading', 'configured', 'needs_setup'] as const) {
      expect(runNowView(row({ forceDueAt: at(H) }), setup, NOW).cancel).toBe('Cancel');
      expect(runNowView(row({ forceDueAt: at(25 * H) }), setup, NOW).cancel).toBe('Dismiss');
      expect(runNowView(row(), setup, NOW).cancel).toBeNull();
      expect(runNowView(row({ forceDueServedAt: at(H) }), setup, NOW).cancel).toBeNull();
    }
  });
});

describe('readRequestView (AC-SV2-33)', () => {
  it('lastRead and nextAllowed lines', () => {
    const v = readRequestView(manual(), NOW);
    expect(v.lastRead).toBe(`last manual read ${ago(at(5 * H), NOW)} (ok, 7 found)`);
    const nd = later(10 * H);
    expect(v.nextAllowed).toBe(`next read allowed after ${dayLabel(nd, PT)} ${localTime(Date.parse(nd), PT)}`);
    const never = readRequestView(manual({ lastRuns: [], nextDueAt: null }), NOW);
    expect(never.lastRead).toBe('never read');
    expect(never.nextAllowed).toBe('next read allowed now');
    expect(readRequestView(manual({ nextDueAt: at(MIN) }), NOW).nextAllowed).toBe('next read allowed now');
  });
  it('disabled -> Off / Off: blocked by the site, no button, Cancel only if pending', () => {
    expect(readRequestView(manual({ enabled: false }), NOW)).toMatchObject({ status: 'Off', button: null, cancel: null });
    const blocked = manual({
      enabled: false, readRequestedAt: at(H),
      lastRuns: [{ status: 'site_block', finishedAt: at(H), found: 0, new: 0, changed: 0, errorCode: 'site_block' }],
    });
    expect(readRequestView(blocked, NOW)).toMatchObject({ status: 'Off: blocked by the site', button: null, cancel: 'Cancel' });
  });
  it('pending + live grant -> Being read now, Cancel', () => {
    const v = readRequestView(manual({ readRequestedAt: at(H), requestGrant: { issuedAt: at(MIN), live: true } }), NOW);
    expect(v).toMatchObject({ status: 'Being read now', button: null, cancel: 'Cancel' });
  });
  it('pending + an expired request grant -> "recorded no result", readable after while next_due_at is ahead', () => {
    const nd = later(3 * H);
    const v = readRequestView(manual({ readRequestedAt: at(2 * H), nextDueAt: nd, requestGrant: { issuedAt: at(H), live: false } }), NOW);
    expect(v.status).toMatch(new RegExp(`^Read requested ${ago(at(2 * H), NOW)} · the read ${ago(at(H), NOW)} recorded no result · readable after `));
    expect(v.status).toContain(localTime(Date.parse(nd), PT));
    expect(v.button).toBeNull();
    expect(v.cancel).toBe('Cancel');
  });
  it('pending -> Read requested, with "readable after" only while next_due_at is in the future', () => {
    const nd = later(3 * H);
    const v = readRequestView(manual({ readRequestedAt: at(H), nextDueAt: nd }), NOW);
    expect(v.status?.startsWith(`Read requested ${ago(at(H), NOW)} · readable after `)).toBe(true);
    expect(v.status).toContain(localTime(Date.parse(nd), PT));
    expect(v).toMatchObject({ button: null, cancel: 'Cancel' });
    expect(readRequestView(manual({ readRequestedAt: at(H), nextDueAt: at(MIN) }), NOW).status).toBe(`Read requested ${ago(at(H), NOW)}`);
  });
  it('expired (> 7 d) -> expired unread, Request read + Dismiss', () => {
    const v = readRequestView(manual({ readRequestedAt: at(8 * D) }), NOW);
    expect(v.status).toBe(`Read request from ${ago(at(8 * D), NOW)} expired unread`);
    expect(v.button).toEqual({ label: 'Request read', disabled: false });
    expect(v.cancel).toBe('Dismiss');
  });
  it('served within 7 d -> Read done (requested), Request read', () => {
    const v = readRequestView(manual({ readRequestServedAt: at(2 * D) }), NOW);
    expect(v.status).toBe(`Read done ${ago(at(2 * D), NOW)} (requested)`);
    expect(v.button).toEqual({ label: 'Request read', disabled: false });
    expect(v.cancel).toBeNull();
  });
  it('else -> no status, Request read', () => {
    const v = readRequestView(manual(), NOW);
    expect(v.status).toBeNull();
    expect(v.button).toEqual({ label: 'Request read', disabled: false });
    expect(v.cancel).toBeNull();
    expect(readRequestView(manual({ readRequestServedAt: at(8 * D) }), NOW).status).toBeNull();
  });
});

describe('dispatchText (the sentence, then PUBLIC_NOTICE)', () => {
  const NAME = 'Alibi Ale Works';
  const cases: Array<[Parameters<typeof dispatchText>[0], string]> = [
    [{ outcome: 'ok' }, `Ingest is starting; ${NAME} will be read in a few minutes.`],
    [{ outcome: 'not_configured' }, 'Queued for the next scheduled Ingest, within a few hours (instant start needs setup).'],
    [{ outcome: 'unavailable' }, 'Queued for the next scheduled Ingest, within a few hours (instant start needs setup).'],
    [{ outcome: 'rejected', reason: 'token_refused' },
      'Queued for the next scheduled Ingest. Instant start failed: GitHub refused the token (see the Owner Queue).'],
    [{ outcome: 'rejected', reason: 'workflow_not_found' },
      'Queued for the next scheduled Ingest. Instant start failed: GitHub did not find the Ingest workflow.'],
    [{ outcome: 'rejected', reason: 'ref_rejected' }, 'Queued for the next scheduled Ingest. Instant start failed: GitHub refused the main branch.'],
    [{ outcome: 'unknown', reason: 'upstream' },
      'Queued for the next scheduled Ingest. Instant start unconfirmed (GitHub did not answer); the run may still start.'],
  ];
  it.each(cases)('%j', (o, sentence) => {
    expect(dispatchText(o, NAME)).toBe(`${sentence} ${PUBLIC_NOTICE}`);
  });
});

describe('runNowErrorText', () => {
  it('too_soon names the floor time from lastGrantAt (PT)', () => {
    const g = at(10 * MIN);
    expect(runNowErrorText(new DataError('rate_limited', 'too_soon'), row({ lastGrantAt: g }))).toBe(
      `Read in the last 30 minutes. Run now opens at ${localTime(Date.parse(g) + 30 * MIN, PT)}.`,
    );
  });
  it('too_soon without a lastGrantAt says "in a few minutes"', () => {
    expect(runNowErrorText(new DataError('rate_limited', 'too_soon'), row({ lastGrantAt: null }))).toBe(
      'Read in the last 30 minutes. Run now opens in a few minutes.',
    );
  });
  it.each([
    [new DataError('invalid_input', 'manual_only'), 'This source is read on command only.'],
    [new DataError('invalid_input', 'link_only'), 'Link-only sources are never read.'],
    [new DataError('invalid_input', 'disabled'), 'Turn the source on first.'],
    [new DataError('invalid_input', 'not_permitted'), 'This source has no current permission record.'],
    [new DataError('not_found', 'source'), 'That source no longer exists.'],
  ])('%s', (e, text) => {
    expect(runNowErrorText(e, row())).toBe(text);
  });
  it('anything else -> userMessage', () => {
    for (const e of [new DataError('network'), new DataError('forbidden'), new DataError('unknown')]) {
      expect(runNowErrorText(e, row())).toBe(userMessage(e));
    }
  });
});

describe('readRequestErrorText', () => {
  it.each([
    [new DataError('invalid_input', 'not_manual'), 'Only read-on-command sources take a read request.'],
    [new DataError('invalid_input', 'disabled'), 'Turn the source on first.'],
    [new DataError('invalid_input', 'not_permitted'), 'This source has no current permission record.'],
    [new DataError('not_found', 'source'), 'That source no longer exists.'],
  ])('%s', (e, text) => {
    expect(readRequestErrorText(e)).toBe(text);
  });
  it('anything else -> userMessage', () => {
    const e = new DataError('network');
    expect(readRequestErrorText(e)).toBe(userMessage(e));
  });
});
