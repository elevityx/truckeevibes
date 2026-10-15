import type { Metadata } from 'next';
import SiteNav from '@/components/SiteNav';
import SourcesList from '@/components/SourcesList';

export const metadata: Metadata = {
  title: 'Sources | TruckeeVibes',
  description: 'The calendars TruckeeVibes reads, and which of them are included yet.',
  alternates: { canonical: '/sources/' },
};

export default function SourcesPage() {
  return (
    <main className="page">
      <SiteNav />
      <h1 className="disp">Sources</h1>
      <p>
        These are the local calendars and sites we list events from. A source is read only after its terms are reviewed. Some
        are link-only: we point to them but never read them.
      </p>
      <SourcesList />
    </main>
  );
}
