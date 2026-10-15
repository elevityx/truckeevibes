// AC-M1-06 .. 11 and AC-M1-55 (spec S1.8 politeFetch, as amended by A2 crawl-delay and A3 redirect hops).
// Contract assumed beyond the spec text (see the report): deps = { fetch, now(): number, sleep(ms), timeoutSignal?(ms) },
// FetchError has `.code`, and the returned function also exposes `.robotsInfo(host)` and `.fetchRobots(host)`.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeAiBotsBlocked, createPoliteFetch, FetchError, type PoliteDeps } from './politeFetch';
import { createSpacer } from './rateLimit';
import { fakeNet, fixture, makeClock, redirect, source, text, T0, UA } from '../testing/fakes';

const ROBOTS_URL = 'https://a.test/robots.txt';

/** Build a PoliteFetch over a fake network. `robots` is the body of a.test/robots.txt, or a Response, or null for 404. */
function setup(opts: { robots?: string | Response | null; src?: Parameters<typeof source>[0]; routes?: Record<string, Response | (() => Response)> } = {}) {
  const clock = makeClock();
  const routes = opts.routes ?? {};
  const net = fakeNet((u) => {
    if (u.pathname === '/robots.txt' && !(u.href in routes)) {
      const r = opts.robots;
      if (r instanceof Response) return r;
      return r == null ? text('not found', 404) : text(r);
    }
    const hit = routes[u.href];
    if (hit) return typeof hit === 'function' ? hit() : hit;
    return text('ok body');
  }, clock.now);
  const pf = createPoliteFetch(source(opts.src), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
  return { pf, net, clock };
}
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(FetchError); return (e as FetchError).code; }
  return 'no-error';
};
const content = (net: ReturnType<typeof fakeNet>) => net.urls().filter((u) => !u.endsWith('/robots.txt'));

describe('legal gate and method gate (AC-M1-06, AC-M1-07)', () => {
  it.each([
    ['unknown', '2027-10-14T00:00:00Z'],
    ['prohibited', '2027-10-14T00:00:00Z'],
    ['permission_required', '2027-10-14T00:00:00Z'],
    ['permitted', '2026-10-01T00:00:00Z'], // recheck already passed
    ['permitted', null], // never reviewed
  ])('disposition %s recheck %s -> terms_gate with 0 network calls', async (d, r) => {
    const { pf, net } = setup({ src: { ingest_disposition: d, terms_recheck_at: r } });
    expect(await code(pf('https://a.test/events', { kind: 'feed' }))).toBe('terms_gate');
    expect(net.calls).toHaveLength(0);
  });

  it('official_api_only passes the gate for api requests', async () => {
    const { pf } = setup({ src: { ingest_disposition: 'official_api_only', allowed_methods: ['api'] } });
    const out = await pf('https://a.test/wp-json/x', { kind: 'api' });
    expect(out.status).toBe(200);
  });

  it('the robots.txt fetch is exempt from the legal gate', async () => {
    const { pf, net } = setup({ robots: 'User-agent: *\nDisallow: /admin\n', src: { ingest_disposition: 'unknown' } });
    await pf.fetchRobots('a.test');
    expect(net.urls()).toEqual([ROBOTS_URL]);
  });

  it('allowed_methods [feed] with kind html -> method_gate, 0 calls', async () => {
    const { pf, net } = setup({ src: { allowed_methods: ['feed'] } });
    expect(await code(pf('https://a.test/events', { kind: 'html' }))).toBe('method_gate');
    expect(net.calls).toHaveLength(0);
  });
});

describe('https and allowed_hosts', () => {
  it('http:// is refused before any request', async () => {
    const { pf, net } = setup();
    expect(await code(pf('http://a.test/feed', { kind: 'feed' }))).toBe('host_not_allowed');
    expect(net.calls).toHaveLength(0);
  });
  it.each(['https://b.test/feed', 'https://a.test.evil.test/feed', 'https://nota.test/feed'])('%s is not allowed', async (u) => {
    const { pf, net } = setup();
    expect(await code(pf(u, { kind: 'feed' }))).toBe('host_not_allowed');
    expect(net.calls).toHaveLength(0);
  });
  it('a subdomain of an allowed host is allowed', async () => {
    const { pf } = setup();
    expect((await pf('https://www.a.test/feed', { kind: 'feed' })).status).toBe(200);
  });
});

