import type { Pick } from '@/lib/picks';
import PickCard from './PickCard';

/** The heading line by count: none for 1-2 picks, "Three a week" for 3, "A few a week" for 4-5. */
function intro(n: number): string | null {
  if (n === 3) return 'Three a week, from the local who keeps this list.';
  if (n >= 4) return 'A few a week, from the local who keeps this list.';
  return null;
}

/** Our picks (W9). 0 picks: nothing. Desktop: a grid of 3 columns; phone: a sideways scroll. */
export default function PicksRow({ picks, tz, onOpen }: { picks: readonly Pick[]; tz: string; onOpen(id: string): void }) {
  if (picks.length === 0) return null;
  const line = intro(picks.length);
  return (
    <section id="picks" className="picks" aria-label="Picked events">
      {line && (
        <div className="picks-h">
          <h2 className="h1">Our picks</h2>
          <p className="small">{line}</p>
        </div>
      )}
      <div className="picks-g">
        {picks.map((p) => (
          <PickCard key={p.event.id} pick={p} tz={tz} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}
