// Tahoe Donner events adapter (A13). Reads the server-rendered list and detail pages (robots allows /events/ and the event pages) and
// never the RSS feed, the calendar action views or the ai1ec exporter (the path guard in politeFetch forbids them). Every event is listed
// (owner decision r4); the drops that remain are data-quality ones. Only the page's own header date is read, never body dates.
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { decodeUtf8, dedupe, makeEvent, sha256Hex, tzOf } from './common';
import { toUtcFromLocal } from '../core/normalize';
import { expandTd, membersOnly, parseTdDate, parseTdTime, TD_MAX_DESCRIPTION, tdVenue, type TdDrop } from '../core/tahoeDonner';
import { capReasons } from '../core/reasonCodes';
import { FetchError, type FetchOut } from '../core/politeFetch';

// A hint list that fails in transport is ignored (the hints are optional); every guard error still ends the run.
const SOFT_HINT_ERRORS: ReadonlySet<string> = new Set(['network', 'timeout']);

const LIST_URL = 'https://www.tahoedonner.com/events/';
const DETAIL_URL = /^https:\/\/www\.tahoedonner\.com\/events\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const MAX_PAGE = 1_048_576;
const MAX_EVENTS = 35;
const CLASSIFIER_CAP = 4000;
const HINT_LISTS: { id: string; hint: string }[] = [
  { id: '94', hint: 'family events' }, { id: '180', hint: 'kids programming' }, { id: '95', hint: 'live music' },
];

class Fail extends Error { constructor(readonly code: string) { super(code); } }

interface ListEntry { postId: string; url: string }

/** Decodes one page. Oversize -> `page_too_large`; a page that does not reach `</html>` is truncated -> `layout_changed`. */
function pageHtml(res: FetchOut): string {
  if (res.body.byteLength > MAX_PAGE) throw new Fail('page_too_large');
  const html = decodeUtf8(res.body);
  if (!html.includes('</html>')) throw new Fail('layout_changed');
  return html;
}

/** `#sdbx-events > div.event` blocks: each needs a title, a post id and a detail link on our own host, else `layout_changed`. */
function parseList(html: string): ListEntry[] {
  const $ = cheerio.load(html);
  const box = $('#sdbx-events');
  if (box.length === 0) throw new Fail('layout_changed');
  const out: ListEntry[] = [];
  box.children('div.event').each((_, el) => {
    const b = $(el);
    const title = b.find('h2').first().text().replace(/\s+/g, ' ').trim();
    const id = /^event-(\d+)-excerpt$/.exec(b.find('[id^="event-"][id$="-excerpt"]').first().attr('id') ?? '')?.[1];
    const href = b.find('.event-action a[href]').first().attr('href') ?? '';
    if (!title || !id || !DETAIL_URL.test(href)) throw new Fail('layout_changed');
    out.push({ postId: id, url: href });
  });
  if (out.length > MAX_EVENTS) throw new Fail('too_many_events');
  return out;
}

interface Detail {
  title: string; dateText: string; hints: string[]; venueText: string; timeText: string | undefined; description: string;
}

function parseDetail(html: string, postId: string): Detail {
  const $ = cheerio.load(html);
  const body = $('body.single-sdbx_event');
  const pid = /(?:^|\s)postid-(\d+)(?:\s|$)/.exec(body.attr('class') ?? '')?.[1];
  const main = $('#main');
  const title = main.find('h1').first().text().replace(/\s+/g, ' ').trim();
  const dateEl = main.find('.pure-u-md-3-24.event-meta').first();
  const metaEl = main.find('.pure-u-md-21-24 .event-meta').first();
  if (body.length === 0 || pid !== postId || !title || dateEl.length === 0 || metaEl.length === 0) throw new Fail('layout_changed');

  dateEl.find('br').replaceWith(' ');
  const dateText = dateEl.text().replace(/[ \s]+/g, ' ').trim();
  const hints = metaEl.find('img[alt]').toArray().map((i) => ($(i).attr('alt') ?? '').replace(/ icon$/i, '').trim().toLowerCase()).filter(Boolean);
  metaEl.find('img').remove();
  const segs = metaEl.text().replace(/[ \s]+/g, ' ').split('|').map((x) => x.trim()).filter(Boolean);
  const venueText = segs[0] ?? '';
  const timeText = segs.length >= 2 ? segs[segs.length - 1] : undefined;

  main.find('.pure-g').first().remove();
  main.find('br,hr').replaceWith('\n');
  main.find('p,li,h1,h2,h3,h4,h5,h6,div,tr').append('\n');
  const description = main.text();
  return { title, dateText, hints, venueText, timeText, description };
}

