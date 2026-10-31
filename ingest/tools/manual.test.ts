// Spec_Manual_Sources M1 (AC-M1-01 .. 06): the manual mappers on trimmed fixtures of the real answers (2026-10-31), the curl fetch
// shim, and `scripts/manual-read.sh all`. No network: the shim gets a fake http and an injected clock.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { curlFetch, ManualBlock, manualAdapter, mapElfsight, mapGcal, mapSquarespace, postProcess, titleTime, withVenue, SPACING_MS } from './manual';
import { curlArgs } from './manualDb';
import { adapter as tribe } from '../adapters/tribe';
import { fakePolite, fixture, source } from '../testing/fakes';
import type { GrantOut, SourceEvent } from '../types';

const NOW = new Date('2026-10-31T08:00:00Z'); // 2026-10-31 01:00 in Los Angeles
const fx = (n: string) => fixture(`manual/${n}`);

const BOA = {
  mapper: 'manual_gcal', tz: 'America/Los_Angeles', town: 'Truckee', hints: ['music'],
  feedUrl: 'https://calendar.google.com/calendar/ical/pvq7se1vhdtap3i4bsa990jbas%40group.calendar.google.com/public/basic.ics',
  link: 'https://www.barofamerica.com/music.html',
  venue: { name: 'Bar of America', address: '10040 Donner Pass Rd, Truckee, CA 96161', lat: 39.327989, lng: -120.184929 },
};
const FF_WIDGET = 'e11cc5c3-c71b-4300-b405-829867efe6c3';
const FF = {
  mapper: 'manual_elfsight', tz: 'America/Los_Angeles', town: 'Truckee', widget: FF_WIDGET,
  feedUrl: `https://core.service.elfsight.com/p/boot/?page=https%3A%2F%2Fwww.fiftyfiftybrewing.com%2Fpages%2Fevents&w=${FF_WIDGET}`,
  link: 'https://www.fiftyfiftybrewing.com/pages/events',
  venue: { name: 'FiftyFifty Brewing Co.', address: '11197 Brockway Rd, Truckee, CA 96161', lat: 39.322527, lng: -120.165175 },
};
const TNB = {
  mapper: 'manual_squarespace', tz: 'America/Los_Angeles', town: 'Tahoe City',
  feedUrl: 'https://www.tahoenational.beer/events?format=json', link: 'https://www.tahoenational.beer/events',
  venue: { name: 'Tahoe National Brewing Co.', address: '850 North Lake Blvd, Tahoe City, CA 96145', lat: 39.1739451, lng: -120.1369173 },
};
const src = (slug: string, family: string, config: Record<string, unknown>, over: Partial<GrantOut['source']> = {}) =>
  source({ slug, family, config, allowed_hosts: ['calendar.google.com', 'www.barofamerica.com'], allowed_methods: ['feed'], page_cap: 1, ...over });

describe('titleTime', () => {
  it('reads a leading time and strips it', () => {
    expect(titleTime('9pm Blues Monsters')).toEqual({ hhmm: '21:00', rest: 'Blues Monsters' });
    expect(titleTime('9:30 pm Full Blast')).toEqual({ hhmm: '21:30', rest: 'Full Blast' });
    expect(titleTime('8 PM - Drinking with Clowns')).toEqual({ hhmm: '20:00', rest: 'Drinking with Clowns' });
    expect(titleTime('12am Late Show')).toEqual({ hhmm: '00:00', rest: 'Late Show' });
    expect(titleTime('12pm Noon Set')).toEqual({ hhmm: '12:00', rest: 'Noon Set' });
  });
  it('anything else is null', () => {
    for (const t of ['Closed for Thanksgiving', '13pm Nope', '0pm Nope', '9pm', '9pm ab', '2026 pm show', 'At 9pm Band']) expect(titleTime(t)).toBeNull();
  });
});

