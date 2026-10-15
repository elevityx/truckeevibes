-- AC-M1-24 ... 26, 28 ... 32, 52, 53, 58, 59, 60: clustering, merge priority, publish rules, summaries, strict rule, card cap,
-- region rejection, trust re-queue, and the M1 stubs for M3.
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

create function pg_temp.ev_status(k text) returns text language plpgsql as $$
declare r text;
begin
  execute 'select e.status::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = $1 limit 1' into r using k;
  return coalesce(r, '<none>');
exception when others then return 'ERR:' || sqlstate; end $$;
create function pg_temp.ev_fails(k text) returns text[] language plpgsql as $$
declare r text[];
begin
  execute 'select private.strict_auto_fails(e) from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = $1 limit 1' into r using k;
  return r;
exception when others then return null; end $$;
create function pg_temp.ev_col(k text, p_col text) returns text language plpgsql as $$
declare r text;
begin
  execute format('select e.%I::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = $1 limit 1', p_col) into r using k;
  return coalesce(r, '<null>');
exception when others then return 'ERR:' || sqlstate; end $$;
create function pg_temp.ev_id(k text) returns uuid language plpgsql as $$
declare r uuid;
begin
  execute 'select se.cluster_id from public.source_events se where se.external_key = $1 limit 1' into r using k;
  return r;
exception when others then return null; end $$;
create function pg_temp.open_cards(k text) returns bigint language plpgsql as $$
declare r bigint;
begin
  execute 'select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = $1 and c.kind = ''event'' and c.status = ''open''' into r using k;
  return r;
exception when others then return -1; end $$;
-- a strict-rule fixture item at "Truckee Community Arts Center"
create function pg_temp.sitem(p_key text, p_title text, p_day int, p_over jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_day, 18, jsonb_build_object('venueName', 'Truckee Community Arts Center', 'age', 'unknown',
           'categoriesHint', jsonb_build_array('music'), 'priceKind', 'unknown')) || p_over $$;

select pg_temp.mk_source('c-org', 'organizer', 'auto');
select pg_temp.mk_source('c-dmo', 'dmo', 'review');

-- AC-M1-24 ---------------------------------------------------------------------------------------------------------
select pg_temp.rb('cl1', 'c-org', jsonb_build_array(
  pg_temp.item('o1', 'Truckee Oktoberfest 2026', 40, 18, '{"venueName":"Cluster Hall"}'),
  pg_temp.item('o2', 'Mountain Harvest Brewfest', 41, 18, '{"venueName":"Cluster Hall"}'),
  pg_temp.item('o3', 'Classic Car Show', 42, 18, '{"venueName":"Cluster Hall"}')));
select pg_temp.rb('cl2', 'c-dmo', jsonb_build_array(
  jsonb_set(pg_temp.item('d1', 'Oktoberfest Truckee 2026', 40, 18, '{"venueName":"Cluster Hall"}'), '{startsAt}', to_jsonb(pg_temp.ts(40, 18, 20))),
  jsonb_set(pg_temp.item('d2', 'Mountain Harvest Brewfest', 41, 18, '{"venueName":"Cluster Hall"}'), '{startsAt}', to_jsonb(pg_temp.ts(41, 18, 45))),
  pg_temp.item('d3', 'Classic Car Swap Meet', 42, 18, '{"venueName":"Cluster Hall"}')));
select pg_temp.cluster_all();
select pg_temp.t($$extensions.similarity('classic car show', 'classic car swap meet') between 0.45 and 0.6$$, 'fixture: the possible-duplicate titles have trigram similarity in [0.45, 0.6]');
select pg_temp.eq($$(select count(distinct cluster_id) || '/' || count(*) from public.source_events where external_key in ('o1', 'd1'))$$, '1/2',
  'AC-M1-24 same venue, starts 20 min apart, "Truckee Oktoberfest 2026" / "Oktoberfest Truckee 2026" -> one event with 2 contributors');
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('o2', 'd2'))$$, '2', 'AC-M1-24 starts 45 min apart -> two events');
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('o3', 'd3'))$$, '2', 'AC-M1-24 titles at similarity 0.5, same venue and time -> two events');
select pg_temp.eq($$(select count(*) from public.review_cards where kind = 'possible_duplicate' and status = 'open'
                        and event_id in (select cluster_id from public.source_events where external_key in ('o3', 'd3'))
                        and other_event_id in (select cluster_id from public.source_events where external_key in ('o3', 'd3')))$$, '1',
  'AC-M1-24 ... and exactly one open possible_duplicate card pairing them');

-- AC-M1-25 ---------------------------------------------------------------------------------------------------------
select pg_temp.ing('pr1', 'c-org', jsonb_build_array(pg_temp.item('pa', 'Pine Nut Harvest Market', 43)));
select pg_temp.ing('pr2', 'c-dmo', jsonb_build_array(pg_temp.item('pb', 'Pine Nut Harvest Market Weekend', 43)));
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('pa', 'pb'))$$, '1', 'fixture: organizer and DMO rows of the same market share one event');
select is(pg_temp.ev_col('pa', 'title'), 'Pine Nut Harvest Market', 'AC-M1-25 organizer (priority 100) title beats the DMO (50) title');
select pg_temp.t($$pg_temp.ev_col('pa', 'field_sources')::jsonb ->> 'title' = 'sev:' || (select max(v.id) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.external_key = 'pa')$$,
  'AC-M1-25 field_sources.title = sev:<id> of the organizer''s latest version');
