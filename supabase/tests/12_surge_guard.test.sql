-- AC-M1-19 ... 23, 51: the surge guard and the non-ok gate. (S1.2 steps 4 and 8, D11.)
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
create function pg_temp.reasons(p_label text) returns text language sql as $$
  select coalesce((select (res -> 'reasons')::text from tres where label = p_label), '<none>') $$;
create function pg_temp.tabs() returns text language sql as $$
  select pg_temp.snap('public.source_events') || pg_temp.snap('public.source_event_versions') || pg_temp.snap('public.events')
      || pg_temp.snap('public.event_changes') || pg_temp.snap('public.venues') $$;

-- AC-M1-19 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('s-new', 'organizer', 'auto');
select pg_temp.ing('n0', 's-new', jsonb_build_array(pg_temp.item('a', 'Alpha Harvest Dinner', 30), pg_temp.item('b', 'Bravo Harvest Dinner', 31)));
select pg_temp.seed_runs('s-new', 6, 2, 2);
create temp table s19 as select pg_temp.tabs() as t, pg_temp.n('public.held_runs') h, pg_temp.n('public.review_cards') c;
select pg_temp.rb('n1', 's-new', jsonb_build_array(pg_temp.item('a', 'Alpha Harvest Dinner', 30))
  || (select jsonb_agg(pg_temp.item('z' || n, 'Zulu ' || substr(md5('z' || n), 1, 10), 2 + n % 40, 9 + n % 10)) from generate_series(1, 25) n));
select is(pg_temp.r('n1', 'status'), 'anomaly', 'AC-M1-19 trust=auto, 7 prior ok runs (median new 2), 25 new -> run status anomaly');
select pg_temp.t($$(select res -> 'reasons' ? 'new_surge' from tres where label = 'n1')$$, 'AC-M1-19 ... with reason new_surge');
select pg_temp.eq($$(select count(*) from public.held_runs h where h.source_id = (select id from public.sources where slug = 's-new') and h.status = 'pending')$$, '1', 'AC-M1-19 one held_runs row');
select pg_temp.eq($$(select jsonb_array_length(items) from public.held_runs where run_id = (select (res ->> 'run_id')::uuid from tres where label = 'n1'))$$, '26', 'AC-M1-19 ... holding the cleaned items');
select pg_temp.eq($$(select count(*) from public.review_cards where kind = 'held_run' and status = 'open' and source_id = (select id from public.sources where slug = 's-new'))$$, '1', 'AC-M1-19 one open held_run card');
select pg_temp.eq($$(select status || '|' || anomaly_reasons::text from public.source_runs where id = (select (res ->> 'run_id')::uuid from tres where label = 'n1'))$$, 'anomaly|{new_surge}', 'AC-M1-19 the run row is anomaly with its reasons');
select pg_temp.t($$(select pg_temp.tabs() = t from s19)$$, 'AC-M1-19 source_events, versions, events, event_changes, venues unchanged');
select pg_temp.eq($$(select sum(missing_runs) from public.source_events where source_id = (select id from public.sources where slug = 's-new'))$$, '0', 'AC-M1-19 no missing_runs increments (the omitted item b stays at 0)');

