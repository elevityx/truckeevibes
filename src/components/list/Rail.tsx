import { CATEGORY_LABELS, CATEGORY_SLUGS } from '@/lib/categories';
import type { BuildCounts } from '@/lib/data/firstPaint';
import type { Area } from '@/lib/data/types';
import { AREAS, AREA_LABELS, type FilterState } from '@/lib/filters/state';

interface Props {
  counts: Pick<BuildCounts, 'areas' | 'kinds' | 'sources'>;
  filters: FilterState;
  /** false = counts unknown: none are shown. Default true. */
  known?: boolean;
  onChange(next: FilterState): void;
}

/** The desktop rail (>= 1024 px): Area checkboxes with live counts, the Kind list, the calendars we read, the land acknowledgement. */
export default function Rail({ counts, filters, known = true, onChange }: Props) {
  const toggle = (a: Area) =>
    onChange({ ...filters, areas: filters.areas.includes(a) ? filters.areas.filter((x) => x !== a) : AREAS.filter((x) => x === a || filters.areas.includes(x)) });
  const toggleCat = (c: string) =>
    onChange({ ...filters, cats: filters.cats.includes(c) ? filters.cats.filter((x) => x !== c) : CATEGORY_SLUGS.filter((x) => x === c || filters.cats.includes(x)) });
  const order = (c: string) => CATEGORY_SLUGS.indexOf(c);
  const kinds = [...CATEGORY_SLUGS].sort((a, b) => (counts.kinds[b] ?? 0) - (counts.kinds[a] ?? 0) || order(a) - order(b));
  return (
    <aside className="rail" aria-label="Filters">
      <div>
        <h3 className="eyebrow">Area</h3>
        <ul>
          {AREAS.map((a) => (
            <li key={a}>
              <label>
                <input type="checkbox" checked={filters.areas.includes(a)} onChange={() => toggle(a)} />
                <span className="bx" aria-hidden="true" />
                {AREA_LABELS[a]}
                {known && <span className="n">{counts.areas[a] ?? 0}</span>}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="eyebrow">Kind</h3>
        <ul>
          {kinds.map((c) => (
            <li key={c}>
              <label>
                <input type="checkbox" checked={filters.cats.includes(c)} onChange={() => toggleCat(c)} />
                <span className="bx" aria-hidden="true" />
                {CATEGORY_LABELS[c]}
                {known && <span className="n">{counts.kinds[c] ?? 0}</span>}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="eyebrow">Calendars we read</h3>
        <p className="small">
          {counts.sources.activeNames.length > 0 && `${counts.sources.activeNames.join(' · ')}. `}
          <a href="/sources/">All sources</a>
        </p>
      </div>
      <p className="small">Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.</p>
    </aside>
  );
}
