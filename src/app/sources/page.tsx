import type { Metadata } from 'next';
import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import SourceGroups from '@/components/sources/SourceGroups';
import { readBuildSnapshot } from '@/lib/data/snapshotFile';

export const metadata: Metadata = {
  title: 'Sources | TruckeeVibes',
  description: 'The calendars TruckeeVibes reads, and which of them are included yet.',
  alternates: { canonical: '/sources/' },
};

// Server component: the snapshot rows are in the exported HTML (first paint); SourceGroups then reconciles with the live read.
export default function SourcesPage() {
  const { sources } = readBuildSnapshot();
  return (
    <>
      <Header current="sources" />
      <main className="wrap pg">
        <p className="eyebrow">Sources</p>
        <h1 className="h1">The calendars we read</h1>
        <SourceGroups initial={sources} />
        <aside className="aside" id="add">
          <p className="eyebrow">Organizers</p>
          <h2 className="h2">Ask to be included</h2>
          <p>Send us your public calendar page. To fix or remove a listing, use the same mailbox.</p>
          <a className="btn" href="mailto:takedown@truckeevibes.com?subject=Add%20my%20calendar">Ask to be included</a>
          <p><a href="/bot/">Our bot</a></p>
        </aside>
      </main>
      <Footer />
    </>
  );
}