describe('robots (AC-M1-08)', () => {
  it('a Disallow / for TruckeeVibesBot blocks, and only /robots.txt was fetched', async () => {
    const { pf, net } = setup({ robots: 'User-agent: TruckeeVibesBot\nDisallow: /\n' });
    expect(await code(pf('https://a.test/events', { kind: 'feed' }))).toBe('robots_blocked');
    expect(net.urls()).toEqual([ROBOTS_URL]);
  });
  it('the * group applies when there is no group for us', async () => {
    const { pf, net } = setup({ robots: 'User-agent: *\nDisallow: /events\n' });
    expect(await code(pf('https://a.test/events/x', { kind: 'feed' }))).toBe('robots_blocked');
    expect(content(net)).toEqual([]);
    expect((await pf('https://a.test/other', { kind: 'feed' })).status).toBe(200);
  });
  it('our own group takes precedence over *', async () => {
    const { pf } = setup({ robots: 'User-agent: *\nDisallow: /\n\nUser-agent: TruckeeVibesBot\nDisallow: /private\n' });
    expect((await pf('https://a.test/events', { kind: 'feed' })).status).toBe(200);
    expect(await code(pf('https://a.test/private/x', { kind: 'feed' }))).toBe('robots_blocked');
  });
  it('rules written for AI bots do not apply to us', async () => {
    const { pf } = setup({ robots: 'User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n' });
    expect((await pf('https://a.test/events', { kind: 'feed' })).status).toBe(200);
  });
  it('404 robots = allowed; 503 and a network error = blocked', async () => {
    const a = setup({ robots: null });
    expect((await a.pf('https://a.test/events', { kind: 'feed' })).status).toBe(200);
    const b = setup({ robots: text('down', 503) });
    expect(await code(b.pf('https://a.test/events', { kind: 'feed' }))).toBe('robots_blocked');
    expect(content(b.net)).toEqual([]);
    const clock = makeClock();
    const net = fakeNet((u) => { if (u.pathname === '/robots.txt') throw new TypeError('network down'); return text('x'); }, clock.now);
    const pf = createPoliteFetch(source(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    expect(await code(pf('https://a.test/events', { kind: 'feed' }))).toBe('robots_blocked');
    expect(content(net)).toEqual([]);
  });
  it('robots.txt is fetched once per host per run, with our User-Agent', async () => {
    const { pf, net } = setup({ robots: 'User-agent: *\nDisallow:\n' });
    await pf('https://a.test/one', { kind: 'feed' });
    await pf('https://a.test/two', { kind: 'feed' });
    expect(net.urls().filter((u) => u === ROBOTS_URL)).toHaveLength(1);
    expect(net.calls[0].headers.get('user-agent')).toBe(UA);
  });
});

describe('redirects (AC-M1-09, A3)', () => {
  it('to a host not in allowed_hosts -> redirect_blocked, target never requested', async () => {
    const { pf, net } = setup({ routes: { 'https://a.test/feed': redirect('https://evil.test/feed') } });
    expect(await code(pf('https://a.test/feed', { kind: 'feed' }))).toBe('redirect_blocked');
    expect(net.urls().some((u) => u.includes('evil.test'))).toBe(false);
  });
  it('to http:// on an allowed host -> redirect_blocked', async () => {
    const { pf, net } = setup({ routes: { 'https://a.test/feed': redirect('http://a.test/feed') } });
    expect(await code(pf('https://a.test/feed', { kind: 'feed' }))).toBe('redirect_blocked');
    expect(net.urls()).not.toContain('http://a.test/feed');
  });
  it('to an allowed subdomain over https is followed; a relative Location resolves against the current URL', async () => {
    const { pf, net } = setup({ routes: {
      'https://a.test/feed': redirect('https://www.a.test/feed2'),
      'https://www.a.test/feed2': redirect('/final'),
    } });
    const out = await pf('https://a.test/feed', { kind: 'feed' });
    expect(out.status).toBe(200);
    expect(content(net)).toEqual(['https://a.test/feed', 'https://www.a.test/feed2', 'https://www.a.test/final']);
    expect(net.calls.every((c) => c.init.redirect === 'manual')).toBe(true);
  });
  it('5 hops are followed, the 6th -> redirect_blocked', async () => {
    const routes: Record<string, Response> = {};
    for (let i = 0; i < 6; i++) routes[`https://a.test/r${i}`] = redirect(`https://a.test/r${i + 1}`);
    const six = setup({ routes });
    expect(await code(six.pf('https://a.test/r0', { kind: 'feed' }))).toBe('redirect_blocked');
    const five = setup({ routes: { ...routes, 'https://a.test/r5': text('done') } });
    expect((await five.pf('https://a.test/r0', { kind: 'feed' })).status).toBe(200);
  });
  it('www -> apex: the apex robots.txt is fetched before the apex URL; a disallow there blocks and the URL is never requested', async () => {
    const clock = makeClock();
    const net = fakeNet((u) => {
      if (u.href === 'https://www.a.test/robots.txt') return text('User-agent: *\nDisallow:\n');
      if (u.href === 'https://a.test/robots.txt') return text('User-agent: *\nDisallow: /feed\n');
      if (u.href === 'https://www.a.test/feed') return redirect('https://a.test/feed', 301);
      return text('x');
    }, clock.now);
    const pf = createPoliteFetch(source(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    expect(await code(pf('https://www.a.test/feed', { kind: 'feed' }))).toBe('robots_blocked');
    const urls = net.urls();
    expect(urls.indexOf('https://a.test/robots.txt')).toBeGreaterThan(-1);
    expect(urls).not.toContain('https://a.test/feed');
  });
  it('www -> apex with permissive robots: apex robots.txt precedes the apex content request', async () => {
    const clock = makeClock();
    const net = fakeNet((u) => {
      if (u.pathname === '/robots.txt') return text('User-agent: *\nDisallow:\n');
      if (u.href === 'https://www.a.test/feed') return redirect('https://a.test/feed', 301);
      return text('x');
    }, clock.now);
    const pf = createPoliteFetch(source(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    await pf('https://www.a.test/feed', { kind: 'feed' });
    const urls = net.urls();
    expect(urls.indexOf('https://a.test/robots.txt')).toBeLessThan(urls.indexOf('https://a.test/feed'));
  });
  it('a same-host redirect to ?format=ical under Disallow: /*?format=ical -> robots_blocked, target not requested', async () => {
    const { pf, net } = setup({
      robots: 'User-agent: *\nDisallow: /*?format=ical\n',
      routes: { 'https://a.test/events': redirect('/events?format=ical') },
    });
    expect(await code(pf('https://a.test/events', { kind: 'feed' }))).toBe('robots_blocked');
    expect(net.urls()).not.toContain('https://a.test/events?format=ical');
  });
  it('page_cap 2: a request plus 2 hops -> page_cap on the second hop (hops count)', async () => {
    const { pf, net } = setup({ src: { page_cap: 2 }, routes: {
      'https://a.test/h0': redirect('/h1'), 'https://a.test/h1': redirect('/h2'), 'https://a.test/h2': text('end'),
    } });
    expect(await code(pf('https://a.test/h0', { kind: 'feed' }))).toBe('page_cap');
    expect(content(net)).toEqual(['https://a.test/h0', 'https://a.test/h1']);
  });
});

describe('spacing, caps, timeout, conditional requests (AC-M1-10)', () => {
  it('three requests to one host start >= 1,000 ms apart (including after the robots fetch)', async () => {
    const { pf, net } = setup({ robots: 'User-agent: *\nDisallow:\n' });
    for (const p of ['/1', '/2', '/3']) await pf(`https://a.test${p}`, { kind: 'feed' });
    const at = net.calls.map((c) => c.at);
    expect(at).toHaveLength(4); // robots + 3
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1000);
  });
  it('page_cap 2: the third request -> page_cap', async () => {
    const { pf } = setup({ src: { page_cap: 2 } });
    await pf('https://a.test/1', { kind: 'feed' });
    await pf('https://a.test/2', { kind: 'feed' });
    expect(await code(pf('https://a.test/3', { kind: 'feed' }))).toBe('page_cap');
  });
  it('a 5 MB body passes, 5 MB + 1 byte -> too_large', async () => {
    const MB5 = 5 * 1024 * 1024;
    const ok = setup({ routes: { 'https://a.test/big': new Response(new Uint8Array(MB5)) } });
    expect((await ok.pf('https://a.test/big', { kind: 'feed' })).body.byteLength).toBe(MB5);
    const over = setup({ routes: { 'https://a.test/big': new Response(new Uint8Array(MB5 + 1)) } });
    expect(await code(over.pf('https://a.test/big', { kind: 'feed' }))).toBe('too_large');
  });
  it('requests time out at 20,000 ms -> timeout', async () => {
    const clock = makeClock();
    const asked: number[] = [];
    const ctrl = new AbortController();
    const net = fakeNet((u, init) => {
      if (u.pathname === '/robots.txt') return text('User-agent: *\nDisallow:\n');
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        ctrl.abort(); // the 20 s deadline "elapses"
      });
    }, clock.now);
    const pf = createPoliteFetch(source(), {
      fetch: net.fetch, now: clock.now, sleep: clock.sleep, timeoutSignal: (ms: number) => { asked.push(ms); return ctrl.signal; },
    });
    expect(await code(pf('https://a.test/slow', { kind: 'feed' }))).toBe('timeout');
    expect(asked).toContain(20_000);
  });
  it('every request (robots included) carries the exact User-Agent and an Accept header', async () => {
    const { pf, net } = setup();
    await pf('https://a.test/x', { kind: 'feed' });
    expect(net.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of net.calls) {
      expect(c.headers.get('user-agent')).toBe(UA);
      expect(c.headers.get('accept')).toBeTruthy();
    }
  });
  it('conditional requests send the stored validators; 304 -> notModified', async () => {
    const { pf, net } = setup({
      src: { etag: 'W/"abc"', last_modified: 'Wed, 14 Oct 2026 10:00:00 GMT' },
      routes: { 'https://a.test/feed': new Response(null, { status: 304 }) },
    });
    const out = await pf('https://a.test/feed', { kind: 'feed', conditional: true });
    expect(out.notModified).toBe(true);
    const c = net.calls.find((x) => x.url === 'https://a.test/feed')!;
    expect(c.headers.get('if-none-match')).toBe('W/"abc"');
    expect(c.headers.get('if-modified-since')).toBe('Wed, 14 Oct 2026 10:00:00 GMT');
  });
  it('non-conditional requests send no validators', async () => {
    const { pf, net } = setup({ src: { etag: 'W/"abc"', last_modified: 'x' } });
    await pf('https://a.test/feed', { kind: 'feed' });
    const c = net.calls.find((x) => x.url === 'https://a.test/feed')!;
    expect(c.headers.get('if-none-match')).toBeNull();
    expect(c.headers.get('if-modified-since')).toBeNull();
  });
  it('returns status, headers, body bytes and notModified=false for a 200', async () => {
    const { pf } = setup({ routes: { 'https://a.test/feed': text('hello', 200, { etag: '"e1"' }) } });
    const out = await pf('https://a.test/feed', { kind: 'feed' });
    expect(out.status).toBe(200);
    expect(out.notModified).toBe(false);
    expect(new TextDecoder().decode(out.body)).toBe('hello');
    expect(out.headers.get('etag')).toBe('"e1"');
  });
});

describe('aiBotsBlocked (AC-M1-11)', () => {
  it('ClaudeBot Disallow: / -> true; * Disallow: /admin only -> false', async () => {
    const a = setup({ robots: 'User-agent: ClaudeBot\nDisallow: /\n' });
    await a.pf('https://a.test/x', { kind: 'feed' });
    expect(a.pf.robotsInfo('a.test')?.aiBotsBlocked).toBe(true);
    const b = setup({ robots: 'User-agent: *\nDisallow: /admin\n' });
    await b.pf('https://a.test/x', { kind: 'feed' });
    expect(b.pf.robotsInfo('a.test')?.aiBotsBlocked).toBe(false);
  });
  it('robotsInfo.hash is the sha256 hex of the robots body', async () => {
    const body = 'User-agent: *\nDisallow: /admin\n';
    const { pf } = setup({ robots: body });
    await pf('https://a.test/x', { kind: 'feed' });
    expect(pf.robotsInfo('a.test')?.hash).toBe(createHash('sha256').update(body).digest('hex'));
  });
  it.each(['ClaudeBot', 'Claude-SearchBot', 'anthropic-ai', 'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'CCBot', 'Google-Extended',
    'Bytespider', 'PerplexityBot', 'Applebot-Extended', 'meta-externalagent'])('computeAiBotsBlocked sees %s', (bot) => {
    expect(computeAiBotsBlocked(`User-agent: ${bot}\nDisallow: /\n`)).toBe(true);
  });
  it('a partial disallow (/private) or an unrelated bot is not "blocked"', () => {
    expect(computeAiBotsBlocked('User-agent: GPTBot\nDisallow: /private\n')).toBe(false);
    expect(computeAiBotsBlocked('User-agent: SomeOtherBot\nDisallow: /\n')).toBe(false);
    expect(computeAiBotsBlocked('')).toBe(false);
  });
});

describe('crawl-delay (AC-M1-55, A2/A3)', () => {
  const twoContent = async (robots: string) => {
    const s = setup({ robots });
    await s.pf('https://a.test/1', { kind: 'feed' });
    await s.pf('https://a.test/2', { kind: 'feed' });
    return s.net.calls.filter((c) => !c.url.endsWith('/robots.txt')).map((c) => c.at);
  };
  it('TruckeeVibesBot group Crawl-delay 10 -> content requests >= 10,000 ms apart', async () => {
    const at = await twoContent(fixture('robots/crawl_delay_group.txt'));
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(10_000);
  });
  it('the first content request also waits the delay after the robots fetch', async () => {
    const s = setup({ robots: fixture('robots/crawl_delay_group.txt') });
    await s.pf('https://a.test/1', { kind: 'feed' });
    expect(s.net.calls[1].at - s.net.calls[0].at).toBeGreaterThanOrEqual(10_000);
  });
  it('* group Crawl-delay 0.5 -> floor of 1,000 ms (and no more)', async () => {
    const at = await twoContent(fixture('robots/crawl_delay_star.txt'));
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
    expect(at[1] - at[0]).toBeLessThan(2000);
  });
  it('a Crawl-delay line before the first User-agent line -> 10,000 ms', async () => {
    const at = await twoContent(fixture('robots/crawl_delay_pregroup.txt'));
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(10_000);
  });
  it('the largest of the pre-group line and a group value wins (A6-1, replaces "group overrides pre-group")', async () => {
    const at = await twoContent('Crawl-delay: 10\nUser-agent: *\nCrawl-delay: 2\n');
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(10_000);
  });
  it('Crawl-delay 60 -> crawl_delay, only /robots.txt fetched', async () => {
    const s = setup({ robots: fixture('robots/crawl_delay_long.txt') });
    expect(await code(s.pf('https://a.test/1', { kind: 'feed' }))).toBe('crawl_delay');
    expect(s.net.urls()).toEqual([ROBOTS_URL]);
  });
  it('Crawl-delay exactly 30 is honored (> 30 is the cutoff)', async () => {
    const s = setup({ robots: 'User-agent: *\nCrawl-delay: 30\n' });
    expect((await s.pf('https://a.test/1', { kind: 'feed' })).status).toBe(200);
  });
  it('a redirect target host with Crawl-delay 10 -> the hop starts >= 10,000 ms after that host\'s robots fetch', async () => {
    const clock = makeClock();
    const net = fakeNet((u) => {
      if (u.href === 'https://www.a.test/robots.txt') return text('User-agent: *\nDisallow:\n');
      if (u.href === 'https://a.test/robots.txt') return text('User-agent: *\nCrawl-delay: 10\n');
      if (u.href === 'https://www.a.test/feed') return redirect('https://a.test/feed');
      return text('x');
    }, clock.now);
    const pf = createPoliteFetch(source(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    await pf('https://www.a.test/feed', { kind: 'feed' });
    const robots = net.calls.find((c) => c.url === 'https://a.test/robots.txt')!;
    const hop = net.calls.find((c) => c.url === 'https://a.test/feed')!;
    expect(hop.at - robots.at).toBeGreaterThanOrEqual(10_000);
  });
  it('a redirect target host with Crawl-delay 60 -> crawl_delay, target not requested', async () => {
    const clock = makeClock();
    const net = fakeNet((u) => {
      if (u.href === 'https://www.a.test/robots.txt') return text('User-agent: *\nDisallow:\n');
      if (u.href === 'https://a.test/robots.txt') return text('User-agent: *\nCrawl-delay: 60\n');
      if (u.href === 'https://www.a.test/feed') return redirect('https://a.test/feed');
      return text('x');
    }, clock.now);
    const pf = createPoliteFetch(source(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    expect(await code(pf('https://www.a.test/feed', { kind: 'feed' }))).toBe('crawl_delay');
    expect(net.urls()).not.toContain('https://a.test/feed');
  });
});

describe('sanity', () => {
  it('fake clock starts at the shared T0', () => { expect(makeClock().now()).toBe(T0); });
});

// AC-M1-72 (A6-1): effective delay = max(1 s, our group, `*` group, pre-group line); > 30 s -> crawl_delay.
describe('conservative crawl-delay (AC-M1-72, A6-1)', () => {
  const OWN = 'User-agent: TruckeeVibesBot\n';
  const gap = async (robots: string) => {
    const s = setup({ robots });
    await s.pf('https://a.test/1', { kind: 'feed' });
    await s.pf('https://a.test/2', { kind: 'feed' });
    const at = s.net.calls.filter((c) => !c.url.endsWith('/robots.txt')).map((c) => c.at);
    return at[1] - at[0];
  };
  const skipped = async (robots: string) => {
    const s = setup({ robots });
    const c = await code(s.pf('https://a.test/1', { kind: 'feed' }));
    return { c, urls: s.net.urls() };
  };

  it.each([
    ['(1) our group without a delay + * 2', `${OWN}Disallow:\n\nUser-agent: *\nCrawl-delay: 2\n`, 2000, undefined],
    ['(2) our group 5 + * 2', `${OWN}Crawl-delay: 5\n\nUser-agent: *\nCrawl-delay: 2\n`, 5000, undefined],
    ['(3) our group 2 + * 5', `${OWN}Crawl-delay: 2\n\nUser-agent: *\nCrawl-delay: 5\n`, 5000, undefined],
    ['(4) only * 3', 'User-agent: *\nCrawl-delay: 3\n', 3000, 4000],
    ['(5) pre-group 10 + * 2', 'Crawl-delay: 10\nUser-agent: *\nCrawl-delay: 2\n', 10_000, undefined],
    ['(6) pre-group 2 + our group (no delay) + * 4', `Crawl-delay: 2\n${OWN}Disallow:\n\nUser-agent: *\nCrawl-delay: 4\n`, 4000, undefined],
    ['(7) pre-group 3 + our group (no delay), no *', `Crawl-delay: 3\n${OWN}Disallow:\n`, 3000, undefined],
    ['(8) our group 0.5, no *', `${OWN}Crawl-delay: 0.5\n`, 1000, 2000],
    ['(12) our group (no delay) + * 30', `${OWN}Disallow:\n\nUser-agent: *\nCrawl-delay: 30\n`, 30_000, undefined],
    ['(13) * "abc" + our group 2', `${OWN}Crawl-delay: 2\n\nUser-agent: *\nCrawl-delay: abc\n`, 2000, 3000],
    ['(14) * -5, nothing else', 'User-agent: *\nCrawl-delay: -5\n', 1000, 2000],
  ])('%s', async (_n, robots, min, max) => {
    const d = await gap(robots);
    expect(d).toBeGreaterThanOrEqual(min);
    if (max !== undefined) expect(d).toBeLessThan(max);
  });

  it.each([
    ['(9) our group 10 + * 60', `${OWN}Crawl-delay: 10\n\nUser-agent: *\nCrawl-delay: 60\n`],
    ['(10) our group 60 + * 1', `${OWN}Crawl-delay: 60\n\nUser-agent: *\nCrawl-delay: 1\n`],
    ['(11) pre-group 45 + our group 5', `Crawl-delay: 45\n${OWN}Crawl-delay: 5\n`],
    ['(15) our group Crawl-delay: Infinity', `${OWN}Crawl-delay: Infinity\n`],
  ])('%s -> crawl_delay, only /robots.txt fetched', async (_n, robots) => {
    const r = await skipped(robots);
    expect(r.c).toBe('crawl_delay');
    expect(r.urls).toEqual([ROBOTS_URL]);
  });

  it('redirect: www.a.test (our group, no delay) 301 -> a.test (our group no delay + * 2) -> the hop starts >= 2,000 ms after a.test robots', async () => {
    const clock = makeClock();
    const net = fakeNet((u) => {
      if (u.href === 'https://www.a.test/robots.txt') return text(`${OWN}Disallow:\n`);
      if (u.href === 'https://a.test/robots.txt') return text(`${OWN}Disallow:\n\nUser-agent: *\nCrawl-delay: 2\n`);
      if (u.href === 'https://www.a.test/feed') return redirect('https://a.test/feed');
      return text('x');
    }, clock.now);
    const pf = createPoliteFetch(source(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    await pf('https://www.a.test/feed', { kind: 'feed' });
    const robots = net.calls.find((c) => c.url === 'https://a.test/robots.txt')!;
    const hop = net.calls.find((c) => c.url === 'https://a.test/feed')!;
    expect(hop.at - robots.at).toBeGreaterThanOrEqual(2000);
  });
});

// AC-M1-73 (d) (A6-2): two sources sharing one spacer, both redirecting to the same host.
describe('shared spacer across sources (AC-M1-73 d, A6-2)', () => {
  it('every c.test request is >= 1,000 ms after the previous one; each c.test content request >= 5,000 ms after the previous c.test request', async () => {
    const clock = makeClock();
    const net = fakeNet((u) => {
      if (u.href === 'https://c.test/robots.txt') return text('User-agent: *\nCrawl-delay: 5\n');
      if (u.pathname === '/robots.txt') return text('User-agent: *\nDisallow:\n');
      if (u.href === 'https://x.test/feed' || u.href === 'https://y.test/feed') return redirect('https://c.test/feed');
      return text('x');
    }, clock.now);
    const spacer = createSpacer({ now: clock.now, sleep: clock.sleep });
    // `spacer` is the new PoliteDeps field (A6-2); typed loosely here so the test compiles before the field exists.
    const deps = { fetch: net.fetch, now: clock.now, sleep: clock.sleep, spacer } as PoliteDeps;
    const pfX = createPoliteFetch(source({ slug: 'x', allowed_hosts: ['x.test', 'c.test'] }), deps);
    const pfY = createPoliteFetch(source({ slug: 'y', allowed_hosts: ['y.test', 'c.test'] }), deps);
    await Promise.all([pfX('https://x.test/feed', { kind: 'feed' }), pfY('https://y.test/feed', { kind: 'feed' })]);
    const c = net.calls.filter((k) => new URL(k.url).hostname === 'c.test').sort((a, b) => a.at - b.at);
    expect(c).toHaveLength(4); // two robots fetches + two content requests
    for (let i = 1; i < c.length; i++) {
      expect(c[i].at - c[i - 1].at).toBeGreaterThanOrEqual(1000);
      if (!c[i].url.endsWith('/robots.txt')) expect(c[i].at - c[i - 1].at).toBeGreaterThanOrEqual(5000);
    }
  });
});
