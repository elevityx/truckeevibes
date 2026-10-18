// AC-W1-21 / 26: the response shape follows the schema file, extra keys are dropped, malformed input is refused; size budget.
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import schema from './events.v1.schema.json';
import { shapeEnvelope } from './shape';
import { rawEnvelope, validate } from './testing';

const S = schema as unknown as Record<string, unknown>;

describe('AC-W1-21 shapeEnvelope', () => {
  it('adds version, scope, season, year, stale:false, pageComplete and attribution; output validates against the schema', () => {
    const out = shapeEnvelope(rawEnvelope({ n: 3 }), { scope: 'vibes' });
    expect(out).not.toBeNull();
    expect(validate(S, out)).toEqual([]);
    expect(out).toMatchObject({ version: 1, scope: 'vibes', season: null, year: null, stale: false, pageComplete: true,
      attribution: { name: 'TruckeeVibes', url: 'https://truckeevibes.com/' }, count: 3 });
  });
  it('pageComplete = (nextCursor === null)', () => {
    expect(shapeEnvelope(rawEnvelope({ nextCursor: 'abc' }), { scope: 'vibes' })?.pageComplete).toBe(false);
    expect(shapeEnvelope(rawEnvelope({ nextCursor: null }), { scope: 'vibes' })?.pageComplete).toBe(true);
  });
  it('scope=lights carries the season and year of the query', () => {
    const out = shapeEnvelope(rawEnvelope({ origin: 'lights' }), { scope: 'lights', season: 'halloween', year: 2026 });
    expect(out).toMatchObject({ scope: 'lights', season: 'halloween', year: 2026 });
    expect(validate(S, out)).toEqual([]);
  });
  it('a raw row with an extra key (confidence) is dropped from the output; extra envelope keys too', () => {
    const raw = rawEnvelope({ n: 2 });
    (raw.events as Record<string, unknown>[])[0].confidence = 93;
    (raw.events as Record<string, unknown>[])[1].lights_include = 'yes';
    raw.status = 'published';
    (raw.mirror as Record<string, unknown>).secret = 'x';
    const out = shapeEnvelope(raw, { scope: 'vibes' });
    expect(out).not.toBeNull();
    expect(validate(S, out)).toEqual([]);
    const text = JSON.stringify(out);
    for (const k of ['confidence', 'lights_include', '"status"', 'secret']) expect(text).not.toContain(k);
  });
  it('every key of the output is a schema key (keys subset, recursively)', () => {
    const out = shapeEnvelope(rawEnvelope({ n: 2 }), { scope: 'vibes' }) as unknown as Record<string, unknown>;
    const props = S.properties as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(Object.keys(props).sort());
    const rowKeys = Object.keys(((S.$defs as Record<string, { properties: object }>).event).properties).sort();
    for (const r of out.events as object[]) expect(Object.keys(r).sort()).toEqual(rowKeys);
  });
  it('a missing or mistyped required key -> null', () => {
    const cases: Array<(r: Record<string, unknown>) => void> = [
      (r) => { delete r.dataAt; },
      (r) => { r.count = '2'; },
      (r) => { r.events = {}; },
      (r) => { (r.events as Record<string, unknown>[])[0].startsAt = 5; },
      (r) => { delete (r.events as Record<string, unknown>[])[0].title; },
      (r) => { (r.events as Record<string, unknown>[])[0].origin = 'other'; },
      (r) => { (r.mirror as Record<string, unknown>).state = 'unknown'; },
      (r) => { delete (r.region as Record<string, unknown>).localBox; },
      (r) => { r.nextCursor = undefined; },
    ];
    for (const mutate of cases) {
      const raw = rawEnvelope({ n: 2 });
      mutate(raw);
      expect(shapeEnvelope(raw, { scope: 'vibes' })).toBeNull();
    }
    expect(shapeEnvelope(null, { scope: 'vibes' })).toBeNull();
    expect(shapeEnvelope([], { scope: 'vibes' })).toBeNull();
    expect(shapeEnvelope('x', { scope: 'vibes' })).toBeNull();
  });
});

describe('AC-W1-26 size', () => {
  it('300 scope=lights rows with 600-char descriptions gzip to <= 40,960 bytes', () => {
    const out = shapeEnvelope(rawEnvelope({ n: 300, origin: 'lights', descLen: 600 }), { scope: 'lights', season: 'christmas', year: 2026 });
    expect(out).not.toBeNull();
    for (const r of out!.events) expect(r.description).toHaveLength(600);
    const gz = gzipSync(Buffer.from(JSON.stringify(out))).length;
    expect(gz).toBeLessThanOrEqual(40_960);
  });
});
