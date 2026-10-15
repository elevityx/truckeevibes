-- AC-M1-33: list_events() as anon (S1.3).
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
create function pg_temp.mk_ev(p_title text, p_start interval, p_end interval, p_status text default 'published', p_merged boolean default false) returns void language plpgsql as $$
begin
  insert into public.events (region_id, slug, title, summary, starts_at, ends_at, time_known, status, merged_into)
    values ((select id from public.regions where slug = 'truckee'),
            'le-' || substr(md5(p_title), 1, 20) || '-' || substr(md5(p_title || 'x'), 1, 6), p_title,
            'Fixture summary for the public read test.', now() + p_start, case when p_end is null then null else now() + p_end end, true,
            p_status::public.event_status,
            case when p_merged then (select id from public.events where title = 'LE Ended Half Hour Ago') end);
exception when others then
  raise notice 'mk_ev % failed: % %', p_title, sqlstate, sqlerrm;
end $$;
select pg_temp.mk_ev('LE Ended Two Hours Ago', interval '-3 hours', interval '-2 hours');
select pg_temp.mk_ev('LE Ended Half Hour Ago', interval '-2 hours', interval '-30 minutes');
select pg_temp.mk_ev('LE Open Ended Recent', interval '-3 hours 30 minutes', null);
select pg_temp.mk_ev('LE Pending Event', interval '1 day', interval '1 day 2 hours', 'pending');
select pg_temp.mk_ev('LE Hidden Event', interval '1 day', interval '1 day 2 hours', 'hidden');
select pg_temp.mk_ev('LE Merged Event', interval '1 day', interval '1 day 2 hours', 'published', true);
select pg_temp.mk_ev('LE Rejected Event', interval '1 day', interval '1 day 2 hours', 'rejected');
select pg_temp.mk_ev('LE Cancelled Event', interval '1 day', interval '1 day 2 hours', 'cancelled');
select pg_temp.mk_ev('LE Soon Event', interval '2 days', interval '2 days 2 hours');
select pg_temp.mk_ev('LE Later Event', interval '10 days', interval '10 days 2 hours');
select pg_temp.mk_ev('LE Far Event', interval '130 days', interval '130 days 2 hours');
select pg_temp.eq($$(select count(*) from public.events where title like 'LE %')$$, '11', 'fixture: 11 fixture events inserted directly');

select is(pg_temp.v('anon', $$(select string_agg(title, ',' order by starts_at, id) from public.list_events() where title like 'LE %')$$),
  'LE Open Ended Recent,LE Ended Half Hour Ago,LE Soon Event,LE Later Event',
  'AC-M1-33 anon: ended 2 h ago absent, ended 30 min ago present, open-ended recent present, pending/hidden/merged/rejected/cancelled absent, 130 days out absent; ordered by starts_at');
select is(pg_temp.v('user', $$(select count(*) from public.list_events() where title like 'LE %')$$), '4', 'AC-M1-33 authenticated may call list_events too');
select is(pg_temp.v('anon', $$(select count(*) from public.list_events(5) where title like 'LE %')$$), '3', 'S1.3 p_days narrows the window (5 days: the 10-day event drops out, leaving 3)');
select is(pg_temp.v('anon', $$(select count(*) from public.list_events(500) where title like 'LE %')$$), '4', 'S1.3 p_days is clamped to 120 (the 130-day event stays out)');
select is(pg_temp.v('anon', $$(select array(select n from (select unnest(p.proargnames) n, unnest(p.proargmodes) m from pg_proc p
      where p.proname = 'list_events' and p.pronamespace = 'public'::regnamespace) x where x.m = 't'))$$),
  '{id,slug,title,summary,starts_at,ends_at,all_day,start_date,end_date,time_known,venue,address,town,area,lat,lng,categories,price_kind,price_min,price_max,age,featured,url,ticket_url,sources}',
  'AC-M1-33 the output columns are exactly the declared set (no confidence, field_sources, moderation or lights_* columns)');
select pg_temp.t($$(select p.prosecdef and p.provolatile = 's' from pg_proc p where p.proname = 'list_events' and p.pronamespace = 'public'::regnamespace)$$, 'S1.3 list_events is security definer and stable');
select pg_temp.t($$pg_temp.x('anon', 'select * from public.events') like 'ERR:42501%'$$, 'D3 anon has no SELECT on events');
select pg_temp.t($$pg_temp.x('user', 'select * from public.source_events') like 'ERR:42501%'$$, 'D3 authenticated has no SELECT on source_events');

-- public attribution and joined venue columns, through the real ingest path
select pg_temp.mk_source('le-auto', 'organizer', 'auto');
select pg_temp.ing('le1', 'le-auto', jsonb_build_array(pg_temp.item('le-a', 'LE Attributed Show', 12, 19, '{"categoriesHint":["music"],"priceKind":"free","ticketUrl":"https://example.test/tix/1"}')));
select is(pg_temp.v('anon', $$(select venue || '|' || address || '|' || town || '|' || area || '|' || lat || '|' || lng || '|' || categories::text || '|' || price_kind || '|' || age || '|' || url || '|' || ticket_url || '|' || sources::text
      from public.list_events() where title = 'LE Attributed Show')$$),
  'Test Hall|10 Main St|Truckee|truckee|39.328|-120.1833|{music}|free|unknown|https://example.test/e/le-a|https://example.test/tix/1|{"Src le-auto"}',
  'S1.3 venue, address, town, area, coordinates, categories, price, age, organizer URL, ticket URL and contributing source names come through');

-- the 2000-row cap
select pg_temp.x('postgres', $$insert into public.events (region_id, slug, title, summary, starts_at, ends_at, time_known, status)
  select (select id from public.regions where slug = 'truckee'), 'le-bulk-' || lpad(n::text, 5, '0') || '-' || substr(md5(n::text), 1, 6), 'LE Bulk ' || n,
         'Fixture summary for the public read cap test.', now() + interval '3 days' + make_interval(secs => n), now() + interval '4 days', true, 'published'
    from generate_series(1, 2001) n$$);
select pg_temp.eq($$(select count(*) from public.events where status = 'published' and merged_into is null and starts_at > now())$$, '2005', 'fixture: more than 2,000 qualifying rows exist');
select is(pg_temp.v('anon', $$(select count(*) from public.list_events())$$), '2000', 'AC-M1-33 with more than 2,000 qualifying rows -> 2,000 rows');

select * from finish();
rollback;
