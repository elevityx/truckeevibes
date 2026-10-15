// Resend over plain fetch (copied from TL:supabase/functions/_shared/resend.ts). Every send carries an Idempotency-Key
// (weekly:<Pacific date> or heartbeat:<UTC date>), so a retry after a crash between "Resend accepted" and the response is
// deduplicated by Resend (24 h). Errors become short codes; provider text is dropped. An outcome where Resend MAY have
// accepted the email (timeout, network error, 5xx) is `ambiguous`.
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}
export type SendResult = { ok: true; id: string | null } | { ok: false; code: string; ambiguous?: boolean };
export type Sleep = (ms: number) => Promise<void>;

export const RESEND_URL = 'https://api.resend.com/emails';

export async function sendEmail(
  apiKey: string,
  idempotencyKey: string,
  email: OutgoingEmail,
  deps: { fetch?: typeof fetch; sleep?: Sleep } = {},
): Promise<SendResult> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(email),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { ok: false, code: 'network', ambiguous: true };
    }
    if (res.ok) {
      let id: string | null = null;
      try { const b = await res.json() as { id?: unknown }; if (typeof b.id === 'string') id = b.id; } catch { /* ignore */ }
      return { ok: true, id };
    }
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Math.max(Number(res.headers.get('retry-after')) || 1, 1), 5);
      await res.body?.cancel();
      await sleep(wait * 1000);
      continue; // same idempotency key
    }
    await res.body?.cancel();
    if (res.status >= 500) return { ok: false, code: `http_${res.status}`, ambiguous: true };
    return { ok: false, code: `http_${res.status}` };
  }
  return { ok: false, code: 'http_429' };
}