select pg_temp.x('admin', format($$select public.admin_update_event(%L, '{"title":"Pine Nut Market Admin Title"}'::jsonb)$$, pg_temp.ev_id('pa')));
select pg_temp.t($$pg_temp.ev_col('pa', 'locked_fields') like '%title%' and pg_temp.ev_col('pa', 'title') = 'Pine Nut Market Admin Title' and pg_temp.ev_col('pa', 'field_sources')::jsonb ->> 'title' = 'admin'$$,
  'AC-M1-25 an admin title edit locks the field (locked_fields has title, field_sources.title = admin)');
select pg_temp.ing('pr3', 'c-org', jsonb_build_array(pg_temp.item('pa', 'Pine Nut Harvest Market Renamed', 43)));
select is(pg_temp.r('pr3', 'changed'), '1', 'fixture: the organizer title change is applied to its source row');
select is(pg_temp.ev_col('pa', 'title'), 'Pine Nut Market Admin Title', 'AC-M1-25 later source changes leave the locked title');

-- AC-M1-26 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('p-auto', 'organizer', 'auto');
select pg_temp.mk_source('p-agg', 'aggregator', 'review');
select pg_temp.mk_source('p-link', 'organizer', 'review');
select pg_temp.rb('lk', 'p-link', jsonb_build_array(pg_temp.item('lk1', 'Link Only Listing', 44)));
select pg_temp.x('postgres', $$update public.sources set trust = 'link_only' where slug = 'p-link'$$);
select pg_temp.rb('pu1', 'p-auto', jsonb_build_array(
  pg_temp.item('pu-pub', 'Publish Me Concert', 44),
  pg_temp.item('pu-time', 'Unknown Time Gathering', 45, 0, '{"timeKnown":false}'),
  pg_temp.item('pu-nogeo', 'No Coordinates Social', 47, 18, '{"venueName":"Nowhere Hall","lat":null,"lng":null}')));
select pg_temp.rb('pu2', 'p-agg', jsonb_build_array(pg_temp.item('pu-agg', 'Aggregator Only Fair', 46)));
select pg_temp.cluster_all();
select is(pg_temp.ev_status('pu-pub'), 'published', 'AC-M1-26 auto source, time known, venue in the drive box, organizer URL -> published');
select is(pg_temp.ev_status('pu-time'), 'pending', 'AC-M1-26 time_known = false -> pending');
select is(pg_temp.open_cards('pu-time')::text, '1', 'AC-M1-26 ... with exactly one open event card');
select pg_temp.x('postgres', $$update public.source_events set needs_cluster = true where external_key = 'pu-time'$$);
select pg_temp.cluster_all();
select is(pg_temp.open_cards('pu-time')::text, '1', 'AC-M1-26 re-running cluster creates no second card');
select is(pg_temp.ev_status('pu-agg'), 'pending', 'AC-M1-26 aggregator-only (strict_auto = false) -> pending');
select is(pg_temp.ev_status('pu-nogeo'), 'pending', 'AC-M1-26 venue without coordinates -> pending');
select is(pg_temp.ev_status('lk1'), '<none>', 'AC-M1-26 a link_only source''s row creates no event');
select pg_temp.eq($$(select needs_cluster::text || '/' || coalesce(cluster_id::text, 'none') from public.source_events where external_key = 'lk1')$$, 'false/none',
  'AC-M1-26 ... the row is left unclustered and out of the outbox');
select pg_temp.eq($$(select count(*) from public.event_changes ec where ec.event_id = pg_temp.ev_id('pu-pub') and ec.field = 'status' and ec.decided_by = 'rule:publish')$$, '1',
  'AC-M1-26 the auto-publish is journaled as an event_changes status row decided_by rule:publish');

-- AC-M1-28: confidence ----------------------------------------------------------------------------------------------
select pg_temp.mk_source('k-auto', 'organizer', 'auto');
select pg_temp.mk_source('k-rev1', 'dmo', 'review');
select pg_temp.mk_source('k-rev2', 'venue', 'review');
select pg_temp.mk_source('k-rev3', 'municipal', 'review');
select pg_temp.rb('kc1', 'k-auto', jsonb_build_array(
  pg_temp.item('kc-base', 'Confidence Base Show', 50),
  pg_temp.item('kc-caps', 'ALL CAPS HARVEST FEST', 51),
  pg_temp.item('kc-early', 'Dawn Patrol Hike', 52, 3),
  pg_temp.item('kc-mega', 'Four Source Mega Fest', 53)));
select pg_temp.rb('kc2', 'k-rev1', jsonb_build_array(
  pg_temp.item('kr-base', 'Confidence Base Show', 50),
  pg_temp.item('kr-mega', 'Four Source Mega Fest', 53),
  (pg_temp.item('kr-low', 'NOWHERE ALL CAPS', 54, 18, '{"timeKnown":false,"lat":null,"lng":null,"venueName":"Nowhere Else Hall"}') - 'url')));
