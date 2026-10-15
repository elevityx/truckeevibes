// Signed calls to the ingest Edge Function (spec S1.6 request format).
import { createHash, createHmac, randomBytes } from 'node:crypto';

export class IngestHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`ingest ${status} ${code}`);
    this.name = 'IngestHttpError';
  }
}

export interface IngestClientOpts { url: string; key: string; fetch: typeof globalThis.fetch; now?: () => number }
export type IngestOp = 'due_sources' | 'submit_batch' | 'finish';

const safeCode = (v: unknown, status: number) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : `http_${status}`);

// The response shape depends on the op; callers narrow it (the Edge Function is the contract).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callIngest<T = any>(op: IngestOp, body: Record<string, unknown>, o: IngestClientOpts): Promise<T> {
  const raw = JSON.stringify({ op, ...body });
  const ts = String(Math.floor((o.now ? o.now() : Date.now()) / 1000));
  const nonce = randomBytes(16).toString('hex');
  const sha = createHash('sha256').update(raw).digest('hex');
  const sig = createHmac('sha256', o.key).update(`${ts}\n${nonce}\n${sha}`).digest('hex');
  let res: Response;
  try {
    res = await o.fetch(o.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tv-ts': ts, 'x-tv-nonce': nonce, 'x-tv-sig': sig },
      body: raw,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    throw new IngestHttpError(0, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await res.text()); } catch { parsed = undefined; }
  if (!res.ok) {
    const code = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).error : undefined;
    throw new IngestHttpError(res.status, safeCode(code, res.status));
  }
  if (parsed === undefined) throw new IngestHttpError(res.status, 'bad_response');
  return parsed as T;
}
