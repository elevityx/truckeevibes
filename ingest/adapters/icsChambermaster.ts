// ChamberMaster: HTML list for discovery, then one per-event iCalendar (spec S1.9 icsChambermaster, A2 cadence 72h).
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { decodeUtf8, dedupe, sha256Hex, tzOf } from './common';
import { parseIcs } from './ics';

const DETAIL = /^\/events\/details\/([A-Za-z0-9][A-Za-z0-9-]*-\d+)\/?$/;

export const adapter: Adapter = {
  family: 'ics_chambermaster',
  version: 'ics_chambermaster.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const listUrl = ctx.source.config.listUrl;
    if (typeof listUrl !== 'string' || !listUrl) throw new Error('config_listUrl_required');
    const list = await ctx.fetch(listUrl, { kind: 'html' });
    if (list.status !== 200) return { items: [], status: 'http_error', httpStatus: list.status };
    const origin = new URL(listUrl).origin;

    // discovery: only /events/details/<slug>-<id>; never the search pages or ?rendermode= variants
    const $ = cheerio.load(decodeUtf8(list.body));
    const ids: string[] = [];
    $('a[href]').each((_, el) => {
      let u: URL;
      try { u = new URL($(el).attr('href') ?? '', listUrl); } catch { return; }
      if (u.origin !== origin || /rendermode/i.test(u.search)) return;
      const m = DETAIL.exec(u.pathname);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });

    const items: SourceEvent[] = [];
    const hashes: string[] = [];
    const chosen = ids.slice(0, Math.max(0, ctx.source.page_cap - 1));
    for (const id of chosen) {
      const details = `${origin}/events/details/${id}`;
      const res = await ctx.fetch(`${origin}/events/addtocalendar/${id}?format=ICal`, { kind: 'feed' });
      if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status, errorCode: 'detail_http' };
      hashes.push(sha256Hex(res.body));
      const parsed = parseIcs(decodeUtf8(res.body), { now: ctx.now, tz: tzOf(ctx.source.config), eventUrl: details });
      for (const i of parsed.items) items.push({ ...i, url: details });
    }
    return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(hashes.join('\n')) };
  },
};
