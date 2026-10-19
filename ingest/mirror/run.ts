// Lights mirror runner (spec W3.3): every 15 minutes, one single-use grant, one exact Lights snapshot, one submit. Holds no database
// key: only INGEST_HMAC_KEY plus Lights' public REST URL and publishable key. Logs counts and codes only, never titles or URLs (V11).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { callIngest, IngestHttpError } from '../core/hmacClient';
import type { PoliteSource } from '../core/politeFetch';
import { createLightsClient } from './lightsClient';
import { readLightsSnapshot } from './truckeelights';

export interface MirrorDeps {
  env: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  log?: (line: string) => void;
}
interface MirrorGrant { grant: string | null; run_id?: string; source?: PoliteSource & { slug?: string } }
interface ApplyOut { status?: unknown; seen?: unknown; added?: unknown; changed?: unknown; removed?: unknown; held?: unknown; invalid?: unknown }

const safeCode = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : 'unknown');
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export async function main(deps: MirrorDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const doFetch = deps.fetch ?? globalThis.fetch;
  const nowDate = deps.now ?? (() => new Date());
  const { INGEST_URL: url, INGEST_HMAC_KEY: key, LIGHTS_REST_URL: restUrl, LIGHTS_PUBLISHABLE_KEY: pubKey } = deps.env;
  if (!url || !key || !restUrl || !pubKey) { log('mirror: config missing'); return 1; }
  const client = { url, key, fetch: doFetch, now: () => nowDate().getTime() };

  let g: MirrorGrant;
  try {
    g = await callIngest<MirrorGrant>('mirror_grant', {}, client);
  } catch (e) {
    log(`mirror: grant failed code=${e instanceof IngestHttpError ? safeCode(e.code) : 'unknown'}`);
    return 1;
  }
  if (!g || typeof g.grant !== 'string' || !g.source) { log('mirror: not due'); return 0; }

  const lights = createLightsClient(g.source, { LIGHTS_REST_URL: restUrl, LIGHTS_PUBLISHABLE_KEY: pubKey },
    { fetch: doFetch, now: () => nowDate().getTime() });
  const snap = await readLightsSnapshot(lights);

  let out: ApplyOut;
  try {
    if (snap.ok) {
      out = await callIngest<ApplyOut>('submit_lights_mirror', {
        grant: g.grant, run: { ...snap.pair, status: 'ok', total: snap.rows.length }, rows: snap.rows,
      }, client);
    } else {
      const code = safeCode(snap.code);
      log(`mirror: aborted code=${code}`);
      await callIngest('submit_lights_mirror', {
        grant: g.grant, run: { ...(snap.pair ?? { region: 'truckee' }), status: 'aborted', abort_code: code }, rows: [],
      }, client);
      return 0;
    }
  } catch (e) {
    log(`mirror: submit failed code=${e instanceof IngestHttpError ? safeCode(e.code) : 'unknown'}`);
    return 1;
  }
  log(`mirror: status=${safeCode(out.status)} rows=${snap.rows.length} added=${n(out.added)} changed=${n(out.changed)} ` +
      `removed=${n(out.removed)} held=${n(out.held)} invalid=${n(out.invalid)}`);
  return 0;
}

const entry = process.argv[1];
if (entry) {
  let self = false;
  try { self = import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { self = false; }
  if (self) main({ env: process.env }).then((code) => process.exit(code), () => process.exit(1));
}