describe('manual_gcal (AC-M1-01)', () => {
  const r = mapGcal(fx('bar-of-america.ics'), BOA, NOW);
  const by = (t: string) => r.items.filter((i) => i.title === t);
  it('9pm Blues Monsters (all-day 2026-11-28) -> 21:00 PT, title stripped, link = config.link', () => {
    const [b] = by('Blues Monsters').filter((i) => i.startsAt.startsWith('2026-11-29'));
    expect(b).toBeDefined();
    expect(b.startsAt).toBe('2026-11-29T05:00:00Z');
    expect(b.allDay).toBe(false);
    expect(b.timeKnown).toBe(true);
    expect(b.url).toBe('https://www.barofamerica.com/music.html');
    expect(b.categoriesHint).toContain('music');
  });
  it('an all-day title without a time drops (no_time); past rows drop', () => {
    expect(r.items.some((i) => /thanksgiving/i.test(i.title))).toBe(false);
    expect(r.dropped.no_time).toBeGreaterThanOrEqual(1);
    expect(r.items.some((i) => i.title === 'Full Blast' && i.startsAt < NOW.toISOString())).toBe(false);
    expect(r.items.every((i) => !i.allDay && Date.parse(i.startsAt) >= NOW.getTime())).toBe(true);
  });
  it('a timed VEVENT stays timed and still links to the venue page, never calendar.google.com', () => {
    expect(by('Holiday Party')).toHaveLength(1);
    expect(r.items.every((i) => i.url === BOA.link)).toBe(true);
  });
  it('a multi-day all-day row with a time drops', () => {
    const multi = fx('bar-of-america.ics').replace('DTEND;VALUE=DATE:20261129', 'DTEND;VALUE=DATE:20261130');
    expect(mapGcal(multi, BOA, NOW).items.some((i) => i.startsAt === '2026-11-29T05:00:00Z')).toBe(false);
  });
  it('items outside the 120-day window are dropped', () => {
    const far = fx('bar-of-america.ics').replace('DTSTART;VALUE=DATE:20261128', 'DTSTART;VALUE=DATE:20270528').replace('DTEND;VALUE=DATE:20261129', 'DTEND;VALUE=DATE:20270529');
    expect(mapGcal(far, BOA, NOW).items.some((i) => i.startsAt.startsWith('2027-05'))).toBe(false);
  });
  it('the venue (with coordinates) comes from config in postProcess', () => {
    const p = postProcess(r.items, src('bar-of-america', 'ics', BOA));
    if ('error' in p) throw new Error(p.error);
    expect(p.items.length).toBe(r.items.length);
    expect(p.items.every((i) => i.venueName === 'Bar of America' && i.lat === 39.327989 && i.lng === -120.184929 && i.town === 'Truckee')).toBe(true);
  });
  it('not a calendar = layout_changed', () => {
    expect(() => mapGcal('<html>hi</html>', BOA, NOW)).toThrow('layout_changed');
  });
});

