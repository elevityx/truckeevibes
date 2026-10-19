// @vitest-environment happy-dom
// AC-W2-07 (XSS), AC-W2-08 (markup parity with Lights' EventsList/EventSheet output), AC-W2-09 (credit), state notes (W2.2 views/states.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createController } from './controller';
import { FIXTURE_CLOCK, fixture, jsonResponse, LOCAL_BOX, rawEnvelope, rawRow, TZ, uuid } from './testing';
import type { Controller, ControllerOptions } from './types';

const made: Controller[] = [];
function make(body: unknown, over: Partial<ControllerOptions> = {}) {
  const fn = (async () => jsonResponse(body)) as typeof fetch;
  const c = createController({ season: 'halloween', year: 2026, tz: TZ, localBox: LOCAL_BOX, fetch: fn, ...over });
  made.push(c);
  return c;
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const mount = (c: Controller, kind: 'list' | 'upcoming' = 'list', o: { onAdd?(): void } = {}) => {
  const el = document.body.appendChild(document.createElement('div'));
  if (kind === 'list') c.mountList(el, o);
  else c.mountUpcoming(el, { ...o, onSeeAll: () => {} });
  return el.shadowRoot!;
};
const overlayRoot = () => (document.body.querySelector('[data-tv-overlay]') as HTMLElement).shadowRoot!;
const roots = (): (Document | ShadowRoot)[] => [document, ...[...document.querySelectorAll('*')].flatMap((e) => (e.shadowRoot ? [e.shadowRoot] : []))];
/** Text nodes in document order, trimmed, empty ones dropped. */
function texts(n: Node): string[] {
  const out: string[] = [];
  const walk = (x: Node) => {
    if (x.nodeType === 3) {
      const t = (x.textContent ?? '').trim();
      if (t) out.push(t);
    }
    if (x.nodeType === 1 && (x as Element).tagName.toLowerCase() === 'style') return;
    x.childNodes.forEach(walk);
  };
  walk(n);
  return out;
}
const shape = (el: Element): string => {
  const cls = el.getAttribute('class');
  const me = `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(' ').join('.') : ''}`;
  const kids = [...el.children].filter((k) => k.tagName.toLowerCase() !== 'svg');
  return kids.length ? `${me}(${kids.map(shape).join(',')})` : me;
};

beforeEach(() => vi.useFakeTimers({ now: FIXTURE_CLOCK.halloween }));
afterEach(() => {
  while (made.length) made.pop()!.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('AC-W2-07 XSS fixture', () => {
  it('creates no active element, keeps hostile text as text, and renders no unsafe link', async () => {
    const c = make(fixture('halloween-xss'));
    await settle();
    const list = mount(c);
    mount(c, 'upcoming');
    for (const id of c.events.map((e) => e.id)) {
      expect(c.open(id)).toBe(true);
      for (const r of roots()) {
        expect(r.querySelectorAll('script, img, iframe, object, embed')).toHaveLength(0);
        for (const a of r.querySelectorAll('[href]')) expect(a.getAttribute('href')).toMatch(/^https:\/\//);
        for (const el of r.querySelectorAll('*')) for (const at of el.getAttributeNames()) expect(at.startsWith('on')).toBe(false);
      }
      c.close();
    }
    const titles = [...list.querySelectorAll('.erow strong')].map((s) => s.textContent);
    expect(titles).toContain('<img src=x onerror=alert(1)>');
    expect(titles).toContain('"><script>alert(1)</script>');
    expect(titles).toContain('Bidi ‮gnp.exe');
    // the 10 KB title row and the off-site pageUrl row are dropped by validation
    expect(titles.some((t) => (t ?? '').length > 200)).toBe(false);
    expect(titles).not.toContain('Evil page link');
    expect(titles).toContain('Proto row');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('a javascript: or data: website renders no Website button', async () => {
    const c = make(fixture('halloween-xss'));
    await settle();
    const ids = c.events.filter((e) => /^javascript:|^data:/.test(e.url ?? '')).map((e) => e.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      c.open(id);
      expect(texts(overlayRoot().querySelector('.eacts')!)).toEqual(['Directions', 'Add to calendar', 'Share']);
      c.close();
    }
  });

  it('a pageUrl on another host renders no "More on TruckeeVibes" button even if it reaches the view', async () => {
    const env = rawEnvelope([rawRow(1, { origin: 'vibes', pageUrl: 'https://truckeevibes.com/e/a/', startsAt: '2026-10-30T23:00:00Z' })]);
    const c = make(env);
    await settle();
    c.open(uuid(1));
    expect(texts(overlayRoot().querySelector('.eacts')!)).toContain('More on TruckeeVibes');
    const more = [...overlayRoot().querySelectorAll('a')].find((a) => a.textContent?.includes('More on'))!;
    expect(more.getAttribute('href')).toBe('https://truckeevibes.com/e/a/');
    c.close();
    // force a hostile pageUrl past validation: the view checks it again
    (c.events[0] as { pageUrl: string | null }).pageUrl = 'https://evil.example/';
    c.open(uuid(1));
    expect(texts(overlayRoot().querySelector('.eacts')!)).not.toContain('More on TruckeeVibes');
  });
});

describe('AC-W2-08 markup parity with Lights', () => {
  // Expected strings written from Lights EventsList.tsx (EventRow) and EventSheet.tsx for this event.
  const ev = rawRow(1, {
    title: 'Halloween in the Park & more', description: 'Trick-or-treat downtown.\nCostume contest at 5:30.', venue: 'Downtown Park',
    address: '10046 Church St, Truckee, CA 96161', lat: 39.545, lng: -119.825, startsAt: '2026-10-30T23:00:00Z', endsAt: '2026-10-31T01:00:00Z',
    url: 'https://example.org/park', adultsOnly: true,
  });
  const plain = rawRow(2, { title: 'Pumpkin Walk', address: 'Heritage Plaza, Tahoe City, CA', venue: null, startsAt: '2026-10-28T01:30:00Z', endsAt: null });

  it('row: aria-label and the element/class sequence', async () => {
    const c = make(rawEnvelope([ev, plain]));
    await settle();
    const root = mount(c);
    const [rowB, rowA] = [...root.querySelectorAll('button.erow')]; // sorted by start: Oct 27 before Oct 30
    expect(rowA.getAttribute('type')).toBe('button');
    expect(rowB.getAttribute('aria-label')).toBe('Pumpkin Walk, Tue, Oct 27 · 6:30 pm, Tahoe City');
    expect(rowA.getAttribute('aria-label')).toBe('Halloween in the Park & more, Fri, Oct 30 · 4–6 pm, Truckee, adults only, 21 and over, worth the drive');
    expect(shape(rowA)).toBe('button.erow(span.dchip(span.mo,span.dd,span.wd),span.info(strong,span.meta(span,span.t21,span.tdrive)),span.chev)');
    expect(shape(rowB)).toBe('button.erow(span.dchip(span.mo,span.dd,span.wd),span.info(strong,span.meta(span)),span.chev)');
    expect(texts(rowA)).toEqual(['OCT', '30', 'Fri', 'Halloween in the Park & more', '4–6 pm · Truckee', '21+', 'Worth the drive']);
    expect(texts(rowB)).toEqual(['OCT', '27', 'Tue', 'Pumpkin Walk', '6:30 pm · Tahoe City']);
    expect(rowA.querySelector('.dchip')!.getAttribute('aria-hidden')).toBe('true');
    expect(rowA.querySelector('.info')!.getAttribute('aria-hidden')).toBe('true');
    expect(rowA.querySelector('.chev svg path')!.getAttribute('d')).toBe('M9 6l6 6-6 6');
  });

  it('list: head, groups with counts, credit last', async () => {
    const c = make(fixture('halloween-ok'));
    await settle();
    const root = mount(c);
    const wrap = root.querySelector('.tv-list')!;
    expect(texts(wrap.querySelector('.list-head')!)).toEqual(['Upcoming events', 'Halloween 2026 · Pacific time']);
    expect(wrap.querySelector('.list-head h2')!.className).toBe('disp');
    const groups = [...wrap.querySelectorAll('section.grp')].map((s) => [s.getAttribute('aria-label'), texts(s.querySelector('h3')!).join(' ')]);
    expect(groups).toEqual([['Today', 'Today 2'], ['This week', 'This week 4'], ['Later', 'Later 6']]);
    expect(wrap.lastElementChild!.className).toBe('fine tv-credit');
  });

  it('upcoming: top 3, "See all events" when more than 3, credit last', async () => {
    const c = make(fixture('halloween-ok'));
    await settle();
    let seeAll = 0;
    const el = document.body.appendChild(document.createElement('div'));
    c.mountUpcoming(el, { onSeeAll: () => seeAll++ });
    const sec = el.shadowRoot!.querySelector('section.upcoming')!;
    expect(sec.getAttribute('aria-label')).toBe('Upcoming events');
    expect(sec.querySelectorAll('ul.erows > li > button.erow')).toHaveLength(3);
    const btn = sec.querySelector('.list-head button.linkbtn') as HTMLButtonElement;
    expect(btn.textContent).toBe('See all events');
    btn.click();
    expect(seeAll).toBe(1);
    expect(sec.lastElementChild!.className).toBe('fine tv-credit');
  });

  it('upcoming with 2 events says "Next 2"', async () => {
    const c = make(rawEnvelope([ev, plain]));
    await settle();
    const root = mount(c, 'upcoming');
    expect(texts(root.querySelector('.list-head')!)).toEqual(['Upcoming events', 'Next 2']);
  });

  it('sheet: text nodes and structure', async () => {
    const c = make(rawEnvelope([ev, plain]));
    await settle();
    const root = mount(c);
    (root.querySelectorAll('button.erow')[1] as HTMLButtonElement).click();
    expect(c.openId()).toBe(uuid(1));
    const o = overlayRoot();
    const aside = o.querySelector('aside.tv-panel')!;
    expect(aside.getAttribute('role')).toBe('dialog');
    expect(aside.getAttribute('aria-label')).toBe('Event details');
    expect(o.querySelector('.tv-scrim')!.getAttribute('aria-hidden')).toBe('true');
    expect(shape(aside.firstElementChild!).startsWith('div.sheet-in.esheet(div.sheet-h(div(p.eyebrow,h2.etitle,p.etags(span.t21.big,span.tdrive.big)),button.iconbtn.x)')).toBe(true);
    expect(texts(aside)).toEqual([
      'Event · Halloween 2026', 'Halloween in the Park & more', '21+ · Adults only', 'Worth the drive',
      'OCT', '30', 'Fri', 'Fri, Oct 30 · 4–6 pm', 'Pacific time',
      'Downtown Park', '10046 Church St, Truckee, CA 96161',
      'Trick-or-treat downtown.\nCostume contest at 5:30.',
      'Website', 'Directions', 'Add to calendar', 'Share',
      'Add to calendar opens Google Calendar.',
      'Powered by', 'TruckeeVibes',
    ]);
    expect(aside.querySelector('.x')!.getAttribute('aria-label')).toBe('Close event details');
    const links = [...aside.querySelectorAll('.eacts a')].map((a) => [a.textContent, a.getAttribute('rel'), a.getAttribute('target')]);
    expect(links).toEqual([
      ['Website', 'nofollow ugc noopener noreferrer', '_blank'],
      ['Directions', 'noopener noreferrer', '_blank'],
      ['Add to calendar', 'noopener noreferrer', '_blank'],
    ]);
    const cal = new URL(aside.querySelectorAll('.eacts a')[2].getAttribute('href')!);
    expect(cal.searchParams.get('dates')).toBe('20261030T230000Z/20261031T010000Z');
  });

  it('sheet: the close button and the scrim close it; Share calls the host', async () => {
    const shared: string[] = [];
    const c = make(rawEnvelope([ev]), { onShare: (e) => shared.push(e.id) });
    await settle();
    c.open(uuid(1));
    (overlayRoot().querySelector('.eacts .btn.primary') as HTMLButtonElement).click();
    expect(shared).toEqual([uuid(1)]);
    (overlayRoot().querySelector('.iconbtn.x') as HTMLButtonElement).click();
    expect(c.isOpen()).toBe(false);
    c.open(uuid(1));
    (overlayRoot().querySelector('.tv-scrim') as HTMLElement).click();
    expect(c.isOpen()).toBe(false);
  });

  it('christmas: eyebrow and list subtitle', async () => {
    vi.setSystemTime(FIXTURE_CLOCK.christmas);
    const c = make(fixture('christmas-ok'), { season: 'christmas' });
    await settle();
    const root = mount(c);
    expect(texts(root.querySelector('.list-head')!)).toEqual(['Upcoming events', 'Christmas 2026 · Pacific time']);
    c.open(c.events[0].id);
    expect(texts(overlayRoot().querySelector('.eyebrow')!)).toEqual(['Event · Christmas 2026']);
    expect((root.host as HTMLElement).getAttribute('data-season')).toBe('christmas');
  });
});

describe('AC-W2-09 credit', () => {
  const credit = (r: ParentNode) => {
    const ps = [...r.querySelectorAll('p.tv-credit')];
    expect(ps).toHaveLength(1);
    expect(ps[0].textContent).toBe('Powered by TruckeeVibes');
    const as = [...r.querySelectorAll('a[href="https://truckeevibes.com/"]')];
    expect(as).toHaveLength(1);
    expect(as[0].textContent).toBe('TruckeeVibes');
    expect(as[0].closest('p.tv-credit')).toBe(ps[0]);
    expect(as[0].getAttribute('target')).toBe('_blank');
    expect(as[0].getAttribute('rel')).toBe('noopener');
  };
  it('list, upcoming and sheet each carry exactly one credit', async () => {
    const c = make(fixture('halloween-ok'));
    await settle();
    credit(mount(c));
    credit(mount(c, 'upcoming'));
    c.open(c.events[0].id);
    credit(overlayRoot());
  });
  it('the empty state shows the credit too', async () => {
    const c = make(fixture('halloween-empty'));
    await settle();
    let added = 0;
    const list = mount(c, 'list', { onAdd: () => added++ });
    expect(texts(list.querySelector('.eempty')!)).toEqual(['No events yet — know one? Add it.', 'Add an event']);
    expect(list.querySelector('.eempty svg path')).not.toBeNull();
    (list.querySelector('.eempty .btn.primary') as HTMLButtonElement).click();
    expect(added).toBe(1);
    credit(list);
    const up = mount(c, 'upcoming');
    expect(texts(up.querySelector('.eempty')!)).toEqual(['No events yet — know one? Add it.']);
    credit(up);
  });
});

describe('state notes (W2.2 views/states.ts)', () => {
  const note = (r: ParentNode) => r.querySelector('.tv-note')?.textContent ?? '';
  it('held', async () => {
    const c = make(fixture('halloween-held'));
    await settle();
    expect(c.state).toBe('held');
    expect(note(mount(c))).toBe('Some events are being re-checked. List last confirmed 7:08 am.');
    expect(note(mount(c, 'upcoming'))).toBe('Some events are being re-checked. List last confirmed 7:08 am.');
  });
  it('stale', async () => {
    const c = make(fixture('halloween-stale'));
    await settle();
    expect(c.state).toBe('stale');
    expect(note(mount(c))).toBe('Events last updated 6:00 am.');
  });
  it('failed: the message and a link, no empty-state copy', async () => {
    const fn = (async () => jsonResponse({ error: 'unavailable' }, 503)) as typeof fetch;
    const c = createController({ season: 'halloween', year: 2026, tz: TZ, localBox: LOCAL_BOX, fetch: fn });
    made.push(c);
    await settle();
    const r = mount(c);
    expect(note(r)).toBe("Events can't load right now. See them on truckeevibes.com.");
    expect(r.querySelector('.tv-note a')!.getAttribute('href')).toBe('https://truckeevibes.com/');
    expect(r.querySelector('.eempty')).toBeNull();
  });
  it('ready: no note; loading: nothing rendered', async () => {
    const c = make(fixture('halloween-ok'));
    const r = mount(c);
    expect(r.querySelector('.tv-list, .upcoming')).toBeNull();
    await settle();
    expect(r.querySelector('.tv-note')).toBeNull();
    expect(r.querySelectorAll('.erow')).toHaveLength(12);
  });
});

describe('styles', () => {
  it('every mounted root and the overlay share one adopted stylesheet (or a style element fallback)', async () => {
    const c = make(fixture('halloween-ok'));
    await settle();
    const a = mount(c);
    const b = mount(c, 'upcoming');
    c.open(c.events[0].id);
    const sheetsOf = (r: ShadowRoot) => (r.adoptedStyleSheets?.length ? r.adoptedStyleSheets[0] : r.querySelector('style')?.textContent);
    expect(sheetsOf(a)).toBeTruthy();
    expect(sheetsOf(b)).toBe(sheetsOf(a));
    expect(sheetsOf(overlayRoot())).toBe(sheetsOf(a));
  });
});
