-- AC-W1-01 ... 17b: public.api_events_v1 (events API v1), the Lights mirror read model, lights_pairs and shown_on_lights.
-- Clock: no fixed calendar date is compared with now(). Window cases are relative to now(); DST / new-year cases use the next
-- future fall-back Sunday and Jan 1; season cases use the next future day inside a Lights window (pg_temp.sday()).
-- lights_pairs boundary cases (AC-W1-12/13) do not depend on now(), so they use fixed 2030 dates.
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

-- isolation: any pre-existing event is hidden inside this (rolled back) transaction
update public.events set status = 'hidden' where status <> 'hidden';

-- ---------------------------------------------------------------------------------------------------------------------
-- W1 helpers
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
-- Pacific wall time on a date -> timestamptz
create function pg_temp.at(p_d date, p_hh int, p_mm int default 0) returns timestamptz language sql as $$
  select (p_d + make_time(p_hh, p_mm, 0)) at time zone 'America/Los_Angeles' $$;
create function pg_temp.z(p_t timestamptz) returns text language sql as $$
  select to_char(p_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
-- the first Sunday of November after today (Pacific), the next Jan 1 after today
create function pg_temp.next_fallback() returns date language sql as $$
  select d::date from generate_series(pg_temp.today() + 1, pg_temp.today() + 400, interval '1 day') d
   where extract(month from d) = 11 and extract(isodow from d) = 7 and extract(day from d) <= 7 order by d limit 1 $$;
create function pg_temp.next_newyear() returns date language sql as $$
  select make_date(extract(year from pg_temp.today())::int + 1, 1, 1) $$;
-- the first day >= today + 2 inside a Lights window (Halloween Sep 15 - Nov 1, Christmas Nov 15 - Jan 6), its season and year
create function pg_temp.sday() returns date language sql as $$
  select d::date from generate_series(pg_temp.today() + 2, pg_temp.today() + 400, interval '1 day') d
   where (extract(month from d) = 9 and extract(day from d) >= 15) or extract(month from d) = 10
      or (extract(month from d) = 11 and (extract(day from d) <= 1 or extract(day from d) >= 15))
      or extract(month from d) = 12 or (extract(month from d) = 1 and extract(day from d) <= 6)
   order by d limit 1 $$;
create function pg_temp.sseason() returns text language sql as $$
  select case when extract(month from pg_temp.sday()) in (9, 10)
                or (extract(month from pg_temp.sday()) = 11 and extract(day from pg_temp.sday()) <= 1) then 'halloween' else 'christmas' end $$;
create function pg_temp.other_season() returns text language sql as $$
  select case pg_temp.sseason() when 'halloween' then 'christmas' else 'halloween' end $$;
create function pg_temp.syear() returns int language sql as $$
  select extract(year from pg_temp.sday())::int - case when extract(month from pg_temp.sday()) = 1 then 1 else 0 end $$;
create function pg_temp.pair(p_season text, p_year int) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('season', p_season, 'year', p_year)) $$;

create function pg_temp.venue(p_name text, p_lat double precision, p_lng double precision, p_area text,
                              p_town text default 'Truckee', p_address text default '10 Main St') returns uuid language sql as $$
  insert into public.venues (name, normalized_name, address, town, area, lat, lng)
    values (p_name, lower(p_name), p_address, p_town, p_area, p_lat, p_lng) returning id $$;
create function pg_temp.vn(p_name text) returns uuid language sql as $$
  select id from public.venues where name = p_name order by created_at limit 1 $$;
-- a published (or other status) timed event at a venue; area defaults to the venue's area
create function pg_temp.ev(p_title text, p_starts timestamptz, p_ends timestamptz default null, p_venue text default 'W1 Hall',
                           p_status text default 'published', p_include text default 'auto', p_tk boolean default true,
                           p_featured boolean default false) returns uuid language sql as $$
  insert into public.events (region_id, title, summary, starts_at, ends_at, time_known, venue_id, area, status, published_at,
                             lights_include, featured, organizer_url)
    select (select r.id from public.regions r where r.slug = 'truckee'), p_title, 'Synthetic summary for ' || p_title,
           p_starts, p_ends, p_tk, v.id, v.area, p_status::public.event_status,
           case when p_status = 'published' then now() - interval '1 day' end, p_include, p_featured, 'https://example.test/w1'
      from (select pg_temp.vn(p_venue) as id, (select area from public.venues where id = pg_temp.vn(p_venue)) as area) v
    returning id $$;
create function pg_temp.eid(p_title text) returns uuid language sql as $$
  select id from public.events where title = p_title order by created_at limit 1 $$;
create function pg_temp.cat(p_event uuid, p_cat text) returns void language sql as $$
  insert into public.event_categories (event_id, category) values (p_event, p_cat);
  update public.events set featured = featured where id = p_event;   -- an event write, as recompute_event does after categories
$$;
create function pg_temp.ls(p_title text) returns text language sql as $$
  select coalesce((select lights_season::text from public.events where title = p_title), '<none>') $$;
create function pg_temp.mirror(p_season text, p_year int, p_title text, p_starts timestamptz, p_lat double precision default 39.328,
                               p_lng double precision default -120.1833, p_removed timestamptz default null,
                               p_desc text default 'A house with lights.', p_adults boolean default false) returns uuid language sql as $$
  insert into private.lights_mirror (lights_id, region_slug, season, year, title, description, venue, address, lat, lng, starts_at,
                                     ends_at, url, adults_only, removed_at)
    values (gen_random_uuid(), 'truckee', p_season, p_year, p_title, p_desc, 'Lights Venue', '1 Lights Way, Truckee', p_lat, p_lng,
            p_starts, p_starts + interval '2 hours', 'https://example.test/lights', p_adults, p_removed)
  returning lights_id $$;
-- api_events_v1(<named args>) as anon -> text (envelope or ERR:...)
create function pg_temp.av(p_args text) returns text language sql as $$
  select pg_temp.v('anon', 'public.api_events_v1(' || p_args || ')') $$;
create function pg_temp.api(p_args text) returns jsonb language sql as $$ select pg_temp.jb(pg_temp.av(p_args)) $$;
create function pg_temp.has(p_env jsonb, p_id uuid) returns boolean language sql as $$
  select coalesce(exists (select 1 from jsonb_array_elements(p_env -> 'events') x where x ->> 'id' = p_id::text), false) $$;
create function pg_temp.row_of(p_env jsonb, p_id uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_env -> 'events') x where x ->> 'id' = p_id::text limit 1 $$;
create function pg_temp.keys(p_obj jsonb) returns text language sql as $$
  select coalesce(string_agg(k, ',' order by k), '<none>') from jsonb_object_keys(p_obj) k $$;
