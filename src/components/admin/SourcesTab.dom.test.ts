// @vitest-environment happy-dom
// AC-SV2-35 (Spec_Sources_V2 §10 DOM tests): the Sources tab mounted in a DOM with the data layer mocked. Run now stamps before it
// dispatches and never dispatches after a refused stamp; "needs setup" disables every Run now button and shows SETUP_NOTE; Cancel and
// Request read call the right RPCs; the 60 s refresh runs only while the tab is active and the page is visible.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adminSourceHealth = vi.fn();
const adminSetForceDue = vi.fn();
const adminSetReadRequest = vi.fn();
const adminDispatch = vi.fn();
const adminDispatchStatus = vi.fn();
const adminSetSourceEnabled = vi.fn();
const adminSetSourceTrust = vi.fn();

vi.mock('@/lib/data', async () => {
  const errors = await vi.importActual<typeof import('@/lib/data/errors')>('@/lib/data/errors');
  const types = await vi.importActual<typeof import('@/lib/data/types')>('@/lib/data/types');
  return {
    ...types,
    ...errors,
    adminSourceHealth: (...a: unknown[]) => adminSourceHealth(...a),
    adminSetForceDue: (...a: unknown[]) => adminSetForceDue(...a),
    adminSetReadRequest: (...a: unknown[]) => adminSetReadRequest(...a),
    adminDispatch: (...a: unknown[]) => adminDispatch(...a),
    adminDispatchStatus: (...a: unknown[]) => adminDispatchStatus(...a),
    adminSetSourceEnabled: (...a: unknown[]) => adminSetSourceEnabled(...a),
    adminSetSourceTrust: (...a: unknown[]) => adminSetSourceTrust(...a),
  };
});

import { DataError } from '@/lib/data/types';
import { PUBLIC_NOTICE, SETUP_NOTE } from './runNow';
import SourcesTab from './SourcesTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-01T20:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const H = 60 * MIN;

/** A source health row as adminSourceHealth returns it (the eight Sources V2 fields included). Untyped on purpose. */
function row(o: Record<string, unknown>) {
  return {
    slug: 'alibi-truckee', name: 'Alibi Ale Works', enabled: true, trust: 'auto', strictAuto: false, maxCards7d: null,
    ingestDisposition: 'permitted', termsRecheckAt: '2027-06-01T00:00:00Z', cadence: '24h', consecutiveFailures: 0,
    lastSuccessAt: iso(2 * H), lastRuns: [{ status: 'ok', finishedAt: iso(2 * H), found: 4, new: 0, changed: 0, errorCode: null }],
    openCards7d: 0, openCards14d: 0, heldRunsPending: 0,
    manualOnly: false, automationRestricted: false, nextDueAt: iso(-20 * H), lastGrantAt: iso(2 * H),
    forceDueAt: null, forceDueServedAt: null, readRequestedAt: null, readRequestServedAt: null, requestGrant: null,
    ...o,
  };
}
const SCHEDULED = row({});
const SCHEDULED2 = row({ slug: 'moodys-bistro', name: "Moody's Bistro" });
const PENDING = row({ slug: 'crystal-bay-casino', name: 'Crystal Bay Casino', forceDueAt: iso(10 * MIN) });
const MANUAL = row({
  slug: 'fiftyfifty-brewing', name: 'FiftyFifty Brewing', trust: 'review', manualOnly: true, automationRestricted: true, cadence: '24h',
  nextDueAt: iso(1 * H), lastGrantAt: iso(30 * H),
});
const MANUAL_PENDING = row({
  slug: 'bar-of-america', name: 'Bar of America', trust: 'review', manualOnly: true, automationRestricted: true,
  nextDueAt: iso(1 * H), lastGrantAt: iso(30 * H), readRequestedAt: iso(1 * H),
});
const ROWS = [SCHEDULED, SCHEDULED2, PENDING, MANUAL, MANUAL_PENDING];

let root: Root | null = null;
let box: HTMLElement;
let vis: DocumentVisibilityState = 'visible';
const onForbidden = vi.fn();

