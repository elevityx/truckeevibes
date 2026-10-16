// Shared feed fetch for the ICS variants: one GET, status handling, parse.
import type { AdapterCtx, AdapterResult } from '../types';
import type { FetchOut } from '../core/politeFetch';
import { decodeUtf8, sha256Hex, tzOf } from './common';
import { parseIcs, type IcsResult } from './ics';

export type FeedOutcome = { ok: false; result: AdapterResult } | { ok: true; res: FetchOut; parsed: IcsResult; hash: string };

export async function fetchIcsFeed(ctx: AdapterCtx, url: string, o: { conditional?: boolean; eventUrl?: string } = {}): Promise<FeedOutcome> {
  const res = await ctx.fetch(url, { kind: 'feed', conditional: o.conditional });
  if (res.notModified) return { ok: false, result: { items: [], status: 'not_modified', httpStatus: res.status } };
  if (res.status !== 200) return { ok: false, result: { items: [], status: 'http_error', httpStatus: res.status } };
  const parsed = parseIcs(decodeUtf8(res.body), { now: ctx.now, family: ctx.source.family, tz: tzOf(ctx.source.config), eventUrl: o.eventUrl, allowedHosts: ctx.source.allowed_hosts });
  return { ok: true, res, parsed, hash: sha256Hex(res.body) };
}