-- AC-M1-20 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('s-500', 'organizer', 'review');
select pg_temp.rb('f0', 's-500', pg_temp.bulk(500));
select is(pg_temp.r('f0', 'status') || '/' || pg_temp.r('f0', 'new'), 'ok/500', 'fixture: 500 occurrences stored (first run of a review source is exempt from new_surge)');
select pg_temp.x('postgres', $$update public.sources set trust = 'auto' where slug = 's-500'$$);
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(distinct e.id) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500') and e.status = 'published')$$, '500', 'fixture (A5-9): 500 distinct published events from s-500 after promotion');
select pg_temp.eq($$(select count(distinct se.cluster_id) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500') and e.status = 'published')$$, '500', 'fixture (A5-9): 500 distinct clusters among the s-500 occurrences');
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500') and e.status = 'published')$$, '500', 'fixture (A5-9): 500 s-500 occurrences join published events');
create temp table s20 as select pg_temp.tabs() as t;
create temp table s20e as select e.id, e.status, e.organizer_url from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500');
select pg_temp.rb('f1', 's-500', pg_temp.bulk(500, 'b', 0, 'https://example.test/moved/'));
select is(pg_temp.r('f1', 'status'), 'anomaly', 'AC-M1-20 a batch changing the URL path of all 500 -> anomaly');
select pg_temp.t($$(select res -> 'reasons' ? 'edit_surge' from tres where label = 'f1')$$, 'AC-M1-20 ... with reason edit_surge');
select pg_temp.t($$(select pg_temp.tabs() = t from s20)$$, 'AC-M1-20 nothing was applied');
select pg_temp.eq($$(select count(distinct e.id) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500') and e.status = 'published' and e.organizer_url like 'https://example.test/e/%')$$, '500', 'AC-M1-20 (A5-9) all 500 distinct published events of s-500 keep their URL and status');
select pg_temp.eq($$(select count(distinct se.cluster_id) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500') and e.status = 'published' and e.organizer_url like 'https://example.test/e/%')$$, '500', 'AC-M1-20 (A5-9) ... over 500 distinct clusters');
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500') and e.status = 'published' and e.organizer_url like 'https://example.test/e/%')$$, '500', 'AC-M1-20 (A5-9) ... and 500 occurrence rows');
select pg_temp.eq($$(select count(*) from (select e.id, e.status, e.organizer_url from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500')
                       except select id, status, organizer_url from s20e) d)$$, '0', 'AC-M1-20 (A5-9) the s-500 (id, status, organizer_url) set after the batch has no row that was not there before');
select pg_temp.eq($$(select count(*) from (select id, status, organizer_url from s20e
                       except select e.id, e.status, e.organizer_url from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 's-500')) d)$$, '0',
  'AC-M1-20 (A5-9) ... and no before row is missing or changed (identity before/after)');

-- AC-M1-21 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('s-100', 'organizer', 'review');
select pg_temp.rb('e0', 's-100', pg_temp.bulk(100, 'e'));
select pg_temp.rb('e1', 's-100', pg_temp.bulk(100, 'e', 19));
select is(pg_temp.r('e1', 'status') || '/' || pg_temp.r('e1', 'changed'), 'ok/19', 'AC-M1-21 run 1 changes 19 (19 <= 40): applied');
select pg_temp.rb('e2', 's-100', pg_temp.bulk(100, 'e', 38));
select is(pg_temp.r('e2', 'status') || '/' || pg_temp.r('e2', 'changed'), 'ok/19', 'AC-M1-21 run 2 changes 19 more (38 <= 40): applied');
select pg_temp.rb('e3', 's-100', pg_temp.bulk(100, 'e', 57));
select is(pg_temp.r('e3', 'status'), 'anomaly', 'AC-M1-21 run 3 (57 > 40) -> anomaly');
select is(pg_temp.reasons('e3'), '["edit_surge_7d"]', 'AC-M1-21 ... with exactly the reason edit_surge_7d');

-- AC-M1-22 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('s-r755', 'organizer', 'review');
select pg_temp.mk_source('s-a755', 'organizer', 'auto');
select pg_temp.mk_source('s-s755', 'organizer', 'review');
select pg_temp.x('postgres', $$update public.sources set strict_auto = true where slug = 's-s755'$$);
select pg_temp.rb('r755', 's-r755', pg_temp.bulk(755, 'r'));
select is(pg_temp.r('r755', 'status'), 'ok', 'AC-M1-22 no prior ok run, trust=review, 755 items -> ok');
select pg_temp.rb('a755', 's-a755', pg_temp.bulk(755, 'a'));
select is(pg_temp.r('a755', 'status'), 'anomaly', 'AC-M1-22 no prior ok run, trust=auto, 755 items -> anomaly');
select pg_temp.t($$(select res -> 'reasons' ? 'new_surge' from tres where label = 'a755')$$, 'AC-M1-22 ... new_surge');
select pg_temp.rb('s755', 's-s755', pg_temp.bulk(755, 's'));
select is(pg_temp.r('s755', 'status'), 'anomaly', 'AC-M1-22 (A2) trust=review + strict_auto, 755 items -> anomaly (no exemption)');
select pg_temp.t($$(select res -> 'reasons' ? 'new_surge' from tres where label = 's755')$$, 'AC-M1-22 ... new_surge');

-- AC-M1-23 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('s-drop', 'organizer', 'auto');
select pg_temp.rb('d0', 's-drop', (select jsonb_agg(pg_temp.item('d' || n, 'Drop ' || substr(md5('d' || n), 1, 10), 5 + n, 10)) from generate_series(1, 20) n));
select is(pg_temp.r('d0', 'status'), 'ok', 'fixture: 20 items from an auto source (new 20 <= 20) is ok');
select pg_temp.seed_runs('s-drop', 6, 20, 0);
select pg_temp.rb('d1', 's-drop', (select jsonb_agg(pg_temp.item('d' || n, 'Drop ' || substr(md5('d' || n), 1, 10), 5 + n, 10)) from generate_series(1, 8) n));
select is(pg_temp.r('d1', 'status'), 'anomaly', 'AC-M1-23 median items_found 20, batch with 8 -> anomaly');
select pg_temp.t($$(select res -> 'reasons' ? 'found_drop' from tres where label = 'd1')$$, 'AC-M1-23 ... found_drop');
select pg_temp.eq($$(select sum(missing_runs) || '/' || count(*) filter (where source_status <> 'live') from public.source_events where source_id = (select id from public.sources where slug = 's-drop'))$$, '0/0', 'AC-M1-23 no gone marks and no missing_runs increments');

select pg_temp.mk_source('s-zero', 'organizer', 'auto');
select pg_temp.rb('z1', 's-zero', (select jsonb_agg(pg_temp.item('q' || n, 'Zero ' || substr(md5('q' || n), 1, 10), 5 + n, 10)) from generate_series(1, 6) n));
select pg_temp.rb('z2', 's-zero', '[]');
select pg_temp.rb('z3', 's-zero', '[]');
select is(pg_temp.r('z2', 'status') || '/' || pg_temp.r('z3', 'status'), 'ok/ok', 'AC-M1-23 after a run with 6 found, the first two 0-found runs are ok');
select pg_temp.rb('z4', 's-zero', '[]');
select is(pg_temp.r('z4', 'status'), 'anomaly', 'AC-M1-23 the third consecutive 0-found run -> anomaly');
select pg_temp.t($$(select res -> 'reasons' ? 'found_zero' from tres where label = 'z4')$$, 'AC-M1-23 ... found_zero');

select pg_temp.mk_source('s-never', 'organizer', 'auto');
select pg_temp.rb('v1', 's-never', '[]');
select pg_temp.rb('v2', 's-never', '[]');
select pg_temp.rb('v3', 's-never', '[]');
select pg_temp.rb('v4', 's-never', '[]');
select pg_temp.rb('v5', 's-never', '[]');
select is(pg_temp.r('v1', 'status') || pg_temp.r('v2', 'status') || pg_temp.r('v3', 'status') || pg_temp.r('v4', 'status') || pg_temp.r('v5', 'status'),
  'okokokokok', 'AC-M1-23 a source that has never found an item: five consecutive 0-found runs are all ok');
select pg_temp.eq($$(select count(*) from public.held_runs where source_id = (select id from public.sources where slug = 's-never')) || '/' || (select count(*) from public.review_cards where source_id = (select id from public.sources where slug = 's-never'))$$,
  '0/0', 'AC-M1-23 ... with no held run and no card (TDRPD case)');

-- AC-M1-51 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('n-auto', 'organizer', 'review');
select pg_temp.rb('k0', 'n-auto', pg_temp.bulk(500, 'k'));
select pg_temp.x('postgres', $$update public.sources set trust = 'auto' where slug = 'n-auto'$$);
select pg_temp.cluster_all();
create temp table s51 as select pg_temp.tabs() as t, pg_temp.snap('public.source_runs') runs, pg_temp.n('public.source_runs') n_runs;
select pg_temp.rb('nok_http_error', 'n-auto', pg_temp.bulk(500, 'k', 500), jsonb_build_object('status', 'http_error', 'http_status', 500, 'error_code', 'http_500'));
select pg_temp.rb('nok_not_modified', 'n-auto', pg_temp.bulk(500, 'k', 500), jsonb_build_object('status', 'not_modified', 'http_status', 304));
select pg_temp.rb('nok_parse_error', 'n-auto', pg_temp.bulk(500, 'k', 500), jsonb_build_object('status', 'parse_error', 'error_code', 'bad_xml'));
select pg_temp.rb('nok_skipped', 'n-auto', pg_temp.bulk(500, 'k', 500), jsonb_build_object('status', 'skipped', 'error_code', 'no_adapter'));
select pg_temp.rb('nok_robots_blocked', 'n-auto', pg_temp.bulk(500, 'k', 500), jsonb_build_object('status', 'robots_blocked', 'error_code', 'robots_blocked'));
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input', 'items_nonok') from tres where label = 'nok_http_error')$$, 'AC-M1-51 http_error + 500 changed items -> invalid_input/items_nonok');
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input', 'items_nonok') from tres where label = 'nok_not_modified')$$, 'AC-M1-51 not_modified + items -> invalid_input/items_nonok');
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input', 'items_nonok') from tres where label = 'nok_parse_error')$$, 'AC-M1-51 parse_error + items -> invalid_input/items_nonok');
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input', 'items_nonok') from tres where label = 'nok_skipped')$$, 'AC-M1-51 skipped + items -> invalid_input/items_nonok');
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input', 'items_nonok') from tres where label = 'nok_robots_blocked')$$, 'AC-M1-51 robots_blocked + items -> invalid_input/items_nonok');
select pg_temp.t($$(select pg_temp.tabs() = t and pg_temp.snap('public.source_runs') = runs from s51)$$,
  'AC-M1-51 source_events, versions, events, event_changes, venues and source_runs are md5-identical after the five refused batches');
select pg_temp.eq($$(select sum(missing_runs) from public.source_events where source_id = (select id from public.sources where slug = 'n-auto'))$$, '0', 'AC-M1-51 missing_runs unchanged');
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input') from (select pg_temp.run_batch_err('n-auto', '[]', '{"status":"anomaly"}') err) x)$$, 'AC-M1-51 a caller-supplied status of anomaly is refused (the server decides)');
-- same statuses with an empty item list: one run row each, counters 0, nothing else touched
create temp table s51b as select pg_temp.tabs() as t;
select pg_temp.rb('em_http_error', 'n-auto', '[]', jsonb_build_object('status', 'http_error', 'http_status', 500, 'error_code', 'http_500'));
select pg_temp.rb('em_not_modified', 'n-auto', '[]', jsonb_build_object('status', 'not_modified', 'http_status', 304));
select pg_temp.rb('em_parse_error', 'n-auto', '[]', jsonb_build_object('status', 'parse_error', 'error_code', 'bad_xml'));
select pg_temp.rb('em_skipped', 'n-auto', '[]', jsonb_build_object('status', 'skipped', 'error_code', 'no_adapter'));
select pg_temp.rb('em_robots_blocked', 'n-auto', '[]', jsonb_build_object('status', 'robots_blocked', 'error_code', 'robots_blocked'));
select pg_temp.eq($$(select count(*) from public.source_runs where id in (select (res ->> 'run_id')::uuid from tres where label like 'em\_%')
                       and items_found = 0 and items_new = 0 and items_changed = 0 and items_gone = 0 and items_invalid = 0 and items_suppressed = 0)$$,
  '5', 'AC-M1-51 the same statuses with items: [] each record one run row with all item counters 0');
select pg_temp.eq($$(select string_agg(status, ',' order by status) from public.source_runs where id in (select (res ->> 'run_id')::uuid from tres where label like 'em\_%'))$$,
  'http_error,not_modified,parse_error,robots_blocked,skipped', 'AC-M1-51 ... with the statuses as sent');
select pg_temp.t($$(select pg_temp.tabs() = t from s51b)$$, 'AC-M1-51 ... and no other table changed');
select pg_temp.eq($$(select sum(missing_runs) from public.source_events where source_id = (select id from public.sources where slug = 'n-auto'))$$, '0', 'AC-M1-51 ... missing_runs still unchanged after the empty non-ok runs');
-- counters are server-computed
select pg_temp.mk_source('n-ok2', 'organizer', 'review');
select pg_temp.rb('cnt', 'n-ok2', (select jsonb_agg(pg_temp.item('m' || n, 'Counter ' || substr(md5('m' || n), 1, 10), 5 + n, 12)) from generate_series(1, 5) n),
  jsonb_build_object('items_new', 0, 'items_changed', 999, 'items_found', 77, 'items_gone', 9));
select pg_temp.eq($$(select items_found || '/' || items_new || '/' || items_changed || '/' || items_gone from public.source_runs where id = (select (res ->> 'run_id')::uuid from tres where label = 'cnt'))$$,
  '5/5/0/0', 'AC-M1-51 an ok batch with 5 new items and p_run items_new=0, items_changed=999 -> run row found 5, new 5, changed 0 (caller counters ignored)');
select pg_temp.t($$(select pg_temp.err(err, '22023', 'invalid_input') from (select pg_temp.run_batch_err('n-ok2', '[]', '{"status":"bogus"}') err) x)$$, 'AC-M1-51 an unknown status is refused');

select * from finish();
rollback;
