// AC-R1c-06: the picks schema, the line lint and the loader.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { lintLine, loadPicks, parsePicksFile } from './picks';
import { readPicks } from './picksFile';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ev = (n: number, startsAt: string) => ({ id: ID(n), title: `Event ${n}`, startsAt }) as VibeEvent;
// weekOf Thu 2026-10-15: the window is Oct 15 00:00 PDT (07:00Z) to Oct 22 00:00 PDT.
const EVENTS = [
  ev(1, '2026-10-16T02:00:00Z'),
  ev(2, '2026-10-15T06:59:00Z'), // 1 minute before the window
  ev(3, '2026-10-22T07:00:00Z'), // the first instant after the window
  ev(4, '2026-10-22T06:59:00Z'), // the last minute inside it
];
const file = (picks: unknown[], weekOf = '2026-10-15') => ({ weekOf, picks });
const long = (n: number) => `A${'a'.repeat(n - 1)}`;
const pick = (n: number, line = 'A short line.') => ({ eventId: ID(n), line });

describe('lintLine', () => {
  it('accepts a normal line and the limits', () => {
    expect(lintLine('Bluegrass at Alibi Truckee, Sunday 6–8:30 pm. It ends early enough for a Monday.')).toEqual([]);
    expect(lintLine(long(160))).toEqual([]);
  });
  it('flags each code', () => {
    expect(lintLine(long(161))).toEqual(['too_long']);
    expect(lintLine('See https://example.org now.')).toContain('url');
    expect(lintLine('See www.example.org now.')).toContain('url');
    expect(lintLine('A night out \u{1F389}')).toContain('emoji');
    expect(lintLine('lowercase start')).toContain('case');
    expect(lintLine('ALL CAPS LINE')).toContain('case');
    expect(lintLine('')).toContain('case');
  });
});

describe('AC-R1c-06 loadPicks', () => {
  it('keeps picks inside the week, in file order, and maps the photo', () => {
    const warns: string[] = [];
    const f = { weekOf: '2026-10-15', picks: [pick(4), { ...pick(1), photo: { src: '/photos/a.jpg', alt: 'A patio' } }] };
    const out = loadPicks(f, EVENTS, (m) => warns.push(m));
    expect(out.map((p) => p.event.id)).toEqual([ID(4), ID(1)]);
    expect(out[0].photo).toBeNull();
    expect(out[1].photo).toEqual({ src: '/photos/a.jpg', alt: 'A patio' });
    expect(warns).toEqual([]);
  });
  it('an id not in the events is dropped with exactly one warning', () => {
    const warns: string[] = [];
    expect(loadPicks(file([pick(9)]), EVENTS, (m) => warns.push(m))).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^picks: dropped 00000000 /);
  });
  it('a start before weekOf or at/after weekOf + 7 days is dropped, never a failure', () => {
    const warns: string[] = [];
    const out = loadPicks(file([pick(2), pick(3), pick(4)]), EVENTS, (m) => warns.push(m));
    expect(out.map((p) => p.event.id)).toEqual([ID(4)]);
    expect(warns).toHaveLength(2);
  });
  it('the window follows weekOf', () => {
    expect(loadPicks(file([pick(3)], '2026-10-22'), EVENTS, () => {})).toHaveLength(1);
  });
});

describe('AC-R1c-06 schema failures throw a code', () => {
  const codeOf = (f: unknown) => {
    try {
      parsePicksFile(f);
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  };
  it('six picks', () => {
    expect(codeOf(file([1, 2, 3, 4, 5, 6].map((n) => pick(n))))).toBe('picks: too_many_picks');
    expect(codeOf(file([1, 2, 3, 4, 5].map((n) => pick(n))))).toBeNull();
    expect(codeOf(file([]))).toBeNull();
  });
  it('a 161-character line, a URL, an emoji, all caps', () => {
    expect(codeOf(file([pick(1, long(161))]))).toBe('picks: pick_0_line_too_long');
    expect(codeOf(file([pick(1, 'Go to https://example.org')]))).toBe('picks: pick_0_line_url');
    expect(codeOf(file([pick(1, 'Fun night \u{1F3B6}')]))).toBe('picks: pick_0_line_emoji');
    expect(codeOf(file([pick(1, 'ALL CAPS')]))).toBe('picks: pick_0_line_case');
  });
  it('weekOf, eventId and photo rules', () => {
    expect(codeOf(file([], '2026-02-30'))).toBe('picks: bad_week_of');
    expect(codeOf(file([], 'next week'))).toBe('picks: bad_week_of');
    expect(codeOf(file([{ eventId: 'nope', line: 'A line.' }]))).toBe('picks: pick_0_bad_event_id');
    expect(codeOf(file([{ ...pick(1), photo: { src: 'https://example.org/a.jpg', alt: 'x' } }]))).toBe('picks: pick_0_bad_photo_src');
    expect(codeOf(file([{ ...pick(1), photo: { src: '/photos/../x.jpg', alt: 'x' } }]))).toBe('picks: pick_0_bad_photo_src');
    expect(codeOf(file([{ ...pick(1), photo: { src: '/photos/a.jpg', alt: '' } }]))).toBe('picks: pick_0_bad_photo_alt');
    expect(codeOf(file([{ ...pick(1), photo: { src: '/photos/a.jpg', alt: 'x'.repeat(121) } }]))).toBe('picks: pick_0_bad_photo_alt');
    expect(codeOf(file([{ ...pick(1), photo: { src: '/photos/a.jpg', alt: 'x'.repeat(120) } }]))).toBeNull();
    expect(codeOf(null)).toBe('picks: not_an_object');
  });
  it('readPicks throws the code from a file on disk (a bad pick fails the build)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'picks-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(file([pick(1, 'ALL CAPS')])));
    expect(() => readPicks(bad)).toThrow('picks: pick_0_line_case');
    expect(() => readPicks(join(dir, 'missing.json'))).toThrow('picks: unreadable');
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, JSON.stringify(file([pick(1)])));
    expect(readPicks(ok).picks).toHaveLength(1);
  });
  it('the shipped src/content/picks.json passes', () => {
    const f = readPicks(join(process.cwd(), 'src/content/picks.json'));
    expect(f.picks.length).toBeGreaterThanOrEqual(0);
    expect(f.picks.length).toBeLessThanOrEqual(5);
  });
  it('the shipped fixture picks pass too', () => {
    expect(readPicks(join(process.cwd(), 'scripts/fixtures/picks-visual.json')).picks).toHaveLength(3);
  });
});
