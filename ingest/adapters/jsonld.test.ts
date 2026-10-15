// AC-M1-15 (A2: JSON-LD only). Contract assumed: parseJsonLdEvents(html, pageUrl, { tz? }) -> SourceEvent[].
import { describe, expect, it } from 'vitest';
import { parseJsonLdEvents } from './jsonld';
import { DESC_SENTINEL, fixture } from '../testing/fakes';

const PAGE = 'https://events.example.test/e/sample-1';
const iso = (s: string) => new Date(s).toISOString();

describe('parseJsonLdEvents', () => {
  it('flattens @graph, keeps the Event subtype, drops WebPage; offset times; location and geo', () => {
    const items = parseJsonLdEvents(fixture('jsonld/page.html'), PAGE, { tz: 'America/Los_Angeles' });
    expect(items).toHaveLength(1);
    const [i] = items;
    expect(i.title).toBe('Sample Jazz Evening');
    expect(iso(i.startsAt)).toBe('2026-10-21T02:00:00.000Z');
    expect(iso(i.endsAt!)).toBe('2026-10-21T04:00:00.000Z');
    expect(i.venueName).toBe('Example Hall');
    expect(i.lat).toBe(39.33);
    expect(i.lng).toBe(-120.18);
    expect(i.url).toBe(PAGE);
    expect(JSON.stringify(items)).not.toContain(DESC_SENTINEL);
  });
  it('a local startDate uses tz; eventStatus Cancelled -> cancelled', () => {
    const [i] = parseJsonLdEvents(fixture('jsonld/cancelled_local.html'), 'https://events.example.test/e/sample-2', { tz: 'America/Los_Angeles' });
    expect(iso(i.startsAt)).toBe('2026-10-22T02:00:00.000Z');
    expect(i.cancelled).toBe(true);
  });
  it('a script larger than 200 KB is ignored (generated here: fixtures are capped at 64 KB)', () => {
    const big = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Event', name: 'OVERSIZED-EVENT', startDate: '2026-10-25T19:00:00-07:00', pad: 'x'.repeat(300 * 1024) });
    expect(big.length).toBeGreaterThan(300 * 1024);
    const html = fixture('jsonld/page.html').replace('</head>', `<script type="application/ld+json">${big}</script></head>`);
    const items = parseJsonLdEvents(html, PAGE, { tz: 'America/Los_Angeles' });
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('OVERSIZED-EVENT');
  });
  it('malformed JSON in one script does not lose the others', () => {
    const html = fixture('jsonld/page.html').replace('</head>', '<script type="application/ld+json">{ not json</script></head>');
    expect(parseJsonLdEvents(html, PAGE, { tz: 'America/Los_Angeles' })).toHaveLength(1);
  });
});
