// Kids live (Spec_Kids_Live K1, AC-K-01 .. 08): the LibCal RSS adapter over a fake network and the real-shaped fixtures.
import { describe, expect, it } from 'vitest';
import { adapter, audienceHints } from './rssLibcal';
import { createPoliteFetch } from '../core/politeFetch';
import type { SourceEvent } from '../types';
import { fakeNet, fixture, makeClock, source, text, SOURCE_EVENT_KEYS } from '../testing/fakes';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const TRUCKEE_FEED = 'https://nevadacountyca.libcal.com/rss.php?cid=20247&m=month&cam=8465';
const KB_FEED = 'https://placer.libcal.com/rss.php?cid=22618&m=month';
const ROBOTS = fixture('libcal/robots.txt');
const TRUCKEE = fixture('libcal/truckee.rss');
const KB = fixture('libcal/placer-kings-beach.rss');

const truckeeCfg = {
  feedUrl: TRUCKEE_FEED, campus: 'Truckee Library', tz: 'America/Los_Angeles', venueName: 'Truckee Library',
  address: '10031 Levon Ave, Truckee, CA 96161', town: 'Truckee', lat: 39.325158, lng: -120.200003,
};
const kbCfg = {
  feedUrl: KB_FEED, campus: 'Kings Beach Library', tz: 'America/Los_Angeles', venueName: 'Kings Beach Library',
  address: '301 Secline St, Kings Beach, CA 96143', town: 'Kings Beach', lat: 39.238603, lng: -120.029914,
};

function harness(body: string | ((u: URL) => Response), cfg: Record<string, unknown> = truckeeCfg, host = 'nevadacountyca.libcal.com') {
  const clock = makeClock(NOW);
  const net = fakeNet((u) => {
    if (u.pathname === '/robots.txt') return text(ROBOTS);
    return typeof body === 'string' ? text(body, 200, { 'content-type': 'application/rss+xml' }) : body(u);
  }, clock.now);
  const src = source({ slug: 'libcal-test', family: 'rss_libcal', config: cfg, allowed_hosts: [host], allowed_methods: ['feed'], page_cap: 1 });
  const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
  return { run: () => adapter.fetch({ source: src, fetch: pf, now: new Date(NOW) }), net };
}

const byTitle = (items: SourceEvent[], t: string) => items.filter((i) => i.title === t);
const item = (o: Partial<Record<'title' | 'link' | 'id' | 'date' | 'start' | 'end' | 'campus' | 'desc', string>> & { aud?: string[]; cats?: string[] } = {}) => {
  const id = o.id ?? '900001';
  return `<item><title>${o.title ?? 'Preschool Storytime'}</title><link>${o.link ?? `https://nevadacountyca.libcal.com/event/${id}`}</link>`
    + `${(o.cats ?? []).map((c) => `<category>${c}</category>`).join('')}<libcal:eventid>${id}</libcal:eventid>`
    + `<libcal:date>${o.date ?? '2026-11-05'}</libcal:date><libcal:start>${o.start ?? '10:30:00'}</libcal:start><libcal:end>${o.end ?? '11:00:00'}</libcal:end>`
    + `<libcal:description>${o.desc ?? '&lt;p&gt;Stories and songs.&lt;/p&gt;'}</libcal:description><libcal:campus>${o.campus ?? 'Truckee Library'}</libcal:campus>`
    + `${(o.aud ?? ['Preschool']).map((a) => `<libcal:audience>${a}</libcal:audience>`).join('')}</item>`;
};
const feed = (...items: string[]) => `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:libcal="https://libcal.com/rss_xmlns.php"><channel><title>x</title>${items.join('\n')}</channel></rss>`;

describe('identity', () => {
  it('is the rss_libcal family', () => {
    expect(adapter.family).toBe('rss_libcal');
    expect(adapter.version).toBe('rss_libcal.1');
  });
});

