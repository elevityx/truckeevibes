// Contract test for _shared/db.ts: the typed callers of the M1 svc_* routines use exactly their parameter names and map their return
// shapes; errors surface the SQLSTATE only (never the provider message). Failing-first: ./db.ts does not exist yet.
// The factory names (ingestDb, weeklyDb) follow TL:_shared/db.ts (digestDb, unsubscribeDb); each takes a supabase-js-like client.
import { assertEquals, assertRejects } from '@std/assert';

type Reply = { data: unknown; error: { code?: string; message: string } | null };
function fakeClient(replies: Record<string, Reply>) {
  const calls: [string, Record<string, unknown>][] = [];
  const sb = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push([fn, args]);
      return Promise.resolve(replies[fn] ?? { data: null, error: null });
    },
  };
  return { sb, calls };
}
async function load() {
  return await import('./db.ts');
}
const V = '00000000-0000-4000-8000-000000000001';

Deno.test('ingestDb calls svc_ingest_nonce / svc_issue_run_grants / svc_ingest_batch / svc_set_venue_geocode / svc_cluster_and_publish with their exact parameter names', async () => {
  const { ingestDb } = await load();
  const { sb, calls } = fakeClient({
    svc_ingest_nonce: { data: true, error: null },
    svc_issue_run_grants: { data: { grants: [{ grant: 'g', run_id: 'r', source: { slug: 's' } }] }, error: null },
    svc_ingest_batch: { data: { run_id: 'r', status: 'ok', new: 1, changed: 0, gone: 0, geocode: [] }, error: null },
    svc_set_venue_geocode: { data: null, error: null },
    svc_cluster_and_publish: { data: { processed: 3, remaining: 0, public_changed: true }, error: null },
  });
  // deno-lint-ignore no-explicit-any
  const db = ingestDb(sb as any);
  assertEquals(await db.nonce('0123456789abcdef0123456789abcdef'), true);
  assertEquals((await db.grants())[0].run_id, 'r');
  assertEquals((await db.batch('tok', { status: 'ok' }, [{ externalKey: 'a' }])).status, 'ok');
  await db.setGeocode(V, 39.3, -120.1, 'nominatim');
  assertEquals(await db.cluster(500), { processed: 3, remaining: 0, public_changed: true });
  assertEquals(calls, [
    ['svc_ingest_nonce', { p_nonce: '0123456789abcdef0123456789abcdef' }],
    ['svc_issue_run_grants', {}],
    ['svc_ingest_batch', { p_grant: 'tok', p_run: { status: 'ok' }, p_items: [{ externalKey: 'a' }] }],
    ['svc_set_venue_geocode', { p_venue_id: V, p_lat: 39.3, p_lng: -120.1, p_geocoder: 'nominatim' }],
    ['svc_cluster_and_publish', { p_limit: 500 }],
  ]);
});

Deno.test('weeklyDb calls svc_weekly_report with no arguments and returns the report object', async () => {
  const { weeklyDb } = await load();
  const { sb, calls } = fakeClient({ svc_weekly_report: { data: { queue_open: 3 }, error: null } });
  // deno-lint-ignore no-explicit-any
  assertEquals(await weeklyDb(sb as any).weeklyReport(), { queue_open: 3 });
  assertEquals(calls, [['svc_weekly_report', {}]]);
});

Deno.test('an rpc error throws "rpc <name> failed" carrying only the SQLSTATE, never the provider message', async () => {
  const { ingestDb } = await load();
  const { sb } = fakeClient({ svc_ingest_batch: { data: null, error: { code: 'P0001', message: 'row data: SYNTHETIC-TITLE-SENTINEL' } } });
  // deno-lint-ignore no-explicit-any
  const e = await assertRejects(() => ingestDb(sb as any).batch('tok', {}, [])) as Error & { code?: string };
  assertEquals(e.message, 'rpc svc_ingest_batch failed');
  assertEquals(e.code, 'P0001');
});

Deno.test('a nonce reply that is not a boolean is treated as an error, not as "fresh"', async () => {
  const { ingestDb } = await load();
  const { sb } = fakeClient({ svc_ingest_nonce: { data: null, error: null } });
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => ingestDb(sb as any).nonce('0123456789abcdef0123456789abcdef'));
});
