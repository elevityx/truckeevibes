// Notices (spec R4b + Amendment R4b-1): the TS twin of private.is_notice_title / notice_rest, and the runner-side drop and cancel.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyNotices, isNoticeTitle, noticeContext, noticeRest, normTitle, pacificDay } from './notices';
import type { SourceEvent } from '../types';

interface Row { title: string; sibling: string; offsets?: number[]; notice: boolean }
const CASES: Row[] = JSON.parse(readFileSync(fileURLToPath(new URL('./notices.cases.json', import.meta.url)), 'utf8'));

/** An item at `YYYY-MM-DD` 19:00 Pacific (PDT in Oct, so 02:00Z the next day). */
function at(title: string, day: string, key: string, extra: Partial<SourceEvent> = {}): SourceEvent {
  const [y, m, d] = day.split('-').map(Number);
  const startsAt = new Date(Date.UTC(y, m - 1, d + 1, 2, 0, 0)).toISOString().replace('.000Z', 'Z');
  return { externalKey: key, title, startsAt, allDay: false, timeKnown: true, tz: 'America/Los_Angeles', categoriesHint: [], rawSummaryLength: 0, ...extra };
}
const shift = (day: string, n: number) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n)).toISOString().slice(0, 10);
const D = '2026-10-30';
function batchOf(row: Row): { notice: SourceEvent; batch: SourceEvent[] } {
  const notice = at(row.title, D, 'n0');
  const sibs = row.sibling ? (row.offsets ?? [0]).map((o, i) => at(row.sibling, shift(D, o), `s${i}`)) : [];
  return { notice, batch: [notice, ...sibs] };
}

describe('helpers', () => {
  it('normTitle twin of the SQL normalization', () => {
    expect(normTitle('  NO  fx   Trivia ')).toBe('no fx trivia');
  });
  it('noticeRest', () => {
    expect(noticeRest('NO Country Fridays Tonight')).toBe('country fridays');
    expect(noticeRest('  no  Trivia   Today ')).toBe('trivia');
    expect(noticeRest('No Tonight')).toBeNull();
    expect(noticeRest('No Trivia Tonight!')).toBeNull();
    expect(noticeRest('Country Fridays')).toBeNull();
  });
  it('isNoticeTitle(null) is false', () => {
    expect(isNoticeTitle(null)).toBe(false);
    expect(isNoticeTitle(undefined)).toBe(false);
    expect(isNoticeTitle(null, true)).toBe(false);
  });
  it('pacificDay: all-day uses startDate; timed uses the Pacific calendar date', () => {
    expect(pacificDay(at('x', '2026-10-30', 'k'))).toBe('2026-10-30');
    expect(pacificDay({ ...at('x', '2026-10-30', 'k'), allDay: true, startDate: '2026-10-31', endDate: '2026-11-01' })).toBe('2026-10-31');
    expect(pacificDay({ ...at('x', '2026-10-30', 'k'), startsAt: '2026-10-31T06:30:00Z' })).toBe('2026-10-30');
  });
});

describe('every parity row (AC-R4b-07, AC-R4b-14)', () => {
  it('has 39 rows, 13 of them notices, 5 with offsets', () => {
    expect(CASES.length).toBe(39);
    expect(CASES.filter((c) => c.notice).length).toBe(13);
    expect(CASES.filter((c) => c.offsets).length).toBe(5);
  });
  it.each(CASES.map((c, i) => [`${i}: ${c.title} | ${c.sibling} | ${JSON.stringify(c.offsets ?? null)}`, c] as const))('%s', (_n, row) => {
    const { notice, batch } = batchOf(row);
    expect(isNoticeTitle(row.title, noticeContext(notice, batch).context)).toBe(row.notice);
    const out = applyNotices(batch);
    expect(out.items.some((i) => i.externalKey === 'n0')).toBe(!row.notice);
    expect(out.dropped).toBe(row.notice ? 1 : 0);
  });
});

