'use client';

import { useEffect, useState } from 'react';
import { listSourcesPublic, toDataError, userMessage, type PublicSource, type PublicSourceStatus } from '@/lib/data';
import { supabaseConfigured } from '@/config/public-env';

const LABEL: Record<PublicSourceStatus, string> = {
  active: 'Included',
  link_only: 'Link only',
  paused: 'Not yet included',
};

/** Text-only rendering of list_sources_public(). Loads in an effect because the build prerenders with empty env. */
export default function SourcesList() {
  const [rows, setRows] = useState<PublicSource[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!supabaseConfigured()) {
      const t = setTimeout(() => setErr('The source list is not available right now.'), 0);
      return () => clearTimeout(t);
    }
    let live = true;
    listSourcesPublic()
      .then((r) => live && setRows(r))
      .catch((e) => live && setErr(userMessage(toDataError(e))));
    return () => {
      live = false;
    };
  }, []);

  if (err) return <p className="card" role="alert">{err}</p>;
  if (rows === null) return <p className="fine">Loading…</p>;
  return (
    <ul className="src-list">
      {rows.map((s) => (
        <li key={s.homepageUrl + s.name}>
          <a href={s.homepageUrl} rel="noopener noreferrer">{s.name}</a>
          <span className="fine">{LABEL[s.status]}</span>
        </li>
      ))}
    </ul>
  );
}
