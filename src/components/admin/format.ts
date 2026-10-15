/** "5 min ago", "3 h ago", "2 d ago"; "never" for null. */
export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Whole minutes with one decimal under 10: 0.5, 4.2, 12. */
export function minutes(seconds: number): string {
  const m = seconds / 60;
  return m < 10 ? (Math.round(m * 10) / 10).toString() : Math.round(m).toString();
}

/** The current time in ms; a module-level function so event handlers can read the clock. */
export const nowMs = (): number => Date.now();
