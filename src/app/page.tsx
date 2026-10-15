import Link from 'next/link';
import SiteNav from '@/components/SiteNav';

// M0 placeholder shell. The event list replaces this in M1.
export default function Home() {
  return (
    <main className="page">
      <SiteNav />
      <h1 className="disp">Events in Truckee and North Lake Tahoe</h1>
      <p className="card">Events are coming soon.</p>
      <p>
        See where listings will come from on the <Link href="/sources/">sources</Link> page, how our crawler behaves on the{' '}
        <Link href="/bot/">bot</Link> page, or read <Link href="/about/">about</Link> this project.
      </p>
    </main>
  );
}
