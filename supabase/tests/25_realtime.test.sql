-- AC-M1-93 ... 97 (Amendment 10): real-time publishing. Chamber auto, cadences, auto sources apply new/edit surges, found_drop still holds, backlog drain.
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

-- AC-M1-93 ---------------------------------------------------------------------------------------------------------
select is((select trust::text from public.sources where slug = 'truckee-chamber'), 'auto', 'AC-M1-93 truckee-chamber trust = auto');
select is((select string_agg(slug || ':' || cadence, ',' order by slug) from public.sources where slug in ('alibi-truckee', 'visit-lake-tahoe', 'truckee-chamber', 'tdrpd')),
  'alibi-truckee:6h,tdrpd:24h,truckee-chamber:24h,visit-lake-tahoe:12h', 'AC-M1-93 cadences alibi 6h / vlt 12h / chamber 24h / tdrpd 24h');
select is((select trust::text || ':' || strict_auto::text from public.sources where slug = 'visit-lake-tahoe'), 'review:true', 'AC-M1-93 vlt stays review + strict_auto');

-- AC-M1-94 ---------------------------------------------------------------------------------------------------------
create function pg_temp.surge_items() returns jsonb language sql as $$
  select jsonb_build_array(pg_temp.item('a', 'Alpha Harvest Dinner', 30))
    || (select jsonb_agg(pg_temp.item('z' || n, 'Zulu ' || substr(md5('z' || n), 1, 10), 2 + n % 40, 9 + n % 10)) from generate_series(1, 25) n) $$;
select pg_temp.mk_source('a-new', 'organizer', 'auto');
select pg_temp.mk_source('r-new', 'organizer', 'review');
select pg_temp.ing('an0', 'a-new', jsonb_build_array(pg_temp.item('a', 'Alpha Harvest Dinner', 30), pg_temp.item('b', 'Bravo Harvest Dinner', 31)));
select pg_temp.ing('rn0', 'r-new', jsonb_build_array(pg_temp.item('a', 'Alpha Harvest Dinner', 30), pg_temp.item('b', 'Bravo Harvest Dinner', 31)));
select pg_temp.seed_runs('a-new', 6, 2, 2);
select pg_temp.seed_runs('r-new', 6, 2, 2);
select pg_temp.ing('an1', 'a-new', pg_temp.surge_items());
select pg_temp.rb('rn1', 'r-new', pg_temp.surge_items());
select is(pg_temp.r('an1', 'status') || '/' || pg_temp.r('an1', 'new'), 'ok/25', 'AC-M1-94 auto source, 25 new (> max(20, 3 x median 2)) -> ok, applied');
select pg_temp.eq($$(select count(*) from public.held_runs where source_id = (select id from public.sources where slug = 'a-new'))$$, '0', 'AC-M1-94 ... no held_runs row');
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 'a-new') and e.status = 'published')$$, '27', 'AC-M1-94 ... and the events are published');
select is(pg_temp.r('rn1', 'status'), 'anomaly', 'AC-M1-94 the same batch on a review source -> anomaly');
select is(pg_temp.reasons('rn1'), '["new_surge"]', 'AC-M1-94 ... held with new_surge');
select pg_temp.eq($$(select count(*) from public.held_runs where source_id = (select id from public.sources where slug = 'r-new') and status = 'pending')$$, '1', 'AC-M1-94 ... one pending held_runs row');

-- AC-M1-95 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('a-edit', 'organizer', 'auto');
select pg_temp.mk_source('r-edit', 'organizer', 'review');
select pg_temp.ing('ae0', 'a-edit', pg_temp.bulk(100, 'e'));
select pg_temp.ing('re0', 'r-edit', pg_temp.bulk(100, 'e'));
select pg_temp.ing('ae1', 'a-edit', pg_temp.bulk(100, 'e', 50));
select pg_temp.rb('re1', 'r-edit', pg_temp.bulk(100, 'e', 50));
select is(pg_temp.r('ae1', 'status') || '/' || pg_temp.r('ae1', 'changed'), 'ok/50', 'AC-M1-95 auto source, 50 of 100 changed (> max(5, 20) and > max(10, 40)) -> ok, applied');
select pg_temp.eq($$(select count(*) from public.held_runs where source_id = (select id from public.sources where slug = 'a-edit'))$$, '0', 'AC-M1-95 ... no held_runs row');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'a-edit') and title like '% v2')$$, '50', 'AC-M1-95 ... the 50 edits are stored');
select is(pg_temp.r('re1', 'status'), 'anomaly', 'AC-M1-95 the same batch on a review source -> anomaly');
select pg_temp.t($$(select res -> 'reasons' ? 'edit_surge' from tres where label = 're1')$$, 'AC-M1-95 ... held with edit_surge');

-- AC-M1-96 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('a-drop', 'organizer', 'auto');
select pg_temp.rb('ad0', 'a-drop', (select jsonb_agg(pg_temp.item('d' || n, 'Drop ' || substr(md5('d' || n), 1, 10), 5 + n, 10)) from generate_series(1, 20) n));
select pg_temp.seed_runs('a-drop', 6, 20, 0);
select pg_temp.rb('ad1', 'a-drop', (select jsonb_agg(pg_temp.item('d' || n, 'Drop ' || substr(md5('d' || n), 1, 10), 5 + n, 10)) from generate_series(1, 8) n));
select is(pg_temp.r('ad1', 'status'), 'anomaly', 'AC-M1-96 auto source, median found 20, batch with 8 -> still anomaly');
select is(pg_temp.reasons('ad1'), '["found_drop"]', 'AC-M1-96 ... with exactly found_drop');
select pg_temp.eq($$(select count(*) from public.held_runs where source_id = (select id from public.sources where slug = 'a-drop') and status = 'pending')$$, '1', 'AC-M1-96 ... one pending held_runs row');

-- AC-M1-97 ---------------------------------------------------------------------------------------------------------
-- A review source's items sit pending with open cards; the migration's steps (trust UPDATE, then the max-20 drain loop) publish them.
select pg_temp.mk_source('q-ch', 'organizer', 'review');
select pg_temp.ing('qc0', 'q-ch', pg_temp.bulk(30, 'q'));
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 'q-ch') and e.status = 'pending')$$, '30', 'AC-M1-97 fixture: 30 queued events pending while the source is review');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.source_id = (select id from public.sources where slug = 'q-ch') and c.kind = 'event' and c.status = 'open')$$, '30', 'AC-M1-97 fixture: 30 open event cards');
update public.sources set trust = 'auto' where slug = 'q-ch';
do $$ declare i int; r jsonb; begin
  for i in 1..20 loop
    r := private.cluster_and_publish(500);
    exit when (r ->> 'remaining')::int = 0;
  end loop;
end $$;
select pg_temp.eq($$(select count(*) from public.events e join public.source_events se on se.cluster_id = e.id where se.source_id = (select id from public.sources where slug = 'q-ch') and e.status = 'published')$$, '30', 'AC-M1-97 after trust = auto and the drain loop all 30 events are published');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.source_id = (select id from public.sources where slug = 'q-ch') and c.kind = 'event' and c.status = 'open')$$, '0', 'AC-M1-97 ... no event card is open');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.source_id = (select id from public.sources where slug = 'q-ch') and c.kind = 'event' and c.decision = 'auto_published')$$, '30', 'AC-M1-97 ... all 30 closed as auto_published');
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster)$$, '0', 'AC-M1-97 ... the outbox is empty');

select * from finish();
rollback;
