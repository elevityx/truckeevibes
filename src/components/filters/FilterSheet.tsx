'use client';

import Sheet from '@/components/ui/Sheet';
import { XIcon } from '@/components/list/icons';
import { EMPTY_FILTERS, type FilterState } from '@/lib/filters/state';
import FilterControls from './FilterControls';

interface Props {
  state: FilterState;
  resultCount: number;
  onChange(next: FilterState): void;
  onClose(): void;
}

export default function FilterSheet({ state, resultCount, onChange, onClose }: Props) {
  return (
    <Sheet label="Filters" onClose={onClose}>
      <div className="sheet-in">
        <div className="sheet-h">
          <h2 className="etitle">Filters</h2>
          <button type="button" className="iconbtn x" aria-label="Close filters" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <FilterControls state={state} onChange={onChange} />
        <div className="eacts">
          <button type="button" className="btn ghost" onClick={() => onChange(EMPTY_FILTERS)}>
            Clear all
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Show {resultCount} {resultCount === 1 ? 'event' : 'events'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
