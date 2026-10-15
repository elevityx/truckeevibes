// CivicPlus iCalendar per category (spec S1.9 icsCivicplus): `config.base`, `config.catIds`.
import type { Adapter, AdapterCtx, AdapterResult, SourceEvent } from '../types';
import { dedupe, sha256Hex } from './common';
import { fetchIcsFeed } from './feeds';

export const adapter: Adapter = {
  family: 'ics_civicplus',
  version: 'ics_civicplus.1',
  async fetch(ctx: AdapterCtx): Promise<AdapterResult> {
    const { base, catIds } = ctx.source.config as { base?: unknown; catIds?: unknown };
    if (typeof base !== 'string' || !base) throw new Error('config_base_required');
    if (!Array.isArray(catIds) || catIds.some((n) => !Number.isInteger(n))) throw new Error('config_catIds_required');
    const items: SourceEvent[] = [];
    const hashes: string[] = [];
    for (const id of catIds as number[]) {
      const url = `${base.replace(/\/+$/, '')}/common/modules/iCalendar/iCalendar.aspx?catID=${id}&feed=calendar`;
      const r = await fetchIcsFeed(ctx, url);
      if (!r.ok) return r.result; // one failed calendar fails the run: a partial list would fake `gone` marks
      items.push(...r.parsed.items);
      hashes.push(r.hash);
    }
    return { items: dedupe(items), status: 'ok', httpStatus: 200, contentHash: sha256Hex(hashes.join('\n')) };
  },
};
