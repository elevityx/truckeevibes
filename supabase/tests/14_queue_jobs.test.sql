-- AC-M1-34 ... 39, 41, 54 (+ S1.4 admin behaviors and the S1.5 job table). Order matters: the heartbeat, notify and weekly-report
-- sections run first, on an otherwise empty ingest history.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------------------------------
-- Shared helpers (this block is repeated verbatim at the top of each M1 pgTAP file; pgTAP files cannot include).
-- Every call into code under test goes through pg_temp.v / pg_temp.x / pg_temp.rb, which turn a database error into a
-- text value, so a missing object fails exactly one assertion instead of aborting the whole file.
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.ctx(p_ctx text) returns void language plpgsql as $$
begin
  if p_ctx in ('admin', 'user') then
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', case p_ctx when 'admin' then 'e1500000-0000-4000-a000-000000000001' else 'e1500000-0000-4000-a000-000000000002' end,
      'role', 'authenticated', 'is_anonymous', false, 'aal', 'aal2',
      'amr', '[{"method":"totp","timestamp":1791564301},{"method":"password","timestamp":1791564300}]'::jsonb)::text, true);
    perform set_config('role', 'authenticated', true);
  elsif p_ctx in ('anon', 'service_role') then
    perform set_config('request.jwt.claims', jsonb_build_object('role', p_ctx)::text, true);
    perform set_config('role', p_ctx, true);
  end if;
end $$;
-- scalar expression -> text as ctx in (postgres, anon, authenticated-user, admin, service_role); error -> 'ERR:<state>|<msg>|<detail>'
create function pg_temp.v(p_ctx text, p_expr text) returns text language plpgsql as $$
declare r text; v_msg text; v_detail text;
begin
  perform pg_temp.ctx(p_ctx);
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
-- statement -> 'OK' or the same ERR text
create function pg_temp.x(p_ctx text, p_sql text) returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform pg_temp.ctx(p_ctx);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
create function pg_temp.q(p_expr text) returns text language sql as $$ select pg_temp.v('postgres', p_expr) $$;
-- an ERR text carries this SQLSTATE / this exact message / this detail
create function pg_temp.err(p_x text, p_state text, p_msg text, p_detail text default null) returns boolean language sql as $$
  select p_x like 'ERR:' || p_state || '|' || p_msg || '|' || coalesce(p_detail, '') || case when p_detail is null then '%' else '' end
$$;
create function pg_temp.errm(p_x text, p_msg text) returns boolean language sql as $$
  select p_x like 'ERR:%|' || p_msg || '|%' $$;
-- md5 over a whole table / query (row text sorted), '-' when empty
create function pg_temp.snap(p_from text) returns text language plpgsql as $$
declare r text;
begin
  execute format('select coalesce(md5(string_agg(t::text, ''|'' order by t::text)), ''-'') from %s t', p_from) into r;
  return r;
exception when others then return 'ERR:' || sqlstate;
end $$;
create function pg_temp.n(p_from text) returns bigint language plpgsql as $$
declare r bigint;
begin
  execute 'select count(*) from ' || p_from into r;
  return r;
exception when others then return -1;
end $$;

-- assertion wrappers: the expression is evaluated through pg_temp.q, so a missing object fails this assertion only
create function pg_temp.eq(p_expr text, p_expected text, p_desc text) returns text language sql as $$
  select is(pg_temp.q(p_expr), p_expected, p_desc) $$;
create function pg_temp.t(p_expr text, p_desc text) returns text language sql as $$
  select is(pg_temp.q(p_expr), 'true', p_desc) $$;
create function pg_temp.jb(p_t text) returns jsonb language plpgsql as $$
begin return p_t::jsonb; exception when others then return null; end $$;

-- local-time helpers: an ISO UTC timestamp for "<days> from today at hh:mm Pacific (+ plus minutes)"
create function pg_temp.ts(p_days int, p_hh int, p_mm int default 0, p_plus int default 0) returns text language sql as $$
  select to_char(((((now() at time zone 'America/Los_Angeles')::date + p_days) + make_time(p_hh, p_mm, 0)
                   + make_interval(mins => p_plus)) at time zone 'America/Los_Angeles') at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
create function pg_temp.tstz(p_days int, p_hh int, p_mm int default 0, p_plus int default 0) returns timestamptz language sql as $$
  select pg_temp.ts(p_days, p_hh, p_mm, p_plus)::timestamptz $$;

-- fixtures. Item key names are the camelCase of the `facts` columns (S1.2 step 6) plus the plan-3.2 SourceEvent keys.
create function pg_temp.mk_admin() returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email)
    select ('e1500000-0000-4000-a000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'm1fx' || n || '@example.test'
      from generate_series(1, 2) n on conflict do nothing;
  insert into public.admins (user_id, note) values ('e1500000-0000-4000-a000-000000000001', 'm1 test') on conflict do nothing;
end $$;
-- an enabled, permitted, evidenced source (the gate allows it); trust/class as asked
create function pg_temp.mk_source(p_slug text, p_class text default 'organizer', p_trust text default 'review',
                                  p_hosts text[] default array['example.test'], p_cadence text default '24h') returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust, enabled, cadence,
      ingest_disposition, allowed_methods, terms_url, terms_hash, terms_reviewed_by, terms_reviewed_at, terms_recheck_at)
    values (p_slug, 'Src ' || p_slug, 'https://example.test/' || p_slug, p_hosts, 'ics', p_class::public.source_class,
            p_trust::public.source_trust, true, p_cadence, 'permitted', array['feed'], 'https://example.test/terms',
            repeat('a', 64), 'test', now(), now() + interval '30 days')
    returning id into v_id;
  return v_id;
