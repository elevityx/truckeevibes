// S1.8 normalize (supports AC-M1-12 .. 16 behaviours). Pure functions.
import { describe, expect, it } from 'vitest';
import { canonicalUrl, cleanTitle, decodeEntities, stripTags, toUtcFromLocal, validateSourceEvent } from './normalize';

describe('decodeEntities / stripTags', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('Fish &amp; Chips &#8211; &#x41; &quot;x&quot; &lt;b&gt;')).toBe('Fish & Chips – A "x" <b>');
  });
  it('stripTags removes markup and collapses whitespace', () => {
    expect(stripTags('<p>Sample <b>Title</b>\n here</p>')).toBe('Sample Title here');
  });
});

describe('cleanTitle', () => {
  it('keeps short titles, collapses spaces', () => { expect(cleanTitle('  Sample   Night ')).toBe('Sample Night'); });
  it('cuts to <= 80 at a word boundary', () => {
    const t = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const out = cleanTitle(t);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(t.startsWith(out)).toBe(true);
    expect(t[out.length]).toBe(' ');
  });
});

describe('toUtcFromLocal(date, time, tz)', () => {
  it('PDT and PST offsets', () => {
    expect(toUtcFromLocal('2026-10-17', '19:00', 'America/Los_Angeles')).toBe('2026-10-18T02:00:00Z');
    expect(toUtcFromLocal('2026-12-05', '19:00', 'America/Los_Angeles')).toBe('2026-12-06T03:00:00Z');
  });
  it('DST gap -> dst_gap', () => {
    expect(toUtcFromLocal('2027-03-14', '02:30', 'America/Los_Angeles')).toBe('dst_gap');
  });
  it('DST fold resolves to the daylight (first) occurrence', () => {
    expect(toUtcFromLocal('2026-11-01', '01:30', 'America/Los_Angeles')).toBe('2026-11-01T08:30:00Z');
  });
});

describe('canonicalUrl', () => {
  it('lowercases the host, drops the fragment and utm_* params, keeps other params', () => {
    expect(canonicalUrl('https://Events.Example.TEST/a/b?utm_source=x&id=7&utm_medium=y#top')).toBe('https://events.example.test/a/b?id=7');
  });
});

describe('validateSourceEvent', () => {
  const ok = {
    externalKey: 'k1', title: 'Sample Night', startsAt: '2026-10-18T02:00:00Z', allDay: false, timeKnown: true,
    tz: 'America/Los_Angeles', url: 'https://events.example.test/e/1', categoriesHint: [], rawSummaryLength: 0,
  };
  it('returns a valid event unchanged', () => { expect(validateSourceEvent({ ...ok })).toEqual(ok); });
  it.each([
    ['no externalKey', { externalKey: '' }],
    ['no title', { title: '' }],
    ['bad startsAt', { startsAt: 'next friday' }],
    ['all-day without dates', { allDay: true }],
  ])('%s -> { invalid }', (_n, patch) => {
    const r = validateSourceEvent({ ...ok, ...patch } as never);
    expect(r).toHaveProperty('invalid');
    expect(typeof (r as { invalid: string }).invalid).toBe('string');
  });
});

describe('validateSourceEvent keeps valid tagReasons (R4b)', () => {
  const base = { externalKey: 'k', title: 'T', startsAt: '2026-10-20T19:00:00Z', allDay: false, timeKnown: true, tz: 'America/Los_Angeles', categoriesHint: [], rawSummaryLength: 0 };
  it('keeps a list of known codes', () => {
    const r = validateSourceEvent({ ...base, tagReasons: ['age:ambiguous', 'price:unknown'] } as never);
    expect('invalid' in r).toBe(false);
    expect((r as { tagReasons?: string[] }).tagReasons).toEqual(['age:ambiguous', 'price:unknown']);
  });
  it('drops the field (not the item) for an unknown code, a non-array, a non-string, or more than 16', () => {
    for (const bad of [['age:made_up'], 'age:ambiguous', [1], Array.from({ length: 17 }, () => 'age:unknown')]) {
      const r = validateSourceEvent({ ...base, tagReasons: bad } as never);
      expect('invalid' in r).toBe(false);
      expect('tagReasons' in r).toBe(false);
    }
  });
  it('an item without tagReasons is returned as is', () => {
    const r = validateSourceEvent(base as never);
    expect('tagReasons' in r).toBe(false);
  });
});
