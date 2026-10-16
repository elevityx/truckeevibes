import Link from 'next/link';

/** The TruckeeVibes lock-up: simple badge plus the two-tone wordmark. Server component, no client JS. */
/** `small` is the footer size (28 px badge, 24 px wordmark). */
export default function Lockup({ small = false }: { small?: boolean }) {
  return (
    <Link className={small ? 'lock sm' : 'lock'} href="/" aria-label="TruckeeVibes home">
      <svg className="lock-badge" viewBox="0 0 170 170" aria-hidden="true" focusable="false">
        <circle cx="85" cy="85" r="80" fill="var(--surface)" stroke="var(--ink)" strokeWidth="10" />
        <polyline points="30,108 58,72 80,92 104,58 140,108" fill="none" stroke="var(--river)" strokeWidth="14" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="124" cy="52" r="14" fill="var(--alpenglow)" />
      </svg>
      <span className="wm">
        Truckee<b>Vibes</b>
      </span>
    </Link>
  );
}
