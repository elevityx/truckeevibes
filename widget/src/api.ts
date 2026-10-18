// Reads every page of one season from the events API and returns only after the last page (atomic): at most 4 pages, deduped by id.
import type { Envelope, Season, WidgetEvent } from './types';
import { validateEnvelope, validateRow } from './validate';

export const DEFAULT_ENDPOINT = 'https://truckeevibes.com/api/v1/events';
export const MAX_PAGES = 4;
export const FETCH_TIMEOUT_MS = 10_000;

export interface FetchOpts { endpoint: string; season: Season; year: number; fetch: typeof fetch; timeoutMs?: number }
export type FetchError = 'network' | 'http' | 'shape' | 'incomplete';
export type FetchResult = { env: Envelope; events: WidgetEvent[]; invalid: number } | { error: FetchError };

function pageUrl(o: FetchOpts, cursor: string | null): string {
  const u = new URL(o.endpoint, typeof location === 'undefined' ? undefined : location.href);
  u.searchParams.set('scope', 'lights');
  u.searchParams.set('season', o.season);
  u.searchParams.set('year', String(o.year));
  if (cursor) u.searchParams.set('cursor', cursor);
  return u.toString();
}

async function getPage(o: FetchOpts, cursor: string | null): Promise<Envelope | FetchError> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await o.fetch(pageUrl(o, cursor), { credentials: 'omit', cache: 'default', signal: ctl.signal });
    } catch {
      return 'network';
    }
    if (!res.ok) return 'http';
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return ctl.signal.aborted ? 'network' : 'shape';
    }
    return validateEnvelope(body) ?? 'shape';
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAll(o: FetchOpts): Promise<FetchResult> {
  let first: Envelope | null = null;
  let dataAt = '';
  let stale = false;
  const seen = new Set<string>();
  const events: WidgetEvent[] = [];
  let invalid = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const env = await getPage(o, cursor);
    if (typeof env === 'string') return { error: env };
    if (!first) {
      first = env;
      dataAt = env.dataAt;
    }
    if (env.dataAt < dataAt) dataAt = env.dataAt; // canonical ISO strings: string order = time order
    stale = stale || env.stale;
    for (const raw of env.events) {
      const e = validateRow(raw);
      if (!e) invalid++;
      else if (!seen.has(e.id)) {
        seen.add(e.id);
        events.push(e);
      }
    }
    cursor = env.nextCursor;
    if (cursor === null) return { env: { ...first, dataAt, stale, nextCursor: null, events: [] }, events, invalid };
  }
  return { error: 'incomplete' };
}
