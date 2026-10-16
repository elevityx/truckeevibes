'use client';

import { CATEGORY_LABELS, CATEGORY_SLUGS } from '@/lib/categories';
import type { Area } from '@/lib/data/types';
import { AREAS, AREA_LABELS, type FilterState } from '@/lib/filters/state';

interface Props {
  state: FilterState;
  onChange(next: FilterState): void;
}

/** Area chips, Kind chips, and the Free and Kids switches. Used in the phone sheet. */
export default function FilterControls({ state, onChange }: Props) {
  const toggleArea = (a: Area) =>
    onChange({ ...state, areas: state.areas.includes(a) ? state.areas.filter((x) => x !== a) : AREAS.filter((x) => x === a || state.areas.includes(x)) });
  const toggleCat = (c: string) =>
    onChange({ ...state, cats: state.cats.includes(c) ? state.cats.filter((x) => x !== c) : CATEGORY_SLUGS.filter((x) => x === c || state.cats.includes(x)) });
  return (
    <div className="fctl">
      <fieldset className="fset">
        <legend>Area</legend>
        <div className="chips">
          {AREAS.map((a) => (
            <button key={a} type="button" className="chip" aria-pressed={state.areas.includes(a)} onClick={() => toggleArea(a)}>
              {AREA_LABELS[a]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="fset">
        <legend>Kind</legend>
        <div className="chips">
          {CATEGORY_SLUGS.map((c) => (
            <button key={c} type="button" className="chip" aria-pressed={state.cats.includes(c)} onClick={() => toggleCat(c)}>
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </fieldset>
      <button type="button" className="sw" role="switch" aria-checked={state.free} onClick={() => onChange({ ...state, free: !state.free })}>
        <span className="tr" aria-hidden="true" />
        <span>Free events only</span>
      </button>
      <button type="button" className="sw" role="switch" aria-checked={state.kids} onClick={() => onChange({ ...state, kids: !state.kids })}>
        <span className="tr" aria-hidden="true" />
        <span>Kids OK</span>
      </button>
    </div>
  );
}
