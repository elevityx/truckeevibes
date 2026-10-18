'use client';

import Link from 'next/link';
import { useState } from 'react';
import QueueTab from './QueueTab';
import SourcesTab from './SourcesTab';
import LightsTab from './LightsTabPanel';   // not ./LightsTab: on a case-insensitive disk it would resolve to ./lightsTab.ts

interface Props {
  /** A forbidden error means the session may have dropped to aal1: re-run the gate. */
  onForbidden(): void;
  onSignOut(): void;
}

type Tab = 'queue' | 'sources' | 'lights';

/** Console: the review queue, the source health board and the Lights mirror (W3). All tabs stay mounted so state survives a tab switch. */
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
          <button className="tab" role="tab" id="tab-lights" aria-selected={tab === 'lights'} aria-controls="pane-lights" type="button" onClick={() => setTab('lights')}>
            Lights
          </button>
        </div>
        <div role="tabpanel" id="pane-queue" aria-labelledby="tab-queue" hidden={tab !== 'queue'}>
          <QueueTab onForbidden={onForbidden} onCount={setOpen} />
        </div>
        <div role="tabpanel" id="pane-sources" aria-labelledby="tab-sources" hidden={tab !== 'sources'}>
          <SourcesTab onForbidden={onForbidden} />
        </div>
        <div role="tabpanel" id="pane-lights" aria-labelledby="tab-lights" hidden={tab !== 'lights'}>
          <LightsTab onForbidden={onForbidden} />
        </div>
      </div>
    </div>
  );
}
