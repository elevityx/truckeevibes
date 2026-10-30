-- AC-M1-167 (DB side), AC-M1-169: A15 ingest quality (price:source_free vocabulary, the cluster-level adult veto in recompute_event).
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
create function pg_temp.reasons(p_label text) returns text language sql as $$
  select coalesce((select (res -> 'reasons')::text from tres where label = p_label), '<none>') $$;
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
create function pg_temp.cats(k text) returns text language sql as $$
  select coalesce((select string_agg(c.category, ',' order by c.category) from public.event_categories c where c.event_id = pg_temp.ev_id(k)), '') $$;
create function pg_temp.veto_rows(k text) returns bigint language sql as $$
  select count(*) from public.event_changes where event_id = pg_temp.ev_id(k) and decided_by = 'rule:adult_veto' $$;
-- the dmo-side item (family + music, all ages) and the venue-side item at the same title, time and venue
create function pg_temp.a_item(p_key text, p_title text, p_days int) returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_days, 18, '{"categoriesHint":["family","music"],"age":"all_ages","tagReasons":["cat:source_map","age:all_ages"]}') $$;
create function pg_temp.b_item(p_key text, p_title text, p_days int, p_over jsonb) returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_days, 18, '{"categoriesHint":["music"]}'::jsonb || p_over) $$;

select pg_temp.mk_source('a15-dmo', 'dmo', 'review');
select pg_temp.mk_source('a15-venue', 'venue', 'review');

-- AC-M1-167 (DB side) ------------------------------------------------------------------------------------------------
select pg_temp.eq($$private.valid_reason_code('price:source_free')$$, 'true', 'AC-M1-167 valid_reason_code(price:source_free) is true');
select pg_temp.eq($$private.valid_reason_code('price:made_up')$$, 'false', 'AC-M1-167 ... and an unknown price code is still false');
select pg_temp.eq($$(select private.clean_source_item((select s from public.sources s where s.slug = 'a15-dmo'),
    pg_temp.item('c1', 'A15 Clean Item', 60, 18, '{"tagReasons":["price:source_free","cat:source_map"]}')) -> 'tag_reasons')$$,
  '["price:source_free", "cat:source_map"]', 'AC-M1-167 clean_source_item keeps price:source_free and cat:source_map, in order');

-- AC-M1-169 1: control, one contributor ------------------------------------------------------------------------------
select pg_temp.ing('a1', 'a15-dmo', jsonb_build_array(pg_temp.a_item('v1a', 'A15 Cluster Veto Fest', 50)));
select pg_temp.eq($$pg_temp.cats('v1a') || '|' || pg_temp.ev_col('v1a', 'age')$$, 'family,music|all_ages', 'AC-M1-169 (1) one contributor: {family,music} and all_ages (control)');
-- 2: a venue copy with the adult signal joins the cluster
select pg_temp.ing('b1', 'a15-venue', jsonb_build_array(pg_temp.b_item('v1b', 'A15 Cluster Veto Fest', 50, '{"tagReasons":["conflict:adult_signal"]}')));
select pg_temp.eq($$(select count(distinct cluster_id) || '/' || count(*) from public.source_events where external_key in ('v1a', 'v1b'))$$, '1/2', 'AC-M1-169 (2) fixture: one event with both contributors');
select pg_temp.eq($$pg_temp.cats('v1a') || '|' || pg_temp.ev_col('v1a', 'age')$$, 'music|unknown', 'AC-M1-169 (2) the cluster veto leaves {music} and age unknown');
select pg_temp.eq($$(select count(*) || '|' || min(old_value::text) || '|' || min(new_value::text) from public.event_changes where event_id = pg_temp.ev_id('v1a') and field = 'age')$$,
  '1|"all_ages"|"unknown"', 'AC-M1-169 (2) exactly one age row, all_ages -> unknown');
select pg_temp.eq($$pg_temp.veto_rows('v1a')$$, '1', 'AC-M1-169 (2) ... decided_by rule:adult_veto');

-- 3: a fresh pair whose venue copy is 21_plus: that age wins by priority; no veto row
select pg_temp.ing('a2', 'a15-dmo', jsonb_build_array(pg_temp.a_item('v2a', 'A15 Cluster Veto Fest Two', 51)));
select pg_temp.ing('b2', 'a15-venue', jsonb_build_array(pg_temp.b_item('v2b', 'A15 Cluster Veto Fest Two', 51, '{"age":"21_plus","tagReasons":["age:21_admission"]}')));
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('v2a', 'v2b'))$$, '1', 'AC-M1-169 (3) fixture: one event');
select pg_temp.eq($$pg_temp.cats('v2a') || '|' || pg_temp.ev_col('v2a', 'age')$$, 'music|21_plus', 'AC-M1-169 (3) {music} and 21_plus (the venue copy wins by priority)');
select pg_temp.eq($$pg_temp.veto_rows('v2a')$$, '0', 'AC-M1-169 (3) ... and no rule:adult_veto row');

-- no row when the stored age is already unknown: the adult copy arrives first, the all-ages copy joins later
select pg_temp.ing('b4', 'a15-venue', jsonb_build_array(pg_temp.b_item('v4b', 'A15 Cluster Veto Fest Four', 53, '{"tagReasons":["conflict:adult_signal"]}')));
select pg_temp.ing('a4', 'a15-dmo', jsonb_build_array(pg_temp.a_item('v4a', 'A15 Cluster Veto Fest Four', 53)));
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('v4a', 'v4b'))$$, '1', 'AC-M1-169 fixture: the late all-ages copy joined the adult copy''s event');
select pg_temp.eq($$pg_temp.cats('v4a') || '|' || pg_temp.ev_col('v4a', 'age') || '|' || pg_temp.veto_rows('v4a')$$, 'music|unknown|0', 'AC-M1-169 an event whose stored age was never all_ages logs no veto');

-- admin-locked categories keep family
select pg_temp.ing('a3', 'a15-dmo', jsonb_build_array(pg_temp.a_item('v3a', 'A15 Cluster Veto Fest Three', 52)));
select pg_temp.x('admin', format($$select public.admin_update_event(%L, '{"categories":["family","music"]}'::jsonb)$$, pg_temp.ev_id('v3a')));
select pg_temp.ing('b3', 'a15-venue', jsonb_build_array(pg_temp.b_item('v3b', 'A15 Cluster Veto Fest Three', 52, '{"tagReasons":["conflict:adult_signal"]}')));
select pg_temp.eq($$pg_temp.cats('v3a')$$, 'family,music', 'AC-M1-169 admin-locked categories: family stays');
select pg_temp.eq($$pg_temp.ev_col('v3a', 'age')$$, 'unknown', 'AC-M1-169 ... while the unlocked age is still demoted');

select pg_temp.eq($$(select count(*) from public.event_changes where decided_by !~ '^(sev:[0-9]+|admin:[0-9a-f-]{36}|rule:[a-z_]{1,40})$')$$, '0', 'AC-M1-169 every decided_by written matches the CHECK pattern');
select pg_temp.eq($$(select count(*) from public.event_changes where decided_by = 'rule:adult_veto')$$, '2', 'AC-M1-169 two rule:adult_veto rows overall (pairs 1 and 3)');

select * from finish();
rollback;
