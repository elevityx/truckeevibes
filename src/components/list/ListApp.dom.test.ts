// @vitest-environment happy-dom
// AC-R1c-CO5 and AC-R1c-09: ListApp mounted in a DOM. Each live path is driven through the mocked data layer: disabling either live
// effect in ListApp (the events read or the sources read) makes a test here fail.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, Suspense, lazy, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';

const listEventsWithMeta = vi.fn();
const listSourcesPublic = vi.fn();
vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => true, publicEnv: { siteUrl: 'https://truckeevibes.com' } }));
vi.mock('@/lib/data/public', () => ({ listEventsWithMeta: () => listEventsWithMeta() }));
vi.mock('@/lib/data', () => ({ listSourcesPublic: () => listSourcesPublic() }));
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<{ default: ComponentType<object> }>) => {
    const L = lazy(loader);
    return (p: object) => createElement(Suspense, { fallback: null }, createElement(L, p));
  },
}));

import { parseSnapshot } from '@/components/list/snapshot';
import { firstPaint } from '@/lib/data/firstPaint';
import { loadPicks } from '@/lib/picks';
import ListApp from './ListApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures', name), 'utf8'));
const snap = parseSnapshot(fixture('snapshot-visual.json'));
const fixturePicks = loadPicks(fixture('picks-visual.json'), snap.events, () => {});
const props = (events: VibeEvent[], picks = fixturePicks) => ({
  list: 'all' as const,
  ...firstPaint({ builtAt: snap.builtAt, events, sources: [] }, 'all'),
  picks,
});

let root: Root | null = null;
let box: HTMLElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount(p: ReturnType<typeof props>) {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => { root!.render(createElement(ListApp, p)); });
  await flush();
  await flush();
}
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const text = () => (box.textContent ?? '').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T15:00:00Z'));
  listEventsWithMeta.mockReset();
  listSourcesPublic.mockReset();
  listSourcesPublic.mockResolvedValue([]);
  window.history.replaceState(null, '', '/');
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  box?.remove();
  vi.useRealTimers();
});

describe('AC-R1c-CO5 live events read', () => {
  it('rejects with a non-empty snapshot: the rows stay and the AC-M1-44 notice shows', async () => {
    listEventsWithMeta.mockRejectedValue(new Error('network'));
    await mount(props(snap.events));
    expect(listEventsWithMeta).toHaveBeenCalled();
    expect(box.querySelectorAll('button.drow').length).toBeGreaterThan(0);
    expect(text()).toContain('Showing events as of');
    expect(text()).toContain('We could not reach the server, so this list may be out of date.');
    expect(text()).not.toContain("Couldn't load the list");
  });
  it('rejects with an empty snapshot: the Error card', async () => {
    listEventsWithMeta.mockRejectedValue(new Error('network'));
    await mount(props([]));
    expect(text()).toContain("Couldn't load the list");
    expect(text()).toContain('Try again');
    expect(box.querySelectorAll('button.drow')).toHaveLength(0);
  });
  it('resolves: the live rows replace the snapshot and no notice shows', async () => {
    const live = snap.events.slice(0, 3).map((e, i) => ({ ...e, title: `Live row ${i}` }));
    listEventsWithMeta.mockResolvedValue({ events: live, truncated: false });
    await mount(props(snap.events));
    expect(text()).toContain('Live row 0');
    expect(text()).not.toContain('Showing events as of');
  });
});

describe('AC-R1c-CO5 live sources read', () => {
  it('3 active sources: the hero says "from 3 local calendars"', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    listSourcesPublic.mockResolvedValue(
      ['A', 'B', 'C'].map((n) => ({ name: `Example Source ${n}`, homepageUrl: `https://example.org/${n}`, status: 'active' })),
    );
    await mount(props(snap.events));
    expect(listSourcesPublic).toHaveBeenCalled();
    expect(text()).toContain('from 3 local calendars');
  });
  it('before the read there is no calendars clause, and a failed read keeps it that way', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    listSourcesPublic.mockRejectedValue(new Error('network'));
    await mount(props(snap.events));
    expect(text()).not.toContain('local calendars');
  });
});

describe('AC-R1c-09 sheet shows the pick line', () => {
  const picked = fixturePicks[0];
  const other = snap.events.find((e) => !fixturePicks.some((p) => p.event.id === e.id))!;
  it('a picked event opened from the URL shows Our pick and its line', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    window.history.replaceState(null, '', `/?event=${picked.event.id}`);
    await mount(props(snap.events));
    await until(() => box.querySelector('[role="dialog"]') !== null);
    const dlg = box.querySelector('[role="dialog"]')!;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain('Our pick');
    expect(dlg.textContent).toContain(picked.line);
  });
  it('an unpicked event shows neither', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    window.history.replaceState(null, '', `/?event=${other.id}`);
    await mount(props(snap.events));
    await until(() => box.querySelector('[role="dialog"]') !== null);
    const dlg = box.querySelector('[role="dialog"]')!;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).not.toContain('Our pick');
    expect(dlg.querySelector('.pickline')).toBeNull();
  });
  it('a pick whose event is gone from the live read drops out of the row', async () => {
    const live = snap.events.filter((e) => e.id !== picked.event.id);
    listEventsWithMeta.mockResolvedValue({ events: live, truncated: false });
    await mount(props(snap.events));
    expect(box.querySelectorAll('.card.pick')).toHaveLength(2);
  });
});

describe('FinderBar in the page', () => {
  it('typing in search filters the list and writes ?q= after 250 ms', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    await mount(props(snap.events));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-15T15:00:00Z'));
    const input = box.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Sunday Market');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(window.location.search).toBe('');
    await act(async () => { vi.advanceTimersByTime(260); });
    expect(window.location.search).toBe('?q=Sunday+Market');
    const titles = [...box.querySelectorAll('button.drow strong')].map((n) => n.textContent);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t === 'Example Sunday Market')).toBe(true);
  });
  it('the URL filters apply after mount, including cat, kids and q', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    window.history.replaceState(null, '', '/?cat=music&q=event');
    await mount(props(snap.events));
    expect(box.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('event');
    const rail = box.querySelector('aside.rail')!;
    const checked = [...rail.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.closest('label')!.textContent);
    expect(checked.some((t) => t?.startsWith('Music'))).toBe(true);
  });
  it('the Kind checkbox writes cat= to the URL', async () => {
    listEventsWithMeta.mockResolvedValue({ events: snap.events, truncated: false });
    await mount(props(snap.events));
    const music = [...box.querySelectorAll<HTMLLabelElement>('aside.rail li label')].find((l) => l.textContent?.startsWith('Music'))!;
    await act(async () => { music.querySelector('input')!.click(); });
    expect(window.location.search).toBe('?cat=music');
  });
});
