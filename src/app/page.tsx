import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import ListApp from '@/components/list/ListApp';
import { firstPaint } from '@/lib/data/firstPaint';
import { readBuildSnapshot } from '@/lib/data/snapshotFile';
import { loadPicks } from '@/lib/picks';
import { readPicks } from '@/lib/picksFile';

// A server component: it runs once, at build, so the snapshot's rows are in the exported HTML (first paint).
// ListApp then reconciles with the live read. Header and Footer stay server-only.
export default function Home() {
  const snapshot = readBuildSnapshot();
  const fp = firstPaint(snapshot, 'all');
  // A bad picks file fails the build (readPicks throws); a pick whose event is gone or outside the week is dropped with a warning.
  const picks = loadPicks(readPicks(), snapshot.events, console.warn);
  return (
    <>
      <Header />
      <main>
        <ListApp list="all" {...fp} picks={picks} />
      </main>
      <Footer />
    </>
  );
}
