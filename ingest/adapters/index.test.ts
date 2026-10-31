// S1.8 registry + A2: families with an adapter in M1; squarespace/rss/html have none.
import { describe, expect, it } from 'vitest';
import { adapters } from './index';

describe('adapter registry', () => {
  it('registers the M1 families, each with family, version and fetch', () => {
    for (const f of ['tribe', 'ics_chambermaster', 'ics_civicplus', 'ics_eventsmanager', 'html_finalsite', 'html_tahoedonner', 'wprest_crystalbay', 'curated_dates']) {
      expect(adapters[f], f).toBeDefined();
      expect(adapters[f].family).toBe(f);
      expect(adapters[f].version).toMatch(/\S/);
      expect(typeof adapters[f].fetch).toBe('function');
    }
  });
  it('has no adapter for squarespace, rss or html (A2)', () => {
    for (const f of ['squarespace', 'rss', 'html']) expect(adapters[f]).toBeUndefined();
  });
  it('has no scheduled adapter for rec1_catalog: TDRPD is read only on request by scripts/tdrpd-refresh.sh (Amendment K3)', () => {
    expect(adapters.rec1_catalog).toBeUndefined();
  });
});
