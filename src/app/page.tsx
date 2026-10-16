import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import ListApp from '@/components/list/ListApp';
import { firstPaint } from '@/lib/data/firstPaint';
import { readBuildSnapshot } from '@/lib/data/snapshotFile';

// A server component: it runs once, at build, so the snapshot's rows are in the exported HTML (first paint).
// ListApp then reconciles with the live read. Header and Footer stay server-only.
export default function Home() {
  const fp = firstPaint(readBuildSnapshot(), 'all');
  return (
    <>
      <Header />
      <main>
        <ListApp list="all" {...fp} picks={[]} />
      </main>
      <Footer />
    </>
  );
}