const tick = (ms = 1) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function settle() {
  for (let i = 0; i < 5; i++) await tick(1);
}
async function mount(active = true) {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => { root!.render(createElement(SourcesTab, { onForbidden, active })); });
  await settle();
}
async function rerender(active: boolean) {
  await act(async () => { root!.render(createElement(SourcesTab, { onForbidden, active })); });
  await settle();
}
const text = (el: Element = box) => (el.textContent ?? '').replace(/\s+/g, ' ');
function rowOf(name: string): HTMLElement {
  const li = [...box.querySelectorAll<HTMLElement>('li.hrow')].find((x) => text(x).includes(name));
  if (!li) throw new Error(`no row for ${name}`);
  return li;
}
function buttonIn(li: HTMLElement, label: string | RegExp): HTMLButtonElement | undefined {
  return [...li.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof label === 'string' ? (b.textContent ?? '').trim() === label : label.test(b.textContent ?? ''));
}
async function click(b: HTMLElement) {
  await act(async () => { b.click(); });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
  for (const f of [adminSourceHealth, adminSetForceDue, adminSetReadRequest, adminDispatch, adminDispatchStatus, onForbidden]) f.mockReset();
  adminSourceHealth.mockResolvedValue(ROWS);
  adminSetForceDue.mockImplementation(async (slug: string, on: boolean) => ({
    slug, at: on ? new Date(NOW).toISOString() : null, already: false, nextDueAt: null, lastGrantAt: null,
  }));
  adminSetReadRequest.mockImplementation(async (slug: string, on: boolean) => ({
    slug, at: on ? new Date(NOW).toISOString() : null, already: false, nextDueAt: null, lastGrantAt: null,
  }));
  adminDispatch.mockResolvedValue({ outcome: 'ok' });
  adminDispatchStatus.mockResolvedValue('configured');
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  box?.remove();
  vi.useRealTimers();
});

describe('AC-SV2-35 Sources tab: needs setup (SC2)', () => {
  it('every schedulable row reads "needs setup" and is disabled, SETUP_NOTE shows, and a click calls nothing', async () => {
    adminDispatchStatus.mockResolvedValue('needs_setup');
    await mount();
    expect(adminDispatchStatus).toHaveBeenCalledTimes(1);
    for (const r of [SCHEDULED, SCHEDULED2, PENDING]) {
      const b = buttonIn(rowOf(r.name), 'needs setup');
      expect(b, `${r.slug} needs setup button`).toBeDefined();
      expect(b!.disabled).toBe(true);
      expect(b!.getAttribute('aria-label')).toBe(`Run now for ${r.name} needs setup`);
      await click(b!);
    }
    expect(text()).toContain(SETUP_NOTE);
    const note = [...box.querySelectorAll('p[role="note"]')].find((p) => text(p).includes('Run now needs setup'));
    expect(note).toBeDefined();
    expect(adminSetForceDue).not.toHaveBeenCalled();
    expect(adminDispatch).not.toHaveBeenCalled();
  });
});