describe('applyNotices cancel and series (AC-R4b-08, AC-R4b-15)', () => {
  const N = (day = D) => at('NO Country Fridays Tonight', day, 'n');
  const F = (day: string, key: string, extra: Partial<SourceEvent> = {}, title = 'Country Fridays') => at(title, day, key, extra);

  it('one same-day sibling, same or absent venue -> drop + cancel, 1/1', () => {
    const pairs: [string | undefined, string | undefined][] = [[undefined, undefined], ['Alibi Ale Works Truckee', 'alibi  ale works truckee'], ['Alibi', undefined], [undefined, 'Alibi']];
    for (const [nv, sv] of pairs) {
      const out = applyNotices([{ ...N(), venueName: nv }, F(D, 's', { venueName: sv }), at('Other', D, 'o')]);
      expect([out.dropped, out.cancelled]).toEqual([1, 1]);
      const s = out.items.find((i) => i.externalKey === 's')!;
      expect(s.cancelled).toBe(true);
      expect(s.tagReasons).toContain('notice:cancel_sibling');
      expect(out.items.map((i) => i.externalKey)).toEqual(['s', 'o']);
    }
  });
  it('a different venue -> dropped, sibling not cancelled', () => {
    const out = applyNotices([{ ...N(), venueName: 'Alibi Ale Works Truckee' }, F(D, 's', { venueName: 'Alibi Ale Works Incline' })]);
    expect([out.dropped, out.cancelled]).toEqual([1, 0]);
    const s = out.items.find((i) => i.externalKey === 's')!;
    expect(s.cancelled).toBeUndefined();
    expect(s.tagReasons ?? []).not.toContain('notice:cancel_sibling');
  });
  it('two same-day siblings -> dropped, none cancelled', () => {
    const out = applyNotices([N(), F(D, 's1'), F(D, 's2')]);
    expect([out.dropped, out.cancelled]).toEqual([1, 0]);
    expect(out.items.every((i) => !i.cancelled)).toBe(true);
  });
  it('one sibling on a different day and no series -> notice kept', () => {
    const out = applyNotices([N(), F('2026-11-06', 's')]);
    expect([out.dropped, out.cancelled]).toEqual([0, 0]);
    expect(out.items.length).toBe(2);
  });
  it('series of two (Oct 23 + Nov 6) -> dropped, nothing cancelled, 1/0', () => {
    const out = applyNotices([N(), F('2026-10-23', 'a'), F('2026-11-06', 'b')]);
    expect([out.dropped, out.cancelled]).toEqual([1, 0]);
    expect(out.items.map((i) => i.externalKey)).toEqual(['a', 'b']);
    expect(out.items.every((i) => !i.cancelled)).toBe(true);
  });
  it('only Nov 6 -> not a notice, all submitted, 0/0', () => {
    const out = applyNotices([N(), F('2026-11-06', 'b')]);
    expect([out.items.length, out.dropped, out.cancelled]).toEqual([2, 0, 0]);
  });
  it('the +-14 window is inclusive: Oct 16 + Nov 13 -> 1/0; Oct 15 + Nov 14 -> 0/0', () => {
    const inside = applyNotices([N(), F('2026-10-16', 'a'), F('2026-11-13', 'b')]);
    expect([inside.dropped, inside.cancelled]).toEqual([1, 0]);
    const outside = applyNotices([N(), F('2026-10-15', 'a'), F('2026-11-14', 'b')]);
    expect([outside.dropped, outside.cancelled]).toEqual([0, 0]);
  });
  it('"Country Fridays Live" is equal-not-contains: 0/0', () => {
    const out = applyNotices([N(), F(D, 's', {}, 'Country Fridays Live')]);
    expect([out.items.length, out.dropped, out.cancelled]).toEqual([2, 0, 0]);
  });
  it('a sibling already cancelled by the source is not counted again, the notice is still dropped', () => {
    const out = applyNotices([N(), F(D, 's', { cancelled: true })]);
    expect([out.dropped, out.cancelled]).toEqual([1, 0]);
    expect(out.items[0].tagReasons ?? []).not.toContain('notice:cancel_sibling');
  });
  it('cancel appends to existing reasons, dedupes, and respects the 16 cap', () => {
    const full = Array.from({ length: 16 }, () => 'cat:default' as const);
    const out = applyNotices([N(), F(D, 's', { tagReasons: ['price:unknown'] })]);
    expect(out.items[0].tagReasons).toEqual(['price:unknown', 'notice:cancel_sibling']);
    const capped = applyNotices([N(), F(D, 's', { tagReasons: full })]);
    expect(capped.items[0].cancelled).toBe(true);
    expect(capped.items[0].tagReasons!.length).toBe(16);
  });
  it('does not mutate its input', () => {
    const s = F(D, 's');
    const input = [N(), s];
    applyNotices(input);
    expect(s.cancelled).toBeUndefined();
    expect(input.length).toBe(2);
  });
  it('a same-run first-ever sibling is handled in the batch', () => {
    const out = applyNotices([at('NO Fx Tonight', D, 'n'), at('Fx', D, 's')]);
    expect(out.items.map((i) => [i.title, i.cancelled])).toEqual([['Fx', true]]);
  });
  it('rule (a) and (b) notices drop without any sibling', () => {
    const out = applyNotices([at('Example Ale Works Closing at 4PM Today', D, 'a'), at('Holiday Hours at Example Hall', D, 'b'), at('Country Fridays', D, 'c')]);
    expect([out.items.length, out.dropped, out.cancelled]).toEqual([1, 2, 0]);
  });
  it('notice day and sibling day are compared in Pacific time, not UTC', () => {
    const late = at('Country Fridays', D, 's', { startsAt: '2026-10-31T06:30:00Z' }); // 23:30 Pacific on Oct 30
    const out = applyNotices([N(), late]);
    expect([out.dropped, out.cancelled]).toEqual([1, 1]);
  });
});

describe('isNoticeTitle (rule a and b spot checks)', () => {
  it.each([
    ['Closing at 4PM', true], ['Closed Today', true], ['Closed until Monday', true], ['Special Hours', true],
    ['Closed-Course Criterium', false], ['Rocky Horror: Closing Tonight', false], ['Closing Tonight, Our Town', false],
    ['Show (closing at 9)', false], ['Les Mis Closing Tonight', true], ['Closed: Private Event', false],
  ])('%s', (t, want) => { expect(isNoticeTitle(t)).toBe(want); });
  it('rule (c) needs context', () => {
    expect(isNoticeTitle('No Trivia Today')).toBe(false);
    expect(isNoticeTitle('No Trivia Today', true)).toBe(true);
    expect(isNoticeTitle('No Trivia Tonight!', true)).toBe(false);
  });
});

describe('AC-M1-168 regression rows and applyNotices keeps look-alikes', () => {
  it('applyNotices keeps "NO SCHOOL - Example Holiday" (all-day) and "Closing Day Celebration"', () => {
    const school = { ...at('NO SCHOOL - Example Holiday', D, 'a'), allDay: true, startDate: D, endDate: shift(D, 1) };
    const out = applyNotices([school, at('Closing Day Celebration', D, 'b')]);
    expect(out.items.map((i) => i.externalKey).sort()).toEqual(['a', 'b']);
    expect(out.dropped).toBe(0);
  });
});
