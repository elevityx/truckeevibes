// AC-M1-63 (A3) plus the S1.12 SourcesTab rules. Interface assumption: SourceHealthRow is the camelCase row of
// adminSourceHealth(); lastRuns[0] is the newest run (admin_source_health orders finished_at desc).
// Spec leaves unspecified (not tested): lastSuccessAt = null, disabled sources, a success exactly at the threshold.
import { describe, expect, it } from 'vitest';
import type { SourceHealthRow } from '@/lib/data/adminQueue';
import { sourceHealth } from './sourceHealth';

const NOW = new Date('2026-11-05T18:00:00Z');
const H = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H).toISOString();
const inDays = (d: number) => new Date(NOW.getTime() + d * 24 * H).toISOString();

function row(over: Partial<SourceHealthRow> = {}): SourceHealthRow {
  return {
    slug: 's', name: 'S', enabled: true, trust: 'auto', strictAuto: false, maxCards7d: null, ingestDisposition: 'permitted',
    termsRecheckAt: inDays(300), cadence: '24h', consecutiveFailures: 0, lastSuccessAt: ago(1),
    lastRuns: [{ status: 'ok', finishedAt: ago(1), found: 5, new: 0, changed: 0, errorCode: null }],
    openCards7d: 0, openCards14d: 0, heldRunsPending: 0, ...over,
  };
}
const zeroItemOk = [{ status: 'ok', finishedAt: ago(1), found: 0, new: 0, changed: 0, errorCode: null }] as SourceHealthRow['lastRuns'];

describe('staleness = max(48 h, cadence + 12 h) (AC-M1-63)', () => {
  it('168 h zero-item source (TDRPD): 6 days green, 181 h red', () => {
    expect(sourceHealth(row({ cadence: '168h', lastSuccessAt: ago(6 * 24), lastRuns: zeroItemOk }), NOW)).toBe('green');
    expect(sourceHealth(row({ cadence: '168h', lastSuccessAt: ago(181), lastRuns: zeroItemOk }), NOW)).toBe('red');
  });
  it('168 h: 179 h green (threshold is 180 h)', () => {
    expect(sourceHealth(row({ cadence: '168h', lastSuccessAt: ago(179) }), NOW)).toBe('green');
  });
  it('24 h: 47 h green, 49 h red', () => {
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: ago(47) }), NOW)).toBe('green');
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: ago(49) }), NOW)).toBe('red');
  });
  it('72 h: 80 h green, 85 h red', () => {
    expect(sourceHealth(row({ cadence: '72h', lastSuccessAt: ago(80) }), NOW)).toBe('green');
    expect(sourceHealth(row({ cadence: '72h', lastSuccessAt: ago(85) }), NOW)).toBe('red');
  });
  it('6 h and 12 h cadences keep the 48 h floor', () => {
    for (const cadence of ['6h', '12h'] as const) {
      expect(sourceHealth(row({ cadence, lastSuccessAt: ago(47) }), NOW)).toBe('green');
      expect(sourceHealth(row({ cadence, lastSuccessAt: ago(49) }), NOW)).toBe('red');
    }
  });
  it('is evaluated against the `now` argument, not the wall clock', () => {
    const later = new Date(NOW.getTime() + 10 * H);
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: ago(40) }), NOW)).toBe('green');
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: ago(40) }), later)).toBe('red');
  });
});

