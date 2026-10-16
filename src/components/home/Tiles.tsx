import EventGlyph from '@/components/list/EventGlyph';
import { LIST_ROUTES_LIVE } from '@/config/features';
import { LISTS, type ListSlug } from '@/lib/lists';

interface Props {
  /** null = unknown: no counts are shown. */
  counts: Record<ListSlug, number> | null;
  active: ListSlug;
  onSelect(slug: ListSlug): void;
}

/** While the routes are off the tiles are a group of toggle buttons; once they are links (R2a) they are a nav. */
function Wrap({ children }: { children: React.ReactNode }) {
  return LIST_ROUTES_LIVE ? (
    <nav className="tiles" aria-label="Lists">{children}</nav>
  ) : (
    <div className="tiles" role="group" aria-label="Lists">{children}</div>
  );
}

/**
 * The lists as tiles (canvas .tile). While LIST_ROUTES_LIVE is false (DR3) a tile is a button that toggles the in-page list; from R2a it is a
 * link. A list that is not ready shows a "Soon" badge instead of a count and does nothing.
 */
export default function Tiles({ counts, active, onSelect }: Props) {
  return (
    <div className="tiles-sec">
      <p className="eyebrow">The lists</p>
      <Wrap>
        {LISTS.map((l) => {
          const on = l.slug === active;
          const inner = (
            <>
              <span className="glyph" aria-hidden="true"><EventGlyph categories={l.glyph ? [l.glyph] : []} /></span>
              <span className="lb">{l.label}</span>
              {!l.ready ? <span className="n">Soon</span> : counts ? <span className="n">{counts[l.slug]}</span> : null}
            </>
          );
          const cls = `tile${on ? ' on' : ''}${l.ready ? '' : ' soon'}`;
          return LIST_ROUTES_LIVE ? (
            <a key={l.slug} className={cls} href={l.path} aria-current={on ? 'page' : undefined}>{inner}</a>
          ) : (
            <button
              key={l.slug}
              type="button"
              className={cls}
              aria-pressed={on}
              aria-disabled={l.ready ? undefined : true}
              onClick={() => l.ready && onSelect(l.slug)}
            >
              {inner}
            </button>
          );
        })}
      </Wrap>
    </div>
  );
}