select pg_temp.rb('kc3', 'k-rev2', jsonb_build_array(pg_temp.item('kv-mega', 'Four Source Mega Fest', 53)));
select pg_temp.rb('kc4', 'k-rev3', jsonb_build_array(pg_temp.item('km-mega', 'Four Source Mega Fest', 53)));
select pg_temp.cluster_all();
select is(pg_temp.ev_col('kc-base', 'confidence'), '90', 'AC-M1-28 auto + time known + geocoded + organizer URL (80) plus a second source (+10) -> 90');
select is(pg_temp.ev_col('kc-caps', 'confidence'), '60', 'AC-M1-28 all-caps title: 80 - 20 = 60');
select is(pg_temp.ev_col('kc-early', 'confidence'), '60', 'AC-M1-28 03:00 local start without a late-night cue: 80 - 20 = 60');
select is(pg_temp.ev_col('kc-mega', 'confidence'), '100', 'AC-M1-28 three additional sources add at most +20: 80 + 20 = 100');
select is(pg_temp.ev_col('kr-low', 'confidence'), '0', 'AC-M1-28 a review-only, untimed, ungeocoded, linkless all-caps row clamps at 0');
select pg_temp.rb('kc5', 'k-auto', jsonb_build_array(pg_temp.item('kc-solo', 'Confidence Solo Show', 55)));
select pg_temp.cluster_all();
select is(pg_temp.ev_col('kc-solo', 'confidence'), '80', 'AC-M1-28 auto + time known + geocoded + organizer URL, one source -> 80');
select pg_temp.t($$(select count(*) = 0 from public.events where confidence not between 0 and 100)$$, 'AC-M1-28 every confidence is within 0-100');

-- AC-M1-29: template summary -----------------------------------------------------------------------------------------
select pg_temp.mk_source('t-bare', 'organizer', 'review');
select pg_temp.rb('ts1', 'k-auto', jsonb_build_array(
  pg_temp.item('ts-alibi', 'Alibi Free Music Night', 56, 18, '{"venueName":"Alibi Ale Works","town":"Truckee","priceKind":"free","age":"21_plus","categoriesHint":["music"]}'),
  pg_temp.item('ts-ticket', 'Ticketed Gala Night', 57, 18, '{"venueName":"Arts Hall","priceKind":"paid","age":"all_ages","categoriesHint":["arts"],"ticketUrl":"https://example.test/t/1"}')));
select pg_temp.rb('ts2', 't-bare', jsonb_build_array(
  (pg_temp.item('ts-bare', 'Bare Minimum Event', 58, 18, '{"venueName":null,"address":null,"town":null,"lat":null,"lng":null,"priceKind":"unknown","categoriesHint":[]}') - 'url')));
select pg_temp.cluster_all();
select is(pg_temp.ev_col('ts-alibi', 'summary'), 'Free live music at Alibi Ale Works in Truckee. 21+. Details on the organizer''s site.', 'AC-M1-29 free, music, Alibi Ale Works, Truckee, 21+, no ticket URL');
select is(pg_temp.ev_col('ts-bare', 'summary'), 'Event. Details on the organizer''s site.', 'AC-M1-29 with nothing known');
select is(pg_temp.ev_col('ts-ticket', 'summary'), 'Ticketed arts event at Arts Hall in Truckee. All ages. Details and tickets on the organizer''s site.', 'AC-M1-29 paid + ticket URL + all ages');
select pg_temp.t($$(select count(*) > 0 and bool_and(char_length(summary) between 10 and 600 and summary !~ '[<>]' and summary !~ '[[:cntrl:]]') from public.events)$$,
  'AC-M1-29 every summary is 10-600 chars, no angle brackets, no control chars or newlines (the Lights clean_event description rules)');
select pg_temp.t($$(select bool_and(summary !~ '  ' and summary ~ '^[A-Z0-9]') from public.events)$$, 'AC-M1-29 summaries are capitalized with collapsed spaces');
select is(pg_temp.ev_col('ts-alibi', 'slug'), 'alibi-free-music-night-' || substr(replace(pg_temp.ev_id('ts-alibi')::text, '-', ''), 1, 6), 'S1.1 slug = left(title slug, 50) || - || first 6 id hex chars');
select is(pg_temp.ev_col('ts-alibi', 'start_day'), (select ((pg_temp.ts(56, 18)::timestamptz) at time zone 'America/Los_Angeles')::date::text), 'S1.1 start_day is the region-local date of starts_at');

-- AC-M1-30: outbox ----------------------------------------------------------------------------------------------------
select pg_temp.mk_source('o-1', 'organizer', 'review');
select pg_temp.cluster_all();
select pg_temp.rb('ob', 'o-1', jsonb_build_array(pg_temp.item('ob1', 'Outbox Gala One', 59), pg_temp.item('ob2', 'Outbox Gala Two', 60), pg_temp.item('ob3', 'Outbox Gala Three', 61)));
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster)$$, '3', 'AC-M1-30 a batch with no cluster call leaves 3 rows in the outbox (simulated crash)');
select pg_temp.eq($$(select (r ->> 'processed') || '/' || (r ->> 'remaining') from (select public.svc_cluster_and_publish(2) r) x)$$, '2/1', 'AC-M1-30 svc_cluster_and_publish(2) processes at most 2 rows');
select pg_temp.eq($$(select (r ->> 'processed') || '/' || (r ->> 'remaining') from (select public.svc_cluster_and_publish(500) r) x)$$, '1/0', 'AC-M1-30 the next call picks up the leftover');
select pg_temp.eq($$(select (r ->> 'processed') || '/' || (r ->> 'remaining') from (select public.svc_cluster_and_publish(500) r) x)$$, '0/0', 'AC-M1-30 a second call -> processed = 0, remaining = 0');
select pg_temp.eq($$(select jsonb_typeof(public.svc_cluster_and_publish(500) -> 'public_changed'))$$, 'boolean', 'S1.2 the cluster result carries a boolean public_changed');

