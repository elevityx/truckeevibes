// Crystal Bay Casino adapter (A14). Reads one WP REST route (`wp/v2/event`); the date, doors/show times, room and an age statement live in
// free text, so every grammar here is strict and fails closed: an event with anything ambiguous is dropped and counted, never guessed.
// Facts only: no description text or images are kept, the link goes to the casino's own event page, and Tixr is never fetched or emitted. Trust ships at review (A14 r3-1).
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { decodeUtf8, dedupe, makeEvent, sha256Hex, tzOf } from './common';
import { decodeEntities, plainText, toUtcFromLocal } from '../core/normalize';

const API_URL = 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100';
const LINK = /^https:\/\/www\.crystalbaycasino\.com\/[a-z0-9/-]{1,120}\/$/;
const MAX_BODY = 1_048_576;
const MAX_EVENTS = 100;
const MAX_TEXT = 20_000;
const CLASSIFIER_CAP = 4000;
const DAY_MS = 86_400_000;
const CONFIG_KEYS = new Set(['apiUrl', 'tz', 'defaultCategories']);

const VENUE = { address: '14 Tahoe Blvd, Crystal Bay, NV 89402', town: 'Crystal Bay', lat: 39.2275377, lng: -120.0046979 } as const;

export type CbcDrop =
  | 'oversize' | 'date_unparsed' | 'date_mixed' | 'date_multiple' | 'date_mismatch'
  | 'no_time' | 'time_multiple' | 'doors_only' | 'dst_gap' | 'out_of_window';

class Fail extends Error { constructor(readonly code: string) { super(code); } }

/** Plain text that keeps block and `<br>` boundaries as line breaks (the shared `plainText` joins blocks without a separator). */
export function cbcText(html: string): string {
  const broken = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|li|h[1-6]|tr|td|section|figure)\b[^>]*>/gi, '\n');
  const text = decodeEntities(broken.replace(/<[^>]*>/g, '')).replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ');
  return text.split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').trim()).filter((l) => l !== '').join('\n');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MDT = /\b(?:(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/gi;

