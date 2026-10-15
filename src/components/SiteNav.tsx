import Link from 'next/link';

export default function SiteNav() {
  return (
    <nav className="site-nav" aria-label="Site">
      <Link className="disp" href="/">TruckeeVibes</Link>
      <Link href="/sources/">Sources</Link>
      <Link href="/bot/">Bot</Link>
      <Link href="/about/">About</Link>
    </nav>
  );
}
