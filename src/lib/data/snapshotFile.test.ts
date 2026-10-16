// AC-M1-75 (d): readBuildSnapshot never throws and whitelists VibeEvent keys.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildSnapshot } from './snapshotFile';

const dir = mkdtempSync(join(tmpdir(), 'snapfile-'));
const full = {
  id: 'a', slug: 's', title: 'T', summary: 'x', startsAt: '2026-11-06T02:00:00Z', endsAt: null, allDay: false, startDate: null, endDate: null,
  timeKnown: true, venue: null, address: null, town: null, area: null, lat: null, lng: null, categories: [], priceKind: 'free', priceMin: null,
  priceMax: null, age: 'all_ages', featured: false, url: null, ticketUrl: null, sources: [],
};

describe('readBuildSnapshot', () => {
  it('a missing file is the empty snapshot', () => {
    expect(readBuildSnapshot(join(dir, 'nope.json'))).toEqual({ builtAt: null, events: [], sources: [] });
  });
  it('invalid JSON is the empty snapshot', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{not json');
    expect(readBuildSnapshot(p)).toEqual({ builtAt: null, events: [], sources: [] });
  });
  it('keeps good rows and builtAt, and drops keys that are not VibeEvent keys', () => {
    const p = join(dir, 'ok.json');
    writeFileSync(p, JSON.stringify({ builtAt: '2026-11-05T18:00:00.000Z', events: [{ ...full, confidence: 0.9, internalNote: 'x' }] }));
    const s = readBuildSnapshot(p);
    expect(s.builtAt).toBe('2026-11-05T18:00:00.000Z');
    expect(s.events).toHaveLength(1);
    expect('confidence' in s.events[0]).toBe(false);
    expect('internalNote' in s.events[0]).toBe(false);
    expect(Object.keys(s.events[0]).sort()).toEqual(Object.keys(full).sort());
    expect(s.events[0].title).toBe('T');
  });
});
