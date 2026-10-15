import ListApp from '@/components/list/ListApp';

// The list is a client app: first paint from the build snapshot, then the live read.
export default function Home() {
  return <ListApp />;
}
