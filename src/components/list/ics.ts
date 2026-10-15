import type { VibeEvent } from '@/lib/data/types';
import { allDaySpan, calendarSpan, placeLine, safeWebsite } from './links';

// A small, pure .ics builder for "Add to calendar". Text values are escaped per RFC 5545 and lines are folded at 75 octets.

export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Fold a content line at 75 octets (continuation lines start with one space). */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // the leading space counts
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** `nowIso` is the DTSTAMP (injected so the output is deterministic in tests). */
export function buildIcs(e: VibeEvent, nowIso: string = new Date().toISOString()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TruckeeVibes//Events//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT'];
  lines.push(`UID:${e.id}@truckeevibes.com`, `DTSTAMP:${stamp(nowIso)}`);
  const day = allDaySpan(e);
  if (day) {
    lines.push(`DTSTART;VALUE=DATE:${day.start}`, `DTEND;VALUE=DATE:${day.end}`);
  } else {
    const { start, end } = calendarSpan(e);
    lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
  }
  lines.push(`SUMMARY:${icsEscape(e.title)}`);
  const site = safeWebsite(e.url);
  const desc = site ? `${e.summary}\n\n${site}` : e.summary;
  if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
  const place = placeLine(e);
  if (place) lines.push(`LOCATION:${icsEscape(place)}`);
  if (site) lines.push(`URL:${site}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function icsFileName(e: Pick<VibeEvent, 'slug'>): string {
  return `${e.slug.replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'event'}.ics`;
}
