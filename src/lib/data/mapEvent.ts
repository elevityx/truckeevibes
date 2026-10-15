import type { PriceKind, VibeEvent } from './types';

// Pure row mapping for list_events(). No client import, so the build script can share it.
/** Only these columns are ever copied: an extra column on a row never reaches the page. */
export interface EventRow {
  id: string; slug: string; title: string; summary: string; starts_at: string; ends_at: string | null; all_day: boolean;
  start_date: string | null; end_date: string | null; time_known: boolean; venue: string | null; address: string | null;
  town: string | null; area: string | null; lat: number | null; lng: number | null; categories: string[] | null;
  price_kind: PriceKind; price_min: number | null; price_max: number | null; age: string; featured: boolean;
  url: string | null; ticket_url: string | null; sources: string[] | null;
}

export function mapEvent(r: EventRow): VibeEvent {
  return {
    id: r.id, slug: r.slug, title: r.title, summary: r.summary, startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day,
    startDate: r.start_date, endDate: r.end_date, timeKnown: r.time_known, venue: r.venue, address: r.address, town: r.town,
    area: r.area, lat: r.lat, lng: r.lng, categories: r.categories ?? [], priceKind: r.price_kind, priceMin: r.price_min,
    priceMax: r.price_max, age: r.age, featured: r.featured, url: r.url, ticketUrl: r.ticket_url, sources: r.sources ?? [],
  };
}