describe('AC-K-01 Truckee fixture', () => {
  it('every item is a Truckee Library fact row with the config venue and the item link', async () => {
    const r = await harness(TRUCKEE).run();
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(25);
    for (const i of r.items) {
      expect(Object.keys(i).every((k) => SOURCE_EVENT_KEYS.has(k)), Object.keys(i).join()).toBe(true);
      expect(i.venueName).toBe('Truckee Library');
      expect(i.address).toBe('10031 Levon Ave, Truckee, CA 96161');
      expect([i.lat, i.lng]).toEqual([39.325158, -120.200003]);
      expect(i.url).toMatch(/^https:\/\/nevadacountyca\.libcal\.com\/event\/\d+$/);
      expect(i.externalKey).toMatch(/^libcal:nevadacountyca\.libcal\.com#\d+$/);
      expect(JSON.stringify(i)).not.toMatch(/All ages welcome|cloudfront/);
    }
    expect(new Set(r.items.map((i) => i.externalKey)).size).toBe(25);
  });
  it('one GET of the feed URL after robots, as a conditional feed request', async () => {
    const h = harness(TRUCKEE);
    await h.run();
    expect(h.net.urls()).toEqual(['https://nevadacountyca.libcal.com/robots.txt', TRUCKEE_FEED]);
  });
  it('kids per branch on the fixtures: Truckee 10, Kings Beach 8', async () => {
    const t = await harness(TRUCKEE).run();
    expect(t.items.filter((i) => i.categoriesHint.includes('kids'))).toHaveLength(10);
    const k = await harness(KB, kbCfg, 'placer.libcal.com').run();
    expect(k.items).toHaveLength(10);
    expect(k.items.filter((i) => i.categoriesHint.includes('kids'))).toHaveLength(8);
  });
});

describe('AC-K-02 / AC-K-03 audience rule (organizer labels only)', () => {
  const kids = (aud: string[]) => audienceHints(aud).includes('audience:kids');
  it('child audiences without an adult audience are kids', () => {
    expect(kids(['Ages 5-10', 'Tweens', 'Ages 8-12'])).toBe(true);
    expect(kids(['Preschool', 'Babies', 'Toddlers'])).toBe(true);
    expect(kids(['Teens', 'Ages 5-10', 'Preschool', 'Tweens', 'Ages 8-12'])).toBe(true);
    expect(kids(['Preschool (3-5 years)'])).toBe(true);
    expect(kids(['Babies (0-24 months)'])).toBe(true);
    expect(kids(['School age (ages 5 and up)'])).toBe(true);
    expect(kids(['Toddlers (18-36 months)', 'Preschool (3-5 years)', 'School age (ages 5 and up)'])).toBe(true);
  });
  it('any adult audience, teens alone, or an older age band is not kids', () => {
    expect(kids(['Teens', 'Adults', 'Seniors (65+)', 'Tweens', 'Ages 8-12'])).toBe(false);
    expect(kids(['Adults (18 and up)'])).toBe(false);
    expect(kids(['Teens', 'Adults', 'Seniors (65+)'])).toBe(false);
    expect(kids(['Ages 13-18'])).toBe(false);
    expect(kids(['Teens'])).toBe(false);
    expect(kids([])).toBe(false);
  });
  it('families / all ages give family, never with an adult audience', () => {
    expect(audienceHints(['Families'])).toEqual(['audience:family']);
    expect(audienceHints(['All Ages', 'Adults'])).toEqual([]);
  });
  it('end to end: the fixture rows', async () => {
    const r = await harness(TRUCKEE).run();
    const has = (t: string) => byTitle(r.items, t).every((i) => i.categoriesHint.includes('kids')) && byTitle(r.items, t).length > 0;
    expect(has('Lego/Duplo Club')).toBe(true);
    expect(has('Preschool Storytime')).toBe(true);
    expect(has('Craft at the Library: Egg Carton Mushrooms')).toBe(true);
    for (const t of ['3D Printer Certification', 'Wild About Wool in Truckee', 'Next Chapter Book Club']) {
      expect(byTitle(r.items, t).length, t).toBeGreaterThan(0);
      expect(byTitle(r.items, t).some((i) => i.categoriesHint.includes('kids')), t).toBe(false);
    }
  });
  it('a LibCal category never gives kids (Storytime category, adult audience)', async () => {
    const r = await harness(feed(item({ title: 'Storytime for Grown-Ups', cats: ['Storytime'], aud: ['Adults'] }))).run();
    expect(r.items[0].categoriesHint).not.toContain('kids');
  });
});

describe('AC-K-09 audience authority end to end (family rss_libcal)', () => {
  const one = async (o: Parameters<typeof item>[0]) => (await harness(feed(item(o), item({ id: '901' }), item({ id: '902' }), item({ id: '903' }))).run()).items[0];
  it('an adult-audience storytime is neither kids nor family', async () => {
    const i = await one({ title: 'Preschool Storytime', aud: ['Adults'] });
    expect(i.categoriesHint).not.toContain('kids');
    expect(i.categoriesHint).not.toContain('family');
  });
  it('an audience-only Builders Club is kids with no adult_signal conflict', async () => {
    const i = await one({ title: 'Builders Club at the Tahoe City Library', aud: ['Toddlers (18-36 months)', 'Preschool (3-5 years)'] });
    expect(i.categoriesHint).toContain('kids');
    expect(i.tagReasons ?? []).not.toContain('conflict:adult_signal');
  });
  it('description positives never give kids/family for an adult audience', async () => {
    const i = await one({ title: 'Spanish Conversation', aud: ['Adults'], desc: '&lt;p&gt;Kids welcome! Family friendly.&lt;/p&gt;' });
    expect(i.categoriesHint).not.toContain('kids');
    expect(i.categoriesHint).not.toContain('family');
  });
  it('raw Kids / Family categories and a forged audience: label are not honored', async () => {
    for (const cats of [['Kids'], ['Family'], ['audience:kids'], ['Children', 'Youth']]) {
      const i = await one({ title: 'Open Studio', aud: ['Teens'], cats });
      expect(i.categoriesHint, cats.join()).not.toContain('kids');
      expect(i.categoriesHint, cats.join()).not.toContain('family');
    }
  });
});

describe('AC-K-04 other campus', () => {
  it('is dropped and counted', async () => {
    const r = await harness(feed(item({ id: '1' }), item({ id: '2', campus: 'Grass Valley Library' }))).run();
    expect(r.items.map((i) => i.externalKey)).toEqual(['libcal:nevadacountyca.libcal.com#1']);
    expect(r.filteredBy?.other_campus).toBe(1);
    expect(r.filtered).toBe(1);
  });
});

describe('AC-K-05 shapes', () => {
  it('bad rows are dropped and counted; the good one stays', async () => {
    const r = await harness(feed(
      item({ id: '1' }), item({ id: '2' }), item({ id: '3' }), item({ id: '4' }), item({ id: '5' }), item({ id: '6' }),
      item({ id: 'x7' }), item({ id: '8', date: '2026-02-30' }), item({ id: '9', start: '10:30' }),
      item({ id: '10', link: 'https://evil.example/event/10' }), item({ id: '11', title: '  ' }),
    )).run();
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(6);
    expect(r.filtered).toBe(5);
  });
  it('more than half bad (>= 4 items) is layout_changed; no channel is layout_changed', async () => {
    const r = await harness(feed(item({ id: '1' }), item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }))).run();
    expect(r.status).toBe('parse_error');
    expect(r.errorCode).toBe('layout_changed');
    const n = await harness('<?xml version="1.0"?><html><body>maintenance</body></html>').run();
    expect(n.errorCode).toBe('layout_changed');
  });
  it('dates outside today .. today+120 are dropped quietly (not shape failures)', async () => {
    const r = await harness(feed(item({ id: '1', date: '2026-10-29' }), item({ id: '2', date: '2027-03-30' }), item({ id: '3' }), item({ id: '4' }))).run();
    expect(r.status).toBe('ok');
    expect(r.items.map((i) => i.externalKey.split('#')[1])).toEqual(['3', '4']);
  });
});

