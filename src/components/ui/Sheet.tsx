'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  label: string;
  onClose(): void;
  children: ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet below 760px, a right-hand panel at 760px and up, with a scrim on phones.
 * Escape closes it, Tab stays inside it, the first heading takes focus on open and focus returns on close.
 */
export default function Sheet({ label, onClose, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const heading = ref.current?.querySelector<HTMLElement>('h1,h2,h3');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onCloseRef.current();
      if (e.key !== 'Tab' || !ref.current) return;
      const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === heading)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </aside>
    </>
  );
}
