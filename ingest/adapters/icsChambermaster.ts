// ChamberMaster: HTML list for discovery, then one direct per-event iCalendar (spec S1.9 icsChambermaster, A2 cadence 72h,
// A9-1 windowed discovery from the 60-day list, A9-2 details-page address).
import * as cheerio from 'cheerio';
import { FetchError } from '../core/politeFetch';
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { addDays, decodeUtf8, dedupe, localDate, sha256Hex, tzOf } from './common';
import { parseIcs } from './ics';

const DETAIL = /^\/events\/details\/([A-Za-z0-9][A-Za-z0-9-]*-\d+)\/?$/;
const DAY = 86_400_000;
const SOFT_DETAIL_ERRORS = new Set(['timeout', 'network', 'too_large']);

const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const titleCase = (s: string) => s.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');

/** schema.org PostalAddress from a ChamberMaster details page, or {} when absent or unusable. */
export function parseChamberDetailAddress(html: string): { address?: string; town?: string } {
  const $ = cheerio.load(html);
  const adr = $('[itemprop="location"]').first().find('[itemprop="address"]').first();
  const get = (k: string) => {
    const el = adr.find(`[itemprop="${k}"]`).first();
    return squash(el.attr('content') ?? el.text());
  };
  const street = get('streetAddress');
  if (adr.length === 0 || !street) return {};
  const loc = titleCase(get('addressLocality'));
  const town = /^[\p{L} .'-]{2,60}$/u.test(loc) ? loc : undefined;
  const rawRegion = get('addressRegion');
  const lower = rawRegion.toLowerCase();
  const region = lower === 'california' ? 'CA' : lower === 'nevada' ? 'NV' : rawRegion.length > 0 && rawRegion.length <= 20 ? rawRegion : '';
  const address = [street, town, [region, get('postalCode')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (address.length > 160 || /[<>]/.test(address)) return {};
  return town ? { address, town } : { address };
}

export const adapter: Adapter = {
  family: 'ics_chambermaster',
  version: 'ics_chambermaster.3',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const listUrl = ctx.source.config.listUrl;
    if (typeof listUrl !== 'string' || !listUrl) throw new Error('config_listUrl_required');
    const list = await ctx.fetch(listUrl, { kind: 'html' });
    if (list.status !== 200) return { items: [], status: 'http_error', httpStatus: list.status };
    const base = new URL(listUrl);
    const origin = base.origin;
    const hosts = new Set(ctx.source.allowed_hosts.map((h) => h.toLowerCase()));

    // A9-1 step 2: a detail link on the list host or any allowed host; never search pages or ?rendermode= variants
    const idOf = (href: string | undefined): string | undefined => {
      let u: URL;
      try { u = new URL(href ?? '', listUrl); } catch { return undefined; }
      const h = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || (h !== base.hostname.toLowerCase() && !hosts.has(h)) || /rendermode/i.test(u.search)) return undefined;
      return DETAIL.exec(u.pathname)?.[1];
    };

    const $ = cheerio.load(decodeUtf8(list.body));
    const dated = new Map<string, string>();
    $('[itemtype]').each((_, el) => {
      if (!/schema\.org\/Event$/i.test($(el).attr('itemtype') ?? '')) return;
      let id: string | undefined;
      $(el).find('a[href]').each((__, a) => { id ??= idOf($(a).attr('href')); });
      const d = /^(\d{4}-\d{2}-\d{2})/.exec($(el).find('[itemprop="startDate"]').first().attr('content') ?? '')?.[1];
      if (id && d) { const prev = dated.get(id); dated.set(id, prev === undefined || d < prev ? d : prev); }
    });
    const ids: string[] = [];
    $('a[href]').each((_, el) => {
      const id = idOf($(el).attr('href'));
      if (id && !ids.includes(id)) ids.push(id);
    });

    // A9-1 step 4: window, earliest first, undated last (fail open)
    const cfgDays = ctx.source.config.windowDays;
    const windowDays = Math.min(Math.max(Number.isInteger(cfgDays) ? (cfgDays as number) : 45, 1), 120);
    const today = localDate(ctx.now, tzOf(ctx.source.config));
    const lo = addDays(today, -1);
    const hi = addDays(today, windowDays);
    let filtered = 0;
    const kept: Array<{ id: string; d?: string; at: number }> = [];
    ids.forEach((id, at) => {
      const d = dated.get(id);
      if (d !== undefined && (d < lo || d > hi)) { filtered++; return; }
      kept.push({ id, d, at });
    });
    kept.sort((a, b) => (a.d === undefined ? (b.d === undefined ? 0 : 1) : b.d === undefined ? -1 : a.d < b.d ? -1 : a.d > b.d ? 1 : 0) || a.at - b.at);

    // A9-1 step 5: 1 list request; per event 1 ICS + at most 1 details page
    const budget = Math.max(0, Math.floor((ctx.source.page_cap - 1) / 2));
    const latest = ctx.now.getTime() + (windowDays + 1) * DAY;
    const items: SourceEvent[] = [];
    const hashes: string[] = [];
    for (const { id } of kept.slice(0, budget)) {
      const details = `${origin}/events/details/${id}`;
      const res = await ctx.fetch(`${origin}/events/ical/${id}.ics`, { kind: 'feed' });
      if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status, errorCode: 'detail_http' };
      hashes.push(sha256Hex(res.body));
      const parsed = parseIcs(decodeUtf8(res.body), { now: ctx.now, family: ctx.source.family, tz: tzOf(ctx.source.config), eventUrl: details, allowedHosts: ctx.source.allowed_hosts });
      const mine: SourceEvent[] = [];
      for (const i of parsed.items) {
        if (Date.parse(i.startsAt) > latest) { filtered++; continue; }
        mine.push({ ...i, url: details });
      }
      if (mine.some((i) => i.venueName && !i.address)) {
        try {
          const page = await ctx.fetch(details, { kind: 'html' });
          if (page.status === 200) {
            const a = parseChamberDetailAddress(decodeUtf8(page.body));
            if (a.address) {
              for (const i of mine) {
                if (i.venueName && !i.address) { i.address = a.address; if (a.town) i.town = a.town; }
              }
            }
          }
        } catch (e) {
          if (!(e instanceof FetchError && SOFT_DETAIL_ERRORS.has(e.code))) throw e;
        }
      }
      items.push(...mine);
    }
    return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(hashes.join('\n')), filtered };
  },
};
