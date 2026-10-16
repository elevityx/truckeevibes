import Lockup from '@/components/brand/Lockup';
import ListsMenu from '@/components/layout/ListsMenu';
import { LIST_ROUTES_LIVE, SHOW_THURSDAY_EMAIL } from '@/config/features';

export type HeaderCurrent = 'sources' | 'about' | 'privacy' | 'bot';

function Links({ current }: { current?: HeaderCurrent }) {
  return (
    <>
      {LIST_ROUTES_LIVE ? <ListsMenu /> : null}
      <a href="/sources/" aria-current={current === 'sources' ? 'page' : undefined}>Sources</a>
      <a href="/about/" aria-current={current === 'about' ? 'page' : undefined}>About</a>
      {SHOW_THURSDAY_EMAIL ? <a className="btn" href="/about/#thursday">Thursday email</a> : null}
    </>
  );
}

/** Site header, rendered by each server page (never by a client component). Below 760 px the links sit in a no-JS details menu. */
export default function Header({ current }: { current?: HeaderCurrent }) {
  return (
    <header className="nav wrap">
      <Lockup />
      <nav className="nav-links" aria-label="Site">
        <Links current={current} />
      </nav>
      <details className="menu">
        <summary aria-label="Menu">Menu</summary>
        <nav aria-label="Site menu">
          <Links current={current} />
        </nav>
      </details>
    </header>
  );
}