-- AC-M1-31: gone / cancelled -------------------------------------------------------------------------------------------
select pg_temp.mk_source('u-1', 'organizer', 'auto');
select pg_temp.ing('u0', 'u-1', jsonb_build_array(pg_temp.item('uv', 'Vanishing Act Show', 62), pg_temp.item('ua', 'Anchor Show Forever', 63),
  pg_temp.item('uc', 'Cancelled By Source Night', 64, 18, '{"cancelled":true}')));
select is(pg_temp.ev_status('uv'), 'published', 'fixture: the future event starts published');
select is(pg_temp.ev_status('uc'), 'cancelled', 'AC-M1-31 a source-cancelled occurrence (ICS STATUS:CANCELLED) -> event cancelled');
select pg_temp.ing('u1', 'u-1', jsonb_build_array(pg_temp.item('ua', 'Anchor Show Forever', 63), pg_temp.item('uc', 'Cancelled By Source Night', 64, 18, '{"cancelled":true}')));
select pg_temp.ing('u2', 'u-1', jsonb_build_array(pg_temp.item('ua', 'Anchor Show Forever', 63), pg_temp.item('uc', 'Cancelled By Source Night', 64, 18, '{"cancelled":true}')));
select is(pg_temp.ev_status('uv'), 'published', 'AC-M1-31 still published while only missing from 2 runs');
select pg_temp.ing('u3', 'u-1', jsonb_build_array(pg_temp.item('ua', 'Anchor Show Forever', 63), pg_temp.item('uc', 'Cancelled By Source Night', 64, 18, '{"cancelled":true}')));
select is(pg_temp.ev_status('uv'), 'unlisted', 'AC-M1-31 all contributing occurrences gone and the event in the future -> unlisted');
select is(pg_temp.v('anon', $$(select count(*) from public.list_events() where title = 'Vanishing Act Show')$$), '0', 'AC-M1-31 ... absent from list_events');
select is(pg_temp.v('anon', $$(select count(*) from public.list_events() where title = 'Anchor Show Forever')$$), '1', 'AC-M1-31 ... while the still-listed event is present');
select is(pg_temp.v('anon', $$(select count(*) from public.list_events() where title = 'Cancelled By Source Night')$$), '0', 'AC-M1-31 a cancelled event is absent from list_events');

-- AC-M1-32: merge, slugs ----------------------------------------------------------------------------------------------
select pg_temp.rb('mg', 'c-org', jsonb_build_array(pg_temp.item('mg-a', 'Merge Alpha Gala', 65), pg_temp.item('mg-b', 'Merge Beta Soiree', 65)));
select pg_temp.cluster_all();
select pg_temp.x('postgres', $$update public.events set created_at = now() - interval '2 days' where id = pg_temp.ev_id('mg-a')$$);
create temp table mg0 as select pg_temp.ev_id('mg-a') a, pg_temp.ev_id('mg-b') b, pg_temp.ev_col('mg-a', 'slug') sa, pg_temp.ev_col('mg-b', 'slug') sb;
select is(pg_temp.v('user', format($$public.admin_merge_events(%L, %L)$$, (select a from mg0), (select b from mg0))), 'ERR:42501|forbidden|', 'AC-M1-32 admin_merge_events by a non-admin -> forbidden');
select is(pg_temp.v('admin', format($$public.admin_merge_events(%L, %L)$$, (select b from mg0), (select a from mg0))), (select a::text from mg0),
  'AC-M1-32 neither exported -> the survivor is the older event (argument order is irrelevant) and its id is returned');
select pg_temp.eq($$(select merged_into::text || '/' || status::text from public.events where id = (select b from mg0))$$, (select a::text || '/hidden' from mg0), 'AC-M1-32 the loser is merged_into the survivor and hidden');
select pg_temp.eq($$(select cluster_id::text || '/' || needs_cluster from public.source_events where external_key = 'mg-b')$$, (select a::text || '/true' from mg0), 'AC-M1-32 the loser''s source row is re-pointed at the survivor and queued');
select pg_temp.t($$(select count(*) > 0 from public.event_changes where event_id = (select b from mg0) and field = 'status')$$, 'AC-M1-32 the merge writes event_changes rows');
select pg_temp.t($$(select (select slug from public.events where id = (select a from mg0)) = (select sa from mg0) and (select slug from public.events where id = (select b from mg0)) = (select sb from mg0))$$, 'AC-M1-32 both slugs are unchanged');
select ok(pg_temp.errm(pg_temp.x('postgres', $$update public.events set slug = 'changed-slug-abc123' where id = (select a from mg0)$$), 'slug_immutable'), 'AC-M1-32 update events set slug -> slug_immutable');

-- AC-M1-52: trust promotion re-evaluates -------------------------------------------------------------------------------
select pg_temp.mk_source('tp-1', 'organizer', 'review');
select pg_temp.rb('tp1', 'tp-1', pg_temp.bulk(30, 'tp') || jsonb_build_array(pg_temp.item('tpx1', 'Gone Soon Fest', 70), pg_temp.item('tpx2', 'Ended Long Ago Fest', 71)));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 'tp-1') and e.status = 'pending')$$, '32', 'fixture: 32 pending events from the review source');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.source_id = (select id from public.sources where slug = 'tp-1') and c.kind = 'event' and c.status = 'open')$$, '32', 'fixture: each has one open event card');
select pg_temp.x('postgres', $$update public.source_events set source_status = 'gone' where external_key = 'tpx1'$$);
select pg_temp.x('postgres', $$update public.source_events set starts_at = now() - interval '3 days', ends_at = now() - interval '2 days' where external_key = 'tpx2'$$);
select pg_temp.x('postgres', $$update public.source_events set needs_cluster = false where external_key like 'tp%'$$);
select pg_temp.x('admin', $$select public.admin_set_source_trust('tp-1', 'auto')$$);
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'tp-1') and needs_cluster)$$, '30',
  'AC-M1-52 admin_set_source_trust re-queues the 30 live, not-ended occurrences (gone and ended > 1 day ago are not re-queued)');
