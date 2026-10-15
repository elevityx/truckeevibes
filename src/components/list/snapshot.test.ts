import { describe, expect, it } from 'vitest';
import { parseSnapshot } from './snapshot';

const good = { id: 'a', title: 'T', startsAt: '2026-11-06T02:00:00Z', categories: [], sources: [] };

describe('parseSnapshot', () => {
  it('keeps well-formed rows and a valid builtAt', () => {
    const s = parseSnapshot({ builtAt: '2026-11-05T12:00:00Z', events: [good, { id: 1 }, null, 'x'] });
    expect(s.events).toHaveLength(1);
    expect(s.builtAt).toBe('2026-11-05T12:00:00Z');
  });
  it('treats junk as an empty snapshot', () => {
    expect(parseSnapshot(null)).toEqual({ builtAt: null, events: [] });
    expect(parseSnapshot({ builtAt: 'nope', events: 'x' })).toEqual({ builtAt: null, events: [] });
  });
});
