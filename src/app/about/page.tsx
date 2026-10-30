import type { Metadata } from 'next';
import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import { readBuildSnapshot } from '@/lib/data/snapshotFile';

export const metadata: Metadata = {
  title: 'About TruckeeVibes',
  description: 'What TruckeeVibes is, how events get on the list, and how to reach us.',
  alternates: { canonical: '/about/' },
};

const LISTS = ['Art', 'Music', '21+', 'Kids', 'Family friendly', 'Outdoors', 'Food & drink'];

// Server component: no client JS. The counts come from the build snapshot.
export default function AboutPage() {
  const { sources } = readBuildSnapshot();
  const active = sources.filter((s) => s.status === 'active').length;
  const others = sources.length - active;
  return (
    <>
      <Header current="about" />
      <main className="wrap">
        <div className="pg">
          <p className="eyebrow">About</p>
          <div className="rule" />
          <h1 className="hero">A local&apos;s list of what&apos;s on</h1>
          <div className="prose" style={{ marginTop: 16 }}>
            <p>
              TruckeeVibes is one list of what is happening around Truckee and North Lake Tahoe, kept by a local for neighbors and for people up for the weekend. The point is to show the best side of this place: the shows, the trail days, the markets and the nights out, without the noise.
            </p>
            <p>
              We read local calendars every morning, keep the facts, write our own line, and link you to the organizer. The best of it goes into the lists: Art, Music, 21+, Kids, Family friendly, Outdoors, Food &amp; drink.
            </p>

            <h2 className="h2">How the list is made</h2>
            <p>
              {active > 0 ? `Today we read ${active} calendars every morning and point to ${others} more we do not read yet. ` : ''}
              <a href="/sources/">The calendars we read</a>
              {' shows each one and its status. The crawler is open source; '}
              <a href="/bot/">our bot page</a>
              {' says how it behaves and how to keep it off your site.'}
            </p>

            <h2 className="h2">Fair to organizers</h2>
            <p>
              {'Every listing links to the organizer. We keep the facts and write our own line; we never copy a description or a photo. If a listing is wrong or you want it taken down, write to '}
              <a href="mailto:takedown@truckeevibes.com">takedown@truckeevibes.com</a>
              {'.'}
            </p>

            <h2 className="h2">The lists</h2>
            <ul>
              {LISTS.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>

            <h2 className="h2">Sister sites</h2>
            <p>
              TruckeeVibes is the year-round list. TruckeeLights covers Christmas and winter, TruckeeFrights covers Halloween and fall; both keep their own look and will draw their events from this list.
            </p>

            <h2 className="h2">Font licenses</h2>
            <p>
              {'The fonts are served from this site under the SIL Open Font License 1.1: '}
              <a href="/fonts/licenses/OFL-AtkinsonHyperlegibleNext.txt">Atkinson Hyperlegible Next</a>
              {' and '}
              <a href="/fonts/licenses/OFL-BricolageGrotesque.txt">Bricolage Grotesque</a>
              {'. '}
              <a href="/fonts/licenses/README.txt">All font licenses</a>
              {'.'}
            </p>

            <h2 className="h2">Privacy</h2>
            <p>No cookies, no accounts.</p>
            <p className="small" style={{ marginTop: 20 }}>Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.</p>
          </div>

          <aside className="card">
            <p className="eyebrow">Organizers</p>
            <h2 className="h2">Add your calendar</h2>
            <p className="small" style={{ margin: 0 }}>If your events have a public calendar page, tell us where it is. Once we have checked its terms, we read it every morning.</p>
            <a className="btn" href="mailto:takedown@truckeevibes.com?subject=Add%20my%20calendar" style={{ justifySelf: 'start', alignSelf: 'flex-start' }}>Add your calendar</a>
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