end $$;
create function pg_temp.item(p_key text, p_title text, p_days int, p_hh int default 18, p_over jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('externalKey', p_key, 'title', p_title,
      'startsAt', pg_temp.ts(p_days, p_hh), 'endsAt', pg_temp.ts(p_days, p_hh, 0, 120),
      'allDay', false, 'timeKnown', true, 'venueName', 'Test Hall', 'address', '10 Main St', 'town', 'Truckee',
      'lat', 39.328, 'lng', -120.1833, 'url', 'https://example.test/e/' || p_key,
      'priceKind', 'free', 'age', 'unknown', 'categoriesHint', jsonb_build_array('music')) || p_over
$$;
-- n distinct, non-clustering items (unique md5 titles, 5 time slots a day over ~100 days). The first p_changed items get
-- a " v2" title suffix (a content change); p_urlbase sets the URL prefix.
create function pg_temp.bulk(p_n int, p_prefix text default 'b', p_changed int default 0, p_urlbase text default 'https://example.test/e/') returns jsonb
language sql as $$
  select coalesce(jsonb_agg(pg_temp.item(p_prefix || n, 'Fest ' || substr(md5(p_prefix || n), 1, 12) || case when n <= p_changed then ' v2' else '' end,
                                         1 + (n % 100), 9 + (n % 5) * 2, jsonb_build_object('url', p_urlbase || p_prefix || n))), '[]')
    from generate_series(1, p_n) n
$$;
-- issue a fresh grant for exactly this source and submit; returns the RPC result. Runs as postgres.
create function pg_temp.run_batch(p_slug text, p_items jsonb, p_run jsonb default '{}') returns jsonb language plpgsql as $$
declare v_tok text;
begin
  update public.sources set next_due_at = now() + interval '1 day' where slug <> p_slug and next_due_at <= now();
  update public.sources set next_due_at = now() where slug = p_slug;
  select g ->> 'grant' into v_tok from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g
   where g #>> '{source,slug}' = p_slug;
  if v_tok is null then raise exception 'test fixture: no grant issued for %', p_slug; end if;
  return public.svc_ingest_batch(v_tok,
    jsonb_build_object('status', 'ok', 'started_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'http_status', 200, 'parser_version', 'test-1') || p_run, p_items);
end $$;
-- run_batch returning only the error text (or 'OK'): for refusals whose result row is not needed
create function pg_temp.run_batch_err(p_slug text, p_items jsonb, p_run jsonb default '{}') returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform pg_temp.run_batch(p_slug, p_items, p_run);
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
create temp table tres (label text primary key, res jsonb, err text);
-- run_batch with the outcome recorded under a label (never raises)
create function pg_temp.rb(p_label text, p_slug text, p_items jsonb, p_run jsonb default '{}') returns void language plpgsql as $$
declare v_msg text; v_detail text;
begin
  insert into tres (label, res) values (p_label, pg_temp.run_batch(p_slug, p_items, p_run))
    on conflict (label) do update set res = excluded.res, err = null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  insert into tres (label, err) values (p_label, 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, ''))
    on conflict (label) do update set err = excluded.err, res = null;
end $$;
create function pg_temp.r(p_label text, p_key text) returns text language sql as $$
  select coalesce((select coalesce(res ->> p_key, err) from tres where label = p_label), '<no result>') $$;
-- drain the cluster outbox; returns the last result
create function pg_temp.cluster_all() returns jsonb language plpgsql as $$
declare r jsonb; i int := 0;
begin
  loop
    r := public.svc_cluster_and_publish(500);
    i := i + 1;
    exit when (r ->> 'remaining')::int = 0 or i > 10;
  end loop;
  return r;
exception when others then
  return jsonb_build_object('error', sqlstate || ':' || sqlerrm);
end $$;
-- ingest + drain in one step (label records the batch result)
create function pg_temp.ing(p_label text, p_slug text, p_items jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.rb(p_label, p_slug, p_items);
  perform pg_temp.cluster_all();
end $$;
create function pg_temp.vid(p_name text) returns uuid language plpgsql as $$
declare r uuid;
begin execute 'select id from public.venues where name = $1 order by created_at limit 1' into r using p_name; return r;
exception when others then return null; end $$;
create function pg_temp.status_of(p_title text) returns text language sql as $$
  select coalesce((select status::text from public.events where title = p_title and merged_into is null), '<none>') $$;
create function pg_temp.seed_runs(p_slug text, p_n int, p_found int, p_new int) returns void language plpgsql as $$
begin
  insert into public.source_runs (id, source_id, started_at, finished_at, status, items_found, items_new)
    select gen_random_uuid(), (select id from public.sources where slug = p_slug),
           now() - make_interval(hours => 24 + n * 6), now() - make_interval(hours => 24 + n * 6), 'ok', p_found, p_new
      from generate_series(1, p_n) n;
exception when others then null;
end $$;
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_admin();
delete from vault.secrets where name in ('project_url', 'notify_function_url', 'notify_cron_secret');

-- AC-M1-38: heartbeat ---------------------------------------------------------------------------------------------------
select pg_temp.mk_source('hb', 'organizer', 'review');
select pg_temp.x('postgres', $$insert into public.source_runs (id, source_id, started_at, finished_at, status)
  values (gen_random_uuid(), (select id from public.sources where slug = 'hb'), now() - interval '37 hours', now() - interval '37 hours', 'ok')$$);
select pg_temp.eq($$private.check_heartbeat()$$, 'alert', 'AC-M1-38 last ok run 37 h ago and no heartbeat in 24 h -> alert');
select pg_temp.eq($$(select count(*) from private.notify_log where kind = 'heartbeat')$$, '1', 'AC-M1-38 ... and a notify_log heartbeat row is written');
select pg_temp.eq($$private.check_heartbeat()$$, 'suppressed', 'AC-M1-38 a second call within 24 h -> suppressed');
select pg_temp.eq($$(select count(*) from private.notify_log where kind = 'heartbeat')$$, '1', 'AC-M1-38 ... without a second log row');
select pg_temp.x('postgres', $$insert into public.source_runs (id, source_id, started_at, finished_at, status)
  values (gen_random_uuid(), (select id from public.sources where slug = 'hb'), now() - interval '2 hours', now() - interval '2 hours', 'ok')$$);
select pg_temp.eq($$private.check_heartbeat()$$, 'ok', 'AC-M1-38 last ok run 2 h ago -> ok');

-- AC-M1-39: run_notify host pinning ------------------------------------------------------------------------------------------
select vault.create_secret('https://abcdefghijklmnop.supabase.test', 'project_url');
select pg_temp.x('postgres', $$select private.set_notify_secret('notify_cron_secret', 'local-test-bearer')$$);
create temp table q0 as select count(*) n from net.http_request_queue;
create temp table hostile (u text);
insert into hostile values
  ('https://attacker.example/functions/v1/weekly-email'),
  ('http://abcdefghijklmnop.supabase.test/functions/v1/weekly-email'),
  ('https://abcdefghijklmnop.supabase.test:8443/functions/v1/weekly-email'),
  ('https://user@abcdefghijklmnop.supabase.test/functions/v1/weekly-email'),
  ('https://abcdefghijklmnop.supabase.test@attacker.example/functions/v1/weekly-email'),
  ('https://abcdefghijklmnop.supabase.test.attacker.example/functions/v1/weekly-email'),
  ('https://abcdefghijklmnop.supabase.test/functions/v1/weekly-email/'),
  ('https://abcdefghijklmnop.supabase.test/functions/v1/weekly-email?x=1'),
  ('https://abcdefghijklmnop.supabase.test/x/functions/v1/weekly-email'),
  ('https://abcdefghijklmnop.supabase.test/functions/v1/ingest');
select pg_temp.eq($$private.run_notify('weekly')$$, '<null>', 'AC-M1-39 no function URL in Vault -> run_notify is a no-op (null)');
create function pg_temp.plant(p_url text) returns text language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'notify_function_url';
  if v_id is null then perform vault.create_secret(p_url, 'notify_function_url');
  else perform vault.update_secret(v_id, p_url); end if;
  return pg_temp.v('postgres', $q$private.run_notify('weekly')$q$);
end $$;
select is((select count(*)::int from hostile h where pg_temp.plant(h.u) = '<null>'), 10, 'AC-M1-39 run_notify returns null for all 10 hostile URLs (other host, http, port, userinfo, suffix/prefix host, path suffix, query, path prefix, other function)');
select is((select count(*)::text from net.http_request_queue), (select n::text from q0), 'AC-M1-39 ... and queues no request');
select pg_temp.x('postgres', $$select private.set_notify_secret('notify_function_url', 'https://abcdefghijklmnop.supabase.test/functions/v1/weekly-email')$$);
select pg_temp.t($$private.run_notify('weekly') is not null$$, 'AC-M1-39 the exact URL on the project host queues a request');
select pg_temp.eq($$(select url || '|' || (headers ->> 'Authorization') || '|' || method from net.http_request_queue order by id desc limit 1)$$,
  'https://abcdefghijklmnop.supabase.test/functions/v1/weekly-email|Bearer local-test-bearer|POST', 'AC-M1-39 ... to weekly-email with the Vault bearer');
select pg_temp.eq($$(select count(*) from net.http_request_queue) - (select n from q0)$$, '1', 'AC-M1-39 ... exactly one');
select pg_temp.t($$not has_function_privilege('authenticated', 'private.run_notify(text)', 'EXECUTE') and not has_function_privilege('anon', 'private.set_notify_secret(text, text)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.check_heartbeat()', 'EXECUTE')$$, 'run_notify / set_notify_secret / check_heartbeat have no API EXECUTE');
delete from vault.secrets where name in ('project_url', 'notify_function_url', 'notify_cron_secret');

-- S1.5: the job table -------------------------------------------------------------------------------------------------------
create temp table jobs_expected (jobname text, schedule text, fn text);
insert into jobs_expected values
  ('tv-expire-queue', '15 10 * * *', 'private.expire_queue()'), ('tv-queue-budget', '25 10 * * *', 'private.queue_budget()'),
  ('tv-expire-held', '35 10 * * *', 'private.expire_held_runs()'), ('tv-terms-recheck', '45 10 * * *', 'private.terms_recheck()'),
  ('tv-retention', '55 10 * * *', 'private.retention_sweep()'), ('tv-heartbeat', '5 * * * *', 'private.check_heartbeat()'),
  ('tv-weekly-email', '7 14,15 * * 4', 'private.run_notify(''weekly'')');
select is((select count(*)::int from jobs_expected e join cron.job j on j.jobname = e.jobname and j.schedule = e.schedule and j.command ilike '%' || e.fn || '%'), 7,
  'S1.5 the seven tv-* pg_cron jobs exist with the specified schedules and functions');
select is((select count(*)::int from cron.job where jobname like 'tv-%'), 7, 'S1.5 and there are no other tv-* jobs');

-- AC-M1-41: weekly report (clean history) -----------------------------------------------------------------------------------------
select pg_temp.mk_source('w-rev', 'organizer', 'review');
select pg_temp.mk_source('w-auto', 'organizer', 'auto');
select pg_temp.ing('w1', 'w-rev', pg_temp.bulk(4, 'wr'));
select pg_temp.ing('w2', 'w-auto', pg_temp.bulk(1, 'wa'));
create function pg_temp.ev_id_q(k text) returns uuid language plpgsql as $$
declare r uuid;
begin execute 'select se.cluster_id from public.source_events se where se.external_key = $1 limit 1' into r using k; return r;
exception when others then return null; end $$;
create function pg_temp.card_of(k text) returns uuid language plpgsql as $$
declare r uuid;
begin
  execute 'select c.id from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = $1 and c.kind = ''event'' and c.status = ''open'' limit 1' into r using k;
  return r;
exception when others then return null; end $$;
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'approve', null, 30)$$, pg_temp.card_of('wr1'))), 'OK', 'fixture: card 1 approved with 30 s');
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'approve', null, 60)$$, pg_temp.card_of('wr2'))), 'OK', 'fixture: card 2 approved with 60 s');
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'approve', null, 90)$$, pg_temp.card_of('wr3'))), 'OK', 'fixture: card 3 approved with 90 s');
select pg_temp.x('postgres', $$insert into public.owner_activity (kind, seconds) values ('featured', 60)$$);
create temp table wr as select pg_temp.jb(pg_temp.v('service_role', 'public.svc_weekly_report()')) r;
select pg_temp.t($$(select r ?& array['queue_open', 'oldest_card_age_hours', 'cards_created_by_source_7d', 'review_minutes_7d', 'decisions_7d', 'published_7d',
   'auto_published_share_7d', 'broken_sources', 'held_runs_pending', 'link_only_by_budget_7d', 'uncarded_pending', 'rejected_out_of_region_7d',
   'published_by_rule_7d', 'terms_recheck_due', 'geocode_month', 'heartbeat_hours'] from wr)$$, 'S1.5 svc_weekly_report returns every documented key');
