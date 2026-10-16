// W9 "Our picks": the schema, the line lint and the loader. Pure, so the same code runs in tests, at build and in the page.
import type { VibeEvent } from '@/lib/data/types';
import { REGION_TZ } from '@/lib/filters/predicates';
import { addDays, startOfDay } from '@/lib/time/pacific';

export interface PicksFile {
  weekOf: string;
  picks: { eventId: string; line: string; photo?: { src: string; alt: string } }[];
}

export interface Pick {
  event: VibeEvent;
  line: string;
  photo: { src: string; alt: string } | null;
}

export const MAX_PICKS = 5;
export const MAX_LINE = 160;

/** Lint codes for one pick line: [] = ok. */
export function lintLine(line: string): string[] {
  const codes: string[] = [];
  if (line.length > MAX_LINE) codes.push('too_long');
  if (/https?:|www\./i.test(line)) codes.push('url');
  if (/\p{Extended_Pictographic}/u.test(line)) codes.push('emoji');
  const letters = line.match(/\p{L}/gu) ?? [];
  const first = letters[0];
  const allCaps = letters.length > 0 && line === line.toUpperCase();
  if (first === undefined || first !== first.toUpperCase() || first === first.toLowerCase() || allCaps) codes.push('case');
  return codes;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Throws `Error('picks: <code>')` for any schema or lint failure; returns the typed file. */
export function parsePicksFile(raw: unknown): PicksFile {
  const fail = (code: string): never => {
    throw new Error(`picks: ${code}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not_an_object');
  const o = raw as Record<string, unknown>;
  if (typeof o.weekOf !== 'string' || !realDate(o.weekOf)) return fail('bad_week_of');
  if (!Array.isArray(o.picks)) return fail('bad_picks');
  if (o.picks.length > MAX_PICKS) return fail('too_many_picks');
  const picks = o.picks.map((p: unknown, i: number) => {
    if (typeof p !== 'object' || p === null) return fail(`pick_${i}_not_an_object`);
    const q = p as Record<string, unknown>;
    if (typeof q.eventId !== 'string' || !UUID.test(q.eventId)) return fail(`pick_${i}_bad_event_id`);
    if (typeof q.line !== 'string') return fail(`pick_${i}_bad_line`);
    const lint = lintLine(q.line);
    if (lint.length > 0) return fail(`pick_${i}_line_${lint[0]}`);
    let photo: { src: string; alt: string } | undefined;
    if (q.photo !== undefined) {
      const ph = q.photo as Record<string, unknown> | null;
      if (typeof ph !== 'object' || ph === null) return fail(`pick_${i}_bad_photo`);
      if (typeof ph.src !== 'string' || !ph.src.startsWith('/photos/') || ph.src.includes('..')) return fail(`pick_${i}_bad_photo_src`);
      if (typeof ph.alt !== 'string' || ph.alt.length < 1 || ph.alt.length > 120) return fail(`pick_${i}_bad_photo_alt`);
      photo = { src: ph.src, alt: ph.alt };
    }
    return { eventId: q.eventId, line: q.line, ...(photo ? { photo } : {}) };
  });
  return { weekOf: o.weekOf, picks };
}

/**
 * Join the picks to events. A pick whose event is missing, or starts outside [weekOf 00:00 Pacific, +7 days), is dropped with a warning
 * (never a failure).
 */
export function loadPicks(file: unknown, events: readonly VibeEvent[], warn: (m: string) => void, tz: string = REGION_TZ): Pick[] {
  const f = parsePicksFile(file);
  const from = startOfDay(f.weekOf, tz);
  const to = startOfDay(addDays(f.weekOf, 7), tz);
  const out: Pick[] = [];
  for (const p of f.picks) {
    const event = events.find((e) => e.id === p.eventId);
    if (!event) {
      warn(`picks: dropped ${p.eventId.slice(0, 8)} not in the list`);
      continue;
    }
    const start = Date.parse(event.startsAt);
    if (start < from || start >= to) {
      warn(`picks: dropped ${p.eventId.slice(0, 8)} outside the week of ${f.weekOf}`);
      continue;
    }
    out.push({ event, line: p.line, photo: p.photo ?? null });
  }
  return out;
}