select pg_temp.eq($$(select (r ->> 'remaining') from (select public.svc_cluster_and_publish(500) r) x)$$, '0', 'AC-M1-52 one svc_cluster_and_publish(500) with no new batch drains them');
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key ~ '^tp[0-9]+$' and e.status = 'published')$$, '30', 'AC-M1-52 all 30 are now published');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key ~ '^tp[0-9]+$' and c.kind = 'event' and c.status = 'closed' and c.decision = 'auto_published')$$, '30', 'AC-M1-52 ... their event cards closed with decision auto_published');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key ~ '^tp[0-9]+$' and c.status = 'open')$$, '0', 'AC-M1-52 ... and none left open');
-- the same by a plain UPDATE, as a migration would; and a non-trust update re-queues nothing
select pg_temp.mk_source('tp-2', 'organizer', 'review');
select pg_temp.ing('tp2', 'tp-2', pg_temp.bulk(5, 'tq'));
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key ~ '^tq[0-9]+$' and e.status = 'pending')$$, '5', 'fixture: 5 pending events from a second review source');
select pg_temp.x('postgres', $$update public.sources set name = 'Renamed Source Two' where slug = 'tp-2'$$);
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'tp-2') and needs_cluster)$$, '0', 'AC-M1-52 an update of sources.name (no trust change) re-queues nothing');
select pg_temp.x('postgres', $$update public.sources set trust = 'auto' where slug = 'tp-2'$$);
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'tp-2') and needs_cluster)$$, '5', 'AC-M1-52 a plain update of trust re-queues the live occurrences');
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key ~ '^tq[0-9]+$' and e.status = 'published')$$, '5', 'AC-M1-52 ... and one cluster call publishes them');

-- AC-M1-53: M1 ships without M3 ---------------------------------------------------------------------------------------
select pg_temp.eq($$private.lights_pairs((select e from public.events e limit 1))::text$$, '[]', 'AC-M1-53 private.lights_pairs(e) returns []');
select pg_temp.eq($$private.event_is_exported(gen_random_uuid())$$, 'false', 'AC-M1-53 private.event_is_exported(id) returns false');
select pg_temp.eq($$to_regclass('private.lights_exports')::text$$, '<null>', 'AC-M1-53 no lights_exports table exists in the M1 tree');
select pg_temp.eq($$(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prosrc ilike '%lights_exports%')$$, '0', 'AC-M1-53 no M1 function body names lights_exports');
select pg_temp.eq($$(select count(*) from public.events where lights_season <> '[]'::jsonb)$$, '0', 'AC-M1-53 recompute_event leaves lights_season empty in M1');

-- AC-M1-58: the strict rule ------------------------------------------------------------------------------------------------
select pg_temp.mk_source('sx', 'aggregator', 'review');
select pg_temp.x('postgres', $$update public.sources set strict_auto = true where slug = 'sx'$$);
select pg_temp.mk_source('sy', 'aggregator', 'review');
select pg_temp.rb('sr1', 'sx', jsonb_build_array(
  pg_temp.sitem('sx-base', 'Truckee Jazz Quartet', 71),
  pg_temp.sitem('sx-allday', 'Truckee Harvest Fair', 72, jsonb_build_object('allDay', true, 'timeKnown', false,
      'startDate', (now() at time zone 'America/Los_Angeles')::date + 72, 'endDate', (now() at time zone 'America/Los_Angeles')::date + 73,
      'startsAt', pg_temp.ts(72, 0), 'endsAt', null)),
  pg_temp.sitem('sx-long', 'Truckee Long Gathering', 73, jsonb_build_object('endsAt', pg_temp.ts(73, 18, 0, 780))),
  pg_temp.sitem('sx-reno', 'Reno Style Jazz Quartet', 74, '{"venueName":"Reno Hall","lat":39.5296,"lng":-119.8138,"town":"Reno"}'),
  pg_temp.sitem('sx-caps', 'TRUCKEE JAZZ QUARTET', 75),
  pg_temp.sitem('sx-pub', 'Truckee Pub Crawl', 76),
  pg_temp.sitem('sx-nolink', 'Truckee Jazz Duo', 77) - 'url',
  pg_temp.sitem('sx-geo', 'Truckee Jazz Trio', 78, '{"venueName":"Ungeocoded Hall","lat":null,"lng":null}'),
  pg_temp.sitem('sx-loft', 'Jazz Quartet', 79, '{"venueName":"The Loft Bar"}'),
  pg_temp.sitem('sx-casino', 'Jazz Quartet', 80, '{"venueName":"Crystal Bay Casino","lat":39.2266,"lng":-120.0030,"town":"Crystal Bay"}'),
  pg_temp.sitem('sx-food', 'Truckee Dinner Series', 81, '{"categoriesHint":["food-drink"]}'),
  pg_temp.sitem('sx-live', 'Live Music', 82),
  pg_temp.sitem('sx-event', 'Event', 83),
  pg_temp.sitem('sx-tbd', 'TBD', 84),
  pg_temp.sitem('sx-untitled', 'Untitled', 85),
  pg_temp.sitem('sx-special', 'Special Event', 86),
  pg_temp.sitem('sx-tba', 'Trivia TBA', 87),
  pg_temp.sitem('sx-family', 'Family Feud Night', 88, '{"venueName":"Crystal Bay Casino","lat":39.2266,"lng":-120.0030,"town":"Crystal Bay","age":"family"}'),
  pg_temp.sitem('sx-loft21', 'Jazz Quartet', 89, '{"venueName":"The Loft Bar","age":"21_plus"}'),
  pg_temp.sitem('sx-loftall', 'Jazz Quartet', 90, '{"venueName":"The Loft Bar","age":"all_ages"}')));