-- the error detail of an api call ('<detail>' when SQLSTATE 22023 invalid_input, else the raw text)
create function pg_temp.bad(p_args text) returns text language plpgsql as $$
declare r text := pg_temp.av(p_args);
begin
  if r like 'ERR:22023|invalid_input|%' then return split_part(r, '|', 3); end if;
  return 'NOT REFUSED: ' || left(r, 120);
end $$;
create function pg_temp.vibes(p_extra text default '') returns text language sql as $$
  select $q$p_scope => 'vibes', p_areas => array['truckee'], p_limit => 500$q$ || p_extra $$;
create function pg_temp.lights(p_season text, p_year int, p_extra text default '') returns text language sql as $$
  select format('p_scope => ''lights'', p_season => %L, p_year => %s', p_season, p_year) || p_extra $$;
create function pg_temp.lights_s(p_season text default null) returns text language sql as $$
  select pg_temp.lights(coalesce(p_season, pg_temp.sseason()), pg_temp.syear(),
                        format(', p_from => %L::date, p_to => %L::date', pg_temp.sday(), pg_temp.sday())) $$;

select pg_temp.venue('W1 Hall', 39.328, -120.1833, 'truckee');
select pg_temp.venue('W1 Barn', 39.3300, -120.1700, 'truckee', 'Truckee', null);
select pg_temp.venue('W1 Reno', 39.5300, -119.8100, 'reno_carson', 'Reno');
select pg_temp.venue('W1 Far', 38.5000, -121.5000, null, 'Sacramento');
select pg_temp.venue('W1 Incline', 39.2500, -119.9500, 'incline_crystal_bay', 'Incline Village');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-01 ... 06: the date predicate (eff_end + 1 h > lo AND starts_at < hi)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ev('W1 Now Running', now() - interval '2 hours', now() + interval '2 hours');
select pg_temp.ev('W1 Ended 61', now() - interval '5 hours', now() - interval '61 minutes');
select pg_temp.ev('W1 Ended 59', now() - interval '5 hours', now() - interval '59 minutes');
select pg_temp.ev('W1 Multi Day', now() - interval '2 days', now() + interval '2 days');
select pg_temp.ev('W1 Null End 359', now() - interval '3 hours 59 minutes');
select pg_temp.ev('W1 Null End 401', now() - interval '4 hours 1 minute');
select pg_temp.ev('W1 Yesterday', pg_temp.at(pg_temp.today() - 1, 10), pg_temp.at(pg_temp.today() - 1, 12));
select pg_temp.ev('W1 In 119 Days', now() + interval '119 days');
select pg_temp.ev('W1 In 121 Days', now() + interval '121 days');
insert into public.events (region_id, title, summary, starts_at, all_day, start_date, end_date, time_known, venue_id, area, status, published_at)
  select r.id, t.title, 'Synthetic all-day summary', pg_temp.at(t.sd, 0), true, t.sd, t.ed, false, pg_temp.vn('W1 Hall'), 'truckee', 'published', now() - interval '1 day'
    from public.regions r, (values ('W1 AllDay Ends Today', pg_temp.today() - 1, pg_temp.today()),
                                   ('W1 AllDay Ends Tomorrow', pg_temp.today(), pg_temp.today() + 1)) t(title, sd, ed)
   where r.slug = 'truckee';
select pg_temp.ev('W1 Fallback Late', pg_temp.at(pg_temp.next_fallback(), 23, 30));
select pg_temp.ev('W1 Fallback Next', pg_temp.at(pg_temp.next_fallback() + 1, 0, 0));
select pg_temp.ev('W1 NYE Night', pg_temp.at(pg_temp.next_newyear() - 1, 22, 0));
select pg_temp.ev('W1 New Year Morning', pg_temp.at(pg_temp.next_newyear(), 10, 0));

create temp table env_now as select pg_temp.api(pg_temp.vibes()) as j;
select ok((select j from env_now) is not null, 'api_events_v1 (vibes, default window) returns an envelope as anon');
select ok(pg_temp.has((select j from env_now), pg_temp.eid('W1 Now Running')), 'AC-W1-01 an event in progress (started 2 h ago, ends in 2 h) is returned');
select ok(not pg_temp.has((select j from env_now), pg_temp.eid('W1 Ended 61')), 'AC-W1-01 an event that ended 61 min ago is not returned');
select ok(pg_temp.has((select j from env_now), pg_temp.eid('W1 Ended 59')), 'AC-W1-01 an event that ended 59 min ago is returned');
select ok(pg_temp.has(pg_temp.api(pg_temp.vibes(format(', p_from => %L::date', pg_temp.today()))), pg_temp.eid('W1 Multi Day')),
  'AC-W1-02 a multi-day event started 2 days ago, ending in 2 days, is returned with from = today');
select ok(pg_temp.has((select j from env_now), pg_temp.eid('W1 Null End 359')), 'AC-W1-03 null ends_at, started 3 h 59 min ago: returned (starts + 3 h + 1 h)');
select ok(not pg_temp.has((select j from env_now), pg_temp.eid('W1 Null End 401')), 'AC-W1-03 null ends_at, started 4 h 1 min ago: not returned');
select is(pg_temp.has((select j from env_now), pg_temp.eid('W1 AllDay Ends Today')),
          ((now() at time zone 'America/Los_Angeles')::time < time '01:00'),
  'AC-W1-04 all-day event with end_date = today (exclusive) is returned only before 01:00 Pacific today');
select ok(pg_temp.has((select j from env_now), pg_temp.eid('W1 AllDay Ends Tomorrow')), 'AC-W1-04 all-day event with end_date = tomorrow is returned');
select is(pg_temp.row_of((select j from env_now), pg_temp.eid('W1 AllDay Ends Tomorrow')) ->> 'endsAt', pg_temp.z(pg_temp.at(pg_temp.today() + 1, 0)),
  'AC-W1-04 its endsAt = tomorrow 00:00 Pacific in Z');
select is(pg_temp.row_of((select j from env_now), pg_temp.eid('W1 AllDay Ends Tomorrow')) ->> 'allDay', 'true', 'AC-W1-04 allDay is true');