describe('red', () => {
  it('consecutive_failures >= 2 is red regardless of freshness', () => {
    expect(sourceHealth(row({ consecutiveFailures: 2 }), NOW)).toBe('red');
    expect(sourceHealth(row({ consecutiveFailures: 7, cadence: '168h', lastSuccessAt: ago(1) }), NOW)).toBe('red');
  });
  it('one failure alone is not red', () => {
    expect(sourceHealth(row({ consecutiveFailures: 1 }), NOW)).toBe('green');
  });
  it.each(['anomaly', 'parse_error', 'http_error'] as const)('last run status %s is red even with a fresh success', (status) => {
    expect(
      sourceHealth(row({ lastRuns: [{ status, finishedAt: ago(1), found: 0, new: 0, changed: 0, errorCode: 'x' }] }), NOW),
    ).toBe('red');
  });
  it.each(['ok', 'not_modified', 'skipped'] as const)('last run status %s is not red', (status) => {
    expect(
      sourceHealth(row({ lastRuns: [{ status, finishedAt: ago(1), found: 0, new: 0, changed: 0, errorCode: null }] }), NOW),
    ).toBe('green');
  });
  it('only the newest run decides the status rule (an old anomaly behind a good run is fine)', () => {
    const runs = [
      { status: 'ok', finishedAt: ago(1), found: 3, new: 0, changed: 0, errorCode: null },
      { status: 'anomaly', finishedAt: ago(25), found: 0, new: 0, changed: 0, errorCode: 'x' },
    ] as SourceHealthRow['lastRuns'];
    expect(sourceHealth(row({ lastRuns: runs }), NOW)).toBe('green');
  });
});

describe('amber', () => {
  it('terms_recheck_at within 14 days is amber', () => {
    expect(sourceHealth(row({ termsRecheckAt: inDays(10) }), NOW)).toBe('amber');
    expect(sourceHealth(row({ termsRecheckAt: inDays(13.9) }), NOW)).toBe('amber');
  });
  it('terms_recheck_at beyond 14 days is green; null is green', () => {
    expect(sourceHealth(row({ termsRecheckAt: inDays(14.1) }), NOW)).toBe('green');
    expect(sourceHealth(row({ termsRecheckAt: null }), NOW)).toBe('green');
  });
  it('5 or more open cards in 7 days is amber; 4 is green', () => {
    expect(sourceHealth(row({ openCards7d: 5 }), NOW)).toBe('amber');
    expect(sourceHealth(row({ openCards7d: 40 }), NOW)).toBe('amber');
    expect(sourceHealth(row({ openCards7d: 4 }), NOW)).toBe('green');
  });
  it('the 14-day card count alone does not make it amber', () => {
    expect(sourceHealth(row({ openCards7d: 0, openCards14d: 20 }), NOW)).toBe('green');
  });
  it('red wins over amber', () => {
    expect(sourceHealth(row({ consecutiveFailures: 2, termsRecheckAt: inDays(3), openCards7d: 9 }), NOW)).toBe('red');
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: ago(60), openCards7d: 9 }), NOW)).toBe('red');
  });
});

describe('green', () => {
  it('a healthy source is green', () => {
    expect(sourceHealth(row(), NOW)).toBe('green');
  });
});

// AC-M1-80 (A7-6): locks in the accepted judgment calls.
describe('judgment calls (AC-M1-80)', () => {
  it('a disabled source is off whatever its runs look like', () => {
    expect(sourceHealth(row({ enabled: false, consecutiveFailures: 5, lastSuccessAt: null }), NOW)).toBe('off');
    expect(sourceHealth(row({ enabled: false }), NOW)).toBe('off');
  });
  it('an enabled source that never succeeded is red', () => {
    expect(sourceHealth(row({ lastSuccessAt: null }), NOW)).toBe('red');
  });
  it('the staleness limit is strict: exactly 48 h is not red, 48 h + 1 ms is', () => {
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: new Date(NOW.getTime() - 48 * H).toISOString() }), NOW)).not.toBe('red');
    expect(sourceHealth(row({ cadence: '24h', lastSuccessAt: new Date(NOW.getTime() - 48 * H - 1).toISOString() }), NOW)).toBe('red');
  });
  it('a terms re-check date in the past is amber', () => {
    expect(sourceHealth(row({ termsRecheckAt: inDays(-3) }), NOW)).toBe('amber');
  });
  it('red wins over amber', () => {
    expect(sourceHealth(row({ termsRecheckAt: inDays(-3), lastSuccessAt: null }), NOW)).toBe('red');
  });
});
