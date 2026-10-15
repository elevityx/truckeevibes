-- AC-M1-17, 18, 49 (S1.2 clean_source_item, diff/apply, geocode budget and svc_set_venue_geocode).
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

-- AC-M1-17 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('b-clean', 'organizer', 'review', array['example.test', 'sup.example.test']);
select pg_temp.x('postgres', $$insert into public.suppressions (kind, value, reason) values ('host', 'sup.example.test', 'fixture')$$);
select pg_temp.rb('clean', 'b-clean', jsonb_build_array(
  pg_temp.item('c1', 'Good Evening Concert', 5),
  pg_temp.item('c2', 'Live <b>Jazz</b>', 5),
  pg_temp.item('c3', 'Far Future Festival', 121),
  pg_temp.item('c4', 'Wrong Host Gala', 6, 18, jsonb_build_object('url', 'https://other.test/x')),
  pg_temp.item('c5', 'Suppressed Host Show', 7, 18, jsonb_build_object('url', 'https://sup.example.test/x')),
  pg_temp.item('c6', 'Ab', 8),
  pg_temp.item('c7', 'End Before Start', 9, 18, jsonb_build_object('endsAt', pg_temp.ts(9, 16))),
  pg_temp.item('c8', 'Lat Without Lng', 10, 18, jsonb_build_object('lng', null)),
  pg_temp.item('', 'Empty Key Event', 11),
  pg_temp.item('c10', 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo', 12),
  pg_temp.item('c11', 'All Day Street Fair', 13, 0, jsonb_build_object('allDay', true, 'timeKnown', false,
      'startDate', (now() at time zone 'America/Los_Angeles')::date + 13, 'endDate', (now() at time zone 'America/Los_Angeles')::date + 14,
      'startsAt', pg_temp.ts(13, 0), 'endsAt', null))));
select is(pg_temp.r('clean', 'status'), 'ok', 'AC-M1-17 the mixed batch is an ok run');
select pg_temp.eq($$(select items_found || '/' || items_new || '/' || items_invalid || '/' || items_suppressed
                       from public.source_runs where id = (select (res ->> 'run_id')::uuid from tres where label = 'clean'))$$,
  '11/3/7/1', 'AC-M1-17 run row counts: found 11, new 3, invalid 7, suppressed 1');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'b-clean'))$$, '3',
  'AC-M1-17 only the 3 valid items were stored (markup title, 121 days, foreign host, suppressed host, short title, bad end, lone lat, empty key dropped)');
select pg_temp.eq($$(select count(*) from public.source_events where title like '%<%' or title = 'Ab')$$, '0', 'AC-M1-17 no stored title carries markup');
select pg_temp.t($$(select char_length(title) <= 80 and 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo' like title || ' %'
                      from public.source_events where external_key = 'c10')$$, 'AC-M1-17 an over-long title is cut to <= 80 chars at a word boundary');
select pg_temp.t($$(select all_day and start_date = (now() at time zone 'America/Los_Angeles')::date + 13
                           and end_date = (now() at time zone 'America/Los_Angeles')::date + 14
                           and starts_at = (((now() at time zone 'America/Los_Angeles')::date + 13)::timestamp at time zone 'America/Los_Angeles')
                      from public.source_events where external_key = 'c11')$$, 'AC-M1-17 an all-day item stores local-midnight starts_at with exclusive start/end dates');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events e on e.id = v.source_event_id where e.source_id = (select id from public.sources where slug = 'b-clean'))$$, '3',
  'AC-M1-17 each stored occurrence has one version row');

-- AC-M1-18 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('b-idem');
select pg_temp.rb('i1', 'b-idem', jsonb_build_array(pg_temp.item('a', 'Alpha Gathering Night', 20), pg_temp.item('b', 'Bravo Gathering Night', 21), pg_temp.item('c', 'Charlie Gathering Night', 22)));
select is(pg_temp.r('i1', 'new'), '3', 'AC-M1-18 first run: new = 3');
select pg_temp.rb('i2', 'b-idem', jsonb_build_array(pg_temp.item('a', 'Alpha Gathering Night', 20), pg_temp.item('b', 'Bravo Gathering Night', 21), pg_temp.item('c', 'Charlie Gathering Night', 22)));
select is(pg_temp.r('i2', 'new') || '/' || pg_temp.r('i2', 'changed'), '0/0', 'AC-M1-18 the same batch twice: second run new = 0, changed = 0');
select pg_temp.eq($$(select items_new || '/' || items_changed from public.source_runs where id = (select (res ->> 'run_id')::uuid from tres where label = 'i2'))$$, '0/0', 'AC-M1-18 ... recorded on the run row');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events e on e.id = v.source_event_id where e.source_id = (select id from public.sources where slug = 'b-idem'))$$, '3',
  'AC-M1-18 ... and no new source_event_versions');
