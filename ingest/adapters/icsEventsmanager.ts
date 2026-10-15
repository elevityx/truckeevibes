// Events Manager (WordPress) site-wide export (spec S1.9 icsEventsmanager, A2): one conditional GET of `config.icsUrl`.
import type { Adapter, AdapterCtx, AdapterResult } from '../types';
import { fetchIcsFeed } from './feeds';

export const adapter: Adapter = {
  family: 'ics_eventsmanager',
  version: 'ics_eventsmanager.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const icsUrl = ctx.source.config.icsUrl;
    if (typeof icsUrl !== 'string' || !icsUrl) throw new Error('config_icsUrl_required');
    const r = await fetchIcsFeed(ctx, icsUrl, { conditional: true });
    if (!r.ok) return r.result;
    const { res, parsed, hash } = r;
    return {
      items: parsed.items, status: 'ok', httpStatus: res.status, contentHash: hash,
      etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined,
    };
  },
};
