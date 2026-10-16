'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

interface Props {
  label: string;
  onClose(): void;
  children: ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** A handle drag closes the sheet past this distance (px) or this speed (px/ms). */
export const DRAG_CLOSE_PX = 80;
export const DRAG_CLOSE_SPEED = 0.5;
/** True when a finished handle drag of `dy` px over `ms` milliseconds should close the sheet. */
export const dragCloses = (dy: number, ms: number): boolean => dy > DRAG_CLOSE_PX || (dy > 0 && dy / Math.max(ms, 1) > DRAG_CLOSE_SPEED);

/**
 * Bottom sheet below 760px (a 40x4 handle drags it down to close), a 520px right-hand panel at 760px and up; a scrim on both.
 * Escape, the scrim and the handle drag close it, Tab stays inside it, the first heading takes focus on open and focus returns on close.
 * It slides in with a transform over the motion tokens (none under reduced motion).
 */
export default function Sheet({ label, onClose, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const [shown, setShown] = useState(false);
  const drag = useRef<{ y0: number; t0: number } | null>(null);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Two frames, so the off-screen position is painted before the transition to the open one starts.
  useEffect(() => {
    let b = 0;
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, []);

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

  const settle = () => {
    drag.current = null;
    if (ref.current) {
      ref.current.style.transition = '';
      ref.current.style.transform = '';
    }
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    drag.current = { y0: e.clientY, t0: e.timeStamp };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (ref.current) ref.current.style.transition = 'none';
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !ref.current) return;
    ref.current.style.transform = `translateY(${Math.max(0, e.clientY - drag.current.y0)}px)`;
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    const close = dragCloses(dy, e.timeStamp - d.t0);
    settle();
    if (close) onCloseRef.current();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={ref} className={`sheet${shown ? ' in' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="grab" aria-hidden="true" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={settle}>
          <span />
        </div>
        {children}
      </aside>
    </>
  );
}