select pg_temp.rb('sr2', 'sy', jsonb_build_array(pg_temp.sitem('sy-base', 'Truckee Jazz Quartet', 91)));
select pg_temp.cluster_all();
select is(pg_temp.r('sr1', 'status'), 'ok', 'fixture: the strict_auto source''s batch is accepted (a first run of 20 items is under the new_surge floor)');
select is(pg_temp.ev_status('sx-base'), 'published', 'AC-M1-58 strict rule: geocoded local venue, time known, 2 h, URL, age unknown, music -> published');
select pg_temp.eq($$(select count(*) from public.event_changes where event_id = pg_temp.ev_id('sx-base') and field = 'status' and decided_by = 'rule:strict_auto')$$, '1', 'AC-M1-58 ... journaled decided_by rule:strict_auto');
select is(pg_temp.open_cards('sx-base')::text, '0', 'AC-M1-58 ... and no open card');
select is(pg_temp.ev_fails('sx-base')::text, '{}', 'AC-M1-58 strict_auto_fails of the base event is empty');
create temp table strict_cases (k text, fail text, label text);
insert into strict_cases values
  ('sx-allday', 'time_unknown', 'all-day'), ('sx-long', 'long', '13 h'), ('sx-reno', 'outside_local', 'Reno coordinates'),
  ('sx-caps', 'flags', 'all-caps title'), ('sx-pub', 'age_ambiguous', 'Pub Crawl title, age unknown'), ('sx-nolink', 'no_link', 'no URL'),
  ('sx-geo', 'geocode_pending', 'venue not yet geocoded'), ('sx-loft', 'age_ambiguous', '"Jazz Quartet" at The Loft Bar'),
  ('sx-casino', 'age_ambiguous', '"Jazz Quartet" at Crystal Bay Casino'), ('sx-food', 'age_ambiguous', 'food-drink category, age unknown'),
  ('sx-live', 'placeholder_title', '"Live Music"'), ('sx-event', 'placeholder_title', '"Event"'), ('sx-tbd', 'placeholder_title', '"TBD"'),
  ('sx-untitled', 'placeholder_title', '"Untitled"'), ('sx-special', 'placeholder_title', '"Special Event"'), ('sx-tba', 'placeholder_title', '"Trivia TBA"'),
  ('sx-family', 'age_ambiguous', '(A4) "Family Feud Night" at Crystal Bay Casino with classifier age family');
select (pg_temp.eq(format($$pg_temp.ev_status(%L)$$, c.k), 'pending', 'AC-M1-58 ' || c.label || ' -> pending')) from strict_cases c order by c.k;
select (pg_temp.t(format($$pg_temp.ev_fails(%L) @> array[%L]::text[]$$, c.k, c.fail), 'AC-M1-58 ' || c.label || ' -> fail ' || c.fail)) from strict_cases c order by c.k;
select is(pg_temp.ev_status('sx-loft21'), 'published', 'AC-M1-58 "Jazz Quartet" at The Loft Bar with age 21_plus -> published (chip shown)');
select is(pg_temp.ev_status('sx-loftall'), 'published', 'AC-M1-58 ... with age all_ages -> published (explicit all_ages overrides a bar venue)');
select is(pg_temp.ev_status('sy-base'), 'pending', 'AC-M1-58 the same event with strict_auto = false -> pending');
-- clustered with an auto source's matching event: published by the auto rule with the organizer's title
select pg_temp.mk_source('sa', 'organizer', 'auto');
select pg_temp.rb('sr3', 'sx', jsonb_build_array(pg_temp.sitem('sx-pair', 'Truckee Jazz Quartet', 92)));
select pg_temp.rb('sr4', 'sa', jsonb_build_array(pg_temp.sitem('sa-pair', 'Truckee Jazz Quartet Live', 92)));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('sx-pair', 'sa-pair'))$$, '1', 'fixture: the aggregator and auto rows share one event');
select is(pg_temp.ev_status('sa-pair') || '|' || pg_temp.ev_col('sa-pair', 'title'), 'published|Truckee Jazz Quartet Live', 'AC-M1-58 clustered with an auto source: published with the auto source''s title (aggregator priority 20 loses)');
select pg_temp.t($$pg_temp.ev_col('sa-pair', 'field_sources')::jsonb ->> 'title' = 'sev:' || (select max(v.id) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.external_key = 'sa-pair')$$, 'AC-M1-58 ... field_sources.title points at the auto source''s version');
-- aggregators can never be auto (A3)
select pg_temp.t($$pg_temp.x('admin', $e$select public.admin_set_source_trust('sx', 'auto')$e$) like 'ERR:22023|invalid_input|aggregator_auto%'$$, 'AC-M1-58 admin_set_source_trust(aggregator, auto) -> invalid_input/aggregator_auto');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'sx')$$, 'review', 'AC-M1-58 ... trust unchanged');
select pg_temp.t($$pg_temp.x('postgres', $e$update public.sources set trust = 'auto' where slug = 'sx'$e$) like 'ERR:23514%'$$, 'AC-M1-58 a direct update of an aggregator to auto -> 23514');
select pg_temp.t($$pg_temp.x('postgres', $e$update public.sources set class = 'aggregator' where slug = 'k-auto'$e$) like 'ERR:23514%'$$, 'AC-M1-58 setting class = aggregator on an auto source -> 23514');
select pg_temp.eq($$(select count(*) from pg_constraint where conname = 'sources_aggregator_not_auto' and conrelid = 'public.sources'::regclass)$$, '1', 'A3 the CHECK is named sources_aggregator_not_auto');
-- strict_auto flip re-queues and publishes the passing rows
select pg_temp.x('postgres', $$update public.sources set strict_auto = true where slug = 'sy'$$);
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'sy') and needs_cluster)$$, '1', 'AC-M1-58 update sources set strict_auto = true re-queues that source''s live rows');
select pg_temp.cluster_all();
select is(pg_temp.ev_status('sy-base'), 'published', 'AC-M1-58 ... and one svc_cluster_and_publish publishes the passing ones');

