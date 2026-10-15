// Pure text and time helpers shared by the adapters (spec S1.8).
import type { SourceEvent } from '../types';

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', deg: '°', eacute: 'é', egrave: 'è', ntilde: 'ñ', middot: '·', bull: '•',
};

/** One pass: named, decimal and hex entities. Unknown entities are left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,10}));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name] ?? NAMED[String(name).toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
    return String.fromCodePoint(cp);
  });
}

/** Removes markup (titles and venues only) and collapses whitespace. Entities are decoded by the caller afterwards. */
export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** The text of a title or venue as the database wants it: no markup, entities decoded, single spaces. */
export function plainText(s: string): string {
  return decodeEntities(stripTags(s)).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Collapse spaces; cut to <= 80 characters at a word boundary. */
export function cleanTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= 80) return t;
  let cut = t.slice(0, 80);
  if (t[80] !== ' ') cut = cut.replace(/\s+\S*$/, '');
  cut = cut.trim();
  return cut === '' ? t.slice(0, 80) : cut;
}

export function isValidZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    dtfCache.set(tz, f);
  }
  return f;
}

/** The zone's UTC offset in ms at an instant. */
function offsetAt(tz: string, utcMs: number): number {
  const p = Object.fromEntries(dtf(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Local wall clock -> UTC instant, as `YYYY-MM-DDTHH:MM:SSZ`. A time that does not exist (spring-forward gap) returns
 * `'dst_gap'`; a time that exists twice (fall-back fold) resolves to the first, daylight, occurrence.
 */
export function toUtcFromLocal(date: string, time: string, tz: string): string | 'dst_gap' {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) throw new Error('bad_local_time');
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] ?? 0));
  const day = 86_400_000;
  const offsets = new Set([offsetAt(tz, wall - day), offsetAt(tz, wall + day)]);
  const hits: number[] = [];
  for (const off of offsets) {
    const cand = wall - off;
    if (offsetAt(tz, cand) === off) hits.push(cand);
  }
  if (hits.length === 0) return 'dst_gap';
  return isoZ(Math.min(...hits));
}

/** Lowercase host (the URL parser does this), no fragment, no `utm_*` parameters. */
export function canonicalUrl(u: string): string {
  const url = new URL(u);
  url.hash = '';
  const sp = new URLSearchParams(url.search);
  for (const k of [...sp.keys()]) if (k.toLowerCase().startsWith('utm_')) sp.delete(k);
  url.search = sp.toString();
  return url.href;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Cheap structural check before submit; the database stays the authority. */
export function validateSourceEvent(x: SourceEvent): SourceEvent | { invalid: string } {
  if (!x || typeof x !== 'object') return { invalid: 'item' };
  if (typeof x.externalKey !== 'string' || x.externalKey.length < 1) return { invalid: 'external_key' };
  if (typeof x.title !== 'string' || x.title.trim() === '') return { invalid: 'title' };
  if (x.allDay) {
    if (typeof x.startDate !== 'string' || typeof x.endDate !== 'string' || !YMD.test(x.startDate) || !YMD.test(x.endDate)) return { invalid: 'dates' };
  } else if (typeof x.startsAt !== 'string' || !ISO.test(x.startsAt) || Number.isNaN(Date.parse(x.startsAt))) {
    return { invalid: 'starts_at' };
  }
  return x;
}