describe('AC-K-06 times', () => {
  it('a timed row converts from Pacific; end <= start gives no end; 00:00-23:59 is all-day', async () => {
    const r = await harness(feed(
      item({ id: '1', date: '2026-11-06', start: '16:00:00', end: '17:00:00' }),
      item({ id: '2', date: '2026-11-06', start: '16:00:00', end: '16:00:00' }),
      item({ id: '3', date: '2026-11-07', start: '00:00:00', end: '23:59:00' }),
      item({ id: '4', date: '2026-11-08', start: '16:00:00', end: '25:00:00' }),
      item({ id: '5', date: '2026-11-08', start: '24:00:00', end: '25:00:00' }),
    )).run();
    expect(r.items.map((i) => i.externalKey.split('#')[1])).toEqual(['1', '2', '3', '4']);
    expect(r.items[3].endsAt).toBeUndefined();
    const [a, b, c] = r.items;
    expect(a.startsAt).toBe('2026-11-07T00:00:00Z');
    expect(a.endsAt).toBe('2026-11-07T01:00:00Z');
    expect(a.allDay).toBe(false);
    expect(b.endsAt).toBeUndefined();
    expect(c.allDay).toBe(true);
    expect([c.startDate, c.endDate]).toEqual(['2026-11-07', '2026-11-08']);
    expect(c.startsAt).toBe('2026-11-07T08:00:00Z');
  });
});

describe('AC-K-07 config', () => {
  const bad = async (cfg: Record<string, unknown>, host = 'nevadacountyca.libcal.com') => {
    await expect(harness(feed(item()), cfg, host).run()).rejects.toThrow('config_libcal_invalid');
  };
  it('unknown key, foreign host, extra query keys, bad coordinates', async () => {
    await bad({ ...truckeeCfg, extra: 1 });
    await bad({ ...truckeeCfg, feedUrl: 'https://placer.libcal.com/rss.php?cid=22618&m=month' });
    await bad({ ...truckeeCfg, feedUrl: 'https://evil.example/rss.php?cid=1&m=month' }, 'evil.example');
    await bad({ ...truckeeCfg, feedUrl: `${TRUCKEE_FEED}&audience=1` });
    await bad({ ...truckeeCfg, feedUrl: 'http://nevadacountyca.libcal.com/rss.php?cid=20247&m=month' });
    await bad({ ...truckeeCfg, lat: 'x' });
    await bad({ ...truckeeCfg, campus: '' });
  });
});

describe('AC-K-08 status', () => {
  it('304 is not_modified; 500 is http_error', async () => {
    const nm = await harness(() => new Response(null, { status: 304 })).run();
    expect(nm.status).toBe('not_modified');
    const e = await harness(() => text('down', 500)).run();
    expect(e.status).toBe('http_error');
  });
});