-- AC-M1-59: card cap -------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('cap', 'aggregator', 'review');
select pg_temp.x('postgres', $$update public.sources set strict_auto = true, max_cards_7d = 3 where slug = 'cap'$$);
select pg_temp.mk_source('cap2', 'aggregator', 'review');
select pg_temp.x('postgres', $$update public.sources set strict_auto = true, max_cards_7d = 3 where slug = 'cap2'$$);
select pg_temp.mk_source('nocap', 'organizer', 'review');
select pg_temp.rb('cp1', 'cap', (select jsonb_agg(pg_temp.sitem('cp' || n, 'Capped ' || substr(md5('cap' || n), 1, 10), 10 + n) - 'url') from generate_series(1, 8) n));
select pg_temp.rb('cp2', 'cap2', jsonb_build_array(pg_temp.sitem('cq1', 'Geocode Waiting Special ' || substr(md5('cq1'), 1, 6), 20, '{"venueName":"Pending Geo Hall","lat":null,"lng":null}')));
select pg_temp.rb('cp3', 'nocap', (select jsonb_agg(pg_temp.sitem('cn' || n, 'Nocap ' || substr(md5('nocap' || n), 1, 10), 25 + n)) from generate_series(1, 4) n));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.review_cards where kind = 'event' and status = 'open' and source_id = (select id from public.sources where slug = 'cap'))$$, '3', 'AC-M1-59 max_cards_7d = 3 and 8 failing events -> exactly 3 open event cards carrying that source_id');
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 'cap') and e.status = 'pending')$$, '8', 'AC-M1-59 all 8 events are pending');
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 'cap') and e.status = 'pending'
                       and not exists (select 1 from public.review_cards c where c.event_id = e.id and c.status = 'open'))$$, '5', 'AC-M1-59 ... 5 of them pending without a card');
select is(pg_temp.ev_status('cq1') || '/' || pg_temp.open_cards('cq1'), 'pending/0', 'AC-M1-59 an event failing only geocode_pending -> pending and no card (deferred)');
select pg_temp.eq($$(select count(*) from public.review_cards where kind = 'event' and status = 'open' and source_id = (select id from public.sources where slug = 'nocap'))$$, '4', 'AC-M1-59 a source with max_cards_7d null -> one card per pending event (unchanged behavior)');
select pg_temp.x('postgres', $$insert into public.review_cards (kind, status, event_id, source_id, created_at, decided_at, decision)
  select 'event', 'closed', e.id, (select id from public.sources where slug = 'cap'), now() - interval '10 days', now() - interval '9 days', 'reject'
    from (select id from public.events where status = 'pending' limit 3) e$$);
select is(pg_temp.x('postgres', $$select private.queue_budget()$$), 'OK', 'AC-M1-59 private.queue_budget() runs');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'cap')$$, 'review', 'AC-M1-59 queue_budget() with 3 cards in each window (3 <= 5) leaves the source''s trust unchanged');
select pg_temp.t($$(select exists (select 1 from jsonb_array_elements(public.svc_weekly_report() -> 'uncarded_pending') e
                      where e ->> 'source' in ('cap', 'Src cap') and (e ->> 'n')::int = 5))$$, 'AC-M1-59 svc_weekly_report().uncarded_pending lists that source with 5');

