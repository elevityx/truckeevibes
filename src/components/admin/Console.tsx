'use client';

import Link from 'next/link';
import { useState } from 'react';
import QueueTab from './QueueTab';
import SourcesTab from './SourcesTab';

interface Props {
  /** A forbidden error means the session may have dropped to aal1: re-run the gate. */
  onForbidden(): void;
  onSignOut(): void;
}

type Tab = 'queue' | 'sources';

/** Console: the review queue and the source health board. Both tabs stay mounted so state survives a tab switch. */
export default function Console({ onForbidden, onSignOut }: Props) {
  const [tab, setTab] = useState<Tab>('queue');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="adm">
      <div className="adm-bar">
        <Link className="wm disp" href="/">TruckeeVibes</Link>
        <span className="tag">Back office</span>
        <span className="sp" />
        <button className="btn ghost" type="button" onClick={onSignOut}>Sign out</button>
      </div>
      <div className="adm-in">
        <div className="tabs" role="tablist">
          <button className="tab" role="tab" id="tab-queue" aria-selected={tab === 'queue'} aria-controls="pane-queue" type="button" onClick={() => setTab('queue')}>
            Queue{open !== null ? ` (${open})` : ''}
          </button>
          <button className="tab" role="tab" id="tab-sources" aria-selected={tab === 'sources'} aria-controls="pane-sources" type="button" onClick={() => setTab('sources')}>
            Sources
          </button>
        </div>
        <div role="tabpanel" id="pane-queue" aria-labelledby="tab-queue" hidden={tab !== 'queue'}>
          <QueueTab onForbidden={onForbidden} onCount={setOpen} />
        </div>
        <div role="tabpanel" id="pane-sources" aria-labelledby="tab-sources" hidden={tab !== 'sources'}>
          <SourcesTab onForbidden={onForbidden} />
        </div>
      </div>
    </div>
  );
}
