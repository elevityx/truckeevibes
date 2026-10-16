'use client';

import { useEffect, useState } from 'react';
import { listSourcesPublic } from '@/lib/data';
import { safeWebsite } from '@/components/list/links';
import type { SnapshotSource } from '@/components/list/snapshot';
import { supabaseConfigured } from '@/config/public-env';

type Status = SnapshotSource['status'];

/** The link for one source: only a plain https homepage becomes an href; otherwise the name shows unlinked. */
export function sourceLink(s: Pick<SnapshotSource, 'name' | 'homepageUrl'>): { name: string; href: string | null } {
  return { name: s.name, href: safeWebsite(s.homepageUrl) };
}

/** Host plus path for display: no scheme, no `www.`, no trailing slash. Display only; the href is never rewritten. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return url;
  }
}

const GROUPS: { status: Status; title: string; blurb: string; label: string; tone: string }[] = [
  { status: 'active', title: 'Calendars we read', blurb: 'We read these every morning and list what they publish, with a link back.', label: 'Read every morning', tone: 'active' },
  { status: 'paused', title: 'Not included yet', blurb: 'Public calendars we have found but do not read yet.', label: 'Not included yet', tone: 'paused' },
  { status: 'link_only', title: 'Link only', blurb: 'We point to these; we do not read them. Ask us if you would like your calendar read.', label: 'Link only', tone: 'link' },
];

/** One status row (canvas .srcrow): name (linked when safe), status label, domain line. */
function StatusRow({ s, label, tone }: { s: SnapshotSource; label: string; tone: string }) {
  const { name, href } = sourceLink(s);
  return (
    <li className="srcrow">
      {href ? <a href={href} rel="noopener noreferrer">{name}</a> : <span className="srow-name">{name}</span>}
      <span className={`status ${tone}`}>{label}</span>
      <span className="meta">{displayUrl(s.homepageUrl)}</span>
    </li>
  );
}

/**
 * The three source groups. First paint comes from the build snapshot; the live read then replaces it. A failed live read
 * keeps the snapshot. Text only (V6).
 */
export default function SourceGroups({ initial }: { initial: SnapshotSource[] }) {
  const [rows, setRows] = useState<SnapshotSource[]>(initial);
  // Until the live read answers, an empty list means "not known yet" (R1b-CO1), never "0 calendars".
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!supabaseConfigured()) return;
    let live = true;
    listSourcesPublic()
      .then((r) => {
        if (!live) return;
        if (r.length > 0) setRows(r);
        setSettled(true);
      })
      .catch(() => live && setSettled(true));
    return () => {
      live = false;
    };
  }, []);

  const by = (status: Status) => rows.filter((r) => r.status === status);
  const [a, p, l] = [by('active').length, by('paused').length, by('link_only').length];
  const unknown = rows.length === 0;
  return (
    <>
      {!unknown && <p className="proof">{`${a} read daily, ${p} not yet, ${l} link only. Every event on the list came from one of the first group.`}</p>}
      {GROUPS.map((g) => (
        <section key={g.status} className="sgroup" aria-labelledby={`g-${g.status}`}>
          <div className="dayh">
            <h2 className="gh" id={`g-${g.status}`}>{g.title}</h2>
            {!unknown && <span className="cnt">{by(g.status).length}</span>}
          </div>
          <p className="small">{g.blurb}</p>
          {unknown && !settled ? (
            <p className="small">Loading the calendar list…</p>
          ) : (
            <ul className="srows">
              {by(g.status).map((s) => (
                <StatusRow key={s.homepageUrl + s.name} s={s} label={g.label} tone={g.tone} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}