select pg_temp.t($$(select (r ->> 'review_minutes_7d')::numeric = 4.0 from wr)$$, 'AC-M1-41 3 cards decided at 30/60/90 s and one 60 s owner_activity -> review_minutes_7d = 4.0');
select pg_temp.eq($$(select r ->> 'decisions_7d' from wr)$$, '3', 'AC-M1-41 decisions_7d = 3');
select pg_temp.eq($$(select r ->> 'published_7d' from wr)$$, '4', 'AC-M1-41 published_7d = 4 (3 approved + 1 by rule)');
select pg_temp.t($$(select (r ->> 'auto_published_share_7d')::numeric = 0.25 from wr)$$, 'AC-M1-41 auto_published_share_7d = published without an admin / published = 1/4');
select pg_temp.eq($$(select (r -> 'published_by_rule_7d' ->> 'publish') || '/' || (r -> 'published_by_rule_7d' ->> 'strict_auto') from wr)$$, '1/0', 'S1.5 published_by_rule_7d = {publish: 1, strict_auto: 0}');
select pg_temp.eq($$(select count(*) from private.notify_log where kind = 'weekly')$$, '1', 'S1.5 svc_weekly_report inserts notify_log(weekly)');

-- AC-M1-34: deciding cards, S1.4 ------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('q-rev', 'organizer', 'review', array['example.test', 'sup2.example.test']);
select pg_temp.ing('q1', 'q-rev', jsonb_build_array(
  pg_temp.item('qa', 'Queue Approve Fest', 20), pg_temp.item('qb', 'Queue Reject Fest', 21), pg_temp.item('qc', 'Queue Open Fest', 22),
  pg_temp.item('qd', 'Queue Patch Fest', 23), pg_temp.item('qe', 'Queue Hide Fest', 24),
  pg_temp.item('qf', 'Queue Suppress Fest', 25, 18, '{"url":"https://sup2.example.test/qf"}')));
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'approve', 'looks right', 900)$$, pg_temp.card_of('qa'))), 'OK', 'AC-M1-34 admin_decide_card(approve, review_seconds 900) succeeds');
select pg_temp.eq($$(select e.status::text || '/' || e.status_by_admin from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'qa')$$, 'published/true', 'AC-M1-34 event published with status_by_admin');
select pg_temp.t($$(select e.published_at is not null from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'qa')$$, 'AC-M1-34 published_at is set');
select pg_temp.eq($$(select c.review_seconds || '/' || c.status || '/' || c.decision || '/' || (c.decided_at is not null) || '/' || (c.decided_by = 'e1500000-0000-4000-a000-000000000001')
                       from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = 'qa' and c.kind = 'event')$$,
  '600/closed/approve/true/true', 'AC-M1-34 card: review_seconds clamped to 600, closed, decision approve, decided_at and decided_by set');