/** The single complete date of the text, or why there is none. A year is never inferred. */
export function parseCbcDate(text: string): { date: string } | { drop: CbcDrop } {
  const complete = new Map<string, Set<number | null>>(); // date -> stated weekdays (null = none)
  const partial: { key: string; wd: number | null }[] = []; // year-less tokens: "mm-dd" + stated weekday
  let invalid = false;
  for (const m of text.matchAll(MDT)) {
    const mon = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3));
    if (m[4] === undefined) {
      partial.push({ key: `${String(mon + 1).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`, wd: m[1] ? WEEKDAYS.indexOf(m[1].toLowerCase().slice(0, 3)) : null });
      continue;
    }
    const y = Number(m[4]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mon, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mon || dt.getUTCDate() !== d) { invalid = true; continue; }
    const key = `${m[4]}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const wd = m[1] ? WEEKDAYS.indexOf(m[1].toLowerCase().slice(0, 3)) : null;
    const set = complete.get(key) ?? new Set<number | null>();
    set.add(wd);
    complete.set(key, set);
  }
  if (invalid) return { drop: 'date_unparsed' };
  if (complete.size === 0) return { drop: 'date_unparsed' };
  // A year-less token is a restatement (not a second date) when its month and day equal a complete date's; otherwise date_mixed (A14 r3-5).
  for (const p of partial) {
    const hit = [...complete].find(([k]) => k.slice(5) === p.key);
    if (!hit) return { drop: 'date_mixed' };
    hit[1].add(p.wd);
  }
  if (complete.size > 1) return { drop: 'date_multiple' };
  const [[date, wds]] = [...complete];
  const actual = new Date(`${date}T00:00:00Z`).getUTCDay();
  for (const wd of wds) if (wd !== null && wd !== actual) return { drop: 'date_mismatch' };
  return { date };
}

const T = String.raw`(\d{1,2})(?::([0-5]\d))?\s*([ap]m)\b`;
const SHOW = new RegExp(String.raw`\bshow(?:\s*time)?\s*:?\s*${T}`, 'gi');
const DOORS = new RegExp(String.raw`\bdoors?(?:\s*open)?\s*:?\s*${T}`, 'gi');
const ANY_TIME = new RegExp(String.raw`(?<![\d:])${T}`, 'gi');

function times(re: RegExp, text: string): { set: Set<string>; labelled: boolean } {
  const set = new Set<string>();
  let labelled = false;
  for (const m of text.matchAll(re)) {
    labelled = true;
    const h = Number(m[1]);
    if (h < 1 || h > 12) continue; // an hour outside 1-12 is ignored
    const hh = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    set.add(`${String(hh).padStart(2, '0')}:${m[2] ?? '00'}`);
  }
  return { set, labelled };
}

/** The show time: a labelled "show" time, else (with no doors label either) the single time in the text. Doors alone never counts. */
export function parseCbcTime(text: string): { time: string } | { drop: CbcDrop } {
  const show = times(SHOW, text).set;
  if (show.size > 1) return { drop: 'time_multiple' };
  if (show.size === 1) return { time: [...show][0] };
  if (times(DOORS, text).labelled) return { drop: 'doors_only' };
  const any = times(ANY_TIME, text).set;
  if (any.size === 0) return { drop: 'no_time' };
  if (any.size > 1) return { drop: 'time_multiple' };
  return { time: [...any][0] };
}

const ROOM_NAME: Record<string, 'Crown Room' | 'Red Room'> = { crown: 'Crown Room', red: 'Red Room' };

/** The room from a title suffix (stripped), else the single room named in the text. A venue label only; it never implies an age. */
export function parseCbcRoom(title: string, text: string): { title: string; room?: 'Crown Room' | 'Red Room' } {
  const s = /\s+[-–—|]\s+(crown room|red room)\s*$/i.exec(title);
  if (s) return { title: title.slice(0, s.index).trim(), room: ROOM_NAME[s[1].toLowerCase().split(' ')[0]] };
  const rooms = new Set([...text.matchAll(/\b(crown|red) room\b/gi)].map((m) => m[1].toLowerCase()));
  return rooms.size === 1 ? { title, room: ROOM_NAME[[...rooms][0]] } : { title };
}

interface Entry { id: number; link: string; title: string; content: string }

function entriesOf(body: Uint8Array, headers: Headers): Entry[] {
  let json: unknown;
  try { json = JSON.parse(decodeUtf8(body)); } catch { throw new Fail('layout_changed'); }
  if (!Array.isArray(json)) throw new Fail('layout_changed');
  if (json.length > MAX_EVENTS || Number(headers.get('x-wp-totalpages') ?? 1) > 1) throw new Fail('too_many_events');
  return json.map((raw: unknown) => {
    const e = raw as { id?: unknown; link?: unknown; title?: { rendered?: unknown }; content?: { rendered?: unknown } } | null;
    if (!e || typeof e !== 'object' || typeof e.id !== 'number' || !Number.isInteger(e.id) || typeof e.link !== 'string' || !LINK.test(e.link)
      || typeof e.title?.rendered !== 'string' || typeof e.content?.rendered !== 'string') throw new Fail('layout_changed');
    return { id: e.id, link: e.link, title: e.title.rendered, content: e.content.rendered };
  });
}

export const adapter: Adapter = {
  family: 'wprest_crystalbay',
  version: 'wprest_crystalbay.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const { source, now } = ctx;
    for (const k of Object.keys(source.config)) if (!CONFIG_KEYS.has(k)) throw new Error('config_key_unknown');
    if (source.config.apiUrl !== API_URL) throw new Error('config_apiUrl_unknown');
    const tz = tzOf(source.config);

    try {
      const res = await ctx.fetch(API_URL, { kind: 'api' });
      if (res.status !== 200) return { items: [], status: 'http_error', httpStatus: res.status };
      if (res.body.byteLength > MAX_BODY) throw new Fail('page_too_large');
      const entries = entriesOf(res.body, res.headers);

      const items: SourceEvent[] = [];
      const filteredBy: Record<string, number> = {};
      const drop = (r: CbcDrop) => { filteredBy[r] = (filteredBy[r] ?? 0) + 1; };
      const lo = now.getTime() - DAY_MS;
      const hi = now.getTime() + 120 * DAY_MS;
      for (const entry of entries) {
        const text = cbcText(entry.content);
        if (text.length > MAX_TEXT) { drop('oversize'); continue; }
        const date = parseCbcDate(text);
        if ('drop' in date) { drop(date.drop); continue; }
        const time = parseCbcTime(text);
        if ('drop' in time) { drop(time.drop); continue; }
        const startsAt = toUtcFromLocal(date.date, time.time, tz);
        if (startsAt === 'dst_gap') { drop('dst_gap'); continue; }
        const ms = Date.parse(startsAt);
        if (ms < lo || ms > hi) { drop('out_of_window'); continue; }

        const { title, room } = parseCbcRoom(plainText(entry.title), text);
        items.push(makeEvent({
          externalKey: `cbc:${entry.id}`, title, startsAt, allDay: false, tz,
          venueName: room ? `Crystal Bay Casino ${room}` : 'Crystal Bay Casino', ...VENUE,
          url: entry.link, ticketUrl: entry.link, family: 'wprest_crystalbay',
        }, text.replace(/https?:\/\/\S+/g, '').slice(0, CLASSIFIER_CAP)));
      }

      const filtered = Object.values(filteredBy).reduce((a, b) => a + b, 0);
      return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(res.body), filtered, filteredBy };
    } catch (e) {
      if (e instanceof Fail) return { items: [], status: 'parse_error', errorCode: e.code };
      throw e;
    }
  },
};
