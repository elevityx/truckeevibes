'use client';

import type { Area } from '@/lib/data/types';
import { AREAS, AREA_LABELS, type FilterState } from '@/lib/filters/state';

interface Props {
  state: FilterState;
  onChange(next: FilterState): void;
}

/** Area chips and the Free toggle. Used in the phone sheet and the desktop rail. */
export default function FilterControls({ state, onChange }: Props) {
  const toggleArea = (a: Area) =>
    onChange({ ...state, areas: state.areas.includes(a) ? state.areas.filter((x) => x !== a) : AREAS.filter((x) => x === a || state.areas.includes(x)) });
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
      <button type="button" className="sw" role="switch" aria-checked={state.free} onClick={() => onChange({ ...state, free: !state.free })}>
        <span className="tr" aria-hidden="true" />
        <span>Free events only</span>
      </button>
    </div>
  );
}