select pg_temp.t($$exists (select 1 from public.event_changes ec join public.source_events se on se.cluster_id = ec.event_id where se.external_key = 'qa'
                      and ec.decided_by = 'admin:e1500000-0000-4000-a000-000000000001')$$, 'AC-M1-34 the decision is journaled in event_changes with decided_by admin:<uid>');
select pg_temp.t($$pg_temp.v('admin', format('public.admin_decide_card(%L, ''approve'', null, 5)', (select c.id from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = 'qa' and c.kind = 'event'))) like 'ERR:%|not\_pending|%'$$, 'AC-M1-34 deciding a closed card -> not_pending');
select is(pg_temp.v('user', format('public.admin_decide_card(%L, ''approve'', null, 5)', pg_temp.card_of('qb'))), 'ERR:42501|forbidden|', 'AC-M1-34 a non-admin -> forbidden');
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'reject', 'not local', 20)$$, pg_temp.card_of('qb'))), 'OK', 'S1.4 reject succeeds');
select pg_temp.eq($$(select e.status::text || '/' || e.status_by_admin || '/' || e.reject_reason from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'qb')$$, 'rejected/true/not local', 'S1.4 reject -> rejected, status_by_admin, reject_reason');
select is(pg_temp.x('admin', format($$select public.admin_card_open(%L)$$, pg_temp.card_of('qc'))), 'OK', 'S1.4 admin_card_open succeeds');
select pg_temp.t($$(select c.opened_at is not null from public.review_cards c where c.id = pg_temp.card_of('qc'))$$, 'S1.4 admin_card_open sets opened_at');
select pg_temp.t($$pg_temp.v('admin', $e$(select count(*) from public.admin_queue('event', 1000))$e$) ~ '^[0-9]+$'$$, 'S1.4 admin_queue(kind, limit) works for an admin (limit above 100 is clamped, not an error)');
select is(pg_temp.v('user', $$(select count(*) from public.admin_queue('event', 10))$$), 'ERR:42501|forbidden|', 'S1.4 admin_queue is forbidden to a non-admin');
select pg_temp.t($$pg_temp.v('admin', $e$(select bool_and(c ? 'kind' or c ? 'id') from public.admin_queue('event', 10) c)$e$) = 'true'$$, 'S1.4 queue rows are jsonb cards');
-- admin_update_event / status / unlock / suppression / activity / health
select is(pg_temp.x('admin', format($$select public.admin_update_event(%L, '{"price_kind":"paid","price_min":12.5}'::jsonb)$$, pg_temp.ev_id_q('qd'))), 'OK', 'S1.4 admin_update_event with allowed keys succeeds');
select pg_temp.t($$(select e.locked_fields @> array['price_kind', 'price_min'] and e.field_sources ->> 'price_kind' = 'admin' and e.price_kind = 'paid' from public.events e where e.id = pg_temp.ev_id_q('qd'))$$, 'S1.4 patched keys are locked, attributed to admin and applied');
select pg_temp.t($$pg_temp.x('admin', format($e$select public.admin_update_event(%L, '{"status":"published"}'::jsonb)$e$, pg_temp.ev_id_q('qd'))) like 'ERR:22023|invalid_input|%'$$, 'S1.4 admin_update_event rejects keys outside the allowed list (invalid_input)');
select is(pg_temp.x('admin', format($$select public.admin_unlock_field(%L, 'price_min')$$, pg_temp.ev_id_q('qd'))), 'OK', 'S1.4 admin_unlock_field succeeds');
select pg_temp.t($$(select not (e.locked_fields @> array['price_min']) and e.locked_fields @> array['price_kind'] from public.events e where e.id = pg_temp.ev_id_q('qd'))$$, 'S1.4 ... and removes only that field from locked_fields');
select is(pg_temp.x('admin', format($$select public.admin_set_event_status(%L, 'hidden', 'duplicate')$$, pg_temp.ev_id_q('qe'))), 'OK', 'S1.4 admin_set_event_status(hidden) succeeds');
select pg_temp.x('postgres', $$update public.source_events set needs_cluster = true where external_key = 'qe'$$);
select pg_temp.cluster_all();
select pg_temp.eq($$(select e.status::text || '/' || e.status_by_admin from public.events e where e.id = pg_temp.ev_id_q('qe'))$$, 'hidden/true', 'S1.4 an admin-hidden event stays hidden through a recompute');
select is(pg_temp.x('admin', $$select public.admin_add_suppression('host', 'sup2.example.test', 'request')$$), 'OK', 'S1.4 admin_add_suppression succeeds');
select pg_temp.eq($$(select e.status::text || '/' || e.reject_reason from public.events e where e.id = pg_temp.ev_id_q('qf'))$$, 'hidden/suppressed', 'S1.4 ... hides matching events with reason suppressed');
select pg_temp.eq($$(select count(*) from public.owner_activity where kind = 'takedown')$$, '1', 'S1.4 ... and logs owner_activity(takedown)');
select is(pg_temp.x('admin', $$select public.admin_log_activity('featured', 45)$$), 'OK', 'S1.4 admin_log_activity succeeds');
select pg_temp.eq($$(select count(*) from public.owner_activity where kind = 'featured' and seconds = 45)$$, '1', 'S1.4 ... and inserts the row');
select pg_temp.t($$pg_temp.v('admin', $e$(select bool_and(s ? 'trust' and s ? 'strict_auto' and s ? 'max_cards_7d' and s ? 'consecutive_failures') from public.admin_source_health() s)$e$) = 'true'$$, 'S1.4 admin_source_health rows carry trust, strict_auto, max_cards_7d and consecutive_failures');
select is(pg_temp.v('user', $$(select count(*) from public.admin_source_health())$$), 'ERR:42501|forbidden|', 'S1.4 admin_source_health is forbidden to a non-admin');

