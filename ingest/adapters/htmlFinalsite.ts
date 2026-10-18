// Finalsite (TTUSD) month-page adapter (A12). Reads the server-rendered calendar pages, never the robots-disallowed `/fs/` ICS export.
// Every anchor must parse or the whole run fails closed with `layout_changed`; the include decision is made by `core/ttusd`.
import type { Adapter, AdapterCtx, AdapterResult } from '../types';
import { decodeUtf8, localDate, sha256Hex, tzOf } from './common';
import { decodeEntities, toUtcFromLocal } from '../core/normalize';
import { filterSchoolItems, SCHOOLS, type RawOccurrence, type SchoolKey } from '../core/ttusd';

const OCCUR = /^(\d+)_(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)_(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/;
const TAG = /<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR = /\s([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const DAY_MS = 86_400_000;

class Layout extends Error { constructor() { super('layout_changed'); } }

function attrsOf(tag: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of tag.matchAll(ATTR)) m.set(x[1].toLowerCase(), x[2] ?? x[3] ?? '');
  return m;
}

/** A strict ISO instant (`YYYY-MM-DDTHH:MM:SSZ`) as epoch ms, or undefined when it is not a real date. */
function instant(s: string): number | undefined {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().replace('.000Z', 'Z') === s ? ms : undefined;
}

/** All event anchors of one page. Throws `Layout` on anything unexpected. */
function parsePage(html: string, tz: string, url: string): RawOccurrence[] {
  if (!html.includes('fsCalendarDaybox')) throw new Layout();
  const out: RawOccurrence[] = [];
  let anchors = 0;
  for (const tag of html.matchAll(TAG)) {
    const a = attrsOf(tag[0]);
    if (!(a.get('class') ?? '').split(/\s+/).includes('fsCalendarEventLink')) continue;
    anchors++;
    const title = decodeEntities(a.get('title') ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const m = OCCUR.exec(a.get('data-occur-id') ?? '');
    if (!title || !m) throw new Layout();
    const s = instant(m[2]);
    const e = instant(m[3]);
    if (s === undefined || e === undefined || e <= s) throw new Layout();
    const allDay = m[2].endsWith('T00:00:00Z') && m[3].endsWith('T00:00:00Z') && (e - s) % DAY_MS === 0;
    const o: RawOccurrence = { externalKey: `${m[1]}#${m[2]}`, title, allDay, startsAt: m[2], url };
    if (allDay) {
      o.startDate = m[2].slice(0, 10);
      o.endDate = m[3].slice(0, 10);
      const local = toUtcFromLocal(o.startDate, '00:00', tz);
      if (local === 'dst_gap') throw new Layout();
      o.startsAt = local;
    } else {
      o.endsAt = m[3];
    }
    out.push(o);
  }
  if ((html.match(/data-occur-id\s*=/gi) ?? []).length !== anchors) throw new Layout();
  return out;
}

export const adapter: Adapter = {
  family: 'html_finalsite',
  version: 'html_finalsite.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const { source, now } = ctx;
    const config = source.config;
    const calendarUrl = typeof config.calendarUrl === 'string' ? config.calendarUrl : '';
    if (!calendarUrl) throw new Error('config_calendarUrl_required');
    const school = config.school;
    if (typeof school !== 'string' || !Object.prototype.hasOwnProperty.call(SCHOOLS, school)) throw new Error('config_school_unknown');
    if (config.allowlist !== 'ttusd') throw new Error('config_allowlist_unknown'); // mandatory: fail closed
    const tz = tzOf(config);

    const [y, mo] = localDate(now, tz).split('-').map(Number);
    const months = Array.from({ length: 5 }, (_, i) => {
      const t = y * 12 + (mo - 1) + i;
      return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
    });

    const bodies: string[] = [];
    const byId = new Map<string, RawOccurrence>();
    try {
      for (const month of months) {
        const res = await ctx.fetch(`${calendarUrl}?cal_date=${month}`, { kind: 'html' });
        if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status };
        const html = decodeUtf8(res.body);
        bodies.push(html);
        for (const o of parsePage(html, tz, calendarUrl)) if (!byId.has(o.externalKey)) byId.set(o.externalKey, o);
      }
    } catch (e) {
      if (e instanceof Layout) return { items: [], status: 'parse_error', errorCode: 'layout_changed' };
      throw e;
    }

    const from = now.getTime() - DAY_MS;
    const to = now.getTime() + 120 * DAY_MS;
    const inWindow = [...byId.values()].filter((o) => { const t = Date.parse(o.startsAt); return t >= from && t <= to; });
    const { items, filtered } = filterSchoolItems(inWindow, school as SchoolKey, tz, now);
    return { items, status: 'ok', httpStatus: 200, contentHash: sha256Hex(bodies.join('\n')), filtered };
  },
};
