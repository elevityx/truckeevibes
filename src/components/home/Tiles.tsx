import EventGlyph from '@/components/list/EventGlyph';
import { LIST_ROUTES_LIVE } from '@/config/features';
import { LISTS, type ListSlug } from '@/lib/lists';

interface Props {
  counts: Record<ListSlug, number>;
  active: ListSlug;
  onSelect(slug: ListSlug): void;
}

/**
 * The lists as tiles (canvas .tile). While LIST_ROUTES_LIVE is false (DR3) a tile is a button that toggles the in-page list; from R2a it is a
 * link. A list that is not ready shows a "Soon" badge instead of a count and does nothing.
 */
export default function Tiles({ counts, active, onSelect }: Props) {
  return (
    <section aria-label="The lists" className="tiles-sec">
      <p className="eyebrow">The lists</p>
      <nav className="tiles" aria-label="Lists">
        {LISTS.map((l) => {
          const on = l.slug === active;
          const inner = (
            <>
              <span className="glyph" aria-hidden="true"><EventGlyph categories={l.glyph ? [l.glyph] : []} /></span>
              <span className="lb">{l.label}</span>
              <span className="n">{l.ready ? counts[l.slug] : 'Soon'}</span>
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
      </nav>
    </section>
  );
}