-- AC-M1-35: expire_queue ---------------------------------------------------------------------------------------------------------------
select pg_temp.ing('x1', 'q-rev', jsonb_build_array(pg_temp.item('xa', 'Expiring Pending Fest', 3), pg_temp.item('xb', 'Future Pending Fest', 30)));
select pg_temp.x('postgres', $$update public.events set starts_at = now() - interval '30 hours', ends_at = now() - interval '28 hours'
  where id = pg_temp.ev_id_q('xa')$$);
select is(pg_temp.x('postgres', $$select private.expire_queue()$$), 'OK', 'AC-M1-35 private.expire_queue() runs');
select pg_temp.eq($$(select e.status::text || '/' || e.reject_reason from public.events e where e.id = pg_temp.ev_id_q('xa'))$$, 'rejected/expired', 'AC-M1-35 a pending event that started yesterday -> rejected / expired');
select pg_temp.eq($$(select c.status || '/' || c.decision || '/' || coalesce(c.review_seconds::text, 'none') from public.review_cards c where c.event_id = pg_temp.ev_id_q('xa') and c.kind = 'event')$$, 'closed/expired/none', 'AC-M1-35 ... its card is closed with decision expired and no review_seconds');
select pg_temp.eq($$(select e.status::text from public.events e where e.id = pg_temp.ev_id_q('xb'))$$, 'pending', 'AC-M1-35 a pending event in the future is untouched');

-- AC-M1-36: queue_budget ------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('qb-1', 'organizer', 'review');
select pg_temp.mk_source('qb-2', 'organizer', 'review');
select pg_temp.ing('b1', 'qb-1', pg_temp.bulk(12, 'ba'));
select pg_temp.ing('b2', 'qb-2', pg_temp.bulk(10, 'bb'));
select pg_temp.x('postgres', $$update public.review_cards set created_at = now() - interval '10 days' where id in (
   select c.id from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.source_id = (select id from public.sources where slug = 'qb-1') and c.kind = 'event' order by c.id limit 6)$$);
select pg_temp.x('postgres', $$update public.review_cards set created_at = now() - interval '10 days' where id in (
   select c.id from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.source_id = (select id from public.sources where slug = 'qb-2') and c.kind = 'event' order by c.id limit 4)$$);
select pg_temp.eq($$(select count(*) from public.review_cards where source_id = (select id from public.sources where slug = 'qb-1') and kind = 'event')$$, '12', 'fixture: 12 cards carry the source id (6 in each 7-day window after backdating)');
select is(pg_temp.x('postgres', $$select private.queue_budget()$$), 'OK', 'AC-M1-36 private.queue_budget() runs');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'qb-1')$$, 'link_only', 'AC-M1-36 6 cards in each of the two windows -> trust link_only');
select pg_temp.eq($$(select count(*) from public.review_cards where source_id = (select id from public.sources where slug = 'qb-1') and kind = 'event' and status = 'open')$$, '0', 'AC-M1-36 ... its open event cards are closed');
select pg_temp.eq($$(select count(*) from public.review_cards where source_id = (select id from public.sources where slug = 'qb-1') and kind = 'event' and decision = 'source_budget')$$, '12', 'AC-M1-36 ... all 12 formerly open cards (6 per window) closed with decision source_budget');
select pg_temp.eq($$(select count(*) from public.review_cards where source_id = (select id from public.sources where slug = 'qb-1') and kind = 'source_budget' and status = 'open')$$, '1', 'AC-M1-36 ... and exactly one open source_budget card');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'qb-2')$$, 'review', 'AC-M1-36 6 cards then 4 -> unchanged');
select pg_temp.x('postgres', $$select private.queue_budget()$$);
select pg_temp.eq($$(select count(*) from public.review_cards where source_id = (select id from public.sources where slug = 'qb-1') and kind = 'source_budget')$$, '1', 'AC-M1-36 a source already link_only is skipped (still one source_budget card)');

-- AC-M1-37: held runs ---------------------------------------------------------------------------------------------------------------------------
create function pg_temp.anomaly_items(p_slug text, p_set text, p_first jsonb default null) returns jsonb language sql as $$
  select coalesce(p_first, '[]'::jsonb) || (select jsonb_agg(pg_temp.item(p_set || n, 'Held ' || p_set || ' ' || substr(md5(p_set || n), 1, 10), 3 + n % 60, 9 + n % 10)) from generate_series(1, 25) n) $$;
