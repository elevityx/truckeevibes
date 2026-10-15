// weekly-email: invoked by pg_cron through pg_net with a bearer secret from Vault (spec S1.7). Not a user endpoint.
// Authority: the bearer is compared in constant time to NOTIFY_CRON_SECRET; the service key never leaves function env.
// It calls only svc_weekly_report. The email carries numbers and source names only, every value escaped; the owner
// address lives only in this function's env. Logs carry the kind and status codes only.
// Env: NOTIFY_CRON_SECRET, RESEND_API_KEY, OWNER_EMAIL, NOTIFY_FROM, SITE_URL, SUPABASE_URL (+ the service key).
import { serviceClient, weeklyDb, type WeeklyDb, type WeeklyReport } from '../_shared/db.ts';
import { json, siteUrl, timingSafeEqual } from '../_shared/http.ts';
import { pacificParts } from '../_shared/pacific.ts';
import { sendEmail } from '../_shared/resend.ts';

export interface WeeklyEnv { cronSecret: string; resendKey: string; ownerEmail: string; from: string; siteUrl: string }
export interface WeeklyDeps {
  db: WeeklyDb;
  fetch: typeof fetch;
  now(): Date;
  log(line: string): void;
}

export function readEnv(): WeeklyEnv | null {
  const cronSecret = Deno.env.get('NOTIFY_CRON_SECRET');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const ownerEmail = Deno.env.get('OWNER_EMAIL');
  if (!cronSecret || !resendKey || !ownerEmail) return null;
  return { cronSecret, resendKey, ownerEmail, from: Deno.env.get('NOTIFY_FROM') ?? 'TruckeeVibes <notify@mail.truckeevibes.com>', siteUrl: siteUrl() };
}

/** HTML-escape every dynamic value. Nothing in the email is markup except the fixed template. */
export function text(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '0');

export function renderWeekly(r: WeeklyReport, site: string): { subject: string; text: string; html: string } {
  const pct = typeof r.auto_published_share_7d === 'number' ? `${Math.round(r.auto_published_share_7d * 100)}%` : 'n/a';
  const rows: [string, string][] = [
    ['Cards waiting for review', num(r.queue_open)],
    ['Oldest card (hours)', num(r.oldest_card_age_hours)],
    ['Review minutes, 7 days', num(r.review_minutes_7d)],
    ['Decisions, 7 days', num(r.decisions_7d)],
    ['Events published, 7 days', num(r.published_7d)],
    ['Published without a human', pct],
    ['Published by rule (auto / strict)', `${num(r.published_by_rule_7d?.publish)} / ${num(r.published_by_rule_7d?.strict_auto)}`],
    ['Held runs pending', num(r.held_runs_pending)],
    ['Sources moved to link-only by budget, 7 days', num(r.link_only_by_budget_7d)],
    ['Rejected as out of region, 7 days', num(r.rejected_out_of_region_7d)],
    ['Geocode lookups this month', `${num(r.geocode_month?.units)} of ${num(r.geocode_month?.cap)}`],
  ];
  const lists: [string, string[]][] = [
    ['Cards created by source, 7 days', (r.cards_created_by_source_7d ?? []).map((x) => `${x.source}: ${num(x.n)}`)],
    ['Sources needing attention', (r.broken_sources ?? []).map((x) =>
      `${x.source}: ${x.status ?? 'no run'}, ${num(x.consecutive_failures)} failures, last success ${x.last_success_at ?? 'never'}`)],
    ['Pending events without a card', (r.uncarded_pending ?? []).map((x) => `${x.source}: ${num(x.n)}`)],
    ['Terms due for re-review', (r.terms_recheck_due ?? []).map((x) => `${x.source}: ${x.terms_recheck_at}`)],
  ];
  const textBody = [
    'TruckeeVibes weekly report', '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    ...lists.flatMap(([title, items]) => [`${title}:`, ...(items.length ? items.map((i) => `  - ${i}`) : ['  none']), '']),
    `Admin: ${site}/admin/`,
  ].join('\n');
  const htmlBody = [
    '<h1 style="font-size:18px">TruckeeVibes weekly report</h1>',
    '<table cellpadding="4" style="border-collapse:collapse">',
    ...rows.map(([k, v]) => `<tr><td>${text(k)}</td><td><strong>${text(v)}</strong></td></tr>`),
    '</table>',
    ...lists.map(([title, items]) => `<h2 style="font-size:15px">${text(title)}</h2>` +
      (items.length ? `<ul>${items.map((i) => `<li>${text(i)}</li>`).join('')}</ul>` : '<p>none</p>')),
    `<p><a href="${text(site)}/admin/">Open the admin</a></p>`,
  ].join('\n');
  return { subject: `TruckeeVibes weekly: ${num(r.queue_open)} waiting for review`, text: textBody, html: htmlBody };
}

export function renderHeartbeat(hours: number | null): { subject: string; text: string; html: string } {
  const line = typeof hours === 'number' && Number.isFinite(hours)
    ? `No successful ingest run for ${hours} hours.` : 'No successful ingest run has been recorded.';
  return { subject: 'TruckeeVibes: ingest has stopped', text: line, html: `<p>${text(line)}</p>` };
}

export async function handle(req: Request, env: WeeklyEnv | null, deps: WeeklyDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!env) { deps.log('weekly-email status=500 not_configured'); return json(500, { error: 'unavailable' }); }
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bearer || !timingSafeEqual(bearer, env.cronSecret)) return json(401, { error: 'unauthorized' });

  let kind: unknown;
  try { kind = ((await req.json()) as { kind?: unknown } | null)?.kind; } catch { kind = undefined; }
  if (kind !== 'weekly' && kind !== 'heartbeat') { deps.log('weekly-email status=400 bad_kind'); return json(400, { error: 'bad_kind' }); }

  const now = deps.now();
  let key: string;
  if (kind === 'weekly') {
    // pg_cron fires at 14:07 and 15:07 UTC on Thursdays; only the 07:xx Pacific one is due.
    const p = pacificParts(now);
    if (p.weekday !== 'Thu' || p.hour !== 7) { deps.log('weekly-email kind=weekly status=200 not_due'); return json(200, { skipped: 'not_due' }); }
    key = `weekly:${p.date}`;
  } else {
    key = `heartbeat:${now.toISOString().slice(0, 10)}`;
  }

  let report: WeeklyReport;
  try { report = await deps.db.weeklyReport(); } catch (e) {
    deps.log(`weekly-email kind=${kind} status=500 code=${(e as { code?: string }).code ?? 'none'}`);
    return json(500, { error: 'unavailable' });
  }
  const mail = kind === 'weekly' ? renderWeekly(report, env.siteUrl) : renderHeartbeat(report.heartbeat_hours ?? null);
  const sent = await sendEmail(env.resendKey, key, { from: env.from, to: env.ownerEmail, ...mail }, { fetch: deps.fetch });
  if (!sent.ok) {
    deps.log(`weekly-email kind=${kind} status=502 send_failed code=${sent.code}`);
    return json(502, { error: 'unavailable' });
  }
  deps.log(`weekly-email kind=${kind} status=200 sent`);
  return json(200, { sent: true, kind });
}

if (import.meta.main) {
  const env = readEnv();
  const sb = serviceClient(Deno.env.get('SUPABASE_URL') ?? '');
  Deno.serve((req) => {
    if (!sb) { console.error('500 not configured'); return Promise.resolve(json(500, { error: 'unavailable' })); }
    return handle(req, env, { db: weeklyDb(sb), fetch, now: () => new Date(), log: (l) => console.log(l) });
  });
}
