// AC-M1-40 and the S1.7 contract of the `weekly-email` Edge Function handler. Failing-first: ./index.ts does not exist yet.
// Shape (modeled on TL send-digest): handle(req, env, deps) with
//   env  = { cronSecret, resendKey, ownerEmail, from, siteUrl }       (NOTIFY_CRON_SECRET, RESEND_API_KEY, OWNER_EMAIL, NOTIFY_FROM, SITE_URL)
//   deps = { db: { weeklyReport(): Promise<WeeklyReport> }, fetch, now(): Date }
// and Resend is reached through the copied sendEmail(apiKey, idempotencyKey, email, { fetch }), so the test inspects the fetch.
import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';

// deno-lint-ignore no-explicit-any
type Handle = (req: Request, env: any, deps: any) => Promise<Response>;
async function load(): Promise<Handle> {
  const m = await import('./index.ts');
  return m.handle as Handle;
}

// Secrets built from fragments so no key-shaped literal sits in the file.
const CRON = ['cron', 'bearer', 'fixture', '0123456789'].join('-');
const RESEND = ['re', 'fixture', 'key', 'abcdef'].join('_');
const OWNER = ['owner', 'fixture'].join('.') + '@' + 'example.test';
const ENV = { cronSecret: CRON, resendKey: RESEND, ownerEmail: OWNER, from: 'TruckeeVibes <notify@example.test>', siteUrl: 'https://example.test' };

const REPORT = {
  queue_open: 7341, oldest_card_age_hours: 12.5,
  cards_created_by_source_7d: [{ source: '<script>x</script>', n: 4 }, { source: 'Alibi Ale Works', n: 2 }],
  review_minutes_7d: 42.5, decisions_7d: 9, published_7d: 30, auto_published_share_7d: 0.8,
  broken_sources: [{ source: '<script>x</script>', status: 'http_error', consecutive_failures: 3, last_success_at: '2026-11-01T00:00:00Z' }],
  held_runs_pending: 1, link_only_by_budget_7d: 0, uncarded_pending: [], rejected_out_of_region_7d: 2,
  published_by_rule_7d: { publish: 20, strict_auto: 10 }, terms_recheck_due: [], geocode_month: { units: 12, cap: 300 }, heartbeat_hours: 40,
};

interface Sent { url: string; headers: Headers; body: { from: string; to: string | string[]; subject: string; html: string; text: string } }
function fake(opts: { now: string; resendStatus?: number }) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const deps = {
    db: { weeklyReport: () => { calls.push('report'); return Promise.resolve(REPORT); } },
    fetch: (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      sent.push({ url: u, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify({ id: 'em_1' }), { status: opts.resendStatus ?? 200 }));
    },
    now: () => new Date(opts.now),
    log: (l: string) => logs.push(l),
  };
  return { sent, logs, calls, deps };
}
const post = (body: unknown, bearer: string | null = CRON) =>
  new Request('https://fn.test/weekly-email', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
  });

// 2026-11-05 is a Thursday. 15:07Z = 07:07 PST; 14:07Z = 06:07 PST. 2026-10-15 is a Thursday: 14:07Z = 07:07 PDT.
const THU_0707_PST = '2026-11-05T15:07:00Z';

Deno.test('AC-M1-40 a wrong or missing bearer -> 401 and nothing is read or sent', async () => {
  const handle = await load();
  for (const b of ['wrong-bearer', '', null]) {
    const f = fake({ now: THU_0707_PST });
    const res = await handle(post({ kind: 'weekly' }, b), ENV, f.deps);
    assertEquals(res.status, 401);
    assertEquals(f.calls, []);
    assertEquals(f.sent.length, 0);
  }
});

Deno.test('S1.7 GET -> 405; missing env -> 500 unavailable', async () => {
  const handle = await load();
  const f = fake({ now: THU_0707_PST });
  assertEquals((await handle(new Request('https://fn.test/weekly-email'), ENV, f.deps)).status, 405);
  const res = await handle(post({ kind: 'weekly' }), null, f.deps);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, 'unavailable');
});

Deno.test('AC-M1-40 Wednesday 07:07 Pacific -> 200 not_due, no report read, no send', async () => {
  const handle = await load();
  const f = fake({ now: '2026-11-04T15:07:00Z' });
  const res = await handle(post({ kind: 'weekly' }), ENV, f.deps);
  assertEquals(res.status, 200);
  assertStringIncludes(JSON.stringify(await res.json()), 'not_due');
  assertEquals(f.calls, []);
  assertEquals(f.sent.length, 0);
});