export const adapter: Adapter = {
  family: 'html_tahoedonner',
  version: 'html_tahoedonner.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const { source, now } = ctx;
    if (source.config.listUrl !== LIST_URL) throw new Error('config_listUrl_unknown');
    const tz = tzOf(source.config);

    try {
      const main = await ctx.fetch(LIST_URL, { kind: 'html' });
      if (main.status !== 200) return { items: [], status: 'http_error', httpStatus: main.status };
      const mainHtml = pageHtml(main);
      const entries = parseList(mainHtml);
      const mainUrls = new Set(entries.map((e) => e.url));

      // Hint lists: usable only as a strict, non-empty subset of the main list reached without a redirect; otherwise ignored.
      const hintOf = new Map<string, string[]>();
      for (const { id, hint } of HINT_LISTS) {
        const url = `${LIST_URL}?categories%5B%5D=${id}`;
        let res: FetchOut;
        try { res = await ctx.fetch(url, { kind: 'html' }); }
        catch (e) { if (e instanceof FetchError && SOFT_HINT_ERRORS.has(e.code)) continue; throw e; }
        try {
          if (res.status !== 200 || res.finalUrl !== url) continue;
          const urls = parseList(pageHtml(res)).map((e) => e.url);
          if (urls.length === 0 || urls.length >= mainUrls.size || !urls.every((u) => mainUrls.has(u))) continue;
          for (const u of urls) hintOf.set(u, [...(hintOf.get(u) ?? []), hint]);
        } catch (e) {
          if (!(e instanceof Fail)) throw e;
        }
      }

      const items: SourceEvent[] = [];
      const filteredBy: Record<string, number> = {};
      const drop = (r: TdDrop) => { filteredBy[r] = (filteredBy[r] ?? 0) + 1; };
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        const res = await ctx.fetch(entry.url, { kind: 'html' });
        if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status };
        const d = parseDetail(pageHtml(res), entry.postId);

        if (d.description.length > TD_MAX_DESCRIPTION) { drop('oversize'); continue; }
        const date = parseTdDate(d.dateText);
        if (!date) { drop('date_unparsed'); continue; }
        const dates = expandTd(date, now, tz);
        if (typeof dates === 'string') { drop(dates); continue; }
        const time = d.timeText === undefined ? undefined : parseTdTime(d.timeText);
        if (!time) { drop('no_time'); continue; }

        const venue = tdVenue(d.venueText);
        const badge = membersOnly(d.title, d.description);
        const hints = [...d.hints, ...(venue?.hints ?? []), ...(hintOf.get(entry.url) ?? [])];
        const classifierText = d.description.slice(0, CLASSIFIER_CAP);
        let made = 0;
        for (const day of dates) {
          const startsAt = toUtcFromLocal(day, time.start, tz);
          const endsAt = time.end ? toUtcFromLocal(day, time.end, tz) : undefined;
          if (startsAt === 'dst_gap') continue;
          const e = makeEvent({
            externalKey: `td:${entry.postId}#${day}`, title: d.title, startsAt, endsAt: endsAt === 'dst_gap' ? undefined : endsAt, allDay: false, tz,
            venueName: venue?.name ?? d.venueText, address: venue?.address, town: 'Truckee', url: entry.url, hints, family: 'html_tahoedonner',
            seriesUid: date.kind === 'range' ? `td:${entry.postId}` : undefined,
          }, classifierText);
          if (badge) {
            e.categoriesHint = [...e.categoriesHint, 'members-only'];
            e.tagReasons = capReasons([...(e.tagReasons ?? []), 'cat:source_map']);
          }
          items.push(e);
          made++;
        }
        if (made === 0) drop('no_time'); // every date fell into a DST gap
      }

      const filtered = Object.values(filteredBy).reduce((a, b) => a + b, 0);
      return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(mainHtml), filtered, filteredBy };
    } catch (e) {
      if (e instanceof Fail) return { items: [], status: 'parse_error', errorCode: e.code };
      throw e;
    }
  },
};
