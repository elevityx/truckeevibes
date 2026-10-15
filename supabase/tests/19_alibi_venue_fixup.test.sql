-- AC-M1-82, AC-M1-83 (a-c), AC-M1-85 (a-d): Alibi venue fix-up (A8-2) and the non-place guard in clean_source_item (A8.1-3).
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

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-83 (a-c): the fresh-reset path. The migration ran with none of these rows; reset succeeding proves a8_state passed.
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from public.venues where btrim(name) ~* '^https?://' or btrim(name) !~ '[[:alpha:]]')$$, '0',
  'AC-M1-83a fresh reset: no venue is named like a URL or without a letter');
select pg_temp.t($$to_regprocedure('private.is_non_place(text)') is not null$$, 'AC-M1-83a private.is_non_place exists');
select pg_temp.t($$to_regprocedure('private.venue_admin_fix(text,text,text,double precision,double precision)') is not null$$, 'AC-M1-83a private.venue_admin_fix exists');
select pg_temp.t($$to_regprocedure('private.drop_non_place_venues()') is not null$$, 'AC-M1-83a private.drop_non_place_venues exists');
select pg_temp.t($$to_regprocedure('private.a8_alibi_venue_fixup()') is not null$$, 'AC-M1-83a private.a8_alibi_venue_fixup exists');
select pg_temp.eq(format($$has_function_privilege(%L, to_regprocedure(%L), 'execute')$$, r.role, f.fn), 'false',
  'AC-M1-83a / AC-M1-85d ' || r.role || ' cannot execute ' || f.fn)
  from (values ('private.is_non_place(text)'), ('private.venue_admin_fix(text,text,text,double precision,double precision)'),
               ('private.drop_non_place_venues()'), ('private.a8_alibi_venue_fixup()'),
               ('private.clean_source_item(public.sources,jsonb)')) f(fn)
  cross join (values ('anon'), ('authenticated'), ('service_role')) r(role);

create temp table fresh_before as
  select (select count(*) from public.venues) as venues, (select count(*) from public.source_events where needs_cluster) as queued,
         pg_temp.snap('public.venues') as vsnap, pg_temp.snap('public.source_events') as sesnap, pg_temp.snap('public.events') as esnap;
select pg_temp.t($$private.a8_alibi_venue_fixup() = '{"truckee":0,"incline":0,"dropped":0}'::jsonb$$,
  'AC-M1-83b fresh reset: the fix-up returns {truckee 0, incline 0, dropped 0}');
select pg_temp.t($$(select (select count(*) from public.venues) = f.venues and (select count(*) from public.source_events where needs_cluster) = f.queued
                           and pg_temp.snap('public.venues') = f.vsnap and pg_temp.snap('public.source_events') = f.sesnap
                           and pg_temp.snap('public.events') = f.esnap from fresh_before f)$$,
  'AC-M1-83b ... and changes no venue, source_events or events row');
select pg_temp.t($$(select enabled and not strict_auto from public.sources where slug = 'alibi-truckee')$$,
  'AC-M1-83c alibi-truckee is still enabled with no strict_auto (trust moves to auto in the alibi_auto step)');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-85 (a, c): the guard in clean_source_item and private.is_non_place
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.csi(p_vn text, p_addr text) returns jsonb language plpgsql as $$
begin
  return private.clean_source_item((select s from public.sources s where s.slug = 'alibi-truckee'),
    pg_temp.item('csi1', 'Guard Check Event', 40, 18, jsonb_build_object('url', null, 'venueName', p_vn, 'address', p_addr)));
