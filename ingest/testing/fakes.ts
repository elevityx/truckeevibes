// Test support only (no application code): a fake clock, a recording fake network and a default grant source.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GrantOut } from '../types';

export const T0 = Date.parse('2026-10-15T12:00:00Z');

export function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url)), 'utf8');
}

/** A clock whose `sleep` advances it, so spacing assertions never wait in real time. */
export function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += Math.max(0, ms); },
    advance: (ms: number) => { t += ms; },
  };
}

export interface Call { url: string; method: string; headers: Headers; at: number; init: RequestInit }
export type Handler = (url: URL, init: RequestInit, call: Call) => Response | Promise<Response>;

/** Recording fake of `fetch`. Unrouted URLs answer 599 so a stray request is visible in `calls`. */
export function fakeNet(handler: Handler, now: () => number = () => T0) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call: Call = { url: url.href, method: (init.method ?? 'GET').toUpperCase(), headers: new Headers(init.headers), at: now(), init };
    calls.push(call);
    return handler(url, init, call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, urls: () => calls.map((c) => c.url) };
}

export const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
export const redirect = (to: string, status = 301) => new Response(null, { status, headers: { location: to } });

export function source(over: Partial<GrantOut['source']> = {}): GrantOut['source'] {
  return {
    slug: 'sample', family: 'ics', config: {}, allowed_hosts: ['a.test'], allowed_methods: ['feed', 'api', 'html'],
    page_cap: 10, etag: null, last_modified: null, content_hash: null,
    ingest_disposition: 'permitted', terms_recheck_at: '2027-10-14T00:00:00Z', ...over,
  };
}

export const UA = 'TruckeeVibesBot/1.0 (+https://truckeevibes.com/bot/)';
export const DESC_SENTINEL = 'SYNTHETIC-DESCRIPTION-SENTINEL';

/** The `SourceEvent` key set (plan 3.2) plus the S1.8/S1.9 additions: `seriesUid`, and `town` from the venue city. */
export const SOURCE_EVENT_KEYS = new Set([
  'externalKey', 'title', 'startsAt', 'endsAt', 'allDay', 'startDate', 'endDate', 'timeKnown', 'tz', 'venueName', 'address',
  'town', 'lat', 'lng', 'url', 'ticketUrl', 'priceText', 'ageText', 'categoriesHint', 'cancelled', 'rawSummaryLength', 'seriesUid',
  // classification output added next to the facts (S1.2 clean_source_item reads these)
  'priceKind', 'priceMin', 'priceMax', 'age', 'tagReasons',
]);

export interface PolitCall { url: string; kind: string; conditional?: boolean }
export type PolitHandler = (url: URL, opts: { kind: string; conditional?: boolean }) => { status?: number; body?: string; headers?: Record<string, string>; notModified?: boolean } | Promise<{ status?: number; body?: string; headers?: Record<string, string>; notModified?: boolean }>;

/** A fake `PoliteFetch` for adapter tests: records (url, kind, conditional) and returns a FetchOut. */
export function fakePolite(handler: PolitHandler) {
  const calls: PolitCall[] = [];
  const fn = async (url: string, opts: { kind: 'feed' | 'api' | 'html'; conditional?: boolean }) => {
    calls.push({ url, kind: opts.kind, conditional: opts.conditional });
    const r = await handler(new URL(url), opts);
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers ?? {}),
      body: new TextEncoder().encode(r.body ?? ''),
      notModified: r.notModified ?? false,
      finalUrl: url,
    };
  };
  return { fetch: fn, calls, urls: () => calls.map((c) => c.url) };
}
