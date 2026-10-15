// S1.4: admin_decide_card raises `not_pending` and `stale` (A5-3); the UI needs them as DataError codes.
import { describe, expect, it } from 'vitest';
import { toDataError, userMessage } from './errors';

describe('queue error codes', () => {
  it.each(['not_pending', 'stale'])('maps %s from PostgREST to a DataError with that code', (code) => {
    expect(toDataError({ message: code }).code).toBe(code);
  });
  it('keeps the detail', () => {
    expect(toDataError({ message: 'stale', details: 'held_run' }).detail).toBe('held_run');
  });
  it('has a plain message for each (not the generic fallback)', () => {
    const generic = userMessage(toDataError({ message: 'nope' }));
    for (const code of ['not_pending', 'stale']) {
      const m = userMessage(toDataError({ message: code }));
      expect(m).not.toBe(generic);
      expect(m.length).toBeGreaterThan(10);
    }
  });
});
