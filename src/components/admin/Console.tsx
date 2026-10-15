'use client';

import Link from 'next/link';
import SourcesTab from './SourcesTab';

interface Props {
  /** A forbidden error means the session may have dropped to aal1: re-run the gate. */
  onForbidden(): void;
  onSignOut(): void;
}

/** M0 console: one tab (Sources). Later milestones add tabs here. */
export default function Console({ onForbidden, onSignOut }: Props) {
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
          <button className="tab" role="tab" aria-selected="true" type="button">Sources</button>
        </div>
        <SourcesTab onForbidden={onForbidden} />
      </div>
    </div>
  );
}