describe('AC-SV2-35 Sources tab: Run now (configured)', () => {
  it('stamps, then dispatches, in that order, and the row shows the dispatch text', async () => {
    await mount();
    const b = buttonIn(rowOf(SCHEDULED.name), 'Run now');
    expect(b, 'Run now button').toBeDefined();
    expect(b!.disabled).toBe(false);
    expect(b!.getAttribute('aria-label')).toBe(`Run now for ${SCHEDULED.name}`);
    await click(b!);
    expect(adminSetForceDue).toHaveBeenCalledWith(SCHEDULED.slug, true);
    expect(adminDispatch).toHaveBeenCalledTimes(1);
    expect(adminSetForceDue.mock.invocationCallOrder[0]).toBeLessThan(adminDispatch.mock.invocationCallOrder[0]);
    expect(text(rowOf(SCHEDULED.name))).toContain(
      `Ingest is starting; ${SCHEDULED.name} will be read in a few minutes. ${PUBLIC_NOTICE}`);
    expect(SETUP_NOTE).toContain('Run now needs setup');
    expect(text()).not.toContain(SETUP_NOTE);
  });

  it('a refused stamp (rate_limited / too_soon) sends no dispatch and the row shows the too-soon text', async () => {
    adminSetForceDue.mockRejectedValue(new DataError('rate_limited', 'too_soon'));
    await mount();
    await click(buttonIn(rowOf(SCHEDULED.name), 'Run now')!);
    expect(adminSetForceDue).toHaveBeenCalledWith(SCHEDULED.slug, true);
    expect(adminDispatch).not.toHaveBeenCalled();
    expect(text(rowOf(SCHEDULED.name))).toMatch(/Read in the last 30 minutes\. Run now opens /);
    expect(onForbidden).not.toHaveBeenCalled();
  });

  it('Cancel on a pending row clears the stamp and never dispatches', async () => {
    await mount();
    const li = rowOf(PENDING.name);
    expect(text(li)).toContain('Queued for the next Ingest run');
    const c = buttonIn(li, 'Cancel');
    expect(c, 'Cancel button').toBeDefined();
    await click(c!);
    expect(adminSetForceDue).toHaveBeenCalledWith(PENDING.slug, false);
    expect(adminSetForceDue).not.toHaveBeenCalledWith(PENDING.slug, true);
    expect(adminDispatch).not.toHaveBeenCalled();
  });
});

describe('AC-SV2-35 Sources tab: read on command rows', () => {
  it('shows the badge; Request read stamps a request, Cancel clears one, and no manual row ever dispatches', async () => {
    await mount();
    const li = rowOf(MANUAL.name);
    expect(li.querySelector('.pill')?.textContent).toBe('Read on command');
    expect(buttonIn(li, /Run now|needs setup/)).toBeUndefined();
    const req = buttonIn(li, 'Request read');
    expect(req, 'Request read button').toBeDefined();
    await click(req!);
    expect(adminSetReadRequest).toHaveBeenCalledWith(MANUAL.slug, true);
    expect(text(rowOf(MANUAL.name))).toContain('Read requested. The conductor reads it with scripts/manual-read.sh requested; nothing is fetched by the server.');

    const lp = rowOf(MANUAL_PENDING.name);
    expect(buttonIn(lp, 'Request read')).toBeUndefined();
    const c = buttonIn(lp, 'Cancel');
    expect(c, 'Cancel on the pending request').toBeDefined();
    await click(c!);
    expect(adminSetReadRequest).toHaveBeenCalledWith(MANUAL_PENDING.slug, false);
    expect(adminSetForceDue).not.toHaveBeenCalled();
    expect(adminDispatch).not.toHaveBeenCalled();
  });
});

describe('AC-SV2-35 Sources tab: refresh while active and visible', () => {
  it('active and visible: a second adminSourceHealth call after 60 s', async () => {
    await mount(true);
    const n0 = adminSourceHealth.mock.calls.length;
    expect(n0).toBeGreaterThanOrEqual(1);
    await tick(60_000);
    await settle();
    expect(adminSourceHealth.mock.calls.length).toBe(n0 + 1);
  });

  it('active=false: no refresh after 60 s', async () => {
    await mount(false);
    const n0 = adminSourceHealth.mock.calls.length;
    await tick(60_000);
    await settle();
    expect(adminSourceHealth.mock.calls.length).toBe(n0);
  });

  it('hidden page: no refresh after 60 s', async () => {
    vis = 'hidden';
    await mount(true);
    const n0 = adminSourceHealth.mock.calls.length;
    await tick(60_000);
    await settle();
    expect(adminSourceHealth.mock.calls.length).toBe(n0);
  });

  it('becoming visible while active reloads once; while inactive it does not', async () => {
    vis = 'hidden';
    await mount(true);
    const n0 = adminSourceHealth.mock.calls.length;
    vis = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(adminSourceHealth.mock.calls.length).toBe(n0 + 1);

    await rerender(false);
    const n1 = adminSourceHealth.mock.calls.length;
    vis = 'hidden';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    vis = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(adminSourceHealth.mock.calls.length).toBe(n1);
  });
});