select pg_temp.rb('i3', 'b-idem', jsonb_build_array(pg_temp.item('a', 'Alpha Gathering Night Returns', 20), pg_temp.item('b', 'Bravo Gathering Night', 21), pg_temp.item('c', 'Charlie Gathering Night', 22)));
select is(pg_temp.r('i3', 'changed') || '/' || pg_temp.r('i3', 'new'), '1/0', 'AC-M1-18 one title changed: changed = 1');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events e on e.id = v.source_event_id where e.source_id = (select id from public.sources where slug = 'b-idem'))$$, '4',
  'AC-M1-18 ... exactly one new version row');
select pg_temp.eq($$(select title from public.source_events where external_key = 'a' and source_id = (select id from public.sources where slug = 'b-idem'))$$, 'Alpha Gathering Night Returns', 'AC-M1-18 ... and the stored title is updated');

select pg_temp.mk_source('b-gone');
select pg_temp.rb('g0', 'b-gone', jsonb_build_array(pg_temp.item('x', 'Xray Harvest Supper', 25), pg_temp.item('y', 'Yankee Harvest Supper', 26)));
create function pg_temp.gone_state() returns text language sql as $$
  select (select source_status || ':' || missing_runs from public.source_events where external_key = 'y' and source_id = (select id from public.sources where slug = 'b-gone')) $$;
select pg_temp.rb('g1', 'b-gone', jsonb_build_array(pg_temp.item('x', 'Xray Harvest Supper', 25)));
select pg_temp.eq('pg_temp.gone_state()', 'live:1', 'AC-M1-18 missing from 1 ok run: live, missing_runs 1');
select pg_temp.rb('g1b', 'b-gone', '[]', jsonb_build_object('status', 'not_modified'));
select pg_temp.eq('pg_temp.gone_state()', 'live:1', 'AC-M1-18 missing from a not_modified run: missing_runs unchanged');
select pg_temp.rb('g1c', 'b-gone', '[]', jsonb_build_object('status', 'http_error', 'http_status', 503, 'error_code', 'http_503'));
select pg_temp.eq('pg_temp.gone_state()', 'live:1', 'AC-M1-18 missing from an http_error run: missing_runs unchanged');
select pg_temp.rb('g2', 'b-gone', jsonb_build_array(pg_temp.item('x', 'Xray Harvest Supper', 25)));
select pg_temp.eq('pg_temp.gone_state()', 'live:2', 'AC-M1-18 missing from 2 ok runs: live, missing_runs 2');
select pg_temp.rb('g3', 'b-gone', jsonb_build_array(pg_temp.item('x', 'Xray Harvest Supper', 25)));
select pg_temp.eq('pg_temp.gone_state()', 'gone:3', 'AC-M1-18 missing from 3 consecutive ok runs: source_status gone');
select is(pg_temp.r('g3', 'gone'), '1', 'AC-M1-18 ... and the run reports gone = 1');
select pg_temp.rb('g4', 'b-gone', jsonb_build_array(pg_temp.item('x', 'Xray Harvest Supper', 25), pg_temp.item('y', 'Yankee Harvest Supper', 26)));
select pg_temp.eq('pg_temp.gone_state()', 'live:0', 'AC-M1-18 an unchanged item that was gone comes back live with missing_runs 0');
select pg_temp.eq($$(select needs_cluster from public.source_events where external_key = 'y' and source_id = (select id from public.sources where slug = 'b-gone'))$$, 'true', 'AC-M1-18 ... and is queued for clustering');

-- AC-M1-49 ---------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('b-geo');
select pg_temp.rb('geo', 'b-geo', (select jsonb_agg(pg_temp.item('v' || n, 'Venue Night ' || substr(md5('geo' || n), 1, 10), 3 + n % 20, 9 + n % 8,
      jsonb_build_object('venueName', 'Venue ' || n, 'address', n || ' Pine St', 'lat', null, 'lng', null))) from generate_series(1, 25) n));
