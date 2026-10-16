// The closed reason-code vocabulary. Twin of `private.valid_reason_code` (supabase/migrations/20261022000300_tags_notices.sql);
// scripts/parity-cases.test.mjs compares the two lists, in order. Codes carry no source text (V6).
export const REASON_CODES = [
  'cat:source_map', 'cat:title_kw', 'cat:desc_kids', 'cat:desc_family', 'cat:default',
  'price:text_free', 'price:text_paid', 'price:text_donation', 'price:desc_free', 'price:title_free', 'price:neg_blocked', 'price:unknown',
  'age:21_admission', 'age:18_admission', 'age:adult_phrase', 'age:all_ages', 'age:family', 'age:ambiguous', 'age:unknown',
  'conflict:adult', 'conflict:adult_signal', 'notice:cancel_sibling',
] as const;

export type ReasonCode = typeof REASON_CODES[number];

const KNOWN: ReadonlySet<string> = new Set(REASON_CODES);
export const isReasonCode = (v: unknown): v is ReasonCode => typeof v === 'string' && KNOWN.has(v);
export const MAX_REASONS = 16;

/** Dedupe (first occurrence wins) and cap at 16. */
export function capReasons(codes: readonly ReasonCode[]): ReasonCode[] {
  return [...new Set(codes)].slice(0, MAX_REASONS);
}
