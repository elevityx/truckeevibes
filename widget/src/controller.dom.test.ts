// @vitest-environment happy-dom
// AC-W2-05 (staleness table, plan §3.3) and AC-W2-06 (controller lifecycle), on a fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createController } from './controller';
import { jsonResponse, LOCAL_BOX, rawEnvelope, rawRow, TZ, uuid } from './testing';
import type { Controller, ControllerOptions, State, WidgetEvent } from './types';

const NOW = Date.parse('2026-10-15T15:00:00Z'); // Thu Oct 15, 8 am PDT
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const upcoming = (n: number, over: Record<string, unknown> = {}) =>
  rawRow(n, { startsAt: iso(NOW + n * 60 * MIN), endsAt: iso(NOW + n * 60 * MIN + 2 * 60 * MIN), ...over });
const confirmedEnv = (events: unknown[], ageMin = 10, over: Record<string, unknown> = {}) =>
  rawEnvelope(events, {
    dataAt: iso(NOW - 2 * MIN),
    mirror: { state: 'confirmed', confirmedAt: iso(NOW - ageMin * MIN), heldSince: null, heldCount: 0 },
    ...over,
  });

type Body = unknown | (() => Response | Promise<Response>);
function serve(...bodies: Body[]) {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (u: RequestInfo | URL) => {
    calls.push(String(u));
    const b = bodies[Math.min(i++, bodies.length - 1)];
    return typeof b === 'function' ? (b as () => Response)() : jsonResponse(b);
  }) as typeof fetch;
  return { fn, calls };
}