select is(pg_temp.r('geo', 'status'), 'ok', 'AC-M1-49 the 25-venue batch is ok');
select pg_temp.eq($$(select jsonb_array_length(res -> 'geocode') from tres where label = 'geo')$$, '20', 'AC-M1-49 25 un-geocoded venues -> 20 returned for geocoding');
select pg_temp.t($$(select bool_and((e ->> 'venue_id')::uuid in (select id from public.venues where lat is null) and (e ->> 'query') ~ '^Venue [0-9]+, [0-9]+ Pine St, Truckee$')
                      from tres, jsonb_array_elements(res -> 'geocode') e where label = 'geo')$$, 'AC-M1-49 each entry is {venue_id, query: name, address, town}');
select pg_temp.eq($$(select units from public.geocode_usage where month = date_trunc('month', now())::date)$$, '20', 'AC-M1-49 the month''s geocode_usage counts the 20 handed out');
select pg_temp.x('postgres', $$update public.geocode_usage set units = cap where month = date_trunc('month', now())::date$$);
select pg_temp.mk_source('b-geo2');
select pg_temp.rb('geo2', 'b-geo2', (select jsonb_agg(pg_temp.item('w' || n, 'Other Venue Night ' || substr(md5('g2' || n), 1, 10), 40 + n, 12,
      jsonb_build_object('venueName', 'Second Venue ' || n, 'address', n || ' Oak St', 'lat', null, 'lng', null))) from generate_series(1, 3) n));
select pg_temp.eq($$(select jsonb_array_length(res -> 'geocode') from tres where label = 'geo2')$$, '0', 'AC-M1-49 month at cap (300) -> 0 returned');

select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster)$$, '0', 'fixture: the outbox is drained before the geocode cases');
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, 39.3280, -120.1833, 'nominatim')$$, pg_temp.vid('Venue 1')));
select pg_temp.eq($$(select lat::text || '|' || lng::text || '|' || geocode_attempts || '|' || coalesce(geocoder, '') || '|' || coalesce(area, '') || '|' || outside_region from public.venues where id = pg_temp.vid('Venue 1'))$$,
  '39.328|-120.1833|1|nominatim|truckee|false', 'AC-M1-49 valid coords: stored, attempts + 1, geocoder, area_for(lat,lng)');
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster and venue_id = pg_temp.vid('Venue 1'))$$, '1', 'AC-M1-49 valid coords set needs_cluster on that venue''s occurrences');
select pg_temp.eq($$(select count(*) from public.source_events where needs_cluster and venue_id <> pg_temp.vid('Venue 1'))$$, '0', 'AC-M1-49 ... and only that venue''s');
-- AC-M1-49 text says "coords stay null, attempts + 1" for (40.0, -119.0); Amendment 2 (AC-M1-60) refines finite out-of-box coords:
-- outside_region = true and attempts = 3. The amendment wins.
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, 40.0, -119.0, 'nominatim')$$, pg_temp.vid('Venue 2')));
select pg_temp.eq($$(select (lat is null)::text || '|' || (lng is null)::text || '|' || outside_region || '|' || geocode_attempts from public.venues where id = pg_temp.vid('Venue 2'))$$,
  'true|true|true|3', 'AC-M1-49/60 out-of-drive-box coords (40.0, -119.0): coords stay null, outside_region, attempts = 3 (A2)');
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, 'NaN'::float8, -120.1, 'nominatim')$$, pg_temp.vid('Venue 3')));
select pg_temp.eq($$(select (lat is null)::text || '|' || outside_region || '|' || geocode_attempts from public.venues where id = pg_temp.vid('Venue 3'))$$,
  'true|false|1', 'AC-M1-49 non-finite coords: coords null, attempts + 1, outside_region unchanged');
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, null, null, 'nominatim')$$, pg_temp.vid('Venue 4')));
select pg_temp.eq($$(select (lat is null)::text || '|' || outside_region || '|' || geocode_attempts from public.venues where id = pg_temp.vid('Venue 4'))$$,
  'true|false|1', 'AC-M1-49 null result: attempts + 1, outside_region unchanged');

-- AC-M1-68 (A5-6): townless venues are unique --------------------------------------------------------------------------
select is(pg_temp.x('postgres', $$insert into public.venues (name, normalized_name, town) values ('Pop-up Hall', 'pop up hall', null)$$), 'OK', 'AC-M1-68 the first townless venue inserts');
select pg_temp.t($$pg_temp.x('postgres', $e$insert into public.venues (name, normalized_name, town) values ('Pop-up Hall', 'pop up hall', null)$e$) like 'ERR:23505|%'$$,
  'AC-M1-68 a second insert of (pop up hall, null town) -> unique_violation');
select pg_temp.eq($$(select count(*) from public.venues where normalized_name = 'pop up hall' and town is null)$$, '1', 'AC-M1-68 ... leaving exactly one such venue');

select * from finish();
rollback;