create temp table env_fb as select pg_temp.api(pg_temp.vibes(format(', p_from => %L::date, p_to => %L::date', pg_temp.next_fallback(), pg_temp.next_fallback()))) as j;
select ok(pg_temp.has((select j from env_fb), pg_temp.eid('W1 Fallback Late')), 'AC-W1-05 to = fall-back Sunday includes 23:30 Pacific (after the repeated hour)');
select ok(not pg_temp.has((select j from env_fb), pg_temp.eid('W1 Fallback Next')), 'AC-W1-05 ... and excludes the next day 00:00 Pacific');
create temp table env_ny as select pg_temp.api(pg_temp.vibes(format(', p_from => %L::date, p_to => %L::date', pg_temp.next_newyear() - 1, pg_temp.next_newyear()))) as j;
select ok(pg_temp.has((select j from env_ny), pg_temp.eid('W1 NYE Night')) and pg_temp.has((select j from env_ny), pg_temp.eid('W1 New Year Morning')),
  'AC-W1-05 from = Dec 31, to = Jan 1 returns the Dec 31 22:00 and the Jan 1 10:00 events');

create temp table env_past as select pg_temp.api(pg_temp.vibes(format(', p_from => %L::date', pg_temp.today() - 3))) as j;
select ok((select j from env_past) is not null and not pg_temp.has((select j from env_past), pg_temp.eid('W1 Yesterday')),
  'AC-W1-06 from earlier than today behaves as now(): an event that ended yesterday is not returned');
create temp table env_far as select pg_temp.api(pg_temp.vibes(format(', p_to => %L::date', pg_temp.today() + 200))) as j;
select ok(pg_temp.has((select j from env_far), pg_temp.eid('W1 In 119 Days')), 'AC-W1-06 an event 119 days out is inside the clamped window');
select ok((select j from env_far) is not null and not pg_temp.has((select j from env_far), pg_temp.eid('W1 In 121 Days')),
  'AC-W1-06 hi - lo is clamped to 120 days (an event 121 days out is not returned even with to = today + 200)');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-07 / 17b: bounds, all in SQL, NULL-safe (22023 invalid_input, detail = the param name)
-- ---------------------------------------------------------------------------------------------------------------------
select is(pg_temp.bad($$p_limit => 0$$), 'limit', 'AC-W1-07 p_limit 0 -> limit');
select is(pg_temp.bad($$p_limit => 501$$), 'limit', 'AC-W1-07 p_limit 501 -> limit');
select is(pg_temp.bad($$p_areas => array['truckee','donner_lake','truckee','truckee','truckee','truckee','truckee','truckee','truckee','truckee','truckee']$$), 'area', 'AC-W1-07 11 areas -> area');
select is(pg_temp.bad($$p_areas => array['atlantis']$$), 'area', 'AC-W1-07 unknown area slug -> area');
select is(pg_temp.bad($$p_categories => array['not-a-category']$$), 'category', 'AC-W1-07 unknown category slug -> category');
select is(pg_temp.bad($$p_categories => array['music','music','music','music','music','music','music','music','music','music','music']$$), 'category', 'AC-W1-07 11 categories -> category');
select is(pg_temp.bad(format('p_areas => array[%L]', repeat('a', 65))), 'area', 'AC-W1-07 a 65-char area item -> area');
select is(pg_temp.bad(format('p_categories => array[%L]', repeat('a', 65))), 'category', 'AC-W1-07 a 65-char category item -> category');
select is(pg_temp.bad($$p_cursor => '!!!not base64!!!'$$), 'cursor', 'AC-W1-07 non-base64 cursor -> cursor');
select is(pg_temp.bad(format('p_cursor => %L', rtrim(translate(encode(convert_to('hello|world', 'UTF8'), 'base64'), '+/', '-_'), '='))), 'cursor', 'AC-W1-07 wrong-shape cursor -> cursor');
select is(pg_temp.bad(format('p_cursor => %L', rtrim(translate(encode(convert_to('2026-13-45T99:99:99Z|' || gen_random_uuid()::text, 'UTF8'), 'base64'), E'+/\n', '-_'), '='))), 'cursor', 'AC-W1-07 a cursor with an impossible timestamp -> cursor');
select is(pg_temp.bad(format('p_cursor => %L', repeat('A', 201))), 'cursor', 'AC-W1-07 a 201-char cursor -> cursor');
select is(pg_temp.bad($$p_scope => 'lights'$$), 'season', 'AC-W1-07 scope=lights without season -> season');
select is(pg_temp.bad($$p_scope => 'lights', p_season => 'halloween'$$), 'year', 'AC-W1-07 scope=lights without year -> year');
select is(pg_temp.bad($$p_scope => 'lights', p_season => 'halloween', p_year => 2026, p_areas => array['truckee']$$), 'area', 'AC-W1-07 scope=lights with areas -> area');
select is(pg_temp.bad($$p_scope => 'lights', p_season => 'halloween', p_year => 2026, p_categories => array['music']$$), 'category', 'scope=lights with categories -> category');
select is(pg_temp.bad($$p_scope => 'vibes', p_season => 'halloween'$$), 'season', 'AC-W1-07 scope=vibes with season -> season');
select is(pg_temp.bad($$p_scope => 'vibes', p_year => 2026$$), 'year', 'scope=vibes with year -> year');
select is(pg_temp.bad(format('p_from => %L::date, p_to => %L::date', pg_temp.today() + 5, pg_temp.today() + 4)), 'to', 'AC-W1-07 to < from -> to');
select is(pg_temp.bad($$p_scope => 'everything'$$), 'scope', 'AC-W1-07 unknown scope -> scope');
select is(pg_temp.bad($$p_scope => 'lights', p_season => null, p_year => 2026$$), 'season', 'AC-W1-17b scope=lights, p_season NULL -> 22023 season');
select is(pg_temp.bad($$p_scope => 'lights', p_season => 'halloween', p_year => null$$), 'year', 'AC-W1-17b scope=lights, p_year NULL -> 22023 year');
select is(pg_temp.bad($$p_scope => 'lights', p_season => 'Halloween', p_year => 2026$$), 'season', 'AC-W1-17b p_season = ''Halloween'' -> 22023 season');
select is(pg_temp.bad($$p_scope => 'lights', p_season => 'halloween', p_year => 1999$$), 'year', 'AC-W1-17b p_year = 1999 -> 22023 year');
select is(pg_temp.bad($$p_areas => array[null]::text[]$$), 'area', 'AC-W1-17b p_areas = array[null] -> area');
select is(pg_temp.bad($$p_categories => array[null]::text[]$$), 'category', 'p_categories = array[null] -> category');
select ok(pg_temp.api($$p_categories => '{}'::text[]$$) is not null, 'AC-W1-17b p_categories = ''{}'' passes');
select ok(pg_temp.api($$p_scope => null$$) is not null, 'p_scope NULL -> vibes');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-08: keyset paging over 700 published events (groups of 3 share starts_at, so ties cross page boundaries)
-- ---------------------------------------------------------------------------------------------------------------------
insert into public.events (region_id, title, summary, starts_at, time_known, venue_id, area, status, published_at)
  select r.id, 'W1 Page Event ' || n, 'Synthetic paging summary', date_trunc('minute', now()) + interval '1 hour' * (1 + (n - 1) / 3),
         true, pg_temp.vn('W1 Incline'), 'incline_crystal_bay', 'published', now() - interval '1 day'
    from public.regions r, generate_series(1, 700) n where r.slug = 'truckee';
