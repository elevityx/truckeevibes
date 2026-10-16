import { FilterIcon } from '@/components/list/icons';

/** "Filters (n)": opens the bottom sheet on phones. n counts Area and Free only (When has its own row). */
export default function FilterButton({ count, onClick }: { count: number; onClick(): void }) {
  return (
    <button type="button" className="btn fbtn" onClick={onClick} aria-haspopup="dialog">
      <FilterIcon />
      Filters{count > 0 ? ` (${count})` : ''}
    </button>
  );
}
