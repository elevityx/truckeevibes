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

// ---------------------------------------------------------------------------------------------------------------------
// A12 (AC-M1-114): TTUSD family floor and path guard
// ---------------------------------------------------------------------------------------------------------------------
import { familyOf, HOST_FAMILIES, spacingKey } from './politeFetch';

describe('AC-M1-114 TTUSD family: path guard and floor', () => {
  const TT_ROBOTS = 'User-agent: *\nCrawl-delay: 5\nDisallow: /fs/\nAllow: /fs/pages/\n';
  const ttSrc = (host: string) => source({ slug: `ttusd-${host.split('.')[0]}`, allowed_hosts: [host], allowed_methods: ['html'], page_cap: 10 });
  function tt(host: string, handler: (u: URL) => Response | undefined, shared?: { clock: ReturnType<typeof makeClock>; spacer: ReturnType<typeof createSpacer> }) {
    const clock = shared?.clock ?? makeClock();
    const spacer = shared?.spacer ?? createSpacer({ now: clock.now, sleep: clock.sleep });
    const net = fakeNet((u) => handler(u) ?? (u.pathname === '/robots.txt' ? text(TT_ROBOTS) : text('<html>ok</html>')), clock.now);
    const pf = createPoliteFetch(ttSrc(host), { fetch: net.fetch, now: clock.now, sleep: clock.sleep, spacer });
    return { pf, net, clock, spacer };
  }
  const page = (host: string, d = '2026-11-01') => `https://${host}/calendar?cal_date=${d}`;
  const noFs = (net: ReturnType<typeof fakeNet>) => expect(net.calls.some((c) => new URL(c.url).pathname.startsWith('/fs/'))).toBe(false);

  it('(a) robots.txt redirecting into /fs/ -> robots_blocked, no request to /fs/, 0 page fetches', async () => {
    const t = tt('te.ttusd.org', (u) => (u.pathname === '/robots.txt' ? redirect('https://te.ttusd.org/fs/robots') : undefined));
    expect(await code(t.pf(page('te.ttusd.org'), { kind: 'html' }))).toBe('robots_blocked');
    noFs(t.net);
    expect(t.net.urls()).toEqual(['https://te.ttusd.org/robots.txt']);
  });
  it('(b) robots disallowing /calendar -> robots_blocked, 0 page fetches', async () => {
    const t = tt('te.ttusd.org', (u) => (u.pathname === '/robots.txt' ? text('User-agent: *\nCrawl-delay: 5\nDisallow: /calendar\n') : undefined));
    expect(await code(t.pf(page('te.ttusd.org'), { kind: 'html' }))).toBe('robots_blocked');
    expect(content(t.net)).toHaveLength(0);
  });
  it('(c) robots 503 -> robots_blocked, and the next TTUSD source waits >= 5000 ms after the failed request', async () => {
    const clock = makeClock();
    const spacer = createSpacer({ now: clock.now, sleep: clock.sleep });
    const a = tt('te.ttusd.org', (u) => (u.pathname === '/robots.txt' ? text('down', 503) : undefined), { clock, spacer });
    expect(await code(a.pf(page('te.ttusd.org'), { kind: 'html' }))).toBe('robots_blocked');
    const failedAt = a.net.calls[0].at;
    const b = tt('nths.ttusd.org', () => undefined, { clock, spacer });
    await b.pf(page('nths.ttusd.org'), { kind: 'html' });
    expect(b.net.calls[0].at - failedAt).toBeGreaterThanOrEqual(5000);
  });
  it('(d) a page redirecting to /fs/calendar-manager/events.ics -> path_not_allowed, never requested', async () => {
    const t = tt('te.ttusd.org', (u) => (u.pathname === '/calendar' ? redirect('https://te.ttusd.org/fs/calendar-manager/events.ics?calendar_ids[]=1', 302) : undefined));
    expect(await code(t.pf(page('te.ttusd.org'), { kind: 'html' }))).toBe('path_not_allowed');
    noFs(t.net);
  });
  it('(e) a redirect to another allowed month page is followed', async () => {
    const t = tt('te.ttusd.org', (u) => (u.pathname === '/calendar' && u.searchParams.get('cal_date') === '2026-10-01' ? redirect('/calendar?cal_date=2026-11-01', 302) : undefined));
    const out = await t.pf(page('te.ttusd.org', '2026-10-01'), { kind: 'html' });
    expect(out.status).toBe(200);
    expect(t.net.urls()).toContain(page('te.ttusd.org'));
  });
  it('(f) the first request on te.ttusd.org after one on nths.ttusd.org waits >= 5000 ms', async () => {
    const clock = makeClock();
    const spacer = createSpacer({ now: clock.now, sleep: clock.sleep });
    const a = tt('nths.ttusd.org', () => undefined, { clock, spacer });
    await a.pf.fetchRobots('nths.ttusd.org');
    const b = tt('te.ttusd.org', () => undefined, { clock, spacer });
    await b.pf(page('te.ttusd.org'), { kind: 'html' });
    expect(b.net.calls[0].url).toBe('https://te.ttusd.org/robots.txt');
    expect(b.net.calls[0].at - a.net.calls[0].at).toBeGreaterThanOrEqual(5000);
  });
  it('(g) spacingKey / familyOf, and non-family hosts keep 1000 ms and no path guard', async () => {
    expect(spacingKey('www.ttusd.org')).toBe('ttusd.org');
    expect(spacingKey('ttusd.org')).toBe('ttusd.org');
    expect(spacingKey('chamber.truckee.com')).toBe('chamber.truckee.com');
    expect(familyOf('te.ttusd.org')).toBe('ttusd.org');
    expect(familyOf('notttusd.org')).toBeUndefined();
    expect(HOST_FAMILIES['ttusd.org'].floorMs).toBe(5000);
    const { pf, net } = setup({ robots: 'User-agent: *\nDisallow: /nothing\n' });
    await pf('https://a.test/fs/anything', { kind: 'html' });
    await pf('https://a.test/other', { kind: 'html' });
    const at = content(net).map((u) => net.calls.find((c) => c.url === u)!.at);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
    expect(at[1] - at[0]).toBeLessThan(5000);
  });
  it('the guard needs the exact month query and the allowed paths (every hop, first request included)', async () => {
    for (const bad of ['https://te.ttusd.org/calendar', 'https://te.ttusd.org/calendar?cal_date=2026-11-02', 'https://te.ttusd.org/calendar?cal_date=2026-11-01&x=1',
      'https://te.ttusd.org/fs/pages/home?cal_date=2026-11-01', 'https://te.ttusd.org/other?cal_date=2026-11-01']) {
      const t = tt('te.ttusd.org', () => undefined);
      expect(await code(t.pf(bad, { kind: 'html' })), bad).toBe('path_not_allowed');
      expect(t.net.calls).toHaveLength(0);
    }
    const ok = tt('www.ttusd.org', () => undefined);
    expect((await ok.pf('https://www.ttusd.org/parents-students/calendars/calendars2?cal_date=2026-11-01', { kind: 'html' })).status).toBe(200);
  });
  it('the floor is seeded before the first request: robots itself starts >= 5000 ms after an earlier family request', async () => {
    const clock = makeClock();
    const spacer = createSpacer({ now: clock.now, sleep: clock.sleep });
    await spacer.acquire('ttusd.org', 1000);
    const t0 = clock.now();
    const t = tt('te.ttusd.org', () => undefined, { clock, spacer });
    await t.pf(page('te.ttusd.org'), { kind: 'html' });
    expect(t.net.calls[0].at - t0).toBeGreaterThanOrEqual(5000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A13 (AC-M1-129 r4): Tahoe Donner family guard, generalized host families, finalUrl
// ---------------------------------------------------------------------------------------------------------------------
describe('AC-M1-129 Tahoe Donner family: path guard, robots and floor', () => {
  const TD_ROBOTS = fixture('tahoedonner/robots.txt');
  const tdSrc = (host = 'www.tahoedonner.com') => source({ slug: 'tahoe-donner', allowed_hosts: [host], allowed_methods: ['html'], page_cap: 45 });
  function td(handler: (u: URL) => Response | undefined, host = 'www.tahoedonner.com') {
    const clock = makeClock();
    const net = fakeNet((u) => handler(u) ?? (u.pathname === '/robots.txt' ? text(TD_ROBOTS) : text('<html>ok</html>')), clock.now);
    const pf = createPoliteFetch(tdSrc(host), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    return { pf, net, clock };
  }
  const B = 'https://www.tahoedonner.com';
  it('allowed: robots, /events/, the three hint lists, a detail', async () => {
    const t = td(() => undefined);
    for (const p of ['/events/', '/events/?categories%5B%5D=94', '/events/?categories%5B%5D=180', '/events/?categories%5B%5D=95', '/events/light-up-the-night/']) {
      expect((await t.pf(`${B}${p}`, { kind: 'html' })).status, p).toBe(200);
    }
    await t.pf.fetchRobots('www.tahoedonner.com');
  });
  it('path_not_allowed: feed, calendar actions, the ai1ec exporter, category 126 and 999, keywords, wp-json, nested paths', async () => {
    for (const p of ['/events/feed/', '/calendar/action~month/', '/?controller=ai1ec_exporter_controller', '/events/?categories%5B%5D=126', '/events/?categories%5B%5D=999',
      '/events/?keywords=x', '/wp-json/wp/v2/types', '/events/a/b/', '/events', '/events/Upper/', `/events/${'a'.repeat(130)}/`]) {
      const t = td(() => undefined);
      expect(await code(t.pf(`${B}${p}`, { kind: 'html' })), p).toBe('path_not_allowed');
      expect(t.net.calls).toHaveLength(0);
    }
  });
  it('a detail 302 -> /calendar/action~agenda/ is path_not_allowed and that path is never requested', async () => {
    const t = td((u) => (u.pathname === '/events/x-y/' ? redirect(`${B}/calendar/action~agenda/`, 302) : undefined));
    expect(await code(t.pf(`${B}/events/x-y/`, { kind: 'html' }))).toBe('path_not_allowed');
    expect(t.net.urls().some((u) => u.includes('action~'))).toBe(false);
  });
  it('robots Disallow: /events/ -> robots_blocked, 0 page fetches', async () => {
    const t = td((u) => (u.pathname === '/robots.txt' ? text('User-agent: *\nDisallow: /events/\n') : undefined));
    expect(await code(t.pf(`${B}/events/`, { kind: 'html' }))).toBe('robots_blocked');
    expect(content(t.net)).toHaveLength(0);
  });
  it('the real robots.txt allows /events/ and the detail pages and blocks calendar actions', async () => {
    const t = td(() => undefined);
    expect((await t.pf(`${B}/events/`, { kind: 'html' })).status).toBe(200);
    expect(await code(t.pf(`${B}/calendar/action~month/`, { kind: 'html' }))).toBe('path_not_allowed');
  });
  it('the first request on tahoedonner.com after one on www.tahoedonner.com waits >= 5000 ms; the spacing key is the apex', async () => {
    expect(spacingKey('www.tahoedonner.com')).toBe('tahoedonner.com');
    expect(familyOf('www.tahoedonner.com')).toBe('tahoedonner.com');
    expect(HOST_FAMILIES['tahoedonner.com'].floorMs).toBe(5000);
    const clock = makeClock();
    const spacer = createSpacer({ now: clock.now, sleep: clock.sleep });
    const mk = (host: string) => {
      const net = fakeNet((u) => (u.pathname === '/robots.txt' ? text(TD_ROBOTS) : text('<html>ok</html>')), clock.now);
      return { net, pf: createPoliteFetch(tdSrc(host), { fetch: net.fetch, now: clock.now, sleep: clock.sleep, spacer }) };
    };
    const a = mk('www.tahoedonner.com');
    await a.pf(`${B}/events/`, { kind: 'html' });
    const b = mk('tahoedonner.com');
    await b.pf('https://tahoedonner.com/events/', { kind: 'html' });
    expect(b.net.calls[0].at - a.net.calls[a.net.calls.length - 1].at).toBeGreaterThanOrEqual(5000);
  });
  it('FetchOut.finalUrl is the last hop; a same-host redirect to another allowed page reports that page', async () => {
    const t = td((u) => (u.pathname === '/events/' && u.search ? redirect(`${B}/events/`, 302) : undefined));
    const out = await t.pf(`${B}/events/?categories%5B%5D=94`, { kind: 'html' });
    expect(out.finalUrl).toBe(`${B}/events/`);
    const plain = await t.pf(`${B}/events/x-y/`, { kind: 'html' });
    expect(plain.finalUrl).toBe(`${B}/events/x-y/`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A14 (AC-M1-138): Crystal Bay Casino family guard
// ---------------------------------------------------------------------------------------------------------------------
describe('AC-M1-138 Crystal Bay Casino family: path guard, robots and floor', () => {
  const CB_ROBOTS = fixture('crystalbay/robots.txt');
  const cbSrc = () => source({ slug: 'crystal-bay-casino', allowed_hosts: ['www.crystalbaycasino.com'], allowed_methods: ['api'], page_cap: 3 });
  function cb(handler: (u: URL) => Response | undefined, robots = CB_ROBOTS) {
    const clock = makeClock();
    const net = fakeNet((u) => handler(u) ?? (u.pathname === '/robots.txt' ? text(robots) : text('[]')), clock.now);
    const pf = createPoliteFetch(cbSrc(), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    return { pf, net, clock };
  }
  const B = 'https://www.crystalbaycasino.com';
  it('allowed: robots and the one REST URL', async () => {
    const t = cb(() => undefined);
    expect((await t.pf(`${B}/wp-json/wp/v2/event?per_page=100`, { kind: 'api' })).status).toBe(200);
    await t.pf.fetchRobots('www.crystalbaycasino.com');
    expect(HOST_FAMILIES['crystalbaycasino.com'].floorMs).toBe(5000);
    expect(familyOf('www.crystalbaycasino.com')).toBe('crystalbaycasino.com');
  });
  it('path_not_allowed: other REST routes, queries and pages; nothing is requested', async () => {
    for (const p of ['/wp-json/wp/v2/event', '/wp-json/wp/v2/event?per_page=100&page=2', '/wp-json/wp/v2/event?per_page=10', '/wp-json/wp/v2/pages/2707',
      '/wp-json/tribe/events/v1/events', '/wp-json/', '/entertainment/events/', '/event/steely-dead/']) {
      const t = cb(() => undefined);
      expect(await code(t.pf(`${B}${p}`, { kind: 'api' })), p).toBe('path_not_allowed');
      expect(t.net.calls, p).toHaveLength(0);
    }
  });
  it('a 302 to tixr.com is blocked with no request to tixr.com; a direct tixr.com request is host_not_allowed', async () => {
    const t = cb((u) => (u.pathname === '/wp-json/wp/v2/event' ? redirect('https://tixr.com/e/211222', 302) : undefined));
    const c = await code(t.pf(`${B}/wp-json/wp/v2/event?per_page=100`, { kind: 'api' }));
    expect(['host_not_allowed', 'redirect_blocked']).toContain(c);
    expect(t.net.urls().some((u) => u.includes('tixr.com'))).toBe(false);
    expect(await code(cb(() => undefined).pf('https://tixr.com/e/211222', { kind: 'api' }))).toBe('host_not_allowed');
  });
  it('robots Disallow: /wp-json/ -> robots_blocked, 0 API fetches', async () => {
    const t = cb(() => undefined, 'User-agent: *\nDisallow: /wp-json/\n');
    expect(await code(t.pf(`${B}/wp-json/wp/v2/event?per_page=100`, { kind: 'api' }))).toBe('robots_blocked');
    expect(content(t.net)).toHaveLength(0);
  });
  it('the second request waits >= 5000 ms after robots', async () => {
    const t = cb(() => undefined);
    await t.pf(`${B}/wp-json/wp/v2/event?per_page=100`, { kind: 'api' });
    expect(t.net.calls[1].at - t.net.calls[0].at).toBeGreaterThanOrEqual(5000);
  });
});

describe('AC-K-10 / AC-K-11 LibCal family: path guard, robots and floor (Spec_Kids_Live)', () => {
  const LC_ROBOTS = fixture('libcal/robots.txt');
  const lcSrc = (host: string) => source({ slug: 'libcal-test', allowed_hosts: [host], allowed_methods: ['feed'], page_cap: 3 });
  function lc(host: string) {
    const clock = makeClock();
    const net = fakeNet((u) => (u.pathname === '/robots.txt' ? text(LC_ROBOTS) : text('<rss/>')), clock.now);
    const pf = createPoliteFetch(lcSrc(host), { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    return { pf, net, clock };
  }
  it('allowed: the month feed with or without a campus', async () => {
    const a = lc('placer.libcal.com');
    expect((await a.pf('https://placer.libcal.com/rss.php?cid=22618&m=month', { kind: 'feed' })).status).toBe(200);
    const b = lc('nevadacountyca.libcal.com');
    expect((await b.pf('https://nevadacountyca.libcal.com/rss.php?cid=20247&m=month&cam=8465', { kind: 'feed' })).status).toBe(200);
    expect(familyOf('nevadacountyca.libcal.com')).toBe('libcal.com');
    expect(HOST_FAMILIES['libcal.com'].floorMs).toBe(10000);
  });
  it('path_not_allowed: ajax, ical, event pages, other windows, process_; nothing is requested', async () => {
    for (const p of ['/ajax/calendar/list?c=-1', '/ical_subscribe.php?src=p&cid=20247', '/event/123', '/rss.php?cid=1&m=all', '/process_x',
      '/calendar?cid=20247', '/rss.php?cid=1&m=month&audience=2', '/rss.php?m=month&cid=1']) {
      const t = lc('nevadacountyca.libcal.com');
      expect(await code(t.pf(`https://nevadacountyca.libcal.com${p}`, { kind: 'feed' })), p).toBe('path_not_allowed');
      expect(t.net.calls, p).toHaveLength(0);
    }
  });
  it('two feed requests on one host are >= 10 s apart', async () => {
    const t = lc('placer.libcal.com');
    await t.pf('https://placer.libcal.com/rss.php?cid=22618&m=month', { kind: 'feed' });
    await t.pf('https://placer.libcal.com/rss.php?cid=22619&m=month', { kind: 'feed' });
    const at = t.net.calls.filter((c) => c.url.includes('rss.php')).map((c) => c.at);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(10000);
  });
  it('the LibCal robots names GPTBot with Disallow: / (ai_bots_blocked true) and allows us', async () => {
    expect(computeAiBotsBlocked(LC_ROBOTS)).toBe(true);
  });
});