describe('manual_elfsight (AC-M1-02)', () => {
  const base = JSON.parse(fx('fiftyfifty-elfsight.json')) as { data: { widgets: Record<string, { data: { settings: { events: Record<string, unknown>[] } } }> } };
  const withEvents = (extra: Record<string, unknown>[]) => {
    const j = structuredClone(base);
    j.data.widgets[FF_WIDGET].data.settings.events.push(...extra);
    return JSON.stringify(j);
  };
  const ev = (id: string, over: Record<string, unknown>) => ({ id, name: `Probe ${id}`, repeatPeriod: 'noRepeat', timeZone: 'America/Los_Angeles',
    start: { type: 'datetime', date: '2026-11-12', time: '18:00' }, end: { type: 'datetime', date: '2026-11-12', time: '20:00' }, ...over });

  it('noRepeat datetime events are kept in PT; past and > 12 h spans drop by reason', () => {
    const r = mapElfsight(fx('fiftyfifty-elfsight.json'), FF, NOW);
    expect(r.items.map((i) => i.title).sort()).toEqual(['Friday Night Music: Duo Dinamico', 'Friday Night Music: Jamie Rollins', 'Friday Night Music: Taylor Carlton']);
    const j = r.items.find((i) => i.title.endsWith('Jamie Rollins'))!;
    expect(j.startsAt).toBe('2026-11-07T02:00:00Z'); // 2026-11-06 18:00 PST
    expect(j.endsAt).toBe('2026-11-07T05:00:00Z');
    expect(j.externalKey).toBe(`elfsight:${FF_WIDGET}#cdc1cd91-c2e0-43cd-8817-f141db989c0c`);
    expect(j.url).toBe(FF.link);
    expect(r.dropped.implausible_time).toBe(2);
    expect(r.dropped.out_of_window).toBe(2);
  });
  it('a repeating event, an unknown or mixed start/end type, and an end before the start drop by reason', () => {
    const r = mapElfsight(withEvents([
      ev('rep', { repeatPeriod: 'weekly' }),
      ev('unk', { start: { type: 'allday', date: '2026-11-12' }, end: { type: 'allday', date: '2026-11-12' } }),
      ev('mix', { end: { type: 'date', date: '2026-11-12' } }),
      ev('neg', { end: { type: 'datetime', date: '2026-11-12', time: '17:00' } }),
    ]), FF, NOW);
    expect(r.dropped.repeating).toBe(1);
    expect(r.dropped.type_unsupported).toBe(2);
    expect(r.dropped.implausible_time).toBe(3);
    expect(r.items.some((i) => i.title.startsWith('Probe'))).toBe(false);
  });
  it('a date event: inclusive end -> exclusive end; longer than 14 days drops', () => {
    const r = mapElfsight(withEvents([
      ev('day', { start: { type: 'date', date: '2026-11-14' }, end: { type: 'date', date: '2026-11-14' } }),
      ev('long', { start: { type: 'date', date: '2026-11-14' }, end: { type: 'date', date: '2026-12-14' } }),
    ]), FF, NOW);
    const d = r.items.find((i) => i.title === 'Probe day')!;
    expect(d.allDay).toBe(true);
    expect([d.startDate, d.endDate]).toEqual(['2026-11-14', '2026-11-15']);
    expect(r.dropped.long_range).toBe(1);
  });
  it('a wrong widget id or no settings.events = layout_changed', () => {
    expect(() => mapElfsight(fx('fiftyfifty-elfsight.json'), { ...FF, widget: '00000000-0000-0000-0000-000000000000' }, NOW)).toThrow('layout_changed');
    const j = structuredClone(base) as { data: { widgets: Record<string, { data: { settings: Record<string, unknown> } }> } };
    delete j.data.widgets[FF_WIDGET].data.settings.events;
    expect(() => mapElfsight(JSON.stringify(j), FF, NOW)).toThrow('layout_changed');
    expect(() => mapElfsight('not json', FF, NOW)).toThrow('layout_changed');
  });
});

