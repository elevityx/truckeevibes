// iCalendar parser (spec S1.9): recurrence expansion in local wall-clock time, occurrence identity, time zones.
import ICAL from 'ical.js';
import { isoZ, isValidZone, toUtcFromLocal } from '../core/normalize';
import type { SourceEvent } from '../types';
import { addDays, DEFAULT_TZ, makeEvent } from './common';

export interface IcsOptions { now: Date; tz?: string; eventUrl?: string; allowedHosts?: string[] }
export interface IcsResult { items: SourceEvent[]; dropped: Record<string, number>; truncated: number }

const DAY = 86_400_000;
const MAX_PER_UID = 60;
const ITER_CAP = 20_000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ymd = (t: ICAL.Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
const hms = (t: ICAL.Time) => `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;

type Instant = { ms: number; tz: string } | { drop: 'bad_tz' | 'dst_gap' };

/** A date-time to a UTC instant. Z -> UTC; a defined VTIMEZONE via ical.js; else the IANA name; floating -> default zone. */
function instantOf(t: ICAL.Time, tzidParam: string | undefined, defaultTz: string): Instant {
  const zone = t.zone;
  if (zone && zone.tzid === 'UTC') return { ms: Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second), tz: defaultTz };
  if (zone && zone.tzid !== 'floating') return { ms: t.toUnixTime() * 1000, tz: isValidZone(zone.tzid) ? zone.tzid : defaultTz };
  const name = tzidParam ?? defaultTz;
  if (!isValidZone(name)) return { drop: 'bad_tz' };
  const out = toUtcFromLocal(ymd(t), hms(t), name);
  if (out === 'dst_gap') return { drop: 'dst_gap' };
  return { ms: Date.parse(out), tz: name };
}

const ACTION = /^(find|see|check|click|register|join|rsvp|contact|call)\b/i;

/** True when the trimmed LOCATION is not a place: an http(s) URL, text with no letter (A8-1), or sentence-like text (A9-3). */
export function isNonPlaceLocation(loc: string): boolean {
  const t = loc.trim();
  if (/^https?:\/\//i.test(t) || !/\p{L}/u.test(t)) return true;
  const head = t.split(',')[0].trim();                                          // the name part, as facts() splits it
  const words = head.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);   // parenthetical notes don't count
  if (ACTION.test(head) && words.length >= 4) return true;                      // an instruction: "Find participating spots on ..."
  if (/[0-9]\s*:/.test(head)) return true;                                      // a schedule: "Night 1: Oct 16 at ...", "Doors 7:00"
  return words.length >= 10;                                                    // a sentence, not a name
}

/** The LOCATION as a link back, or undefined: https only, no userinfo, no port, host (lower-case) in allowedHosts (lower-cased, exact match). */
export function locationLink(loc: string, allowedHosts: readonly string[] | undefined): string | undefined {
  if (!allowedHosts || allowedHosts.length === 0) return undefined;
  try {
    const u = new URL(loc.trim());
    const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '' || !hosts.has(u.hostname.toLowerCase())) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

const stamp = (ms: number) => isoZ(ms).replace(/[-:]/g, '');
const txt = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

interface Frame { vevent: ICAL.Component; ev: ICAL.Event }

export function parseIcs(text: string, opts: IcsOptions): IcsResult {
  const defaultTz = opts.tz ?? DEFAULT_TZ;
  const winStart = opts.now.getTime() - DAY;
  const winEnd = opts.now.getTime() + 120 * DAY;
  const dropped: Record<string, number> = {};
  const drop = (r: string) => { dropped[r] = (dropped[r] ?? 0) + 1; };
  let truncated = 0;
  const items: SourceEvent[] = [];

  const root = new ICAL.Component(ICAL.parse(text));
  const groups = new Map<string, { masters: Frame[]; overrides: Frame[] }>();
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const uid = txt(vevent.getFirstPropertyValue('uid'));
    if (!uid || !vevent.hasProperty('dtstart')) continue;
    const g = groups.get(uid) ?? { masters: [], overrides: [] };
    (vevent.hasProperty('recurrence-id') ? g.overrides : g.masters).push({ vevent, ev: new ICAL.Event(vevent) });
    groups.set(uid, g);
  }

  const tzidOf = (f: Frame, prop: string) => txt(f.vevent.getFirstProperty(prop)?.getParameter('tzid'));

  /** Facts shared by every occurrence of one VEVENT (everything except the times). */
  function facts(f: Frame, uid: string) {
    const v = f.vevent;
    const loc = txt(v.getFirstPropertyValue('location'));
    let venueName: string | undefined;
    let address: string | undefined;
    let locLink: string | undefined;
    if (loc && isNonPlaceLocation(loc)) {
      locLink = locationLink(loc, opts.allowedHosts);   // A8-1: a URL or letterless LOCATION is not a venue
    } else if (loc) {
      const i = loc.indexOf(',');
      venueName = (i < 0 ? loc : loc.slice(0, i)).trim();
      address = i < 0 ? undefined : loc.slice(i + 1).trim();
    }
    const geo = v.getFirstPropertyValue('geo');
    const lat = Array.isArray(geo) ? Number(geo[0]) : undefined;
    const lng = Array.isArray(geo) ? Number(geo[1]) : undefined;
    const hints: string[] = [];
    for (const p of v.getAllProperties('categories')) for (const x of p.getValues()) if (typeof x === 'string') hints.push(x);
    return {
      title: txt(v.getFirstPropertyValue('summary')) ?? '',
      venueName, address, lat, lng, hints,
      url: txt(v.getFirstPropertyValue('url')) ?? opts.eventUrl ?? locLink,
      description: txt(v.getFirstPropertyValue('description')),
      cancelled: String(v.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED',
      uid,
    };
  }

  /** One occurrence -> item (or a counted drop). `start`/`end` are wall-clock times in the VEVENT's own zone. */
  function emit(f: Frame, uid: string, rid: string, start: ICAL.Time, end: ICAL.Time | null, recurring: boolean): 'in' | 'out' | 'dropped' {
    const x = facts(f, uid);
    const common = {
      externalKey: `${uid}#${rid}`, title: x.title, venueName: x.venueName, address: x.address, lat: x.lat, lng: x.lng, url: x.url,
      hints: x.hints, cancelled: x.cancelled, seriesUid: recurring ? uid : undefined,
    };
    if (start.isDate) {
      const sd = ymd(start);
      const ed = end && end.isDate ? ymd(end) : addDays(sd, 1);
      const midnight = toUtcFromLocal(sd, '00:00', defaultTz);
      if (midnight === 'dst_gap') { drop('dst_gap'); return 'dropped'; }
      const ms = Date.parse(midnight);
      if (ms < winStart || ms > winEnd) return 'out';
      items.push(makeEvent({ ...common, startsAt: midnight, allDay: true, startDate: sd, endDate: ed > sd ? ed : addDays(sd, 1), tz: defaultTz }, x.description));
      return 'in';
    }
    const s = instantOf(start, tzidOf(f, 'dtstart'), defaultTz);
    if ('drop' in s) { drop(s.drop); return 'dropped'; }
    if (s.ms < winStart || s.ms > winEnd) return 'out';
    let endsAt: string | undefined;
    if (end && !end.isDate) {
      const e = instantOf(end, tzidOf(f, 'dtend'), defaultTz);
      if (!('drop' in e) && e.ms > s.ms) endsAt = isoZ(e.ms);
    }
    items.push(makeEvent({ ...common, startsAt: isoZ(s.ms), endsAt, allDay: false, tz: s.tz }, x.description));
    return 'in';
  }

  /** The recurrence id of an override as the same string shape the expansion uses. */
  function ridOf(f: Frame): string | null {
    const t = f.vevent.getFirstPropertyValue('recurrence-id');
    if (!(t instanceof ICAL.Time)) return null;
    if (t.isDate) return `${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}`;
    const i = instantOf(t, tzidOf(f, 'recurrence-id'), defaultTz);
    return 'drop' in i ? null : stamp(i.ms);
  }

  for (const [uid, g] of groups) {
    const overrides = new Map<string, Frame>();
    for (const o of g.overrides) { const rid = ridOf(o); if (rid) overrides.set(rid, o); }
    const emitted = new Set<string>();

    for (const m of g.masters) {
      const recurring = m.ev.isRecurring();
      const start = m.ev.startDate;
      if (!recurring) {
        emit(m, uid, '', start, m.vevent.hasProperty('dtend') || m.vevent.hasProperty('duration') ? m.ev.endDate : null, false);
        continue;
      }
      const dur = m.vevent.hasProperty('dtend') || m.vevent.hasProperty('duration') ? m.ev.endDate.subtractDate(start) : null;
      const startTzid = tzidOf(m, 'dtstart');
      let count = 0;
      const it = m.ev.iterator();
      for (let n = 0; n < ITER_CAP; n++) {
        const t = it.next();
        if (!t) break;
        const inst = start.isDate ? null : instantOf(t, startTzid, defaultTz);
        if (inst && 'drop' in inst) { drop(inst.drop); continue; }
        const ms = inst ? inst.ms : Date.parse(toUtcFromLocal(ymd(t), '00:00', defaultTz) as string);
        if (!Number.isNaN(ms) && ms > winEnd + DAY) break;
        const rid = t.isDate ? `${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}` : stamp((inst as { ms: number }).ms);
        const ov = overrides.get(rid);
        if (ov) {
          emitted.add(rid);
          if (count >= MAX_PER_UID) { truncated++; continue; }
          const r = emit(ov, uid, rid, ov.ev.startDate, ov.vevent.hasProperty('dtend') || ov.vevent.hasProperty('duration') ? ov.ev.endDate : null, true);
          if (r === 'in') count++;
          continue;
        }
        if (!Number.isNaN(ms) && ms < winStart) continue;
        if (!Number.isNaN(ms) && ms > winEnd) continue;
        if (count >= MAX_PER_UID) { truncated++; continue; }
        let end: ICAL.Time | null = null;
        if (dur) { end = t.clone(); end.addDuration(dur); }
        const r = emit(m, uid, rid, t, end, true);
        if (r === 'in') count++;
      }
    }
    // overrides whose original slot was never produced by the expansion (moved into the window, or no master)
    for (const [rid, o] of overrides) {
      if (emitted.has(rid)) continue;
      emit(o, uid, rid, o.ev.startDate, o.vevent.hasProperty('dtend') || o.vevent.hasProperty('duration') ? o.ev.endDate : null, g.masters.length > 0);
    }
  }
  return { items, dropped, truncated };
}
