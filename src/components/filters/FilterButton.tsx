import { FilterIcon } from '@/components/list/icons';

/** "Filters (n)": opens the bottom sheet on phones. n is the same active-filter count "Clear filters (n)" shows. Hidden while `hidden`. */
export default function FilterButton({ count, onClick, hidden = false }: { count: number; onClick(): void; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <button type="button" className="btn fbtn" onClick={onClick} aria-haspopup="dialog">
      <FilterIcon />
      Filters{count > 0 ? ` (${count})` : ''}
    </button>
  );
}
