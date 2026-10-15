import { dateChip } from '@/lib/time/pacific';

/** OCT / 30 / Fri, in the region's zone. Decorative: rows and sheets say the date in words too. */
export default function DateChip({ iso, tz }: { iso: string; tz: string }) {
  const c = dateChip(iso, tz);
  return (
    <span className="dchip" aria-hidden="true">
      <span className="mo">{c.month}</span>
      <span className="dd">{c.day}</span>
      <span className="wd">{c.weekday}</span>
    </span>
  );
}
