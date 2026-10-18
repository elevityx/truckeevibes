'use client';

// The demo host: picks a synthetic fixture by ?season=halloween|christmas&state=ok|held|stale|failed|empty|xss, mounts the widget's
// upcoming section and list, and feeds a stand-in "host map" (a list of pin ids) from on('events'). The fixtures are fixed in time
// (fixture clock below); the demo fetch moves them to today (data times by the exact offset, event times by whole days), so the
// page reads the same on any day. Under the e2e page clock the offset is zero and the fixtures are served as they are.
import { useEffect, useRef, useState } from 'react';
import { TOKENS } from '../../../widget/demo/lightsTokens';
import type { Controller, ControllerOptions, Season } from '../../../widget/src/types';

const CLOCK: Record<Season, number> = { halloween: Date.parse('2026-10-15T15:00:00Z'), christmas: Date.parse('2026-12-10T17:00:00Z') };
const STATES = ['ok', 'held', 'stale', 'failed', 'empty', 'xss'] as const;
const DAY = 86_400_000;
// Truckee's local event box (Lights eventBounds of the region bbox).
const LOCAL_BOX = { minLat: 39.1, maxLat: 39.5, minLng: -120.47, maxLng: -119.88 };


type Global = { createController(o: ControllerOptions): Controller; version: string };

function shiftIso(v: unknown, d: number): unknown {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v) + d).toISOString() : v;
}

/** fetch that moves a fixture from its fixture clock to now. */
function demoFetch(season: Season): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok) return res;
    const body = (await res.json()) as { dataAt?: unknown; mirror?: Record<string, unknown>; events?: Record<string, unknown>[] };
    const d = Date.now() - CLOCK[season];
    const days = Math.round(d / DAY) * DAY;
    body.dataAt = shiftIso(body.dataAt, d);
    if (body.mirror) for (const k of ['confirmedAt', 'heldSince']) body.mirror[k] = shiftIso(body.mirror[k], d);
    for (const e of body.events ?? []) for (const k of ['startsAt', 'endsAt']) e[k] = shiftIso(e[k], days);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export default function WidgetDemo({ src, integrity }: { src: string; integrity: string }) {
  const upcoming = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [label, setLabel] = useState('');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const season: Season = q.get('season') === 'christmas' ? 'christmas' : 'halloween';
    const s = q.get('state');
    const state = (STATES as readonly string[]).includes(s ?? '') ? (s as (typeof STATES)[number]) : 'ok';
    const html = document.documentElement;
    html.dataset.theme = season;
    let c: Controller | null = null;
    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onload = () => {
      const tv = (window as unknown as { TruckeeVibes?: Global }).TruckeeVibes;
      if (!tv || !upcoming.current || !list.current) return;
      setLabel(`${season} · ${state} · widget ${tv.version}`);
      c = tv.createController({
        season, year: 2026, tz: 'America/Los_Angeles', localBox: LOCAL_BOX,
        endpoint: `/widget-demo/fixture-${season}-${state}.json`, fetch: demoFetch(season),
      });
      c.on('events', (evs) => setPins(evs.map((e) => e.id)));
      c.on('state', (st) => (html.dataset.tvState = st));
      c.mountUpcoming(upcoming.current, { onSeeAll: () => list.current?.scrollIntoView() });
      c.mountList(list.current, { onAdd: () => {} });
    };
    document.head.appendChild(script);
    return () => {
      c?.destroy();
      script.remove();
      delete html.dataset.theme;
      delete html.dataset.tvState;
    };
  }, [src, integrity]);

  return (
    <main className="tl-demo">
      <style>{TOKENS}</style>
      <h1>TruckeeVibes events widget</h1>
      <p>Demo on synthetic data ({label}). The host page styles and the map are stand-ins.</p>
      <div data-tv-upcoming="" ref={upcoming} />
      <div data-tv-list="" ref={list} />
      <section aria-label="Host map pins">
        <p>Host map pins (ids from on(&apos;events&apos;)):</p>
        <ol data-pins="">
          {pins.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
