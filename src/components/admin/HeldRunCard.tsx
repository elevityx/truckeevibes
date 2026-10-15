import type { HeldRun } from '@/lib/data/adminQueue';

/** A held ingest run: the sample of what it carried and why it was held. Text only. */
export default function HeldRunCard({ run }: { run: HeldRun }) {
  const reason =
    run.summary && typeof run.summary === 'object' && 'reason' in run.summary && typeof (run.summary as { reason: unknown }).reason === 'string'
      ? (run.summary as { reason: string }).reason
      : null;
  return (
    <div className="held">
      <p>
        <b>{run.itemCount}</b> {run.itemCount === 1 ? 'event' : 'events'} held{reason ? ` (${reason})` : ''}. Accept to publish them, or
        discard the run.
      </p>
      {run.sample.length > 0 && (
        <ul className="sample">
          {run.sample.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
          {run.itemCount > run.sample.length && <li className="fine">and {run.itemCount - run.sample.length} more</li>}
        </ul>
      )}
    </div>
  );
}
