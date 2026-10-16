// AC-R1a-09: the About page renders from a fixture snapshot (4 active, 2 paused, 8 link_only).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const sources = [
  ...Array.from({ length: 4 }, (_, i) => ({ name: `Example A${i}`, homepageUrl: 'https://example.org/a', status: 'active' as const })),
  ...Array.from({ length: 2 }, (_, i) => ({ name: `Example P${i}`, homepageUrl: 'https://example.org/p', status: 'paused' as const })),
  ...Array.from({ length: 8 }, (_, i) => ({ name: `Example L${i}`, homepageUrl: 'https://example.org/l', status: 'link_only' as const })),
];
vi.mock('@/lib/data/snapshotFile', () => ({ readBuildSnapshot: () => ({ builtAt: null, events: [], sources }) }));

import AboutPage from './page';

const html = renderToStaticMarkup(createElement(AboutPage));
const text = html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

describe('AC-R1a-09 About', () => {
  it('counts come from the snapshot', () =>
    expect(text).toContain('Today we read 4 calendars every morning and point to 10 more we do not read yet.'));
  for (const sentence of [
    'A local\'s list of what\'s on',
    'TruckeeVibes is one list of what is happening around Truckee and North Lake Tahoe, kept by a local for neighbors and for people up for the weekend. The point is to show the best side of this place: the shows, the trail days, the markets and the nights out, without the noise.',
    'We read local calendars every morning, keep the facts, write our own line, and link you to the organizer. The best of it goes into the lists: Art, Music, 21+, Kids, Family friendly, Outdoors, Food & drink.',
    'The calendars we read shows each one and its status. The crawler is open source; our bot page says how it behaves and how to keep it off your site.',
    'Every listing links to the organizer. We keep the facts and write our own line; we never copy a description or a photo. If a listing is wrong or you want it taken down, write to takedown@truckeevibes.com.',
    'TruckeeVibes is the year-round list. TruckeeLights covers Christmas and winter, TruckeeFrights covers Halloween and fall; both keep their own look and will draw their events from this list.',
    'No cookies, no accounts.',
    'Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.',
    'If your events have a public calendar page, tell us where it is. Once we have checked its terms, we read it every morning.',
  ]) it(`has: ${sentence.slice(0, 50)}`, () => expect(text).toContain(sentence));
  for (const h of ['How the list is made', 'Fair to organizers', 'The lists', 'Sister sites', 'Privacy', 'Add your calendar']) it(`h2 ${h}`, () => expect(html).toContain(`>${h}</h2>`));
  it('has no HuntingtonVibe, college or Placeholder text', () => {
    for (const bad of ['HuntingtonVibe', 'college', 'Placeholder']) expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
  });
  it('has exactly one plain mailto:takedown@ link (the button adds only a subject)', () => {
    expect(html.match(/href="mailto:takedown@truckeevibes\.com"/g)).toHaveLength(1);
    expect(html.match(/href="mailto:takedown@truckeevibes\.com\?subject=Add%20my%20calendar"/g)).toHaveLength(1);
  });
});