Deno.test('AC-M1-40 the slot guard keeps exactly one of the two cron fires (14:xx and 15:xx UTC) in both PST and PDT', async () => {
  const handle = await load();
  const cases: [string, boolean][] = [
    ['2026-11-05T14:07:00Z', false], // 06:07 PST
    ['2026-11-05T15:07:00Z', true],  // 07:07 PST
    ['2026-10-15T14:07:00Z', true],  // 07:07 PDT
    ['2026-10-15T15:07:00Z', false], // 08:07 PDT
  ];
  for (const [now, due] of cases) {
    const f = fake({ now });
    const res = await handle(post({ kind: 'weekly' }), ENV, f.deps);
    assertEquals(res.status, 200, now);
    assertEquals(f.sent.length, due ? 1 : 0, now);
  }
});

Deno.test('AC-M1-40 Thursday 07:07 Pacific -> exactly one send with Idempotency-Key weekly:<Pacific date>', async () => {
  const handle = await load();
  const f = fake({ now: THU_0707_PST });
  const res = await handle(post({ kind: 'weekly' }), ENV, f.deps);
  assertEquals(res.status, 200);
  assertEquals(f.calls, ['report']);
  assertEquals(f.sent.length, 1);
  const s = f.sent[0];
  assertEquals(s.url, 'https://api.resend.com/emails');
  assertEquals(s.headers.get('Idempotency-Key'), 'weekly:2026-11-05');
  assertEquals(s.headers.get('Authorization'), `Bearer ${RESEND}`);
  assertEquals(s.body.from, ENV.from);
  assert([s.body.to].flat().includes(OWNER));
});

Deno.test('AC-M1-40 the email shows the queue size and review minutes (text and HTML)', async () => {
  const handle = await load();
  const f = fake({ now: THU_0707_PST });
  await handle(post({ kind: 'weekly' }), ENV, f.deps);
  const { text, html } = f.sent[0].body;
  for (const part of [text, html]) {
    assertStringIncludes(part, '7341');
    assertStringIncludes(part, '42.5');
  }
});

Deno.test('AC-M1-40 a source named <script>x</script> appears escaped in the HTML (never raw)', async () => {
  const handle = await load();
  const f = fake({ now: THU_0707_PST });
  await handle(post({ kind: 'weekly' }), ENV, f.deps);
  const { html } = f.sent[0].body;
  assertStringIncludes(html, '&lt;script&gt;x&lt;/script&gt;');
  assertFalse(html.includes('<script'));
  assertFalse(f.sent[0].body.subject.includes('<'));
});

Deno.test('S1.7 a Resend failure -> 502 unavailable; neither the owner address nor the API key reaches the logs or the response', async () => {
  const handle = await load();
  const f = fake({ now: THU_0707_PST, resendStatus: 500 });
  const res = await handle(post({ kind: 'weekly' }), ENV, f.deps);
  assertEquals(res.status, 502);
  const text = await res.text();
  const logged = f.logs.join('\n');
  for (const secret of [OWNER, RESEND, CRON]) {
    assertFalse(text.includes(secret));
    assertFalse(logged.includes(secret));
  }
});

Deno.test('S1.7 heartbeat bypasses the slot guard: one short email naming the hours, key heartbeat:<UTC date>', async () => {
  const handle = await load();
  const f = fake({ now: '2026-11-04T03:30:00Z' }); // a Tuesday night in Pacific, 2026-11-04 UTC
  const res = await handle(post({ kind: 'heartbeat' }), ENV, f.deps);
  assertEquals(res.status, 200);
  assertEquals(f.sent.length, 1);
  assertEquals(f.sent[0].headers.get('Idempotency-Key'), 'heartbeat:2026-11-04');
  assertStringIncludes(f.sent[0].body.text, 'No successful ingest run for 40 hours');
  assert([f.sent[0].body.to].flat().includes(OWNER));
});

Deno.test('S1.7 heartbeat needs the bearer too', async () => {
  const handle = await load();
  const f = fake({ now: THU_0707_PST });
  assertEquals((await handle(post({ kind: 'heartbeat' }, 'nope'), ENV, f.deps)).status, 401);
  assertEquals(f.sent.length, 0);
});

Deno.test('S1.7 an unknown kind, a missing kind or a non-JSON body -> 400', async () => {
  const handle = await load();
  for (const b of [{ kind: 'daily' }, {}, 'not json']) {
    const f = fake({ now: THU_0707_PST });
    const res = await handle(post(b), ENV, f.deps);
    assertEquals(res.status, 400, JSON.stringify(b));
    assertEquals(f.sent.length, 0);
  }
});
