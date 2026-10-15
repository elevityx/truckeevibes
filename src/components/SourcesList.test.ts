// AC-M1-77: source links go through safeWebsite. Interface assumption: SourcesList.tsx exports a pure
// sourceLink(s) returning { name, href: string | null }.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => false, publicEnv: {} }));
vi.mock('@/lib/data', () => ({ listSourcesPublic: async () => [], toDataError: (e: unknown) => e, userMessage: () => '' }));

import { sourceLink } from './SourcesList';

const src = (homepageUrl: string) => ({ name: 'S', homepageUrl, status: 'active' as const });

describe('sourceLink', () => {
  it('an https url links', () => expect(sourceLink(src('https://example.org/x'))).toEqual({ name: 'S', href: 'https://example.org/x' }));
  for (const bad of ['http://example.org/x', 'https://user:pw@example.org/x', 'javascript:alert(1)', 'ftp://example.org/x', 'not a url']) {
    it(`no href for ${bad}`, () => expect(sourceLink(src(bad))).toEqual({ name: 'S', href: null }));
  }
});