-- AC-M1-60: out of region ----------------------------------------------------------------------------------------------------
select pg_temp.mk_source('oor', 'organizer', 'auto');
select pg_temp.ing('or1', 'oor', jsonb_build_array(pg_temp.item('or-1', 'Nevada City Gold Rush Day', 66, 18, '{"venueName":"Foothill Hall","town":"Nevada City","lat":null,"lng":null}')));
select is(pg_temp.ev_status('or-1') || '/' || pg_temp.open_cards('or-1'), 'pending/1', 'fixture: the ungeocoded event is pending with one card');
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, 39.26, -121.02, 'nominatim')$$, pg_temp.vid('Foothill Hall')));
select pg_temp.eq($$(select outside_region::text || '|' || geocode_attempts || '|' || (lat is null) from public.venues where id = pg_temp.vid('Foothill Hall'))$$, 'true|3|true', 'AC-M1-60 svc_set_venue_geocode(39.26, -121.02): outside_region = true, attempts = 3, coords null');
select pg_temp.cluster_all();
select is(pg_temp.ev_status('or-1') || '|' || pg_temp.ev_col('or-1', 'reject_reason') || '|' || pg_temp.ev_col('or-1', 'status_by_admin'), 'rejected|out_of_region|false', 'AC-M1-60 the event is rejected by rule: reject_reason out_of_region, status_by_admin false');
select is(pg_temp.open_cards('or-1')::text, '0', 'AC-M1-60 ... no open card');
select pg_temp.eq($$(select c.decision from public.review_cards c where c.event_id = pg_temp.ev_id('or-1') and c.kind = 'event')$$, 'out_of_region', 'AC-M1-60 ... the former card is closed with decision out_of_region');
select pg_temp.eq($$(select count(*) from public.event_changes where event_id = pg_temp.ev_id('or-1') and field = 'status' and decided_by = 'rule:region')$$, '1', 'AC-M1-60 ... journaled decided_by rule:region');
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, 39.3280, -120.1833, 'nominatim')$$, pg_temp.vid('Foothill Hall')));
select pg_temp.cluster_all();
select pg_temp.eq($$(select outside_region::text from public.venues where id = pg_temp.vid('Foothill Hall'))$$, 'false', 'AC-M1-60 a later in-box result clears outside_region');
select pg_temp.t($$pg_temp.ev_status('or-1') in ('published', 'pending')$$, 'AC-M1-60 ... and the event re-evaluates (no longer rejected)');

-- AC-M1-67 (A5-5): one total contributor order -------------------------------------------------------------------------
select pg_temp.mk_source('t67-a', 'organizer', 'review');
select pg_temp.mk_source('t67-b', 'organizer', 'review');
select pg_temp.rb('t67a', 't67-a', jsonb_build_array(pg_temp.item('t67x', 'Truckee Oktoberfest 2026', 61, 19, '{"venueName":"Tie Hall"}')));
select pg_temp.rb('t67b', 't67-b', jsonb_build_array(jsonb_set(pg_temp.item('t67y', 'Oktoberfest Truckee 2026', 61, 19, '{"venueName":"Tie Hall"}'),
  '{startsAt}', to_jsonb(pg_temp.ts(61, 19, 0, 10)))));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(distinct cluster_id) || '/' || count(*) from public.source_events where external_key in ('t67x', 't67y'))$$, '1/2',
  'AC-M1-67 fixture: the two equal-priority occurrences cluster into one event');
-- X = the occurrence with the lower se.id (19:00); Y = the other (19:10); same first_seen_at
create temp table t67 as
  select (array_agg(external_key order by id))[1] xk, (array_agg(external_key order by id))[2] yk,
         (array_agg(title order by id))[1] xt, (array_agg(title order by id))[2] yt, min(cluster_id::text)::uuid ev
    from public.source_events where external_key in ('t67x', 't67y');
select pg_temp.x('postgres', $$update public.source_events set first_seen_at = '2026-01-01 00:00:00+00' where external_key in ('t67x', 't67y')$$);
select pg_temp.x('postgres', $$update public.source_events se set starts_at = case when se.external_key = t.xk then pg_temp.tstz(61, 19) else pg_temp.tstz(61, 19, 0, 10) end
  from t67 t where se.external_key in (t.xk, t.yk)$$);
-- the event's current title equals Y's title; no open card, so the recompute opens a fresh one
select pg_temp.x('postgres', $$update public.events e set title = t.yt from t67 t where e.id = t.ev$$);
select pg_temp.x('postgres', $$delete from public.review_cards where kind = 'event' and event_id = (select ev from t67)$$);
select pg_temp.x('postgres', $$select private.recompute_event((select ev from t67))$$);
select pg_temp.t($$(select e.starts_at = pg_temp.tstz(61, 19) from public.events e join t67 t on t.ev = e.id)$$,
  'AC-M1-67 the event title equals Y''s title: starts_at is still X''s (the lower se.id), not Y''s');
select pg_temp.t($$(select e.field_sources ->> 'starts_at' = 'sev:' || (select max(v.id)::text from public.source_event_versions v join public.source_events se on se.id = v.source_event_id
                                                                      join t67 t on se.external_key = t.xk)
                      from public.events e join t67 t on t.ev = e.id)$$, 'AC-M1-67 ... field_sources starts_at names X''s latest version');
select pg_temp.t($$(select c.source_id = (select se.source_id from public.source_events se join t67 t on se.external_key = t.xk)
                      from public.review_cards c join t67 t on t.ev = c.event_id where c.kind = 'event' and c.status = 'open')$$,
  'AC-M1-67 the open event card''s source_id is X''s source');
-- swapping which title matches the event changes neither
select pg_temp.x('postgres', $$update public.events e set title = t.xt from t67 t where e.id = t.ev$$);
select pg_temp.x('postgres', $$delete from public.review_cards where kind = 'event' and event_id = (select ev from t67)$$);
select pg_temp.x('postgres', $$select private.recompute_event((select ev from t67))$$);
select pg_temp.t($$(select e.starts_at = pg_temp.tstz(61, 19) from public.events e join t67 t on t.ev = e.id)$$, 'AC-M1-67 swapped title match: starts_at is still X''s');
select pg_temp.t($$(select c.source_id = (select se.source_id from public.source_events se join t67 t on se.external_key = t.xk)
                      from public.review_cards c join t67 t on t.ev = c.event_id where c.kind = 'event' and c.status = 'open')$$,
  'AC-M1-67 swapped title match: the card source is still X''s source');

select * from finish();
rollback;