const made: Controller[] = [];
function make(fetchFn: typeof fetch, over: Partial<ControllerOptions> = {}) {
  const c = createController({ season: 'halloween', year: 2026, tz: TZ, localBox: LOCAL_BOX, fetch: fetchFn, ...over });
  made.push(c);
  return c;
}
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  while (made.length) made.pop()!.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('AC-W2-05 staleness (first match wins)', () => {
  const cases: [string, Body[], State][] = [
    ['network error', [() => { throw new TypeError('offline'); }], 'failed'],
    ['HTTP 503 (the API has no stale fallback)', [() => jsonResponse({ error: 'unavailable' }, 503)], 'failed'],
    ["mirror.state 'none'", [rawEnvelope([upcoming(1)], { dataAt: iso(NOW), mirror: { state: 'none', confirmedAt: null, heldSince: null, heldCount: 0 } })], 'failed'],
    ['age 6 h 1 min', [confirmedEnv([upcoming(1)], 361)], 'failed'],
    ['incomplete (a 5th page)', [confirmedEnv([upcoming(1)], 10, { nextCursor: 'more' })], 'failed'],
    ['held, even when fresh', [rawEnvelope([upcoming(1)], { dataAt: iso(NOW), mirror: { state: 'held', confirmedAt: iso(NOW - MIN), heldSince: iso(NOW - MIN), heldCount: 3 } })], 'held'],
    ['held with confirmedAt 6 h 1 min old', [rawEnvelope([upcoming(1)], { dataAt: iso(NOW), mirror: { state: 'held', confirmedAt: iso(NOW - 361 * MIN), heldSince: iso(NOW - MIN), heldCount: 3 } })], 'failed'],
    ['stale:true', [confirmedEnv([upcoming(1)], 10, { stale: true })], 'stale'],
    ['age 91 min', [confirmedEnv([upcoming(1)], 91)], 'stale'],
    ['age 89 min', [confirmedEnv([upcoming(1)], 89)], 'ready'],
  ];
  it.each(cases)('%s -> %s', async (_n, bodies, want) => {
    const c = make(serve(...bodies).fn);
    const seen: State[] = [];
    c.on('state', (s) => seen.push(s));
    expect(c.state).toBe('loading');
    await settle();
    expect(c.state).toBe(want);
    expect(seen).toEqual([want]);
    if (want === 'failed') expect(c.events).toEqual([]);
    else expect(c.events.map((e) => e.id)).toEqual([uuid(1)]);
  });

  it.each([
    ['held', { state: 'held', confirmedAt: iso(NOW - 10 * MIN), heldSince: iso(NOW - 5 * MIN), heldCount: 2 }],
    ['none', { state: 'none', confirmedAt: null, heldSince: null, heldCount: 0 }],
    ['an expired confirmation', { state: 'confirmed', confirmedAt: iso(NOW - 361 * MIN), heldSince: null, heldCount: 0 }],
  ])('multi-page: page 2 reporting %s -> failed, no events (W2 review P1)', async (_n, m2) => {
    const p1 = confirmedEnv([upcoming(1)], 10, { nextCursor: 'p2' });
    const p2 = confirmedEnv([upcoming(2)], 10, { mirror: m2 });
    const fn = (async (u: RequestInfo | URL) => jsonResponse(new URL(String(u)).searchParams.get('cursor') ? p2 : p1)) as typeof fetch;
    const c = make(fn);
    await settle();
    expect(c.state).toBe('failed');
    expect(c.events).toEqual([]);
  });

  it('multi-page: both pages held -> held with all events', async () => {
    const m = { state: 'held', confirmedAt: iso(NOW - 10 * MIN), heldSince: iso(NOW - 5 * MIN), heldCount: 2 };
    const p1 = confirmedEnv([upcoming(1)], 10, { nextCursor: 'p2', mirror: m });
    const p2 = confirmedEnv([upcoming(2)], 10, { mirror: m });
    const fn = (async (u: RequestInfo | URL) => jsonResponse(new URL(String(u)).searchParams.get('cursor') ? p2 : p1)) as typeof fetch;
    const c = make(fn);
    await settle();
    expect(c.state).toBe('held');
    expect(c.events.map((e) => e.id)).toEqual([uuid(1), uuid(2)]);
  });

  it('the state info carries the note and the times', async () => {
    const c = make(serve(confirmedEnv([upcoming(1)], 91)).fn);
    const infos: unknown[] = [];
    c.on('state', (_s, info) => infos.push(info));
    await settle();
    expect(infos).toEqual([{ note: 'Events last updated 6:29 am.', dataAt: iso(NOW - 2 * MIN), confirmedAt: iso(NOW - 91 * MIN) }]);
  });

  it('a failure after ready keeps the previous events while their data is at most 6 h old', async () => {
    const s = serve(confirmedEnv([upcoming(1, { endsAt: iso(NOW + 9 * 60 * MIN) })]), () => jsonResponse({ error: 'unavailable' }, 503));
    const c = make(s.fn);
    await settle();
    expect(c.state).toBe('ready');
    await c.refresh();
    expect(c.state).toBe('failed');
    expect(c.events.map((e) => e.id)).toEqual([uuid(1)]);
    // 6 h later the kept data is too old: dropped on the next failure
    vi.setSystemTime(NOW + 6 * 60 * MIN + 5 * MIN);
    await c.refresh();
    expect(c.events).toEqual([]);
  });

  it('rejects bad options', () => {
    const f = serve(confirmedEnv([])).fn;
    expect(() => createController({ season: 'easter' as 'halloween', year: 2026, tz: TZ, localBox: LOCAL_BOX, fetch: f })).toThrow('tv_options');
    expect(() => createController({ season: 'halloween', year: 2026.5, tz: TZ, localBox: LOCAL_BOX, fetch: f })).toThrow('tv_options');
    expect(() => createController({ season: 'halloween', year: 2026, tz: '', localBox: LOCAL_BOX, fetch: f })).toThrow('tv_options');
    expect(() => createController({ season: 'halloween', year: 2026, tz: TZ, localBox: { ...LOCAL_BOX, minLat: Number.NaN }, fetch: f })).toThrow('tv_options');
  });
});

