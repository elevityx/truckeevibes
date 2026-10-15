import type { Metadata } from 'next';
import SiteNav from '@/components/SiteNav';

export const metadata: Metadata = {
  title: 'About the TruckeeVibes crawler',
  description: 'What the TruckeeVibes bot fetches, how often, and how to ask us to stop.',
  alternates: { canonical: '/bot/' },
};

// Static server component: no data, no client JS.
export default function BotPage() {
  return (
    <main className="page">
      <SiteNav />
      <h1 className="disp">The TruckeeVibes crawler</h1>
      <p>TruckeeVibes lists local events by reading public calendars. This page says exactly what our crawler does.</p>

      <h2 className="disp">Who we are</h2>
      <p>Our requests identify themselves with this user agent:</p>
      <p className="card"><code>TruckeeVibesBot/1.0 (+https://truckeevibes.com/bot/)</code></p>

      <h2 className="disp">What we fetch</h2>
      <ul>
        <li>Public event calendars, feeds and event pages only. We never log in to anything.</li>
        <li>Each source is fetched only after we have reviewed its terms and recorded that automated reading is allowed.</li>
      </ul>

      <h2 className="disp">How often</h2>
      <ul>
        <li>At most 4 times a day per source.</li>
        <li>At most 1 request per second per host.</li>
        <li>Conditional requests avoid downloading an unchanged page again.</li>
      </ul>

      <h2 className="disp">Rules we follow</h2>
      <ul>
        <li>We honor robots.txt for our user agent and for the wildcard agent.</li>
        <li>Sites that block AI agents are never processed by an LLM. We do not use an LLM to process any source today.</li>
        <li>We store facts only (title, time, place, link). We write our own short descriptions, link back to the organizer, and never copy images.</li>
      </ul>

      <h2 className="disp">Ask us to stop</h2>
      <p>
        Organizers can opt out at any time by emailing <a href="mailto:takedown@truckeevibes.com">takedown@truckeevibes.com</a>.
        We remove the source and its events within 48 hours.
      </p>
    </main>
  );
}
