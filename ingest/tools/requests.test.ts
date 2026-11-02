// Spec_Sources_V2 §7 (AC-SV2-21, AC-SV2-24): the pure read-request helpers of the manual reader. No I/O.
import { describe, expect, it } from 'vitest';
import { formatRequests, grantRefusal, grantSql, parseRequests, REQUESTS_SQL, SLUG_RE, type PendingRequest } from './requests';
import * as manualDb from './manualDb';

// The spec's formatter (§7): PT, weekday + month + day + time. The expected strings use the same Intl options, so the ICU spacing
// (", " after the weekday, U+202F before AM/PM in newer ICU) never makes the test brittle; the DST checks below pin the hour.
const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pt = (iso: string) => PT.format(new Date(iso));

describe('REQUESTS_SQL and SLUG_RE', () => {
  it('selects only enabled manual-only sources with a read request younger than 7 days, in slug order', () => {
    const q = REQUESTS_SQL.replace(/\s+/g, ' ');
    expect(q).toContain('select slug, read_requested_at as requested_at, next_due_at from public.sources');
    expect(q).toContain("where enabled and manual_only and read_requested_at > now() - interval '7 days'");
    expect(q).toMatch(/order by slug\s*;?\s*$/);
  });
  it('SLUG_RE moved here; manualDb re-exports the same object', () => {
    expect(SLUG_RE.source).toBe('^[a-z0-9-]{2,60}$');
    expect(manualDb.SLUG_RE).toBe(SLUG_RE);
    for (const ok of ['bar-of-america', 'ab', 'tdrpd-rec1']) expect(SLUG_RE.test(ok)).toBe(true);
    for (const bad of ['a', 'Bar', "x'y", 'a b', 'a'.repeat(61), '']) expect(SLUG_RE.test(bad)).toBe(false);
  });
});

describe('parseRequests', () => {
  it('maps snake_case rows to PendingRequest', () => {
    expect(parseRequests([
      { slug: 'bar-of-america', requested_at: '2026-11-02T02:40:00.000Z', next_due_at: null },
      { slug: 'diamond-peak', requested_at: '2026-11-02T02:41:00.000Z', next_due_at: '2026-11-03T17:17:00.000Z' },
    ])).toEqual([
      { slug: 'bar-of-america', requestedAt: '2026-11-02T02:40:00.000Z', nextDueAt: null },
      { slug: 'diamond-peak', requestedAt: '2026-11-02T02:41:00.000Z', nextDueAt: '2026-11-03T17:17:00.000Z' },
    ]);
  });
  it('drops a row whose slug fails SLUG_RE or whose times are not ISO, and non-object rows', () => {
    const good = { slug: 'ivgid', requested_at: '2026-11-02T02:40:00.000Z', next_due_at: null };
    expect(parseRequests([
      { slug: "x'; drop table", requested_at: '2026-11-02T02:40:00.000Z', next_due_at: null },
      { slug: 'Bad Slug', requested_at: '2026-11-02T02:40:00.000Z', next_due_at: null },
      { slug: 'no-time', requested_at: 'yesterday', next_due_at: null },
      { slug: 'num-time', requested_at: 1762051200000, next_due_at: null },
      { slug: 'missing-time', next_due_at: null },
      { slug: 'bad-next', requested_at: '2026-11-02T02:40:00.000Z', next_due_at: 'soon' },
      null, 'bar-of-america', 42,
      good,
    ])).toEqual([{ slug: 'ivgid', requestedAt: '2026-11-02T02:40:00.000Z', nextDueAt: null }]);
    expect(parseRequests([])).toEqual([]);
  });
});

describe('formatRequests', () => {
  const now = Date.parse('2026-11-02T03:00:00.000Z'); // Sun Nov 1, 7:00 PM PST
  it('empty list -> one "no pending read requests" line', () => {
    expect(formatRequests([], now)).toEqual(['no pending read requests']);
  });
  it('"readable now" when nextDueAt is null or not in the future; "readable after <time> PT" otherwise', () => {
    const rows: PendingRequest[] = [
      { slug: 'bar-of-america', requestedAt: '2026-11-02T02:40:00.000Z', nextDueAt: null },
      { slug: 'diamond-peak', requestedAt: '2026-11-02T02:41:00.000Z', nextDueAt: '2026-11-02T03:00:00.000Z' },
      { slug: 'ivgid', requestedAt: '2026-11-02T02:42:00.000Z', nextDueAt: '2026-11-03T17:17:00.000Z' },
    ];
    expect(formatRequests(rows, now)).toEqual([
      `bar-of-america · requested ${pt('2026-11-02T02:40:00.000Z')} PT · readable now`,
      `diamond-peak · requested ${pt('2026-11-02T02:41:00.000Z')} PT · readable now`,
      `ivgid · requested ${pt('2026-11-02T02:42:00.000Z')} PT · readable after ${pt('2026-11-03T17:17:00.000Z')} PT`,
    ]);
  });
  it('PT across the DST change (2026-11-01 02:00 PDT -> 01:00 PST)', () => {
    const before = '2026-11-01T08:30:00.000Z'; // 1:30 AM PDT
    const after = '2026-11-01T10:30:00.000Z';  // 2:30 AM PST
    const summer = '2026-07-04T19:05:00.000Z'; // 12:05 PM PDT
    const [a, b, c] = formatRequests([
      { slug: 'a-one', requestedAt: before, nextDueAt: null },
      { slug: 'b-two', requestedAt: after, nextDueAt: null },
      { slug: 'c-three', requestedAt: summer, nextDueAt: '2026-12-01T17:17:00.000Z' },
    ], Date.parse('2026-11-01T11:00:00.000Z'));
    expect(a).toMatch(/^a-one · requested Sun,? Nov 1, 1:30\s?AM PT · readable now$/u);
    expect(b).toMatch(/^b-two · requested Sun,? Nov 1, 2:30\s?AM PT · readable now$/u);
    expect(c).toMatch(/^c-three · requested Sat,? Jul 4, 12:05\s?PM PT · readable after Tue,? Dec 1, 9:17\s?AM PT$/u);
  });
});

describe('grantRefusal', () => {
  it('manual_request_withdrawn -> withdrawn; manual_grant_refused -> gate', () => {
    expect(grantRefusal('ERROR:  manual_request_withdrawn (SQLSTATE P0001)')).toBe('withdrawn');
    expect(grantRefusal('ERROR:  manual_grant_refused (SQLSTATE P0001)')).toBe('gate');
  });
  it('an unrelated error -> null (manualGrant then throws grant_call_failed)', () => {
    expect(grantRefusal('Cannot find project ref. Have you run supabase link?')).toBeNull();
    expect(grantRefusal('ERROR:  permission denied for function svc_manual_grant_requested (SQLSTATE 42501)')).toBeNull();
    expect(grantRefusal('')).toBeNull();
  });
});

describe('grantSql', () => {
  it('requested -> svc_manual_grant_requested; plain -> svc_manual_grant', () => {
    expect(grantSql('bar-of-america', true)).toBe("select public.svc_manual_grant_requested('bar-of-america') as g");
    expect(grantSql('bar-of-america', false)).toBe("select public.svc_manual_grant('bar-of-america') as g");
  });
  it('throws Error("slug") on a slug that fails SLUG_RE (nothing is quoted unchecked)', () => {
    for (const bad of ["x'); drop table public.sources; --", 'Bar', 'a', '']) {
      expect(() => grantSql(bad, true)).toThrow('slug');
      expect(() => grantSql(bad, false)).toThrow('slug');
    }
  });
});
