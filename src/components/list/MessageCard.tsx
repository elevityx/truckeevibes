import type { ReactNode } from 'react';

/** A boxed message for the list states (canvas .card): a heading, body copy and optional actions. */
export default function MessageCard({ title, tone, children }: { title: string; tone?: 'danger'; children: ReactNode }) {
  return (
    <div className="card msg">
      <h2 className="h2" style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{title}</h2>
      {children}
    </div>
  );
}
