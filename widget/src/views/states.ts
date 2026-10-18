// Notes for the degraded states (plan §3.3): S2 held, S3 stale, S1 failed. Times are wall-clock in the region's zone.
import { el } from '../dom';
import { noteClock } from '../time';
import type { State, StateInfo } from '../types';
import { CREDIT_URL } from './credit';

export const FAILED_TEXT = "Events can't load right now. See them on truckeevibes.com.";

/** The plain-text note of a state, or null (ready / loading). `ref` is the time the data was last confirmed. */
export function noteText(state: State, ref: number | null, tz: string): string | null {
  if (state === 'failed') return FAILED_TEXT;
  if (ref === null) return null;
  if (state === 'held') return `Some events are being re-checked. List last confirmed ${noteClock(ref, tz)}.`;
  if (state === 'stale') return `Events last updated ${noteClock(ref, tz)}.`;
  return null;
}

/** The note element rendered above the list content, or null. */
export function renderNote(state: State, info: StateInfo): HTMLElement | null {
  if (!info.note) return null;
  if (state === 'failed') {
    return el('p', { class: 'tv-note', role: 'status' }, "Events can't load right now. See them on ",
      el('a', { href: CREDIT_URL, target: '_blank', rel: 'noopener' }, 'truckeevibes.com'), '.');
  }
  return el('p', { class: 'tv-note', role: 'status' }, info.note);
}
