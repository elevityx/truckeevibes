// S1.8 registry + A2: families with an adapter in M1; squarespace/rss/html have none.
import { describe, expect, it } from 'vitest';
import { adapters } from './index';

describe('adapter registry', () => {
  it('registers the M1 families, each with family, version and fetch', () => {
    for (const f of ['tribe', 'ics_chambermaster', 'ics_civicplus', 'ics_eventsmanager']) {
      expect(adapters[f], f).toBeDefined();
      expect(adapters[f].family).toBe(f);
      expect(adapters[f].version).toMatch(/\S/);
      expect(typeof adapters[f].fetch).toBe('function');
    }
  });
  it('has no adapter for squarespace, rss or html (A2)', () => {
    for (const f of ['squarespace', 'rss', 'html']) expect(adapters[f]).toBeUndefined();
  });
});