exception when others then return jsonb_build_object('error', sqlstate || ':' || sqlerrm);
end $$;
select pg_temp.eq($$(pg_temp.csi('https://alibialeworks.com/events/', 'x') ? 'facts')$$, 'true', 'AC-M1-85a a URL venueName is not a reject (the item is kept)');
select pg_temp.eq($$(pg_temp.csi('https://alibialeworks.com/events/', 'x') -> 'facts' ->> 'venue_name')$$, '<null>', 'AC-M1-85a a URL venueName is stored as null');
select pg_temp.eq($$(pg_temp.csi('https://alibialeworks.com/events/', 'x') -> 'facts' ->> 'address')$$, '<null>', 'AC-M1-85a ... and its address as null');
select pg_temp.eq($$(pg_temp.csi(' 2026 ', 'x') -> 'facts' ->> 'venue_name')$$, '<null>', 'AC-M1-85a a letterless venueName '' 2026 '' is stored as null');
select pg_temp.eq($$(pg_temp.csi(' 2026 ', 'x') -> 'facts' ->> 'address')$$, '<null>', 'AC-M1-85a ... with its address');
select pg_temp.eq($$(pg_temp.csi('HTTP://x.example.test', 'x') -> 'facts' ->> 'venue_name')$$, '<null>', 'AC-M1-85a an upper-case HTTP:// venueName is stored as null');
select pg_temp.eq($$(pg_temp.csi('Alibi Ale Works - Truckee Public House', '10069 Bridge St') -> 'facts' ->> 'venue_name')$$, 'Alibi Ale Works - Truckee Public House',
  'AC-M1-85a a real venue name is kept');