create temp table pages (n int primary key, j jsonb);
create function pg_temp.page_all() returns int language plpgsql as $$
declare c text := null; i int := 0; j jsonb;
begin
  loop
    i := i + 1;
    j := pg_temp.api($q$p_scope => 'vibes', p_areas => array['incline_crystal_bay'], p_limit => 200$q$
                     || case when c is null then '' else format(', p_cursor => %L', c) end);
    insert into pages values (i, j);
    c := j ->> 'nextCursor';
    exit when c is null or i >= 10;
  end loop;
  return i;
end $$;
select is(pg_temp.page_all(), 4, 'AC-W1-08 700 events at limit 200 -> 4 pages');
select is((select string_agg((j ->> 'count'), ',' order by n) from pages), '200,200,200,100', 'AC-W1-08 page counts 200/200/200/100');
select ok((select j -> 'nextCursor' = 'null'::jsonb from pages where n = 4), 'AC-W1-08 the last page has nextCursor = null');
create temp table paged as
  select row_number() over (order by p.n, x.o) as k, (x.e ->> 'id')::uuid as id
    from pages p, jsonb_array_elements(p.j -> 'events') with ordinality x(e, o);
select is((select count(distinct id)::int from paged), 700, 'AC-W1-08 no duplicate and no gap: 700 distinct ids');
select is((select array_agg(id order by k) from paged),
          (select array_agg(id order by starts_at, id) from public.events where title like 'W1 Page Event %'),
  'AC-W1-08 the concatenated pages equal the (starts_at, id) order, ties included');
