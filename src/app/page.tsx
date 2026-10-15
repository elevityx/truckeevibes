import ListApp from '@/components/list/ListApp';
import { readBuildSnapshot } from '@/lib/data/snapshotFile';

// A server component: it runs once, at build, so the snapshot's rows are in the exported HTML (first paint).
// ListApp then reconciles with the live read.
export default function Home() {
  return <ListApp initialSnapshot={readBuildSnapshot()} />;
}