select pg_temp.eq($$(pg_temp.csi('Alibi Ale Works - Truckee Public House', '10069 Bridge St') -> 'facts' ->> 'address')$$, '10069 Bridge St', 'AC-M1-85a ... with its address');
select pg_temp.eq($$private.is_non_place(null)$$, 'false', 'AC-M1-85c is_non_place(null) is false');
select pg_temp.eq($$private.is_non_place('')$$, 'true', 'AC-M1-85c is_non_place('''') is true');
select pg_temp.eq($$private.is_non_place('Café 1')$$, 'false', 'AC-M1-85c is_non_place(''Café 1'') is false');
select pg_temp.eq($$private.is_non_place(' https://x.example.test/ ')$$, 'true', 'AC-M1-85c a URL is a non-place');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-82 (A8.1 fixture): venues T, I, U, N, C; events E_T, E_U, E_G, E_N, E_C; source_events with clusters
-- ---------------------------------------------------------------------------------------------------------------------
create temp table fx (label text primary key, id uuid);
create function pg_temp.mk_venue(p_label text, p_name text, p_attempts int default 0) returns void language plpgsql as $$
begin
  insert into public.venues (name, normalized_name, town, geocode_attempts) values (p_name, private.normalize_title(p_name), null, p_attempts);
  insert into fx select p_label, v.id from public.venues v where v.name = p_name;
end $$;
create function pg_temp.mk_event(p_label text, p_slug text, p_title text, p_day int, p_venue text, p_area text) returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into public.events (region_id, slug, title, normalized_title, summary, starts_at, time_known, start_day, venue_id, area, status, origin)
    values (private.region_id(), p_slug, p_title, private.normalize_title(p_title), 'Fixture event for the Alibi fix-up.', pg_temp.tstz(p_day, 18), true,
            (pg_temp.tstz(p_day, 18) at time zone 'America/Los_Angeles')::date, (select id from fx where label = p_venue), p_area, 'pending', 'ingest')
    returning id into v_id;
  insert into fx values (p_label, v_id);
end $$;
create function pg_temp.mk_se(p_key text, p_title text, p_day int, p_venue text, p_status text, p_event text) returns void language plpgsql as $$
begin
  insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, all_day, time_known, start_day,
      venue_id, source_status, cluster_id, needs_cluster)
    values ((select id from public.sources where slug = 'alibi-truckee'), p_key, '{}'::jsonb, md5(p_key), p_title, private.normalize_title(p_title),
            pg_temp.tstz(p_day, 18), false, true, (pg_temp.tstz(p_day, 18) at time zone 'America/Los_Angeles')::date,
            (select id from fx where label = p_venue), p_status, (select id from fx where label = p_event), false);
end $$;

select pg_temp.mk_venue('T', 'Alibi Ale Works - Truckee Public House', 1);
select pg_temp.mk_venue('I', 'Alibi Ale Works - Incline Public House', 1);
select pg_temp.mk_venue('U', 'https://alibialeworks.com/events/');
select pg_temp.mk_venue('N', '2026');
select pg_temp.mk_venue('C', 'Example Hall');
select pg_temp.mk_event('E_T', 'fx-trivia-night-aaaaa1', 'Fixture Trivia Night', 50, 'T', null);
select pg_temp.mk_event('E_U', 'fx-football-watch-aaaaa2', 'Fixture Football Watch', 51, 'U', 'truckee');
select pg_temp.mk_event('E_G', 'fx-gone-watch-aaaaa3', 'Fixture Gone Watch Party', 52, 'U', 'truckee');
select pg_temp.mk_event('E_N', 'fx-year-event-aaaaa4', 'Fixture Yearly Gathering', 53, 'N', 'truckee');
select pg_temp.mk_event('E_C', 'fx-control-hall-aaaaa5', 'Fixture Control Concert', 54, 'C', null);
select pg_temp.mk_se('t1', 'Fixture Trivia Night', 50, 'T', 'live', 'E_T');
select pg_temp.mk_se('t2', 'Fixture Trivia Night', 50, 'T', 'live', 'E_T');
select pg_temp.mk_se('t3', 'Fixture Trivia Night', 50, 'T', 'gone', 'E_T');
select pg_temp.mk_se('i1', 'Fixture Incline Quiz Hour', 55, 'I', 'live', null);
select pg_temp.mk_se('u1', 'Fixture Football Watch', 51, 'U', 'live', 'E_U');
select pg_temp.mk_se('u2', 'Fixture Football Watch', 51, 'U', 'live', 'E_U');
select pg_temp.mk_se('u3', 'Fixture Gone Watch Party', 52, 'U', 'gone', 'E_G');
select pg_temp.mk_se('n1', 'Fixture Yearly Gathering', 53, 'N', 'live', 'E_N');
select pg_temp.mk_se('c1', 'Fixture Control Concert', 54, 'C', 'live', 'E_C');
create temp table snap_ev as select id, slug from public.events;
create temp table snap_se as select id, cluster_id from public.source_events;
create temp table snap_c as select * from public.venues where id = (select id from fx where label = 'C');
select pg_temp.t($$(select count(*) = 10 from fx)$$, 'fixture: five venues and five events were created');
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster)$$, '0', 'fixture: no row is queued before the fix-up');

select pg_temp.t($$private.a8_alibi_venue_fixup() = '{"truckee":1,"incline":1,"dropped":2}'::jsonb$$,
  'AC-M1-82 the fix-up returns {truckee 1, incline 1, dropped 2}');

-- (a)
select pg_temp.eq($$(select concat_ws('|', lat, lng, geocoder, verified, town, address, area, outside_region, name, geocode_attempts)
                       from public.venues where id = (select id from fx where label = 'T'))$$,
  '39.3291704|-120.1843897|admin|t|Truckee|10069 Bridge St, Truckee, CA 96161|truckee|f|Alibi Ale Works - Truckee Public House|1',
  'AC-M1-82a Truckee Public House: coordinates, admin geocoder, verified, town, address, area; name and attempts unchanged');
select pg_temp.eq($$(select concat_ws('|', lat, lng, geocoder, verified, town, address, area, outside_region, name, geocode_attempts)
                       from public.venues where id = (select id from fx where label = 'I'))$$,
  '39.249088|-119.9489837|admin|t|Incline Village|931 Tahoe Blvd, Incline Village, NV 89451|incline_crystal_bay|f|Alibi Ale Works - Incline Public House|1',
  'AC-M1-82a Incline Public House: coordinates, admin geocoder, verified, town, address, area; name and attempts unchanged');
select pg_temp.t($$(select bool_and(private.in_local_box(private.region_id(), lat, lng)) from public.venues where id in (select id from fx where label in ('T', 'I')))$$,
  'AC-M1-82a both pubs are inside the local box');

-- (b)
select pg_temp.eq($$(select count(*) from public.venues where id in (select id from fx where label in ('U', 'N')))$$, '0', 'AC-M1-82b the URL venue U and the letterless venue N are gone');
select pg_temp.eq($$(select count(*) from public.source_events where external_key in ('u1', 'u2', 'u3') and venue_id is null)$$, '3', 'AC-M1-82b U''s 3 source_events have no venue');
select pg_temp.eq($$(select count(*) from public.source_events where external_key = 'n1' and venue_id is null)$$, '1', 'AC-M1-82b N''s source_event has no venue');
select pg_temp.eq($$(select count(*) from public.events where id in (select id from fx where label in ('E_U', 'E_G', 'E_N')) and venue_id is null and area is null)$$, '3',
  'AC-M1-82b E_U, E_G and E_N have no venue and no area');
select pg_temp.eq($$(select concat_ws('|', venue_id = (select id from fx where label = 'C'), area is null) from public.events where id = (select id from fx where label = 'E_C'))$$, 't|t',
  'AC-M1-82b E_C is unchanged');
select pg_temp.t($$(select c::text = (select s::text from snap_c s) from public.venues c where c.id = (select id from fx where label = 'C'))$$, 'AC-M1-82c control venue C is unchanged');

-- (c)
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster)$$, '6', 'AC-M1-82c exactly 6 rows are queued');
select pg_temp.eq($$(select string_agg(external_key, ',' order by external_key) from public.source_events where needs_cluster)$$, 'i1,n1,t1,t2,u1,u2',
  'AC-M1-82c ... the live rows of T, I, U and N (T 2, I 1, U 2, N 1)');
select pg_temp.eq($$(select count(*) from public.source_events where external_key in ('t3', 'u3', 'c1') and needs_cluster)$$, '0', 'AC-M1-82c the gone rows and C''s row are not queued');
create temp table queued as select id from public.source_events where needs_cluster;

-- (d) idempotence
update public.source_events set needs_cluster = false;
create temp table idem as select pg_temp.snap('public.venues') vs, pg_temp.snap('public.source_events') ss, pg_temp.snap('public.events') es;
select pg_temp.t($$private.a8_alibi_venue_fixup() = '{"truckee":0,"incline":0,"dropped":0}'::jsonb$$, 'AC-M1-82d second call returns zeros');
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster)$$, '0', 'AC-M1-82d ... and queues nothing');
select pg_temp.t($$(select pg_temp.snap('public.venues') = vs and pg_temp.snap('public.source_events') = ss and pg_temp.snap('public.events') = es from idem)$$,
  'AC-M1-82d ... and changes no venue, source_event or event');
update public.source_events set needs_cluster = true where id in (select id from queued);

-- (e) + (h) drain
select pg_temp.t($$(pg_temp.cluster_all() ->> 'remaining')::int = 0$$, 'AC-M1-82e the drain empties the outbox');
select pg_temp.eq($$(select count(*) from public.source_events se join snap_se s on s.id = se.id where se.cluster_id is distinct from s.cluster_id)$$, '1',
  'AC-M1-82e every cluster_id equals its snapshot except one row');
select pg_temp.t($$(select se.cluster_id is not null from public.source_events se where se.external_key = 'i1')$$, 'AC-M1-82e ... that row is I''s i1, now clustered');
select pg_temp.eq($$(select count(*) from public.events)$$, (select (count(*) + 1)::text from snap_ev), 'AC-M1-82e the event count is the snapshot plus I''s one new event');
select pg_temp.eq($$(select count(*) from public.events e join snap_ev s on s.id = e.id and s.slug = e.slug)$$, (select count(*)::text from snap_ev),
  'AC-M1-82e every snapshot (id, slug) still exists unchanged');
select pg_temp.eq($$(select concat_ws('|', venue_id = (select id from fx where label = 'T'), area) from public.events where id = (select id from fx where label = 'E_T'))$$, 't|truckee',
  'AC-M1-82e E_T has venue T and area truckee');
select pg_temp.eq($$(select count(*) from public.events where id in (select id from fx where label in ('E_U', 'E_N', 'E_G')) and venue_id is null and area is null)$$, '3',
  'AC-M1-82e E_U, E_N and the unqueued E_G keep no venue and no area');
select pg_temp.eq($$(select e.area from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'i1')$$, 'incline_crystal_bay',
  'AC-M1-82e I''s new event has area incline_crystal_bay');
select pg_temp.eq($$(select count(*) from public.events where status <> 'pending')$$, '0', 'AC-M1-82e every event stays pending (trust review)');
select pg_temp.eq($$(select count(*) from public.events where merged_into is not null)$$, '0', 'AC-M1-82h no event is merged');
select pg_temp.eq($$(select count(*) from public.review_cards where kind = 'possible_duplicate')$$, '0', 'AC-M1-82h the drain opened no possible_duplicate card');

-- (i) the cleanup is re-runnable
create temp table idem2 as select pg_temp.snap('public.venues') vs, pg_temp.snap('public.source_events') ss, pg_temp.snap('public.events') es;
select pg_temp.eq($$private.drop_non_place_venues()$$, '0', 'AC-M1-82i drop_non_place_venues() again returns 0');
select pg_temp.t($$(select pg_temp.snap('public.venues') = vs and pg_temp.snap('public.source_events') = ss and pg_temp.snap('public.events') = es from idem2)$$,
  'AC-M1-82i ... and changes no row');

-- (f) ambiguity: a town-null twin next to the town-'Truckee' row
select pg_temp.x('postgres', $q$insert into public.venues (name, normalized_name, town) values ('Alibi Ale Works - Truckee Public House', private.normalize_title('Alibi Ale Works - Truckee Public House'), null)$q$);
select pg_temp.eq($$(select count(*) from public.venues where normalized_name = private.normalize_title('Alibi Ale Works - Truckee Public House'))$$, '2', 'fixture: two Truckee Public House rows');
select pg_temp.t($$pg_temp.err(pg_temp.x('postgres', $q$select private.venue_admin_fix('Alibi Ale Works - Truckee Public House', '10069 Bridge St, Truckee, CA 96161', 'Truckee', 39.3291704, -120.1843897)$q$),
  'P0001', 'venue_fixup_ambiguous')$$, 'AC-M1-82f two candidates fail closed with venue_fixup_ambiguous');
select pg_temp.x('postgres', $q$delete from public.venues where town is null and normalized_name = private.normalize_title('Alibi Ale Works - Truckee Public House')$q$);

-- (g) outside the drive box
create temp table snap_c2 as select * from public.venues where id = (select id from fx where label = 'C');
select pg_temp.t($$pg_temp.err(pg_temp.x('postgres', $q$select private.venue_admin_fix('Example Hall', 'x', 'Reno', 40.0, -119.0)$q$), 'P0001', 'venue_fixup_outside_box')$$,
  'AC-M1-82g coordinates outside the drive box raise venue_fixup_outside_box');
select pg_temp.t($$(select c::text = (select s::text from snap_c2 s) from public.venues c where c.id = (select id from fx where label = 'C'))$$, 'AC-M1-82g ... and the control venue is unchanged');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-85 (b): end to end through svc_ingest_batch
-- ---------------------------------------------------------------------------------------------------------------------
create temp table e2e_before as select count(*) as venues from public.venues;
select pg_temp.rb('g1', 'alibi-truckee', jsonb_build_array(
  pg_temp.item('g1x', 'Guard End To End Event', 41, 18, jsonb_build_object('url', null, 'venueName', 'https://alibialeworks.com/events/', 'address', 'x', 'lat', null, 'lng', null))));
select pg_temp.eq($$pg_temp.r('g1', 'status')$$, 'ok', 'AC-M1-85b svc_ingest_batch accepts the URL-venue item');
select pg_temp.eq($$pg_temp.r('g1', 'new')$$, '1', 'AC-M1-85b ... as a new row');
select pg_temp.t($$(select count(*) = (select b.venues from e2e_before b) from public.venues)$$, 'AC-M1-85b no venue is created');
select pg_temp.eq($$(select concat_ws('|', venue_id is null, facts ->> 'venue_name' is null) from public.source_events where external_key = 'g1x')$$, 't|t',
  'AC-M1-85b the stored source_events row has venue_id null and venue_name null');

select * from finish();
rollback;