describe('AC-W2-06 lifecycle', () => {
  const lightsEv = upcoming(1);
  const vibesEv = upcoming(2, { origin: 'vibes', description: null, summary: 'Ours.', formerIds: [uuid(90)], pageUrl: 'https://truckeevibes.com/e/two/' });
  const base = () => confirmedEnv([lightsEv, vibesEv, upcoming(3)]);
  const overlay = () => document.body.querySelector(':scope > [data-tv-overlay]') as HTMLElement | null;
  const panel = () => overlay()?.shadowRoot?.querySelector('aside.tv-panel') ?? null;

  it('(a) a controller with no mounts still emits events', async () => {
    const c = make(serve(base()).fn);
    const got: WidgetEvent[][] = [];
    c.on('events', (e) => got.push(e));
    await settle();
    expect(got).toHaveLength(1);
    expect(got[0].map((e) => e.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('(b) unmounting the list and mounting upcoming keeps events, selection and an open sheet', async () => {
    const c = make(serve(base()).fn);
    await settle();
    const a = document.body.appendChild(document.createElement('div'));
    const un = c.mountList(a);
    expect(a.shadowRoot?.querySelectorAll('.erow')).toHaveLength(3);
    expect(c.open(uuid(1))).toBe(true);
    un();
    expect(a.shadowRoot?.childNodes.length).toBe(0);
    const b = document.body.appendChild(document.createElement('div'));
    c.mountUpcoming(b, { onSeeAll: () => {} });
    expect(b.shadowRoot?.querySelectorAll('.erow')).toHaveLength(3);
    expect(c.events).toHaveLength(3);
    expect(c.isOpen()).toBe(true);
    expect(c.openId()).toBe(uuid(1));
    expect(panel()).not.toBeNull();
    // remounting the same element reuses its shadow root
    c.mountList(a);
    expect(a.shadowRoot?.querySelectorAll('.erow')).toHaveLength(3);
  });

  it('(c) open by lights id, vibes id and former id emits the canonical id; unknown -> false, no emit', async () => {
    const c = make(serve(base()).fn);
    await settle();
    const opened: string[] = [];
    c.on('open', (id) => opened.push(id));
    expect(c.open(uuid(1))).toBe(true);
    expect(c.open(uuid(2))).toBe(true);
    expect(c.open(uuid(90))).toBe(true); // former id of event 2: already open, same canonical id -> idempotent
    expect(c.open(uuid(1))).toBe(true);
    expect(c.open(uuid(1))).toBe(true); // same id again: no second emit
    expect(opened).toEqual([uuid(1), uuid(2), uuid(1)]);
    c.close();
    expect(c.open(uuid(90))).toBe(true);
    expect(opened.at(-1)).toBe(uuid(2));
    expect(c.open(uuid(77))).toBe(false);
    expect(opened).toHaveLength(4);
  });

  it('(d) close emits once; a second close is a no-op', async () => {
    const c = make(serve(base()).fn);
    await settle();
    const closed: string[] = [];
    c.on('close', (id) => closed.push(id));
    c.open(uuid(3));
    c.close();
    c.close();
    expect(closed).toEqual([uuid(3)]);
    expect(c.isOpen()).toBe(false);
    expect(c.openId()).toBeNull();
    expect(panel()).toBeNull();
    expect(overlay()).not.toBeNull(); // the host stays
  });

  it('(e) Escape closes', async () => {
    const c = make(serve(base()).fn);
    await settle();
    c.open(uuid(1));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(c.isOpen()).toBe(false);
  });

  it('(f) focus moves to the sheet heading and returns to the opener inside another shadow root', async () => {
    const c = make(serve(base()).fn);
    await settle();
    const host = document.body.appendChild(document.createElement('div'));
    const sr = host.attachShadow({ mode: 'open' });
    const btn = sr.appendChild(document.createElement('button'));
    btn.textContent = 'opener';
    btn.focus();
    expect(sr.activeElement).toBe(btn);
    c.open(uuid(1));
    const h2 = overlay()!.shadowRoot!.querySelector('h2.etitle') as HTMLElement;
    expect(h2.getAttribute('tabindex')).toBe('-1');
    expect(overlay()!.shadowRoot!.activeElement).toBe(h2);
    c.close();
    expect(sr.activeElement).toBe(btn);
  });

  it('(f2) focus is not restored to an opener that left the document', async () => {
    const c = make(serve(base()).fn);
    await settle();
    const btn = document.body.appendChild(document.createElement('button'));
    btn.focus();
    c.open(uuid(1));
    btn.remove();
    expect(() => c.close()).not.toThrow();
  });

  it('(g) the overlay host is a direct child of body, created once across 3 opens', async () => {
    const c = make(serve(base()).fn);
    await settle();
    for (const id of [uuid(1), uuid(2), uuid(3)]) {
      c.open(id);
      c.close();
    }
    c.open(uuid(1));
    expect(document.body.querySelectorAll('[data-tv-overlay]')).toHaveLength(1);
    expect(overlay()!.parentElement).toBe(document.body);
    expect(overlay()!.shadowRoot!.querySelectorAll('aside[role=dialog]')).toHaveLength(1);
  });

  it('(h) destroy removes the overlay host and stops timers', async () => {
    const s = serve(base());
    const c = make(s.fn);
    await settle();
    const el = document.body.appendChild(document.createElement('div'));
    c.mountList(el);
    c.open(uuid(1));
    const n = s.calls.length;
    c.destroy();
    expect(overlay()).toBeNull();
    expect(el.shadowRoot?.childNodes.length).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.calls.length).toBe(n);
    expect(c.open(uuid(1))).toBe(false);
    expect(() => c.destroy()).not.toThrow();
  });

  it('(i) headless: open() is false, no overlay, mounts are no-ops', async () => {
    const c = make(serve(base()).fn, { headless: true });
    const got: WidgetEvent[][] = [];
    c.on('events', (e) => got.push(e));
    await settle();
    expect(got).toHaveLength(1);
    const el = document.body.appendChild(document.createElement('div'));
    c.mountList(el)();
    c.mountUpcoming(el, { onSeeAll: () => {} })();
    expect(el.shadowRoot).toBeNull();
    expect(c.open(uuid(1))).toBe(false);
    expect(overlay()).toBeNull();
  });

  it('(j) the 60 s tick drops an event 1 h after its end and emits only on change', async () => {
    // ended 29.5 min ago: listed until NOW + 30.5 min, so the 5-min refresh at 30 min still has it and the tick at 31 min drops it
    const ending = upcoming(1, { startsAt: iso(NOW - 120 * MIN), endsAt: iso(NOW - 29.5 * MIN) });
    const c = make(serve(confirmedEnv([ending, upcoming(5)])).fn);
    const got: string[][] = [];
    c.on('events', (e) => got.push(e.map((x) => x.id)));
    await settle();
    expect(got).toEqual([[uuid(1), uuid(5)]]);
    await vi.advanceTimersByTimeAsync(25.5 * MIN);
    const n0 = got.length; // one emit per 5-min refresh so far
    await vi.advanceTimersByTimeAsync(4 * MIN); // ticks at 26..29 min, no refresh, nothing changed
    expect(got).toHaveLength(n0);
    await vi.advanceTimersByTimeAsync(1 * MIN); // the refresh at 30 min
    expect(got).toHaveLength(n0 + 1);
    expect(got.at(-1)).toEqual([uuid(1), uuid(5)]);
    await vi.advanceTimersByTimeAsync(1 * MIN); // the tick at 31 min
    expect(got).toHaveLength(n0 + 2);
    expect(got.at(-1)).toEqual([uuid(5)]);
    expect(c.events.map((e) => e.id)).toEqual([uuid(5)]);
  });

  it('(k) a refresh 5 min later swaps the data atomically', async () => {
    const s = serve(base(), confirmedEnv([upcoming(7), upcoming(8)]));
    const c = make(s.fn);
    const el = document.body.appendChild(document.createElement('div'));
    c.mountList(el);
    const got: string[][] = [];
    c.on('events', (e) => got.push(e.map((x) => x.id)));
    await settle();
    expect(el.shadowRoot!.querySelectorAll('.erow')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(s.calls).toHaveLength(2);
    expect(got).toEqual([[uuid(1), uuid(2), uuid(3)], [uuid(7), uuid(8)]]);
    expect(el.shadowRoot!.querySelectorAll('.erow')).toHaveLength(2);
    expect(c.events.map((e) => e.id)).toEqual([uuid(7), uuid(8)]);
  });

  it('a successful refresh that removes the open event closes the sheet and emits close (W2 review P2)', async () => {
    const c = make(serve(base(), confirmedEnv([upcoming(3)])).fn);
    await settle();
    const closed: string[] = [];
    c.on('close', (id) => closed.push(id));
    c.open(uuid(1));
    await c.refresh();
    expect(c.isOpen()).toBe(false);
    expect(closed).toEqual([uuid(1)]);
    expect(panel()).toBeNull();
  });

  it('a successful refresh that changes the open event redraws the sheet from the new data', async () => {
    const c = make(serve(base(), confirmedEnv([upcoming(1, { title: 'Renamed' }), upcoming(3)])).fn);
    await settle();
    c.open(uuid(1));
    await c.refresh();
    expect(c.openId()).toBe(uuid(1));
    expect(overlay()!.shadowRoot!.querySelector('h2.etitle')!.textContent).toBe('Renamed');
  });

  it('a failed refresh leaves the open sheet to the host (handoff contract)', async () => {
    const c = make(serve(base(), () => jsonResponse({ error: 'unavailable' }, 503)).fn);
    await settle();
    const closed: string[] = [];
    c.on('close', (id) => closed.push(id));
    c.open(uuid(1));
    await c.refresh();
    expect(c.state).toBe('failed');
    expect(c.isOpen()).toBe(true);
    expect(closed).toEqual([]);
  });

  it('the tick that expires the open event closes the sheet', async () => {
    const ending = upcoming(1, { startsAt: iso(NOW - 120 * MIN), endsAt: iso(NOW - 58 * MIN) });
    const c = make(serve(confirmedEnv([ending, upcoming(5)])).fn);
    await settle();
    c.open(uuid(1));
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(c.isOpen()).toBe(false);
  });

  it('an identical refresh keeps the focused row node (W2 review P2)', async () => {
    const c = make(serve(base()).fn);
    const el = document.body.appendChild(document.createElement('div'));
    c.mountList(el);
    await settle();
    const row = el.shadowRoot!.querySelectorAll<HTMLElement>('.erow')[1];
    row.focus();
    await c.refresh();
    expect(row.isConnected).toBe(true);
    expect(el.shadowRoot!.activeElement).toBe(row);
  });

  it('a changed refresh moves focus to the same event row, and close returns focus to the replacement row', async () => {
    const s = serve(base(), confirmedEnv([lightsEv, vibesEv, upcoming(3), upcoming(4)]), confirmedEnv([lightsEv, vibesEv, upcoming(3), upcoming(6)]));
    const c = make(s.fn);
    const el = document.body.appendChild(document.createElement('div'));
    c.mountList(el);
    await settle();
    const row = () => el.shadowRoot!.querySelector<HTMLElement>(`.erow[data-id="${uuid(2)}"]`)!;
    row().focus();
    await c.refresh();
    expect(el.shadowRoot!.activeElement).toBe(row());
    row().click();
    expect(c.openId()).toBe(uuid(2));
    const opener = row();
    await c.refresh();
    expect(opener.isConnected).toBe(false);
    c.close();
    expect(el.shadowRoot!.activeElement).toBe(row());
  });

  it('emits events before state on every load', async () => {
    const c = make(serve(base()).fn);
    const order: string[] = [];
    c.on('events', () => order.push('events'));
    c.on('state', () => order.push('state'));
    await settle();
    expect(order).toEqual(['events', 'state']);
  });

  it('refetches on visibilitychange only when the last fetch is over 5 min old', async () => {
    const s = serve(base());
    make(s.fn);
    await settle();
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(s.calls).toHaveLength(1);
    vi.setSystemTime(NOW + 6 * MIN); // the interval has not fired (fake clock jump only)
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(s.calls).toHaveLength(2);
  });

  it('uses the default endpoint with the season query', async () => {
    const s = serve(base());
    make(s.fn);
    await settle();
    expect(s.calls[0]).toBe('https://truckeevibes.com/api/v1/events?scope=lights&season=halloween&year=2026');
  });
});