select ok((select e1.starts_at = e2.starts_at from paged p1 join public.events e1 on e1.id = p1.id, paged p2 join public.events e2 on e2.id = p2.id
            where p1.k = 200 and p2.k = 201), 'AC-W1-08 rows 200 and 201 share starts_at (a tie across the page boundary)');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-09: key whitelist by keys
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ev('Status of the confidence lights', now() + interval '1 day');
create temp table env_keys as select pg_temp.api(pg_temp.vibes()) as j;
select is(pg_temp.keys((select j from env_keys)), 'count,dataAt,events,mirror,nextCursor,region', 'AC-W1-09 envelope keys are exactly the SQL envelope list');
select is(pg_temp.keys((select j -> 'mirror' from env_keys)), 'confirmedAt,heldCount,heldSince,state', 'AC-W1-09 mirror keys');
select is(pg_temp.keys((select j -> 'region' from env_keys)), 'localBox,tz', 'AC-W1-09 region keys');
select is(pg_temp.keys((select j #> '{region,localBox}' from env_keys)), 'maxLat,maxLng,minLat,minLng', 'AC-W1-09 localBox keys');
select is((select j #>> '{region,tz}' from env_keys), 'America/Los_Angeles', 'region.tz from public.regions');
select is((select array_agg(distinct pg_temp.keys(x)) from env_keys, jsonb_array_elements(j -> 'events') x),
  array['address,adultsOnly,age,allDay,categories,description,endDate,endsAt,formerIds,id,lat,lng,origin,pageUrl,startDate,startsAt,summary,ticketUrl,timeKnown,title,town,url,venue'],
  'AC-W1-09 every vibes row has exactly the schema keys (a title containing status/confidence/lights changes nothing)');
select ok(not exists (select 1 from env_keys, jsonb_array_elements(j -> 'events') x, jsonb_object_keys(x) k
                       where k in ('confidence','field_sources','locked_fields','lights_include','lights_season','lights_override_at',
                                   'status','reject_reason','moderated_by','moderated_at')), 'AC-W1-09 no private key in any row');
select is(pg_temp.row_of((select j from env_keys), pg_temp.eid('Status of the confidence lights')) ->> 'pageUrl',
  'https://truckeevibes.com/e/' || (select slug from public.events where id = pg_temp.eid('Status of the confidence lights')) || '/',
  'pageUrl = https://truckeevibes.com/e/<slug>/ for a published event');
select is(pg_temp.row_of((select j from env_keys), pg_temp.eid('Status of the confidence lights')) ->> 'origin', 'vibes', 'origin = vibes');
select ok(pg_temp.row_of((select j from env_keys), pg_temp.eid('Status of the confidence lights')) -> 'description' = 'null'::jsonb, 'vibes rows carry description = null');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-10: scope=lights returns live mirror rows 1:1 (pair truckee/halloween/2091, rows in the near future)
-- ---------------------------------------------------------------------------------------------------------------------
create temp table m10 (k text primary key, id uuid);
insert into m10 values
  ('l1', pg_temp.mirror('halloween', 2091, 'Lights House Tour', date_trunc('minute', now()) + interval '1 day')),
  ('l2', pg_temp.mirror('halloween', 2091, 'Lights House Tour', date_trunc('minute', now()) + interval '1 day 10 minutes')),
  ('l3', pg_temp.mirror('halloween', 2091, 'Candy Cane Lane', date_trunc('minute', now()) + interval '1 day 2 hours', 39.3, -120.2, null,
                        'A long walk past glowing houses; bring cocoa.', true)),
  ('r1', pg_temp.mirror('halloween', 2091, 'Gone House', date_trunc('minute', now()) + interval '1 day 4 hours', 39.3, -120.2, now() - interval '1 hour'));
create temp table env_l10 as select pg_temp.api(pg_temp.lights('halloween', 2091)) as j;
select is((select (j ->> 'count')::int from env_l10), 3, 'AC-W1-10 exactly the 3 live mirror rows');
select is((select array_agg((x ->> 'id')::uuid order by x ->> 'id') from env_l10, jsonb_array_elements(j -> 'events') x),
          (select array_agg(id order by id::text) from m10 where k like 'l%'), 'AC-W1-10 ids = lights_id of the live rows (the removed row is absent)');
select ok((select bool_and(x ->> 'origin' = 'lights') from env_l10, jsonb_array_elements(j -> 'events') x), 'AC-W1-10 origin = lights');
select is((select x - 'id' from env_l10, jsonb_array_elements(j -> 'events') x where x ->> 'id' = (select id::text from m10 where k = 'l3')),
  jsonb_build_object('origin', 'lights', 'formerIds', '[]'::jsonb, 'pageUrl', null, 'title', 'Candy Cane Lane',
    'description', 'A long walk past glowing houses; bring cocoa.', 'summary', null,
    'startsAt', pg_temp.z(date_trunc('minute', now()) + interval '1 day 2 hours'), 'endsAt', pg_temp.z(date_trunc('minute', now()) + interval '1 day 4 hours'),
    'allDay', false, 'startDate', null, 'endDate', null, 'timeKnown', true, 'venue', 'Lights Venue', 'address', '1 Lights Way, Truckee',
    'town', null, 'lat', 39.3, 'lng', -120.2, 'categories', '[]'::jsonb, 'age', 'unknown', 'adultsOnly', true,
    'url', 'https://example.test/lights', 'ticketUrl', null),
  'AC-W1-10 a lights row carries the mirror fields verbatim (description, adultsOnly) and the fixed lights defaults');
select is((select count(*)::int from env_l10, jsonb_array_elements(j -> 'events') x where x ->> 'title' = 'Lights House Tour'), 2,
  'AC-W1-10 two mirror rows with identical titles at one venue 10 min apart stay two rows');
select is((select array_agg(distinct pg_temp.keys(x)) from env_l10, jsonb_array_elements(j -> 'events') x),
  array['address,adultsOnly,age,allDay,categories,description,endDate,endsAt,formerIds,id,lat,lng,origin,pageUrl,startDate,startsAt,summary,ticketUrl,timeKnown,title,town,url,venue'],
  'AC-W1-09 every lights row has exactly the schema keys');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-11: shown_on_lights authority cases (pair = the next in-window day's season/year; one case per 2-hour slot)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ev('Monster Mash Hotel', pg_temp.at(pg_temp.sday(), 7), null, 'W1 Barn', 'published', 'yes');           -- control
select pg_temp.ev('Pumpkin Patch Alpha', pg_temp.at(pg_temp.sday(), 9), null, 'W1 Hall', 'published', 'yes');          -- (a)
update public.events set lights_override_at = now() where title = 'Pumpkin Patch Alpha';
select pg_temp.mirror(pg_temp.sseason(), pg_temp.syear(), 'Pumpkin Patch Alpha', pg_temp.at(pg_temp.sday(), 9));
select pg_temp.ev('Haunted Maze Bravo', pg_temp.at(pg_temp.sday(), 11), null, 'W1 Hall', 'published', 'yes');          -- (b)
select pg_temp.mirror(pg_temp.sseason(), pg_temp.syear(), 'Haunted Maze Bravo', pg_temp.at(pg_temp.sday(), 11, 10), 39.3281, -120.1834, now() - interval '1 hour');
select pg_temp.ev('Ghost Walk Charlie', pg_temp.at(pg_temp.sday(), 13), null, 'W1 Hall', 'published', 'yes');          -- (c)
update public.events set lights_override_at = now() - interval '1 hour' where title = 'Ghost Walk Charlie';
select pg_temp.mirror(pg_temp.sseason(), pg_temp.syear(), 'Ghost Walk Charlie', pg_temp.at(pg_temp.sday(), 13), 39.328, -120.1833, now() - interval '2 hours');
select pg_temp.ev('Costume Contest Delta', pg_temp.at(pg_temp.sday(), 15), null, 'W1 Hall', 'published', 'yes');       -- (d)
update public.events set lights_override_at = now() - interval '2 hours' where title = 'Costume Contest Delta';
select pg_temp.mirror(pg_temp.sseason(), pg_temp.syear(), 'Costume Contest Delta', pg_temp.at(pg_temp.sday(), 15), 39.328, -120.1833, now() - interval '1 hour');
select pg_temp.ev('Candy Crawl Echo', pg_temp.at(pg_temp.sday(), 17), null, 'W1 Hall', 'published', 'yes');            -- (e)
update public.events set lights_override_at = now() - interval '2 hours' where title = 'Candy Crawl Echo';
create temp table m11 (k text primary key, id uuid);
insert into m11 values ('e', pg_temp.mirror(pg_temp.sseason(), pg_temp.syear(), 'Candy Crawl Echo', pg_temp.at(pg_temp.sday(), 17), 39.328, -120.1833, now() - interval '3 hours'));
select pg_temp.ev('Trunk Treat Foxtrot', pg_temp.at(pg_temp.sday(), 19), null, 'W1 Hall', 'published', 'yes');         -- (f)
update public.events set lights_override_at = now() - interval '1 hour' where title = 'Trunk Treat Foxtrot';
insert into m11 values ('f', pg_temp.mirror(pg_temp.sseason(), pg_temp.syear(), 'Trunk Treat Foxtrot', pg_temp.at(pg_temp.sday(), 19), 39.328, -120.1833, now() - interval '2 hours'));
select pg_temp.ev('Spooky Story Golf', pg_temp.at(pg_temp.sday(), 21), null, 'W1 Hall', 'published', 'no');            -- (g)
update public.events set lights_override_at = now() where title = 'Spooky Story Golf';
select pg_temp.ev('Harvest Fest India', pg_temp.at(pg_temp.sday(), 8), null, 'W1 Hall', 'published', 'yes');          -- (h) survivor
select pg_temp.ev('Harvest Fest Loser', pg_temp.at(pg_temp.sday(), 8), null, 'W1 Hall', 'hidden', 'yes');             -- (h) loser
update public.events set merged_into = pg_temp.eid('Harvest Fest India') where title = 'Harvest Fest Loser';

create temp table env_l11 as select pg_temp.api(pg_temp.lights_s()) as j;
select ok(pg_temp.has((select j from env_l11), pg_temp.eid('Monster Mash Hotel')), 'AC-W1-11 control: an eligible Vibes event with no mirror row is shown');
select is(pg_temp.row_of((select j from env_l11), pg_temp.eid('Monster Mash Hotel')) ->> 'address', 'W1 Barn, Truckee',
  'scope=lights: a Vibes venue with no address falls back to "<name>, <town>"');
select ok(not pg_temp.has((select j from env_l11), pg_temp.eid('Pumpkin Patch Alpha')), 'AC-W1-11 (a) covering a live mirror row -> not shown, even with yes + override');
select ok(not pg_temp.has((select j from env_l11), pg_temp.eid('Haunted Maze Bravo')), 'AC-W1-11 (b) covering a removed row with no override -> not shown (veto)');
select ok(pg_temp.has((select j from env_l11), pg_temp.eid('Ghost Walk Charlie')), 'AC-W1-11 (c) override set after the removal -> shown');
select ok(not pg_temp.has((select j from env_l11), pg_temp.eid('Costume Contest Delta')), 'AC-W1-11 (d) override set before the removal -> not shown');
select ok(pg_temp.has((select j from env_l11), pg_temp.eid('Candy Crawl Echo')), 'AC-W1-11 (e) before the re-removal: override newer than the removal -> shown');
update private.lights_mirror set removed_at = now() - interval '1 hour' where lights_id = (select id from m11 where k = 'e');
select ok(not pg_temp.has(pg_temp.api(pg_temp.lights_s()), pg_temp.eid('Candy Crawl Echo')), 'AC-W1-11 (e) re-removal after the override (new removed_at > override) -> not shown');
select ok(pg_temp.has((select j from env_l11), pg_temp.eid('Trunk Treat Foxtrot')), 'AC-W1-11 (f) before the restore: override after the removal -> shown');
update private.lights_mirror set removed_at = null where lights_id = (select id from m11 where k = 'f');
create temp table env_l11f as select pg_temp.api(pg_temp.lights_s()) as j;
select ok(not pg_temp.has((select j from env_l11f), pg_temp.eid('Trunk Treat Foxtrot')) and pg_temp.has((select j from env_l11f), (select id from m11 where k = 'f')),
  'AC-W1-11 (f) mirror row restored -> the mirror row is back and the Vibes copy is hidden by live dedupe');
select ok(not pg_temp.has((select j from env_l11), pg_temp.eid('Spooky Story Golf')), 'AC-W1-11 (g) lights_include = no + override -> not shown');
select ok(not pg_temp.has((select j from env_l11), pg_temp.eid('Harvest Fest Loser')) and pg_temp.has((select j from env_l11), pg_temp.eid('Harvest Fest India')),
  'AC-W1-11 (h) a merged event never shows; the eligible survivor does');
select ok((select j from env_l11) is not null and not pg_temp.has(pg_temp.api(pg_temp.lights_s(pg_temp.other_season())), pg_temp.eid('Monster Mash Hotel')),
  'AC-W1-11 (i) an event eligible for one season does not show under the other season of the same year');
select ok(pg_temp.has((select j from env_l11), (select lights_id from private.lights_mirror where title = 'Pumpkin Patch Alpha')),
  'AC-W1-11 (a) ... the covering live mirror row itself is returned');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-12: lights_pairs window boundaries (lights_include = yes; Pacific dates; fixed 2030 dates, no now() dependency)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ev('LP Sep 14', pg_temp.at('2030-09-14', 23, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Sep 15', pg_temp.at('2030-09-15', 0, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Nov 01', pg_temp.at('2030-11-01', 23, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Nov 02', pg_temp.at('2030-11-02', 0, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Nov 14', pg_temp.at('2030-11-14', 23, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Nov 15', pg_temp.at('2030-11-15', 0, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Jan 06', pg_temp.at('2031-01-06', 23, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Jan 07', pg_temp.at('2031-01-07', 0, 30), null, 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Dec 31 Span', pg_temp.at('2030-12-31', 22), pg_temp.at('2031-01-01', 2), 'W1 Hall', 'pending', 'yes');
select pg_temp.ev('LP Never', pg_temp.at('2030-10-31', 18), null, 'W1 Hall', 'published', 'no');
select is(pg_temp.ls('LP Sep 14'), '[]', 'AC-W1-12 Sep 14 -> []');
select is(pg_temp.ls('LP Sep 15'), pg_temp.pair('halloween', 2030)::text, 'AC-W1-12 Sep 15 -> halloween');
select is(pg_temp.ls('LP Nov 01'), pg_temp.pair('halloween', 2030)::text, 'AC-W1-12 Nov 1 -> halloween');
select is(pg_temp.ls('LP Nov 02'), '[]', 'AC-W1-12 Nov 2 -> []');
select is(pg_temp.ls('LP Nov 14'), '[]', 'AC-W1-12 Nov 14 -> []');
select is(pg_temp.ls('LP Nov 15'), pg_temp.pair('christmas', 2030)::text, 'AC-W1-12 Nov 15 -> christmas Y');
select is(pg_temp.ls('LP Jan 06'), pg_temp.pair('christmas', 2030)::text, 'AC-W1-12 Jan 6 Y+1 -> christmas Y');
select is(pg_temp.ls('LP Jan 07'), '[]', 'AC-W1-12 Jan 7 -> []');
select is(pg_temp.ls('LP Dec 31 Span'), pg_temp.pair('christmas', 2030)::text, 'AC-W1-12 Dec 31 22:00 -> Jan 1 02:00 -> christmas Y');
select is(pg_temp.ls('LP Never'), '[]', 'AC-W1-12 lights_include = no -> [] always');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-13: lights_pairs auto
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.cat(pg_temp.ev('LA Category', pg_temp.at('2030-10-20', 18)), 'halloween-fall');
select pg_temp.cat(pg_temp.ev('LA Reno', pg_temp.at('2030-10-20', 18), null, 'W1 Reno'), 'halloween-fall');
select pg_temp.ev('Haunted Barn Tour', pg_temp.at('2030-10-21', 18));
select pg_temp.cat(pg_temp.ev('LA Time Unknown', pg_temp.at('2030-10-22', 18), null, 'W1 Hall', 'published', 'auto', false), 'halloween-fall');
select pg_temp.cat(pg_temp.ev('LA Far', pg_temp.at('2030-10-23', 18), null, 'W1 Far'), 'halloween-fall');
select pg_temp.cat(pg_temp.ev('LA Pending', pg_temp.at('2030-10-24', 18), null, 'W1 Hall', 'pending'), 'halloween-fall');
select pg_temp.cat(pg_temp.ev('LA Holiday', pg_temp.at('2030-12-05', 18)), 'holiday');
select pg_temp.ev('LA Plain Music', pg_temp.at('2030-10-25', 18));
select pg_temp.ev('Tree Lighting Night', pg_temp.at('2030-12-06', 18));
select is(pg_temp.ls('LA Category'), pg_temp.pair('halloween', 2030)::text, 'AC-W1-13 category halloween-fall, published, time known, in the drive box -> halloween');
select is(pg_temp.ls('LA Reno'), '[]', 'AC-W1-13 same at a reno_carson venue, not featured -> []');
update public.events set featured = true where title = 'LA Reno';
select is(pg_temp.ls('LA Reno'), pg_temp.pair('halloween', 2030)::text, 'AC-W1-13 ... featured -> halloween');
select is(pg_temp.ls('Haunted Barn Tour'), pg_temp.pair('halloween', 2030)::text, 'AC-W1-13 title "Haunted Barn Tour", no category -> halloween (keyword)');
select is(pg_temp.ls('LA Time Unknown'), '[]', 'AC-W1-13 time_known = false -> []');
select is(pg_temp.ls('LA Far'), '[]', 'AC-W1-13 venue outside the drive box -> []');
select is(pg_temp.ls('LA Pending'), '[]', 'auto + pending -> []');
select is(pg_temp.ls('LA Holiday'), pg_temp.pair('christmas', 2030)::text, 'auto: category holiday -> christmas');
select is(pg_temp.ls('LA Plain Music'), '[]', 'auto: no category and no keyword -> []');
select is(pg_temp.ls('Tree Lighting Night'), pg_temp.pair('christmas', 2030)::text, 'auto: christmas keyword (tree lighting) -> christmas');
select ok(private.lights_keyword_hit('halloween', 'trick or treat street') and not private.lights_keyword_hit('halloween', 'haunting melodies')
          and private.lights_keyword_hit('christmas', 'santa run') and not private.lights_keyword_hit('christmas', 'santana tribute'),
  'lights_keyword_hit matches whole words only');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-13b: publication transition reaches lights_season in the same transaction (trigger events_zz_lights_pairs)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('w1-src', 'organizer', 'review');
select pg_temp.ing('b13', 'w1-src', jsonb_build_array(
  pg_temp.item('k13a', 'Carving Night Kilo', pg_temp.sday() - pg_temp.today(), 18,
               jsonb_build_object('categoriesHint', jsonb_build_array(case pg_temp.sseason() when 'halloween' then 'halloween-fall' else 'holiday' end))),
  pg_temp.item('k13b', 'Lantern Walk Lima', pg_temp.sday() - pg_temp.today(), 20,
               jsonb_build_object('categoriesHint', jsonb_build_array(case pg_temp.sseason() when 'halloween' then 'halloween-fall' else 'holiday' end)))));
select is(pg_temp.status_of('Carving Night Kilo') || '|' || pg_temp.ls('Carving Night Kilo') || '|' || pg_temp.status_of('Lantern Walk Lima') || '|' || pg_temp.ls('Lantern Walk Lima'),
  'pending|[]|pending|[]', 'AC-W1-13b fixture: two pending events (review source) with lights_season = []');
-- (ii) admin_set_event_status as an AAL2 admin
select is(pg_temp.x('admin', format($$select public.admin_set_event_status(%L, 'published', null)$$, pg_temp.eid('Lantern Walk Lima'))), 'OK',
  'AC-W1-13b (ii) admin_set_event_status(published) as an AAL2 admin');
select is(pg_temp.ls('Lantern Walk Lima'), pg_temp.pair(pg_temp.sseason(), pg_temp.syear())::text, 'AC-W1-13b (ii) lights_season holds the pair at once');
select ok(pg_temp.has(pg_temp.api(pg_temp.lights_s()), pg_temp.eid('Lantern Walk Lima')), 'AC-W1-13b (ii) api_events_v1(lights) as anon returns it in the same transaction');
-- (i) private.recompute_event with an auto non-aggregator source
update public.sources set trust = 'auto' where slug = 'w1-src';
select is(pg_temp.q(format('private.recompute_event(%L) is not null', pg_temp.eid('Carving Night Kilo'))), 'true', 'AC-W1-13b (i) recompute_event runs');
select is(pg_temp.status_of('Carving Night Kilo'), 'published', 'AC-W1-13b (i) recompute_event publishes it (auto, confidence >= 70)');
select ok((select confidence >= 70 from public.events where title = 'Carving Night Kilo'), 'AC-W1-13b (i) confidence >= 70');
select is(pg_temp.ls('Carving Night Kilo'), pg_temp.pair(pg_temp.sseason(), pg_temp.syear())::text, 'AC-W1-13b (i) lights_season holds the pair (computed from the row as written)');
select ok(pg_temp.has(pg_temp.api(pg_temp.lights_s()), pg_temp.eid('Carving Night Kilo')), 'AC-W1-13b (i) api_events_v1(lights) returns it without refresh_lights_pairs');
-- reverse: published -> hidden empties lights_season immediately
select is(pg_temp.x('admin', format($$select public.admin_set_event_status(%L, 'hidden', 'test')$$, pg_temp.eid('Lantern Walk Lima'))), 'OK', 'AC-W1-13b hide as admin');
select is(pg_temp.ls('Lantern Walk Lima'), '[]', 'AC-W1-13b published -> hidden empties lights_season at once');
select ok(not pg_temp.has(pg_temp.api(pg_temp.lights_s()), pg_temp.eid('Lantern Walk Lima')), 'AC-W1-13b ... and the API stops returning it');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-14: formerIds (merge chains within 5 hops, sorted)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ev('Chain C', now() + interval '2 days');
select pg_temp.ev('Chain B', now() + interval '2 days', null, 'W1 Hall', 'hidden');
select pg_temp.ev('Chain A', now() + interval '2 days', null, 'W1 Hall', 'hidden');
update public.events set merged_into = pg_temp.eid('Chain C') where title = 'Chain B';
update public.events set merged_into = pg_temp.eid('Chain B') where title = 'Chain A';
select pg_temp.ev('Chain X' || n, now() + interval '3 days', null, 'W1 Hall', case when n = 7 then 'published' else 'hidden' end) from generate_series(1, 7) n;
update public.events e set merged_into = pg_temp.eid('Chain X' || (substr(e.title, 8)::int + 1)) where e.title ~ '^Chain X[1-6]$';
create temp table env_14 as select pg_temp.api(pg_temp.vibes()) as j;
select is(pg_temp.row_of((select j from env_14), pg_temp.eid('Chain C')) -> 'formerIds',
          (select jsonb_agg(id::text order by id::text) from public.events where title in ('Chain A', 'Chain B')),
  'AC-W1-14 A -> B -> C: C has formerIds = [A, B] (sorted)');
select is(pg_temp.row_of((select j from env_14), pg_temp.eid('Chain X7')) -> 'formerIds',
          (select jsonb_agg(id::text order by id::text) from public.events where title in ('Chain X2', 'Chain X3', 'Chain X4', 'Chain X5', 'Chain X6')),
  'AC-W1-14 a 6-hop chain lists only the 5 nearest');
select is(pg_temp.row_of((select j from env_14), pg_temp.eid('Status of the confidence lights')) -> 'formerIds', '[]'::jsonb, 'formerIds = [] for an unmerged event');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-15: the mirror envelope (pair truckee/christmas/2092)
-- ---------------------------------------------------------------------------------------------------------------------
select is((select j -> 'mirror' from (select pg_temp.api(pg_temp.lights('christmas', 2092)) j) x),
  '{"state":"none","confirmedAt":null,"heldSince":null,"heldCount":0}'::jsonb, 'AC-W1-15 no runs -> state none');
insert into private.lights_mirror_runs (region_slug, season, year, status, finished_at) values ('truckee', 'christmas', 2092, 'ok', '2026-10-01 10:00:00+00');
insert into private.lights_mirror_runs (region_slug, season, year, status, finished_at) values ('truckee', 'christmas', 2092, 'aborted', '2026-10-01 11:00:00+00');
select is((select j -> 'mirror' from (select pg_temp.api(pg_temp.lights('christmas', 2092)) j) x),
  '{"state":"confirmed","confirmedAt":"2026-10-01T10:00:00Z","heldSince":null,"heldCount":0}'::jsonb,
  'AC-W1-15 an ok run -> confirmed, confirmedAt = its finished_at (a later aborted run does not renew it)');
insert into private.lights_mirror_runs (region_slug, season, year, status, held, finished_at) values ('truckee', 'christmas', 2092, 'held', 2, '2026-10-01 12:00:00+00');
insert into private.lights_mirror_holds (region_slug, season, year, removal_set, first_obs_at, last_obs_at, observations)
  values ('truckee', 'christmas', 2092, array[gen_random_uuid(), gen_random_uuid()], '2026-10-01 11:45:00+00', '2026-10-01 12:00:00+00', 2);
select is((select j -> 'mirror' from (select pg_temp.api(pg_temp.lights('christmas', 2092)) j) x),
  '{"state":"held","confirmedAt":"2026-10-01T10:00:00Z","heldSince":"2026-10-01T11:45:00Z","heldCount":2}'::jsonb,
  'AC-W1-15 a later held run + hold row -> held, confirmedAt unchanged, heldCount = set size, heldSince = first_obs_at');
select is((select j -> 'mirror' from env_keys), '{"state":"none","confirmedAt":null,"heldSince":null,"heldCount":0}'::jsonb, 'AC-W1-15 scope vibes -> none');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-16: privileges
-- ---------------------------------------------------------------------------------------------------------------------
select ok(pg_temp.v('anon', '(select count(*) from private.lights_mirror)') like 'ERR:42501|%', 'AC-W1-16 anon select on private.lights_mirror -> 42501');
select ok(pg_temp.v('anon', '(select count(*) from private.lights_mirror_runs)') like 'ERR:42501|%', 'AC-W1-16 anon select on private.lights_mirror_runs -> 42501');
select ok(pg_temp.v('anon', '(select count(*) from private.lights_mirror_holds)') like 'ERR:42501|%', 'AC-W1-16 anon select on private.lights_mirror_holds -> 42501');
select ok(pg_temp.v('user', '(select count(*) from private.lights_mirror)') like 'ERR:42501|%',
  'AC-W1-16 authenticated select on private.lights_mirror -> 42501');
select ok(has_function_privilege('anon', 'public.api_events_v1(text, text, integer, date, date, text[], text[], integer, text)', 'EXECUTE'), 'AC-W1-16 anon executes api_events_v1');
select is((select count(*)::int from (values ('anon'), ('authenticated'), ('service_role')) r(role),
             (values ('private.refresh_lights_pairs()'), ('private.shown_on_lights(public.events, text, text, integer, double precision, double precision)'),
                     ('private.lights_pairs(public.events)'), ('private.lights_covers(private.lights_mirror, public.events, double precision, double precision)'),
                     ('private.lights_window(text, integer)'), ('private.lights_keyword_hit(text, text)'), ('private.lights_mirror_box(text)')) f(sig)
            where has_function_privilege(r.role, f.sig, 'EXECUTE')), 0,
  'AC-W1-16 refresh_lights_pairs / shown_on_lights / lights_pairs (and the other helpers) are not executable by anon/authenticated/service_role');
select is(pg_temp.q($$(select prosecdef from pg_proc where oid = 'public.api_events_v1(text, text, integer, date, date, text[], text[], integer, text)'::regprocedure)$$), 'true',
  'api_events_v1 is security definer');
select is(pg_temp.q($$(select provolatile from pg_proc where oid = 'public.api_events_v1(text, text, integer, date, date, text[], text[], integer, text)'::regprocedure)$$), 's',
  'api_events_v1 is stable');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W1-17b: p_limit NULL -> the default, not unbounded (501 mirror rows of pair truckee/halloween/2093)
-- ---------------------------------------------------------------------------------------------------------------------
insert into private.lights_mirror (lights_id, region_slug, season, year, title, description, address, lat, lng, starts_at, adults_only)
  select gen_random_uuid(), 'truckee', 'halloween', 2093, 'Bulk House ' || n, 'Lights.', '1 Bulk Way', 39.33, -120.18,
         now() + interval '1 day' + interval '1 minute' * n, false from generate_series(1, 501) n;
create temp table env_17b as select pg_temp.api(pg_temp.lights('halloween', 2093) || ', p_limit => null') as j;
select is((select (j ->> 'count')::int from env_17b), 500, 'AC-W1-17b p_limit NULL (lights) -> default 500 of 501');
select ok((select j ->> 'nextCursor' is not null from env_17b), 'AC-W1-17b ... with a nextCursor');
select is((select (j ->> 'count')::int from (select pg_temp.api(pg_temp.lights('halloween', 2093) || format(', p_cursor => %L', (select j ->> 'nextCursor' from env_17b))) j) x), 1,
  'the cursor continues to the 501st row');
select is((select (j ->> 'count')::int from (select pg_temp.api($$p_scope => 'vibes', p_areas => array['incline_crystal_bay']$$) j) x), 200, 'p_limit NULL (vibes) -> default 200');

-- ---------------------------------------------------------------------------------------------------------------------
-- refresh_lights_pairs (nightly) and its cron job
-- ---------------------------------------------------------------------------------------------------------------------
update public.events set lights_season = '[]' where title = 'Monster Mash Hotel';
select ok(pg_temp.q('private.refresh_lights_pairs()')::int >= 0, 'refresh_lights_pairs runs');
select ok(pg_temp.ls('Monster Mash Hotel') <> '[]', 'refresh_lights_pairs restores a stale lights_season (the trigger also recomputes on write)');
select is((select schedule from cron.job where jobname = 'tv-lights-pairs'), '50 10 * * *', 'cron tv-lights-pairs at 50 10 * * *');
select is((select b::text from private.lights_mirror_box('truckee') b), '(39.09,39.6,-120.47,-119.6)', 'lights_mirror_box(truckee)');
select is((select count(*)::int from private.lights_mirror_box('reno')), 0, 'lights_mirror_box: any other slug -> no row');

select * from finish();
rollback;
