import Lockup from '@/components/brand/Lockup';
import { SISTER_SITES } from '@/config/features';

function Site({ name, href }: { name: string; href: string | null }) {
  return href ? <a href={href} rel="noopener noreferrer">{name}</a> : <>{name}</>;
}

/** Site footer, rendered by each server page (never by a client component). */
export default function Footer() {
  return (
    <div className="wrap">
      <footer className="foot">
        <div className="foot-top">
          <Lockup small />
          <nav className="row" aria-label="Footer">
            <a href="/sources/">Sources</a>
            <a href="/about/">About</a>
            <a href="/sources/#add">Add your calendar</a>
            <a href="/bot/">Our bot</a>
          </nav>
        </div>
        <p className="small">A free, plain list of what is happening in Truckee and North Lake Tahoe, gathered from local calendars with links back to the organizers.</p>
        <p className="small">
          Sister sites: <Site name="TruckeeLights" href={SISTER_SITES.lights} /> (Christmas and winter) and <Site name="TruckeeFrights" href={SISTER_SITES.frights} /> (Halloween and fall) draw from this list.
        </p>
        <p className="small">No cookies, no accounts.</p>
        <p className="small">Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.</p>
      </footer>
    </div>
  );
}
