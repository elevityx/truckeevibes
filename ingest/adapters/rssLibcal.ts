// LibCal RSS adapter (Spec_Kids_Live K1). Reads one public library month feed (`rss.php?cid=…&m=month[&cam=…]`) and keeps the facts of each
// item at the configured branch. Kids and family come only from the organizer's audience labels (DR-K3), carried as reserved `audience:*`
// hints that only the `rss_libcal` category map resolves. The description is used for classification only and never stored; images are
// never read. Every grammar fails closed: a malformed item is dropped and counted, and a feed that is mostly malformed fails the run.
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { addDays, decodeUtf8, dedupe, localDate, makeEvent, sha256Hex } from './common';
import { isValidZone, plainText, toUtcFromLocal } from '../core/normalize';

const KEYS = new Set(['feedUrl', 'campus', 'tz', 'venueName', 'address', 'town', 'lat', 'lng']);
const FEED_URL = /^https:\/\/[a-z0-9-]+\.libcal\.com\/rss\.php\?cid=\d{1,6}&m=month(?:&cam=\d{1,6})?$/;
const MAX_BODY = 1_048_576;
const MAX_ITEMS = 300;
const CLASSIFIER_CAP = 4000;
const HMS = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const ALL_DAY_ENDS = new Set(['', '00:00:00', '23:59:00', '23:59:59']);

const CHILD_AUDIENCE = /^(?:babies|baby|toddlers?|preschool|kids|children|tweens?|school age)\b/;
const AGE_BAND = /^ages?\s+(\d{1,2})\s*[-–]\s*(\d{1,2})\b/;
const ADULT_AUDIENCE = /\b(?:adults?|seniors?|grown[- ]?ups?)\b/; // anywhere in a label: "Children and Adults" is not a kids audience
const FAMILY_AUDIENCE = /^(?:families|family|all ages)\b/;

class Fail extends Error { constructor(readonly code: string) { super(code); } }
const bad = () => new Error('config_libcal_invalid');

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The organizer's audience labels -> reserved eligibility hints (DR-K3). Any adult audience vetoes both; `Teens` is neutral. */
export function audienceHints(labels: readonly string[]): string[] {
  const ls = labels.map(norm).filter((l) => l !== '');
  if (ls.some((l) => ADULT_AUDIENCE.test(l))) return [];
  const child = ls.some((l) => {
    if (CHILD_AUDIENCE.test(l)) return true;
    const m = AGE_BAND.exec(l);
    return !!m && +m[1] <= +m[2] && +m[2] <= 12;
  });
  const out: string[] = [];
  if (child) out.push('audience:kids');
  if (ls.some((l) => FAMILY_AUDIENCE.test(l))) out.push('audience:family');
  return out;
}

interface Cfg { feedUrl: string; host: string; campus: string; tz: string; venueName: string; address: string; town: string; lat: number; lng: number }

function validate(ctx: AdapterCtx): Cfg {
  const c = ctx.source.config;
  for (const k of Object.keys(c)) if (!KEYS.has(k)) throw bad();
  const str = (v: unknown, max: number): string => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(); return v; };
  const feedUrl = str(c.feedUrl, 200);
  if (!FEED_URL.test(feedUrl)) throw bad();
  const host = new URL(feedUrl).hostname.toLowerCase();
  if (!ctx.source.allowed_hosts.some((a) => host === a.toLowerCase())) throw bad();
  const tz = str(c.tz, 60);
  if (!isValidZone(tz)) throw bad();
  const { lat, lng } = c;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) throw bad();
  return {
    feedUrl, host, campus: str(c.campus, 80), tz, venueName: str(c.venueName, 80), address: str(c.address, 160), town: str(c.town, 60), lat, lng,
  };
}

const isDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const adapter: Adapter = {
  family: 'rss_libcal',
  version: 'rss_libcal.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const cfg = validate(ctx);
    const res = await ctx.fetch(cfg.feedUrl, { kind: 'feed', conditional: true });
    if (res.notModified) return { items: [], status: 'not_modified', httpStatus: res.status };
    if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status };
    try {
      if (res.body.byteLength > MAX_BODY) throw new Fail('layout_changed');
      const $ = cheerio.load(decodeUtf8(res.body), { xml: true });
      if ($('rss > channel').length !== 1) throw new Fail('layout_changed');
      const nodes = $('rss > channel > item').toArray();
      if (nodes.length > MAX_ITEMS) throw new Fail('too_many_events');

      const today = localDate(ctx.now, cfg.tz);
      const last = addDays(today, 120);
      const link = new RegExp(`^https://${cfg.host.replace(/\./g, '\\.')}/event/\\d{1,12}$`);
      const items: SourceEvent[] = [];
      const filteredBy: Record<string, number> = {};
      const drop = (code: string) => { filteredBy[code] = (filteredBy[code] ?? 0) + 1; };
      let shapeBad = 0;

      for (const n of nodes) {
        const el = $(n);
        const one = (tag: string) => el.children(tag.replace(':', '\\:')).first().text().trim();
        const all = (tag: string) => el.children(tag.replace(':', '\\:')).toArray().map((x) => $(x).text().trim());
        const id = one('libcal:eventid');
        const date = one('libcal:date');
        const start = one('libcal:start');
        const end = one('libcal:end');
        const url = one('link');
        const title = plainText(one('title'));
        if (!/^\d{1,12}$/.test(id) || !isDate(date) || !HMS.test(start) || !link.test(url) || title === '') { shapeBad++; drop('shape'); continue; }
        if (one('libcal:campus') !== cfg.campus) { drop('other_campus'); continue; }
        if (date < today || date > last) { drop('out_of_window'); continue; }

        const allDay = start === '00:00:00' && ALL_DAY_ENDS.has(end);
        let startsAt: string;
        let endsAt: string | undefined;
        if (allDay) {
          const m = toUtcFromLocal(date, '00:00', cfg.tz);
          if (m === 'dst_gap') { drop('dst_gap'); continue; }
          startsAt = m;
        } else {
          const s = toUtcFromLocal(date, start, cfg.tz);
          if (s === 'dst_gap') { drop('dst_gap'); continue; }
          startsAt = s;
          if (HMS.test(end) && end > start) {
            const e = toUtcFromLocal(date, end, cfg.tz);
            if (e !== 'dst_gap') endsAt = e;
          }
        }
        const hints = [...audienceHints(all('libcal:audience')), ...all('category').filter((l) => l !== '' && !l.includes(':'))];
        const description = plainText(one('libcal:description')).slice(0, CLASSIFIER_CAP);
        items.push(makeEvent({
          externalKey: `libcal:${cfg.host}#${id}`, title, startsAt, endsAt, allDay,
          startDate: allDay ? date : undefined, endDate: allDay ? addDays(date, 1) : undefined, tz: cfg.tz,
          venueName: cfg.venueName, address: cfg.address, town: cfg.town, lat: cfg.lat, lng: cfg.lng, url, hints, family: 'rss_libcal',
        }, description));
      }
      if (nodes.length >= 4 && shapeBad * 2 > nodes.length) throw new Fail('layout_changed');
      const filtered = Object.values(filteredBy).reduce((a, b) => a + b, 0);
      return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(res.body), filtered, filteredBy };
    } catch (e) {
      if (e instanceof Fail) return { items: [], status: 'parse_error', errorCode: e.code };
      throw e;
    }
  },
};
