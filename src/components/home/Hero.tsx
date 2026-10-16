import { whenWindow } from '@/lib/filters/predicates';
import { REGION_TZ } from '@/lib/filters/predicates';
import type { HeroCounts } from '@/lib/data/firstPaint';
import type { ListDef } from '@/lib/lists';
import { dayLabel, longDay, monthDay } from '@/lib/time/pacific';

const TZ = REGION_TZ;

/** "This weekend around Truckee" from Friday 3 pm to Monday 12 am (inside the This weekend window), else "Around Truckee this week". */
export function heroLine(now: number): string {
  const [s, e] = whenWindow('weekend', now, TZ);
  return now >= s && now < e ? 'This weekend around Truckee' : 'Around Truckee this week';
}

const things = (n: number) => `${n} ${n === 1 ? 'thing' : 'things'}`;
const events = (n: number) => `${n} ${n === 1 ? 'event' : 'events'}`;
const calendars = (k: number) => `${k} local ${k === 1 ? 'calendar' : 'calendars'}`;

/** The proof line as three parts, so the middle can be the /sources/ link. */
export function proofParts(h: HeroCounts, k: number, mode: 'desktop' | 'phone'): { before: string; link: string; after: string } {
  const last = h.lastStart ? ` through ${monthDay(h.lastStart)}` : '';
  const before =
    mode === 'desktop'
      ? `${things(h.n7)} in the next 7 days, ${h.nw} this weekend. ${events(h.total)}${last} from `
      : `${things(h.n7)} in 7 days, ${h.nw} this weekend. ${events(h.total)} from `;
  return { before, link: calendars(k), after: ', checked daily.' };
}

export function heroProof(h: HeroCounts, k: number, mode: 'desktop' | 'phone'): string {
  const p = proofParts(h, k, mode);
  return `${p.before}${p.link}${p.after}`;
}

interface Props {
  now: number;
  list: ListDef;
  /** Events in the active list, and the Pacific date (YYYY-MM-DD) of the last start. */
  listCount: number;
  listLast: string | null;
  hero: HeroCounts;
  activeSources: number;
}

function Proof({ h, k, mode }: { h: HeroCounts; k: number; mode: 'desktop' | 'phone' }) {
  const p = proofParts(h, k, mode);
  return (
    <p className={`proof ${mode === 'desktop' ? 'dsk' : 'phn'}`}>
      {p.before}
      <a href="/sources/">{p.link}</a>
      {p.after}
    </p>
  );
}

/** The page head: eyebrow, alpenglow rule, headline and proof (home) or list title and lede (a list). No photo element (launch default). */
export default function Hero({ now, list, listCount, listLast, hero, activeSources }: Props) {
  const iso = new Date(now).toISOString();
  if (list.slug === 'all') {
    return (
      <section className="hero-sec">
        <p className="eyebrow">
          <span className="dsk">{longDay(iso, TZ)} · Pacific time</span>
          <span className="phn">{dayLabel(iso, TZ)}</span>
        </p>
        <div className="rule" />
        <h1 className="hero">{heroLine(now)}</h1>
        <Proof h={hero} k={activeSources} mode="desktop" />
        <Proof h={hero} k={activeSources} mode="phone" />
      </section>
    );
  }
  return (
    <section className="hero-sec">
      <p className="eyebrow">
        <span className="dsk">A list · {events(listCount)}{listLast ? ` through ${monthDay(listLast)}` : ''}</span>
        <span className="phn">A list · {events(listCount)}</span>
      </p>
      <div className="rule" />
      <h1 className="hero">{list.title}</h1>
      <p className="proof lede">{list.lede}</p>
    </section>
  );
}
