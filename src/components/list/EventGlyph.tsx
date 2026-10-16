import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  music: <><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  'food-drink': <><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 0-3 3-3 6 0 2 1 3 3 3v9" /></>,
  outdoors: <><path d="M3 18l6-9 4 6 2-3 6 6z" /><circle cx="17" cy="7" r="2" /></>,
  family: <><circle cx="9" cy="7" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3 20v-2a5 5 0 0 1 10 0v2M15 20v-1.5a3 3 0 0 1 6 0V20" /></>,
  arts: <><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-2 0-3 3-1 3-3a9 9 0 0 0-5-10z" /><circle cx="8" cy="10" r="1" /><circle cx="12" cy="7" r="1" /><circle cx="16" cy="10" r="1" /></>,
  community: <><circle cx="12" cy="7" r="3" /><path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" /></>,
  markets: <><path d="M4 9l1.5-5h13L20 9M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M5 11.5V20h14v-8.5" /></>,
  sports: <><path d="M3 10v4M6 8v8M18 8v8M21 10v4M6 12h12" /></>,
  nightlife: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" /></>,
  learning: <><path d="M4 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z" /></>,
  holiday: <><rect x="3" y="9" width="18" height="12" rx="1" /><path d="M2 9h20v-3H2zM12 6v15M12 6c-2-4-6-3-5 0M12 6c2-4 6-3 5 0" /></>,
  'halloween-fall': <><path d="M12 7c4-1 8 2 8 7 0 4-3 7-8 7s-8-3-8-7c0-5 4-8 8-7zM12 7c0-2 1-3 3-3" /></>,
};
const ALIAS: Record<string, string> = { kids: 'family' };

/** A line glyph for the event's first known category (`kids` uses the family glyph); a calendar for the rest. Decorative. Paths from the approved mockup. */
export default function EventGlyph({ categories }: { categories: readonly string[] }) {
  const key = categories.map((c) => ALIAS[c] ?? c).find((c) => c in GLYPHS);
  return <Svg>{key ? GLYPHS[key] : <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>}</Svg>;
}