create function pg_temp.setup_held(p_slug text) returns void language plpgsql as $$
begin
  perform pg_temp.mk_source(p_slug, 'organizer', 'auto');
  perform pg_temp.ing('base-' || p_slug, p_slug, jsonb_build_array(pg_temp.item(p_slug || '-a', 'Held Base Alpha ' || p_slug, 5), pg_temp.item(p_slug || '-b', 'Held Base Bravo ' || p_slug, 6)));
  perform pg_temp.seed_runs(p_slug, 6, 2, 2);
end $$;
create function pg_temp.held_card(p_label text) returns uuid language plpgsql as $$
declare r uuid;
begin
  execute 'select c.id from public.review_cards c where c.kind = ''held_run'' and c.held_run_id = (select (res ->> ''run_id'')::uuid from tres where label = $1)' into r using p_label;
  return r;
exception when others then return null; end $$;
select pg_temp.setup_held('hr-a');
select pg_temp.rb('ha', 'hr-a', pg_temp.anomaly_items('hr-a', 'ha', jsonb_build_array(pg_temp.item('hr-a-a', 'Held Base Alpha Changed', 5))));
select is(pg_temp.r('ha', 'status'), 'anomaly', 'fixture: hr-a produces an anomaly run');
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'accept', null, 40)$$, pg_temp.held_card('ha'))), 'OK', 'AC-M1-37 accepting the newest held run succeeds');
select pg_temp.eq($$(select title from public.source_events where external_key = 'hr-a-a')$$, 'Held Base Alpha Changed', 'AC-M1-37 ... the held items are replayed (an event row changes)');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.external_key = 'hr-a-a')$$, '2', 'AC-M1-37 ... and a version row is appended');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'hr-a'))$$, '27', 'AC-M1-37 ... the 25 new occurrences are stored (26 items + the untouched base item)');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'ha'))$$, 'accepted', 'AC-M1-37 ... the held run is marked accepted');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'hr-a') and needs_cluster)$$, '0', 'AC-M1-37 ... and clustering ran inline');
select pg_temp.setup_held('hr-b');
select pg_temp.rb('hb1', 'hr-b', pg_temp.anomaly_items('hr-b', 'hb1'));
select pg_temp.rb('hb2', 'hr-b', pg_temp.anomaly_items('hr-b', 'hb2'));
select is(pg_temp.r('hb1', 'status') || '/' || pg_temp.r('hb2', 'status'), 'anomaly/anomaly', 'fixture: two successive anomaly runs on hr-b');
select pg_temp.t($$pg_temp.x('admin', format($e$select public.admin_decide_card(%L, 'accept', null, 5)$e$, pg_temp.held_card('hb1'))) like 'ERR:%|stale|%'$$, 'AC-M1-37 accepting an older held run when a newer run exists -> stale');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'hb1'))$$, 'pending', 'AC-M1-37 ... the older held run stays pending');
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'accept', null, 5)$$, pg_temp.held_card('hb2'))), 'OK', 'AC-M1-37 accepting the newest one works');
select pg_temp.setup_held('hr-c');
select pg_temp.rb('hc', 'hr-c', pg_temp.anomaly_items('hr-c', 'hc'));
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'discard', null, 5)$$, pg_temp.held_card('hc'))), 'OK', 'AC-M1-37 discard succeeds');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'hc'))$$, 'discarded', 'AC-M1-37 ... the held run is discarded');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'hr-c'))$$, '2', 'AC-M1-37 ... and nothing was applied');
select pg_temp.setup_held('hr-d');
select pg_temp.rb('hd', 'hr-d', pg_temp.anomaly_items('hr-d', 'hd'));
select pg_temp.setup_held('hr-e');
select pg_temp.rb('he', 'hr-e', pg_temp.anomaly_items('hr-e', 'he'));
select pg_temp.x('postgres', $$update public.held_runs set created_at = now() - interval '8 days' where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'hd')$$);
select pg_temp.x('postgres', $$update public.held_runs set created_at = now() - interval '6 days' where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'he')$$);
select is(pg_temp.x('postgres', $$select private.expire_held_runs()$$), 'OK', 'AC-M1-37 private.expire_held_runs() runs');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'hd'))$$, 'expired', 'AC-M1-37 a held run older than 7 days -> expired');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'hr-d')$$, 'review', 'AC-M1-37 ... and its source goes to trust review');
select pg_temp.eq($$(select c.status || '/' || c.decision from public.review_cards c where c.id = pg_temp.held_card('hd'))$$, 'closed/expired', 'AC-M1-37 ... and its card is closed expired');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'he'))$$, 'pending', 'AC-M1-37 a 6-day-old held run stays pending');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'hr-e')$$, 'auto', 'AC-M1-37 ... and its source keeps trust auto');

-- AC-M1-54: retention with FKs ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('rt', 'organizer', 'review');
select pg_temp.ing('rt0', 'rt', jsonb_build_array(pg_temp.item('rt-a', 'Retention Old Version Fest', 8), pg_temp.item('rt-gone', 'Retention Gone Fest', 9)));
create temp table rt_ids as select gen_random_uuid() anom100, gen_random_uuid() ok100, gen_random_uuid() old401;
select pg_temp.x('postgres', $$insert into public.source_runs (id, source_id, started_at, finished_at, status, anomaly_reasons) select anom100, (select id from public.sources where slug = 'rt'), now() - interval '100 days', now() - interval '100 days', 'anomaly', array['new_surge'] from rt_ids$$);
select pg_temp.x('postgres', $$insert into public.source_runs (id, source_id, started_at, finished_at, status) select ok100, (select id from public.sources where slug = 'rt'), now() - interval '100 days', now() - interval '100 days', 'ok' from rt_ids$$);
select pg_temp.x('postgres', $$insert into public.source_runs (id, source_id, started_at, finished_at, status, anomaly_reasons) select old401, (select id from public.sources where slug = 'rt'), now() - interval '401 days', now() - interval '401 days', 'anomaly', array['new_surge'] from rt_ids$$);
select pg_temp.x('postgres', $$insert into public.held_runs (run_id, source_id, items, summary, status, created_at) select anom100, (select id from public.sources where slug = 'rt'), '[]', '{}', 'pending', now() - interval '100 days' from rt_ids$$);
select pg_temp.x('postgres', $$insert into public.held_runs (run_id, source_id, items, summary, status, created_at) select old401, (select id from public.sources where slug = 'rt'), '[]', '{}', 'expired', now() - interval '401 days' from rt_ids$$);
select pg_temp.x('postgres', $$insert into public.review_cards (kind, status, held_run_id, source_id, created_at) select 'held_run', 'open', anom100, (select id from public.sources where slug = 'rt'), now() - interval '100 days' from rt_ids$$);
select pg_temp.x('postgres', $$insert into public.review_cards (kind, status, held_run_id, source_id, created_at, decided_at, decision) select 'held_run', 'closed', old401, (select id from public.sources where slug = 'rt'), now() - interval '401 days', now() - interval '400 days', 'expired' from rt_ids$$);
select pg_temp.x('postgres', $$insert into private.ingest_nonces (nonce, seen_at) values ('11111111111111111111111111111111', now() - interval '2 days')$$);
select pg_temp.x('postgres', $$insert into private.ingest_grants (token_hash, source_id, run_id, issued_at, expires_at, used_at)
  values (extensions.digest('old-grant', 'sha256'), (select id from public.sources where slug = 'rt'), gen_random_uuid(), now() - interval '31 days', now() - interval '31 days' + interval '30 minutes', now() - interval '31 days')$$);
