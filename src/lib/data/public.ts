import { getSupabase } from '@/lib/supabase/client';
import { toDataError } from './errors';
import { mapEvent, type EventRow } from './mapEvent';
import type { VibeEvent } from './types';
import { listSourcesPublic } from './sources';

/** list_events() returns at most 2,000 rows. A full page means the window was cut off. */
export const EVENT_ROW_CAP = 2000;
const DEFAULT_DAYS = 120;
const RETRY_DAYS = 60;

async function fetchRows(days: number): Promise<EventRow[]> {
  const { data, error } = await getSupabase().rpc('list_events', { p_days: days });
  if (error) throw error;
  return Array.isArray(data) ? (data as EventRow[]) : [];
}

/**
 * Upcoming published events. When the 2,000-row cap is hit and the window is longer than 60 days, retry once with
 * 60 days and report `truncated`. A window that is already 60 days or less is not retried.
 */
export async function listEventsWithMeta(days: number = DEFAULT_DAYS): Promise<{ events: VibeEvent[]; truncated: boolean }> {
  try {
    let rows = await fetchRows(days);
    let truncated = false;
    if (rows.length >= EVENT_ROW_CAP) {
      truncated = true;
      console.warn(`list_events hit the ${EVENT_ROW_CAP}-row cap for ${days} days`);
      if (days > RETRY_DAYS) rows = await fetchRows(RETRY_DAYS);
    }
    return { events: rows.map(mapEvent), truncated };
  } catch (e) {
    throw toDataError(e);
  }
}

export async function listEvents(days: number = DEFAULT_DAYS): Promise<VibeEvent[]> {
  return (await listEventsWithMeta(days)).events;
}

/** The public source list (name, homepage, status). */
export const listSources = listSourcesPublic;
