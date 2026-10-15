import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
export const ChevIcon = () => <Svg><path d="M9 6l6 6-6 6" /></Svg>;
export const XIcon = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const WebIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></Svg>;
export const CalIcon = () => <Svg><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5" /></Svg>;
export const DirIcon = () => <Svg><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></Svg>;
export const ShareIcon = () => <Svg><path d="M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" /></Svg>;
export const FilterIcon = () => <Svg><path d="M4 6h16M7 12h10M10 18h4" /></Svg>;
export const TicketIcon = () => <Svg><path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z" /><path d="M13 6v12" strokeDasharray="2 3" /></Svg>;