-- append-only guards
select pg_temp.t($$pg_temp.x('postgres', $e$update public.source_event_versions set accepted_at = now() - interval '401 days'$e$) like 'ERR:%|forbidden|%'$$, 'S1.1 UPDATE on source_event_versions is forbidden outside retention');
select pg_temp.t($$pg_temp.x('postgres', $e$delete from public.event_changes$e$) like 'ERR:%|forbidden|%'$$, 'S1.1 DELETE on event_changes is forbidden outside retention');
select is(pg_temp.x('postgres', $$select set_config('tv.retention', 'on', true)$$), 'OK', 'fixture: tv.retention on');
select pg_temp.x('postgres', $$update public.source_event_versions set accepted_at = now() - interval '401 days' where source_event_id = (select id from public.source_events where external_key = 'rt-a')$$);
select pg_temp.x('postgres', $$update public.event_changes set at = now() - interval '401 days' where event_id in (select id from public.events where title = 'Retention Old Version Fest')$$);
select pg_temp.x('postgres', $$update public.source_events set source_status = 'gone', starts_at = now() - interval '31 days', ends_at = now() - interval '31 days' + interval '2 hours' where external_key = 'rt-gone'$$);
select pg_temp.x('postgres', $$select set_config('tv.retention', 'off', true)$$);
select is(pg_temp.x('postgres', $$select private.retention_sweep()$$), 'OK', 'AC-M1-54 retention_sweep() succeeds with no FK error');
select pg_temp.eq($$(select count(*) from public.source_runs r where r.id = (select anom100 from rt_ids)) || '/' || (select count(*) from public.held_runs where run_id = (select anom100 from rt_ids)) || '/' || (select count(*) from public.review_cards where held_run_id = (select anom100 from rt_ids))$$, '1/1/1', 'AC-M1-54 the 100-day anomaly run, its held run and its card remain');
select pg_temp.eq($$(select count(*) from public.source_runs where id = (select ok100 from rt_ids))$$, '0', 'AC-M1-54 the 100-day ok run is gone');
select pg_temp.eq($$(select count(*) from public.source_runs where id = (select old401 from rt_ids)) || '/' || (select count(*) from public.held_runs where run_id = (select old401 from rt_ids)) || '/' || (select count(*) from public.review_cards where held_run_id = (select old401 from rt_ids))$$, '0/0/0', 'AC-M1-54 the 401-day held run, its card and its source run are gone');
select pg_temp.eq($$(select count(*) from private.ingest_nonces where nonce = '11111111111111111111111111111111')$$, '0', 'AC-M1-54 nonces 2 days old are deleted');
select pg_temp.eq($$(select count(*) from pg_indexes where schemaname = 'private' and indexname = 'ingest_nonces_seen_at_idx' and indexdef like '%(seen_at)%')$$, '1', 'AC-M1-54 ingest_nonces_seen_at_idx exists on (seen_at)');
select pg_temp.eq($$(select count(*) from private.ingest_grants where used_at < now() - interval '30 days')$$, '0', 'S1.5 ingest_grants older than 30 days are deleted');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.external_key = 'rt-a' and v.accepted_at < now() - interval '400 days')$$, '0', 'S1.5 source_event_versions older than 400 days are deleted');
select pg_temp.eq($$(select count(*) from public.event_changes where at < now() - interval '400 days')$$, '0', 'S1.5 event_changes older than 400 days are deleted');
select pg_temp.eq($$(select count(*) from public.source_events where external_key = 'rt-gone')$$, '0', 'S1.5 gone source_events that started more than 30 days ago are deleted');
select pg_temp.eq($$(select count(*) from public.source_events where external_key = 'rt-a')$$, '1', 'S1.5 live source_events are kept');

-- AC-M1-65 (A5-3) pgTAP half: accept refusals ------------------------------------------------------------------------------------------
select pg_temp.setup_held('hr-f');
select pg_temp.rb('hf1', 'hr-f', pg_temp.anomaly_items('hr-f', 'hf1'));
-- (d) a run of the same source whose finished_at equals the held run's (direct insert pins the timestamp) counts as newer
select pg_temp.x('postgres', $$insert into public.source_runs (id, source_id, started_at, finished_at, status)
  select gen_random_uuid(), r.source_id, r.started_at, r.finished_at, 'ok' from public.source_runs r where r.id = (select (res ->> 'run_id')::uuid from tres where label = 'hf1')$$);
select pg_temp.t($$pg_temp.err(pg_temp.x('admin', format($e$select public.admin_decide_card(%L, 'accept', null, 5)$e$, pg_temp.held_card('hf1'))), 'P0001', 'stale', 'newer\_run')$$,
  'AC-M1-65(d) a same-finished_at run of the source makes the accept stale, with detail newer_run');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'hf1'))$$, 'pending', 'AC-M1-65(d) ... and the held run stays pending');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'hr-f'))$$, '2', 'AC-M1-65(d) ... with nothing applied');
-- the older-held-run stale case carries the named detail too
select pg_temp.t($$pg_temp.err(pg_temp.x('admin', format($e$select public.admin_decide_card(%L, 'accept', null, 5)$e$, pg_temp.held_card('hb1'))), 'P0001', 'stale', 'newer\_run')$$,
  'AC-M1-37/65 accepting an older held run -> stale with detail newer_run');
