// AC-R1a-18: when the sources read fails but events are fine, the last snapshot's sources are kept.
import { describe, expect, it } from 'vitest';
import { lastKnownSources } from './snapshot-sources';

const good = { name: 'Example A', homepageUrl: 'https://example.org/a', status: 'active' };

describe('lastKnownSources', () => {
  it('returns the well-formed sources of the previous snapshot', () => {
    expect(lastKnownSources(JSON.stringify({ builtAt: 'x', events: [], sources: [good, { name: 1 }, null] }))).toEqual([good]);
  });
  it('returns [] for a missing, invalid or source-less previous snapshot', () => {
    expect(lastKnownSources(null)).toEqual([]);
    expect(lastKnownSources('{nope')).toEqual([]);
    expect(lastKnownSources(JSON.stringify({ events: [] }))).toEqual([]);
  });
});
