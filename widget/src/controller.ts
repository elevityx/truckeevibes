// The page-lifetime controller (W2.2): loads the season's events, decides the freshness state (plan §3.3), renders list / upcoming
// mounts and the one event sheet, and emits events for the host's own map. No cookies, no storage, no requests beyond `endpoint`.
import { DEFAULT_ENDPOINT, fetchAll } from './api';
import { notEnded, startClock } from './clock';
import { styleFor } from './mounts';
import type { Controller, ControllerOptions, State, StateInfo, WidgetEvent } from './types';
import type { ViewCtx } from './views/ctx';
import { renderList } from './views/list';
import { renderSheet } from './views/sheet';
import { noteText } from './views/states';
import { renderUpcoming } from './views/upcoming';

const MIN = 60_000;
export const REFRESH_MS = 5 * MIN;
export const STALE_AFTER_MS = 90 * MIN;
export const FAIL_AFTER_MS = 6 * 60 * MIN;

type Listener = (...a: never[]) => void;
type Mount = { el: HTMLElement; root: ShadowRoot; render(): void };

const ours = new WeakMap<HTMLElement, ShadowRoot>();

function validOptions(o: ControllerOptions): boolean {
  if (!o || (o.season !== 'halloween' && o.season !== 'christmas')) return false;
  if (!Number.isInteger(o.year) || typeof o.tz !== 'string' || o.tz.length === 0) return false;
  const b = o.localBox;
  return !!b && [b.minLat, b.maxLat, b.minLng, b.maxLng].every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** The focused element inside `root`, or null (guarded: some DOM shims throw when focus sits on a removed node). */
function activeIn(root: ShadowRoot): Element | null {
  try {
    return root.activeElement;
  } catch {
    return null;
  }
}

/** Deepest focused element, through open shadow roots. */
function deepActive(): HTMLElement | null {
  let a: Element | null = document.activeElement;
  while (a && a.shadowRoot && activeIn(a.shadowRoot)) a = activeIn(a.shadowRoot);
  return a instanceof HTMLElement ? a : null;
}

export function createController(o: ControllerOptions): Controller {
  if (!validOptions(o)) throw new TypeError('tv_options');
  const now = o.now ?? (() => Date.now());
  const fetchFn = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const endpoint = o.endpoint ?? DEFAULT_ENDPOINT;
  const headless = o.headless === true;

  let state: State = 'loading';
  let info: StateInfo = { note: null, dataAt: null, confirmedAt: null };
  let all: WidgetEvent[] = []; // sorted, as loaded
  let events: WidgetEvent[] = []; // not ended
  let lastDataAt: number | null = null; // the age reference of `all`
  let lastFetch = 0;
  let inflight: Promise<void> | null = null;
  let destroyed = false;
  let openEv: WidgetEvent | null = null;
  let opener: HTMLElement | null = null;
  let openerId: string | null = null;
  let overlayHost: HTMLElement | null = null;
  let overlayRoot: ShadowRoot | null = null;
  let renderKey = '';
  const listeners: Record<string, Set<Listener>> = { events: new Set(), state: new Set(), open: new Set(), close: new Set() };
  const mounts = new Set<Mount>();

  const emit = (ev: string, ...args: unknown[]) => {
    for (const fn of [...listeners[ev]]) (fn as (...a: unknown[]) => void)(...args);
  };
  const viewCtx = (): ViewCtx => ({
    season: o.season, year: o.year, tz: o.tz, localBox: o.localBox, now: now(), state, info, onOpen: (id) => void api.open(id),
  });
  /** Re-renders every mount; a focused event row gets focus back on its replacement (same event id). */
  const renderAll = () =>
    mounts.forEach((m) => {
      const id = activeIn(m.root)?.getAttribute('data-id') ?? null;
      m.render();
      if (id) m.root.querySelector<HTMLElement>(`.erow[data-id="${id}"]`)?.focus();
    });
  // What the mounts show: unchanged -> no re-render, so an identical refresh keeps every node (and keyboard focus) in place.
  const keyOf = (t: number) => `${state}|${info.note}|${new Date(t).toISOString().slice(0, 13)}|${JSON.stringify(events)}`;
  const rowFor = (id: string) => {
    for (const m of mounts) {
      const r = m.root.querySelector<HTMLElement>(`.erow[data-id="${id}"]`);
      if (r) return r;
    }
    return null;
  };

  function setData(next: WidgetEvent[], ref: number | null) {
    all = next;
    lastDataAt = ref;
    events = all.filter((e) => notEnded(e, now()));
  }

  async function load(): Promise<void> {
    lastFetch = now();
    const r = await fetchAll({ endpoint, season: o.season, year: o.year, fetch: fetchFn });
    if (destroyed) return;
    const t = now();
    let next: State;
    let ref: number | null = null;
    if ('error' in r || r.env.mirror.state === 'none') next = 'failed';
    else {
      const confirmed = r.env.mirror.confirmedAt ? Date.parse(r.env.mirror.confirmedAt) : Number.POSITIVE_INFINITY;
      ref = Math.min(Date.parse(r.env.dataAt), confirmed);
      const age = t - ref;
      if (age > FAIL_AFTER_MS) next = 'failed';
      else if (r.env.mirror.state === 'held') next = 'held';
      else if (r.env.stale || age > STALE_AFTER_MS) next = 'stale';
      else next = 'ready';
    }
    if (next === 'failed') {
      const keep = (state === 'ready' || state === 'held' || state === 'stale') && lastDataAt !== null && t - lastDataAt <= FAIL_AFTER_MS;
      if (!keep) setData([], null);
      else setData(all, lastDataAt);
      info = { note: noteText('failed', null, o.tz), dataAt: 'error' in r ? null : r.env.dataAt, confirmedAt: 'error' in r ? null : r.env.mirror.confirmedAt };
    } else if (!('error' in r)) {
      const sorted = r.events.slice().sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      setData(sorted, ref);
      info = { note: noteText(next, ref, o.tz), dataAt: r.env.dataAt, confirmedAt: r.env.mirror.confirmedAt };
    }
    state = next;
    const k = keyOf(t);
    if (k !== renderKey) {
      renderKey = k;
      renderAll();
    }
    // A failed read leaves an open sheet to the host's handoff (L1); a successful one reconciles it with the new data.
    if (next !== 'failed') reconcile();
    emit('events', events.slice());
    emit('state', state, { ...info });
  }

  function refresh(): Promise<void> {
    if (destroyed) return Promise.resolve();
    if (!inflight) inflight = load().finally(() => (inflight = null));
    return inflight;
  }

  // ---- timers ----
  const initial = setTimeout(() => void refresh(), 0);
  const interval = setInterval(() => void refresh(), REFRESH_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible' && now() - lastFetch > REFRESH_MS) void refresh();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  const stopClock = startClock((t) => {
    if (destroyed) return;
    const before = events.map((e) => e.id).join(',');
    events = all.filter((e) => notEnded(e, t));
    const changed = events.map((e) => e.id).join(',') !== before;
    const k = keyOf(t);
    if (k !== renderKey) {
      renderKey = k;
      renderAll();
    }
    if (changed) {
      reconcile();
      emit('events', events.slice());
    }
  }, now);

  // ---- mounts ----
  function mount(el: HTMLElement, draw: () => HTMLElement | null): () => void {
    if (headless || destroyed) return () => {};
    let root = ours.get(el);
    if (!root) {
      if (el.shadowRoot) throw new TypeError('tv_mount');
      root = el.attachShadow({ mode: 'open' });
      ours.set(el, root);
    }
    el.setAttribute('data-season', o.season);
    for (const m of mounts) if (m.el === el) mounts.delete(m);
    const r = root;
    const style = styleFor(r);
    const m: Mount = {
      el,
      root: r,
      render() {
        const content = draw();
        r.replaceChildren(...(style ? [style] : []), ...(content ? [content] : []));
      },
    };
    mounts.add(m);
    m.render();
    return () => {
      if (!mounts.has(m)) return;
      mounts.delete(m);
      r.replaceChildren();
    };
  }

  // ---- sheet ----
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') api.close();
  };
  function share(e: WidgetEvent) {
    if (o.onShare) return o.onShare(e);
    const data = { title: e.title, text: e.title, url: e.pageUrl ?? location.href };
    try {
      if (typeof navigator.share === 'function') void navigator.share(data).catch(() => {});
      else void navigator.clipboard?.writeText(data.url).catch(() => {});
    } catch {
      /* sharing is best effort */
    }
  }
  function ensureOverlay(): ShadowRoot {
    if (!overlayHost || !overlayRoot) {
      overlayHost = document.createElement('div');
      overlayHost.setAttribute('data-tv-overlay', '');
      overlayHost.setAttribute('data-season', o.season);
      overlayRoot = overlayHost.attachShadow({ mode: 'open' });
      document.body.appendChild(overlayHost);
    }
    return overlayRoot;
  }
  /** Draws the sheet for `e` into the overlay; `focus` moves focus to its heading. */
  function drawSheet(e: WidgetEvent, focus: boolean) {
    const root = ensureOverlay();
    const style = styleFor(root);
    const [scrim, panel] = renderSheet(e, { season: o.season, year: o.year, tz: o.tz, localBox: o.localBox, onClose: () => api.close(), onShare: share });
    root.replaceChildren(...(style ? [style] : []), scrim, panel);
    const h = panel.querySelector('h2');
    if (h) {
      h.setAttribute('tabindex', '-1');
      if (focus) h.focus();
    }
  }
  /** Keeps the open sheet in step with the data: closes it when its event is gone, redraws it when the event changed. */
  function reconcile() {
    if (!openEv) return;
    const cur = events.find((e) => e.id === openEv!.id);
    if (!cur) return api.close();
    if (JSON.stringify(cur) === JSON.stringify(openEv)) return;
    openEv = cur;
    drawSheet(cur, overlayRoot ? activeIn(overlayRoot) != null : false);
  }
  function resolve(id: string): WidgetEvent | null {
    return events.find((e) => e.id === id) ?? events.find((e) => e.formerIds.includes(id)) ?? null;
  }

  const api: Controller = {
    on(ev: string, fn: Listener) {
      const set = listeners[ev];
      if (!set || destroyed) return () => {};
      set.add(fn);
      return () => void set.delete(fn);
    },
    mountList: (el, mo) => mount(el, () => renderList(events, viewCtx(), mo?.onAdd ? () => mo.onAdd?.() : undefined)),
    mountUpcoming: (el, mo) => mount(el, () => renderUpcoming(events, viewCtx(), mo)),
    open(id) {
      if (headless || destroyed) return false;
      const e = resolve(id);
      if (!e) return false;
      if (openEv && openEv.id === e.id) return true;
      if (!openEv) {
        opener = deepActive();
        openerId = opener?.getAttribute('data-id') ?? null;
        document.addEventListener('keydown', onKey);
      }
      openEv = e;
      drawSheet(e, true);
      emit('open', e.id);
      return true;
    },
    close() {
      if (!openEv) return;
      const id = openEv.id;
      openEv = null;
      document.removeEventListener('keydown', onKey);
      overlayRoot?.replaceChildren();
      // The opener may have been replaced by a re-render: fall back to the current row of the same event.
      const back = opener && opener.isConnected ? opener : openerId ? rowFor(openerId) : null;
      opener = null;
      openerId = null;
      back?.focus();
      emit('close', id);
    },
    isOpen: () => openEv !== null,
    openId: () => openEv?.id ?? null,
    refresh,
    destroy() {
      if (destroyed) return;
      if (openEv) {
        openEv = null;
        document.removeEventListener('keydown', onKey);
      }
      destroyed = true;
      clearTimeout(initial);
      clearInterval(interval);
      stopClock();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      overlayHost?.remove();
      overlayHost = null;
      overlayRoot = null;
      for (const m of mounts) m.root.replaceChildren();
      mounts.clear();
      for (const k of Object.keys(listeners)) listeners[k].clear();
    },
    get state() {
      return state;
    },
    get events() {
      return events;
    },
  };
  return api;
}
