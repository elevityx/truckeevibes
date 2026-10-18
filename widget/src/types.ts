// Public types of the TruckeeVibes events widget (W2). L1 (Truckee Lights) copies these into its loader.
export type Season = 'halloween' | 'christmas';
export interface Box { minLat: number; maxLat: number; minLng: number; maxLng: number }
export interface WidgetEvent {            // Lights PublicEvent shape (+ extras); description '' when absent
  id: string; title: string; description: string; venue: string | null; address: string; lat: number; lng: number;
  startsAt: string; endsAt: string | null; url: string | null; adultsOnly: boolean;
  origin: 'lights' | 'vibes'; formerIds: string[]; pageUrl: string | null; allDay: boolean; startDate: string | null;
  endDate: string | null; timeKnown: boolean }
export type State = 'loading' | 'ready' | 'held' | 'stale' | 'failed';
export interface StateInfo { note: string | null; dataAt: string | null; confirmedAt: string | null }
export interface ControllerOptions {
  season: Season; year: number; tz: string; localBox: Box;
  endpoint?: string;                    // default 'https://truckeevibes.com/api/v1/events'
  headless?: boolean;                   // shadow mode: no overlay, open() → false, mounts are no-ops
  onShare?(e: WidgetEvent): void;       // host share (Lights: shareOrCopy + toast); absent → navigator.share/clipboard fallback
  now?(): number; fetch?: typeof fetch; // tests
}
export interface Controller {
  on(ev: 'events', fn: (evs: WidgetEvent[]) => void): () => void;
  on(ev: 'state', fn: (s: State, info: StateInfo) => void): () => void;
  on(ev: 'open' | 'close', fn: (id: string) => void): () => void;
  mountList(el: HTMLElement, o?: { onAdd?(): void }): () => void;
  mountUpcoming(el: HTMLElement, o: { onAdd?(): void; onSeeAll(): void }): () => void;
  open(id: string): boolean; close(): void; isOpen(): boolean; openId(): string | null; refresh(): Promise<void>; destroy(): void;
  readonly state: State; readonly events: readonly WidgetEvent[];
}

/** The validated API envelope (only the keys the widget reads). */
export interface Envelope {
  dataAt: string;
  stale: boolean;
  mirror: { state: 'none' | 'confirmed' | 'held'; confirmedAt: string | null; heldSince: string | null; heldCount: number };
  nextCursor: string | null;
  events: unknown[];
}
