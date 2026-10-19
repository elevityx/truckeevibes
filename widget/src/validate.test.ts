// AC-W2-03: each row rule has a reject case; __proto__ is never copied; invalid rows are counted (api.test.ts); description fallback.
import { describe, expect, it } from 'vitest';
import { rawEnvelope, rawRow, uuid } from './testing';
import { validateEnvelope, validateRow } from './validate';

describe('validateRow', () => {
  it('accepts a schema row and maps it to the Lights event shape', () => {
    const r = validateRow(rawRow(1, { url: 'https://example.org/a' }));
    expect(r).toEqual({
      id: uuid(1), title: 'Event 1', description: 'A synthetic event.', venue: 'Hall', address: '1 Main St, Truckee, CA 96161', lat: 39.33, lng: -120.18,
      startsAt: '2026-10-30T23:00:00.000Z', endsAt: '2026-10-31T01:00:00.000Z', url: 'https://example.org/a', adultsOnly: false,
      origin: 'lights', formerIds: [], pageUrl: null, allDay: false, startDate: null, endDate: null, timeKnown: true,
    });
  });

  const bad: [string, Record<string, unknown>][] = [
    ['id not a uuid', { id: 'x' }],
    ['id upper-case', { id: '00000000-0000-4000-8000-00000000000A' }],
    ['formerIds item not a uuid', { formerIds: ['nope'] }],
    ['formerIds not an array', { formerIds: 'x' }],
    ['title empty', { title: '' }],
    ['title 201 chars', { title: 'a'.repeat(201) }],
    ['title not a string', { title: 5 }],
    ['description 2,001 chars', { description: 'a'.repeat(2001) }],
    ['summary 2,001 chars', { summary: 'a'.repeat(2001), description: null }],
    ['venue 301 chars', { venue: 'a'.repeat(301) }],
    ['address 301 chars', { address: 'a'.repeat(301) }],
    ['address missing', { address: null }],
    ['startsAt without Z', { startsAt: '2026-10-30T23:00:00+00:00' }],
    ['startsAt not a date', { startsAt: 'tomorrow' }],
    ['endsAt without Z', { endsAt: '2026-10-31T01:00:00' }],
    ['lat not finite', { lat: null }],
    ['lng a string', { lng: '-120' }],
    ['url too long', { url: 'https://example.org/' + 'a'.repeat(2048) }],
    ['url not a string', { url: 5 }],
    ['ticketUrl too long', { ticketUrl: 'https://example.org/' + 'a'.repeat(2048) }],
    ['pageUrl on another host', { pageUrl: 'https://evil.example/' }],
    ['pageUrl look-alike host', { pageUrl: 'https://truckeevibes.com.evil.example/' }],
    ['adultsOnly not strict', { adultsOnly: 'true' }],
    ['allDay not strict', { allDay: 1 }],
    ['timeKnown not strict', { timeKnown: null }],
    ['origin unknown', { origin: 'other' }],
    ['startDate malformed', { startDate: '10/30/2026' }],
  ];
  it.each(bad)('rejects: %s', (_n, over) => expect(validateRow(rawRow(1, over))).toBeNull());

  it('rejects non-objects', () => {
    for (const x of [null, 1, 'x', [], undefined]) expect(validateRow(x)).toBeNull();
  });

  it('never copies __proto__ (JSON own key) and returns a plain object', () => {
    const raw = JSON.parse(JSON.stringify(rawRow(2)).replace('{', '{"__proto__":{"polluted":true},"constructor":{"x":1},'));
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true);
    const r = validateRow(raw)!;
    expect(r).not.toBeNull();
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(r, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r, 'constructor')).toBe(false);
    expect((r as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('description falls back to summary, then the empty string', () => {
    expect(validateRow(rawRow(3, { origin: 'vibes', description: null, summary: 'Our summary.' }))!.description).toBe('Our summary.');
    expect(validateRow(rawRow(3, { origin: 'vibes', description: null, summary: null }))!.description).toBe('');
  });

  it('keeps a valid truckeevibes.com page link and the former ids', () => {
    const r = validateRow(rawRow(4, { origin: 'vibes', pageUrl: 'https://truckeevibes.com/e/x/', formerIds: [uuid(9)] }))!;
    expect(r.pageUrl).toBe('https://truckeevibes.com/e/x/');
    expect(r.formerIds).toEqual([uuid(9)]);
  });
});

describe('validateEnvelope', () => {
  it('reads the known keys', () => {
    const e = validateEnvelope(rawEnvelope([rawRow(1)]))!;
    expect(e.dataAt).toBe('2026-10-15T14:50:00.000Z');
    expect(e.mirror).toEqual({ state: 'confirmed', confirmedAt: '2026-10-15T14:48:00.000Z', heldSince: null, heldCount: 0 });
    expect(e.nextCursor).toBeNull();
    expect(e.events).toHaveLength(1);
    expect(e.stale).toBe(false);
  });
  it.each([
    ['not an object', null],
    ['version 2', rawEnvelope([], { version: 2 })],
    ['dataAt missing', rawEnvelope([], { dataAt: undefined })],
    ['stale not boolean', rawEnvelope([], { stale: 'no' })],
    ['mirror state unknown', rawEnvelope([], { mirror: { state: 'odd', confirmedAt: null, heldSince: null, heldCount: 0 } })],
    ['heldCount negative', rawEnvelope([], { mirror: { state: 'held', confirmedAt: null, heldSince: null, heldCount: -1 } })],
    ['events not an array', rawEnvelope([], { events: {} })],
    ['nextCursor a number', rawEnvelope([], { nextCursor: 3 })],
  ])('rejects: %s', (_n, x) => expect(validateEnvelope(x)).toBeNull());
});
