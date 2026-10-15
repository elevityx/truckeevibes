import type { Metadata } from 'next';
import SiteNav from '@/components/SiteNav';

export const metadata: Metadata = {
  title: 'About TruckeeVibes',
  description: 'What TruckeeVibes is, how events get on the list, and how to reach us.',
  alternates: { canonical: '/about/' },
};

// Static server component: no data, no client JS.
export default function AboutPage() {
  return (
    <main className="page">
      <SiteNav />
      <h1 className="disp">About TruckeeVibes</h1>
      <p>
        TruckeeVibes is a free, plain list of what is happening in Truckee and North Lake Tahoe. It is a sister site to Truckee
        Lights, the community map of decorated houses.
      </p>

      <h2 className="disp">How events get here</h2>
      <p>
        The list is curated and automated. A person reviews each source before we read it, and the software then gathers the
        facts (title, time, place, link) from public calendars. Every event links back to the organizer, so you always end up
        at the original page for details and tickets.
      </p>

      <h2 className="disp">Open source</h2>
      <p>The code is public under the MIT license. Read how our crawler behaves on the <a href="/bot/">bot page</a>.</p>

      <h2 className="disp">Contact</h2>
      <p>
        Organizers who want an event or source removed can write to <a href="mailto:takedown@truckeevibes.com">takedown@truckeevibes.com</a>.
      </p>
    </main>
  );
}