describe('manual_squarespace (AC-M1-03)', () => {
  const base = JSON.parse(fx('tahoe-national.json')) as { upcoming: Record<string, unknown>[] };
  it('7 upcoming rows with ms times, link on the same host, venue and coordinates from the row', () => {
    const r = mapSquarespace(fx('tahoe-national.json'), TNB, NOW);
    expect(r.items).toHaveLength(7);
    for (const i of r.items) {
      expect(new URL(i.url!).hostname).toBe('www.tahoenational.beer');
      expect(i.externalKey).toMatch(/^sqs:www\.tahoenational\.beer#[0-9a-f]{24}$/);
      expect(i.venueName).toBe('Tahoe National Brewing Co.');
      expect([i.lat, i.lng]).toEqual([39.1739451, -120.1369173]);
    }
    const first = r.items.find((i) => i.externalKey.endsWith('6ad6d3e810a3e67ed5c45923'))!;
    expect(first.startsAt).toBe(new Date(1793934000886).toISOString());
    expect(first.title).toBe('Thursday Trivia at National');
  });
  it('an absolute or protocol-relative fullUrl is dropped (off_site_link); a bad end time drops', () => {
    const j = structuredClone(base);
    j.upcoming[0].fullUrl = 'https://evil.example/x';
    j.upcoming[1].fullUrl = '//evil.example/x';
    j.upcoming[2].endDate = j.upcoming[2].startDate;
    const r = mapSquarespace(JSON.stringify(j), TNB, NOW);
    expect(r.items).toHaveLength(4);
    expect(r.dropped.off_site_link).toBe(2);
    expect(r.dropped.implausible_time).toBe(1);
  });
  it('no upcoming array = layout_changed', () => {
    expect(() => mapSquarespace(JSON.stringify({ collection: {} }), TNB, NOW)).toThrow('layout_changed');
    expect(() => mapSquarespace('<html>', TNB, NOW)).toThrow('layout_changed');
  });
});

/** A fake curl: url -> { status, body }, with a clock that only moves when the shim sleeps. */
function fakeCurl(handler: (u: URL) => { status?: number; body?: string }) {
  let t = 1_000_000;
  const calls: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const deps = {
    http: async (url: string) => { calls.push({ url, at: t }); const r = handler(new URL(url)); return { status: r.status ?? 200, body: r.body ?? '' }; },
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
  };
  return { deps, calls, sleeps };
}

describe('Tribe through the curl fetch shim (AC-M1-04)', () => {
  it('yields the same items as the scheduled adapter on the same fixture', async () => {
    const BASE = 'https://events.example.test';
    const page = (u: URL) => fixture(u.searchParams.get('page') === '2' ? 'tribe/events_p2.json' : 'tribe/events_p1.json');
    const s = source({ slug: 'tribe-manual', family: 'tribe', config: { base: BASE, tz: 'America/Los_Angeles' }, allowed_hosts: ['events.example.test'], allowed_methods: ['api'], page_cap: 2 });
    const T = new Date('2026-10-15T19:00:00Z');
    const scheduled = await tribe.fetch({ source: s, fetch: fakePolite((u) => ({ body: page(u) })).fetch as never, now: T });
    const c = fakeCurl((u) => ({ body: page(u) }));
    const shim = curlFetch(s, c.deps);
    const manual = await manualAdapter(s).fetch({ source: s, fetch: shim, now: T });
    expect(manual.status).toBe('ok');
    expect(manual.items).toEqual(scheduled.items);
    expect(c.calls).toHaveLength(2);
    expect(shim.requests()).toBe(2);
  });
});

describe('the curl fetch shim (AC-M1-05)', () => {
  const s = src('bar-of-america', 'ics', BOA, { page_cap: 2 });
  it('off allowed_hosts, non-https, credentials, a port, a wrong kind, or over page_cap throw before curl runs', async () => {
    const c = fakeCurl(() => ({ body: 'BEGIN:VCALENDAR' }));
    const f = curlFetch(s, c.deps);
    await expect(f('https://evil.example/x', { kind: 'feed' })).rejects.toThrow('host_not_allowed');
    await expect(f('http://calendar.google.com/x', { kind: 'feed' })).rejects.toThrow('not_https');
    await expect(f('https://u:p@calendar.google.com/x', { kind: 'feed' })).rejects.toThrow('url_credentials_or_port');
    await expect(f('https://calendar.google.com:8443/x', { kind: 'feed' })).rejects.toThrow('url_credentials_or_port');
    await expect(f('https://calendar.google.com/x', { kind: 'api' })).rejects.toThrow('method_not_allowed');
    expect(c.calls).toHaveLength(0);
    await f('https://calendar.google.com/a', { kind: 'feed' });
    await f('https://www.barofamerica.com/b', { kind: 'feed' });
    await expect(f('https://calendar.google.com/c', { kind: 'feed' })).rejects.toThrow('page_cap');
    expect(c.calls).toHaveLength(2);
  });
  it('requests are >= 6 s apart (injected clock)', async () => {
    const c = fakeCurl(() => ({ body: 'ok' }));
    const f = curlFetch(s, c.deps);
    await f('https://calendar.google.com/a', { kind: 'feed' });
    await f('https://calendar.google.com/b', { kind: 'feed' });
    expect(c.calls[1].at - c.calls[0].at).toBeGreaterThanOrEqual(SPACING_MS);
  });
  it('401/403/429 and challenge bodies are blocks', async () => {
    for (const [status, body] of [[401, ''], [403, 'Forbidden'], [429, ''], [200, '<html><title>Attention Required! | Cloudflare</title>'], [200, 'cf-chl-bypass']] as const) {
      const f = curlFetch(s, fakeCurl(() => ({ status, body })).deps);
      const e = await f('https://calendar.google.com/a', { kind: 'feed' }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ManualBlock);
      expect((e as ManualBlock).httpStatus).toBe(status);
    }
  });
  it('a block inside the Tribe adapter surfaces as ManualBlock (not http_error or parse_error)', async () => {
    const t = source({ slug: 'diamond-peak', family: 'tribe', config: { base: 'https://www.diamondpeak.com' }, allowed_hosts: ['www.diamondpeak.com'], allowed_methods: ['api'], page_cap: 2 });
    const f = curlFetch(t, fakeCurl(() => ({ status: 200, body: '<html>Just a moment... challenge-platform</html>' })).deps);
    await expect(manualAdapter(t).fetch({ source: t, fetch: f, now: NOW })).rejects.toBeInstanceOf(ManualBlock);
  });
  it('curl argv: -q first, https only, no redirects, no user agent', () => {
    const a = curlArgs({ method: 'GET', url: 'https://calendar.google.com/x', headers: {} }, '/tmp/out');
    expect(a[0]).toBe('-q');
    expect(a).toContain('=https');
    expect(a.some((x) => x === '-A' || x === '--user-agent' || /user-agent/i.test(x))).toBe(false);
    expect(a.some((x) => x === '-L' || x === '--location')).toBe(false);
  });
});

describe('manualAdapter and postProcess', () => {
  it('maps config.mapper or Tribe; anything else throws', () => {
    expect(manualAdapter(src('a', 'ics', BOA)).version).toBe('manual_gcal.1');
    expect(manualAdapter(source({ family: 'tribe', config: { base: 'https://x.test' } })).version).toBe('tribe.1');
    expect(() => manualAdapter(source({ family: 'html', config: {} }))).toThrow('no_manual_adapter');
    expect(() => manualAdapter(source({ family: 'ics', config: { mapper: 'toString' } }))).toThrow('no_manual_adapter');
  });
  it('withVenue: config.venues match replaces a wrong venue; an item with coordinates or another venue keeps its own', () => {
    const cfg = { town: 'Incline Village', venue: { name: 'Diamond Peak Ski Resort', address: '1210 Ski Way, Incline Village, NV 89451', lat: 39.251679, lng: -119.925873 },
      venues: [{ match: 'diamond peak', name: 'Diamond Peak Ski Resort', address: '1210 Ski Way, Incline Village, NV 89451', lat: 39.251679, lng: -119.925873 }] };
    const e = { externalKey: 'k', title: 'T', startsAt: '2026-12-01T01:00:00Z', allDay: false, timeKnown: true, tz: 'America/Los_Angeles', categoriesHint: [], rawSummaryLength: 0 } as SourceEvent;
    const dp = withVenue({ ...e, venueName: 'Diamond Peak Ski Resort', address: '116 cosser st', town: 'Dayton' }, cfg);
    expect([dp.venueName, dp.address, dp.town, dp.lat]).toEqual(['Diamond Peak Ski Resort', '1210 Ski Way, Incline Village, NV 89451', 'Incline Village', 39.251679]);
    expect(withVenue({ ...e }, cfg).lat).toBe(39.251679);
    const other = withVenue({ ...e, venueName: 'Somewhere Else' }, cfg);
    expect([other.venueName, other.lat]).toEqual(['Somewhere Else', undefined]);
    expect(withVenue({ ...e, venueName: 'X', lat: 1, lng: 2 }, cfg).lat).toBe(1);
  });
  it('postProcess caps the item count, drops notices and strips members-only', () => {
    const e = (i: number, title = `Show ${i}`, cats: string[] = []) => ({ externalKey: `k${i}`, title, startsAt: '2026-12-01T01:00:00Z', allDay: false, timeKnown: true, tz: 'America/Los_Angeles', categoriesHint: cats, rawSummaryLength: 0 }) as SourceEvent;
    const s = src('bar-of-america', 'ics', BOA);
    expect(postProcess(Array.from({ length: 1001 }, (_, i) => e(i)), s)).toEqual({ error: 'too_many_items' });
    const p = postProcess([e(1, 'Live Band', ['music', 'members-only']), e(2, 'Kitchen Closed for Maintenance')], s);
    if ('error' in p) throw new Error(p.error);
    expect(p.items.map((i) => i.title)).toEqual(['Live Band']);
    expect(p.items[0].categoriesHint).toEqual(['music']);
  });
});

describe('scripts/manual-read.sh all (AC-M1-06)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tv-manual-sh-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`); chmodSync(p, 0o755); return p; };
  const run = (list: string, codes: Record<string, number>, tdrpd: number, listFails = false) => {
    const log = join(dir, `calls-${Math.random().toString(36).slice(2)}`);
    const cases = Object.entries(codes).map(([s, c]) => `  ${s}) exit ${c} ;;`).join('\n');
    const reader = script(`read-${Math.random().toString(36).slice(2)}.sh`,
      `if [ "$1" = "--list" ]; then ${listFails ? 'exit 1' : `printf '${list}'`}; exit 0; fi\necho "read $1" >> ${log}\ncase "$1" in\n${cases}\n  *) exit 9 ;;\nesac`);
    const td = script(`tdrpd-${Math.random().toString(36).slice(2)}.sh`, `echo "read tdrpd-rec1" >> ${log}\nexit ${tdrpd}`);
    const r = spawnSync('bash', [join(process.cwd(), 'scripts', 'manual-read.sh'), 'all'], { env: { ...process.env, MANUAL_READ_TS: reader, MANUAL_TDRPD: td }, encoding: 'utf8' });
    let calls: string[] = [];
    try { calls = readFileSync(log, 'utf8').trim().split('\n'); } catch { calls = []; }
    return { code: r.status, out: r.stdout, calls };
  };
  it('reads each listed source once, delegates tdrpd-rec1, skips a refused grant, exits with the worst other code', () => {
    const r = run('bar-of-america\\ndiamond-peak\\ntdrpd-rec1\\nivgid\\n', { 'bar-of-america': 0, 'diamond-peak': 3, ivgid: 2 }, 3);
    expect(r.calls).toEqual(['read bar-of-america', 'read diamond-peak', 'read tdrpd-rec1', 'read ivgid']);
    expect(r.out).toContain('manual-read diamond-peak: skipped');
    expect(r.out).toContain('manual-read tdrpd-rec1: skipped');
    expect(r.code).toBe(2);
  });
  it('all ok (and refusals) exit 0', () => {
    expect(run('a-one\\ntdrpd-rec1\\n', { 'a-one': 0 }, 0).code).toBe(0);
    expect(run('a-one\\n', { 'a-one': 3 }, 0).code).toBe(0);
  });
  it('a failed --list (CLI not linked) exits 1 and reads nothing (review P0-1: never a silent skip)', () => {
    const r = run('', {}, 0, true);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });
});