-- source no longer permitted: nothing applied, held run stays pending
select pg_temp.setup_held('hr-g');
select pg_temp.rb('hg1', 'hr-g', pg_temp.anomaly_items('hr-g', 'hg1'));
select pg_temp.x('postgres', $$update public.sources set enabled = false where slug = 'hr-g'$$);
select pg_temp.t($$pg_temp.err(pg_temp.x('admin', format($e$select public.admin_decide_card(%L, 'accept', null, 5)$e$, pg_temp.held_card('hg1'))), '23514', 'source_not_permitted')$$,
  'AC-M1-65 accepting a held run of a disabled source -> source_not_permitted');
select pg_temp.eq($$(select status from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'hg1'))$$, 'pending', 'AC-M1-65 ... the held run stays pending');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'hr-g'))$$, '2', 'AC-M1-65 ... and nothing was applied');
select pg_temp.setup_held('hr-h');
select pg_temp.rb('hh1', 'hr-h', pg_temp.anomaly_items('hr-h', 'hh1'));
select pg_temp.x('postgres', $$update public.sources set enabled = false, opt_out = true where slug = 'hr-h'$$);
select pg_temp.t($$pg_temp.err(pg_temp.x('admin', format($e$select public.admin_decide_card(%L, 'accept', null, 5)$e$, pg_temp.held_card('hh1'))), '23514', 'source_not_permitted')$$,
  'AC-M1-65 accepting a held run after the source opted out -> source_not_permitted');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'hr-h'))$$, '2', 'AC-M1-65 ... nothing applied');

-- AC-M1-66 (A5-4): admin_update_event validation and journaling ---------------------------------------------------------------------------
select pg_temp.ing('q66', 'q-rev', jsonb_build_array(pg_temp.item('q66a', 'Patch Validation Fest', 27)));
create temp table e66 as select pg_temp.ev_id_q('q66a') id, (select starts_at from public.events where id = pg_temp.ev_id_q('q66a')) starts_at;
create function pg_temp.ev66() returns text language sql as $$
  select pg_temp.snap(format('(select * from public.events where id = %L)', (select id from e66)))
      || pg_temp.snap(format('(select * from public.event_changes where event_id = %L)', (select id from e66)))
      || pg_temp.snap(format('(select * from public.event_categories where event_id = %L)', (select id from e66))) $$;
-- the patch is refused with invalid_input / <detail> and the event, its journal and its categories are unchanged
create function pg_temp.bad66(p_patch text, p_detail text) returns boolean language plpgsql as $$
declare b text := pg_temp.ev66(); x text;
begin
  x := pg_temp.x('admin', format('select public.admin_update_event(%L, %L::jsonb)', (select id from e66), p_patch));
  return pg_temp.err(x, '22023', 'invalid\_input', p_detail) and pg_temp.ev66() = b;
end $$;
select pg_temp.t($$pg_temp.bad66('{"price_min":50,"price_max":10}', 'price')$$, 'AC-M1-66 price_min 50 > price_max 10 -> invalid_input/price, event unchanged');
select pg_temp.t($$pg_temp.bad66('{"price_min":-1}', 'patch')$$, 'AC-M1-66 price_min -1 -> invalid_input/patch');
select pg_temp.t($$pg_temp.bad66('{"price_max":100000}', 'patch')$$, 'AC-M1-66 price_max 100000 -> invalid_input/patch');
select pg_temp.t($$pg_temp.bad66('{"title":null}', 'patch')$$, 'AC-M1-66 title null -> invalid_input/patch');
select pg_temp.t($$pg_temp.bad66(jsonb_build_object('ends_at', (select starts_at + interval '121 days' from e66))::text, 'ends_at')$$, 'AC-M1-66 ends_at = starts_at + 121 days -> invalid_input/ends_at');
select pg_temp.t($$pg_temp.bad66(jsonb_build_object('ends_at', (select starts_at from e66))::text, 'ends_at')$$, 'AC-M1-66 ends_at = starts_at -> invalid_input/ends_at');
select pg_temp.t($$pg_temp.bad66('{"age":"adult"}', 'patch')$$, 'AC-M1-66 age adult (not an enum value) -> invalid_input/patch');
select pg_temp.t($$pg_temp.bad66('{"organizer_url":"http://x.test/"}', 'patch')$$, 'AC-M1-66 organizer_url over http -> invalid_input/patch');
select pg_temp.t($$pg_temp.bad66('{"starts_at":"not a date"}', 'patch')$$, 'AC-M1-66 starts_at "not a date" -> invalid_input/patch');
-- categories are journaled
select pg_temp.eq($$(select array_to_string(array_agg(category order by category), ',') from public.event_categories where event_id = (select id from e66))$$, 'music', 'fixture: the event has categories {music}');
select is(pg_temp.x('admin', format($$select public.admin_update_event(%L, '{"categories":["music","outdoors"]}'::jsonb)$$, (select id from e66))), 'OK', 'AC-M1-66 a categories patch succeeds');
select pg_temp.eq($$(select count(*) from public.event_changes where event_id = (select id from e66) and field = 'categories')$$, '1', 'AC-M1-66 ... and writes exactly one event_changes row with field categories');
select pg_temp.eq($$(select old_value::text || '|' || new_value::text || '|' || decided_by from public.event_changes where event_id = (select id from e66) and field = 'categories')$$,
  '["music"]|["music", "outdoors"]|admin:e1500000-0000-4000-a000-000000000001', 'AC-M1-66 ... old_value ["music"], new_value ["music","outdoors"], decided_by admin:<uid>');
select is(pg_temp.x('admin', format($$select public.admin_update_event(%L, '{"categories":["music","outdoors"]}'::jsonb)$$, (select id from e66))), 'OK', 'AC-M1-66 the same categories patch again succeeds');
select pg_temp.eq($$(select count(*) from public.event_changes where event_id = (select id from e66) and field = 'categories')$$, '1', 'AC-M1-66 ... without a new journal row');
select pg_temp.t($$pg_temp.err(pg_temp.x('postgres', format($e$update public.events set price_min = -5 where id = %L$e$, (select id from e66))), '23514', '%')$$, 'AC-M1-66 a direct update of price_min to -5 -> check_violation');

select * from finish();
rollback;
