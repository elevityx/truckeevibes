-- AC-M1-115 ... 118 (Amendment 12): TTUSD sources, the exact-key twin, the all-day publish branch and the public read.
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

create function pg_temp.dt(p_days int) returns text language sql as $$
  select to_char((now() at time zone 'America/Los_Angeles')::date + p_days, 'YYYY-MM-DD') $$;
create temp table tt_items (slug text, k text, item jsonb, primary key (slug, k));
-- a school item. p_venue picks the school venue (name + one-line address); coordinates come from pg_temp.item.
create function pg_temp.ti(p_key text, p_title text, p_day int, p_hh int, p_venue text, p_over jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_day, p_hh, jsonb_build_object('venueName', p_venue,
           'address', case p_venue when 'Truckee Elementary School' then '11911 Donner Pass Rd, Truckee, CA 96161'
                                   when 'North Tahoe High School' then '2945 Polaris Rd, Tahoe City, CA 96145'
                                   when 'Truckee High School' then '11725 Donner Pass Rd, Truckee, CA 96161'
                                   else '11603 Donner Pass Rd, Truckee, CA 96161' end,
           'categoriesHint', jsonb_build_array('schools', 'community'), 'priceKind', 'unknown')) || p_over $$;
create function pg_temp.tad(p_key text, p_title text, p_day int, p_venue text, p_over jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.ti(p_key, p_title, p_day, 0, p_venue, jsonb_build_object('allDay', true, 'timeKnown', false,
           'startDate', pg_temp.dt(p_day), 'endDate', pg_temp.dt(p_day + 1), 'categoriesHint', jsonb_build_array('schools'))) || p_over
         - 'endsAt' $$;
-- the item arrives with the source's whole list so far (a growing list never trips found_drop), then the outbox drains
create function pg_temp.arrive(p_slug text, p_item jsonb) returns void language plpgsql as $$
begin
  insert into tt_items values (p_slug, p_item ->> 'externalKey',
      p_item || jsonb_build_object('url', 'https://' || (select allowed_hosts[1] from public.sources where slug = p_slug) || '/calendar'))
    on conflict (slug, k) do update set item = excluded.item;
  perform pg_temp.rb('arr-' || p_slug || '-' || (p_item ->> 'externalKey'), p_slug, (select jsonb_agg(item order by k) from tt_items where slug = p_slug));
  perform pg_temp.cluster_all();
end $$;
create function pg_temp.n_events(p_title text, p_day int) returns bigint language sql as $$
  select count(*) from public.events where title = p_title and merged_into is null and start_day = ((now() at time zone 'America/Los_Angeles')::date + p_day) $$;
create function pg_temp.ev_n(k text) returns text language sql as $$ select pg_temp.ev_col(k, 'status') $$;

-- AC-M1-115 --------------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from public.sources where slug like 'ttusd-%')$$, '9', 'AC-M1-115 nine TTUSD source rows');
select pg_temp.eq($$(select string_agg(slug || '=' || allowed_hosts[1] || (config ->> 'calendarUrl') || '|' || class::text, ',' order by slug) from public.sources where slug like 'ttusd-%')$$,
  'ttusd-acms=acms.ttusd.orghttps://acms.ttusd.org/calendar|organizer,ttusd-district=www.ttusd.orghttps://www.ttusd.org/parents-students/calendars/calendars2|municipal,ttusd-dte=dte.ttusd.orghttps://dte.ttusd.org/calendar|organizer,ttusd-kbe=kbe.ttusd.orghttps://kbe.ttusd.org/calendar|organizer,ttusd-nths=nths.ttusd.orghttps://nths.ttusd.org/calendar|organizer,ttusd-nts=nts.ttusd.orghttps://nts.ttusd.org/calendar|organizer,ttusd-te=te.ttusd.orghttps://te.ttusd.org/calendar|organizer,ttusd-ths=ths.ttusd.orghttps://ths.ttusd.org/calendar|organizer,ttusd-tle=tle.ttusd.orghttps://tle.ttusd.org/calendar|organizer',
  'AC-M1-115 hosts, calendar URLs and classes match the table');
select pg_temp.eq($$(select count(*) from public.sources where slug like 'ttusd-%' and homepage_url = config ->> 'calendarUrl' and page_cap = 6 and family = 'html_finalsite')$$, '9', 'AC-M1-115 homepage_url is the calendar URL, page_cap 6');
select pg_temp.eq($$(select count(*) from public.sources where slug like 'ttusd-%' and enabled and trust = 'auto' and cadence = '24h' and ingest_disposition = 'permitted'
    and allowed_methods = array['html']::text[] and terms_recheck_at > now() and config ->> 'allowlist' = 'ttusd')$$, '7', 'AC-M1-115 seven enabled auto 24h permitted html sources with future recheck and allowlist ttusd');
select pg_temp.eq($$(select string_agg(slug, ',' order by slug) from public.sources where slug in ('ttusd-kbe', 'ttusd-dte') and not enabled)$$, 'ttusd-dte,ttusd-kbe', 'AC-M1-115 kbe and dte are disabled');
select pg_temp.eq($$(select count(*) from public.sources where enabled)$$, '17', 'AC-M1-115 fifteen sources enabled (A13 adds tahoe-donner, A14 adds three); Kids live: +3 libraries, -tdrpd = seventeen');
select pg_temp.eq($$(select count(*) from public.categories where slug = 'schools')$$, '1', 'AC-M1-115 the schools category exists');
select pg_temp.eq($$(select count(*) from public.categories)$$, '15', 'AC-M1-115 fifteen categories (A13 adds members-only)');
select pg_temp.t($$(select pg_temp.x('postgres', $s$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('ttusd-bogus', 'Bogus Family', 'https://example.test/', array['example.test'], 'html_bogus', 'organizer')$s$)) like 'ERR:23514%'$$,
  'AC-M1-115 family html_bogus fails the CHECK');
select pg_temp.eq($$(select has_function_privilege('service_role', 'private.ttusd_twin(public.source_events)', 'execute'))$$, 'false', 'AC-M1-115 ttusd_twin is not granted');

-- AC-M1-116 twin (r3) -----------------------------------------------------------------------------------------------
-- District 12:00 + TE 14:00 + TE 19:00 stay three events in all six arrival orders (one day per order).
do $$
declare perms int[][] := array[[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]; p int; j int; v_i int; v_slug text; v_it jsonb;
begin
  for p in 1 .. 6 loop
    for j in 1 .. 3 loop
      v_i := perms[p][j];
      v_slug := case v_i when 1 then 'ttusd-district' else 'ttusd-te' end;
      v_it := pg_temp.ti('fm' || p || '-' || v_i, 'Fall Musical', 20 + p, case v_i when 1 then 12 when 2 then 14 else 19 end, 'Truckee Elementary School');
      perform pg_temp.arrive(v_slug, v_it);
    end loop;
  end loop;
end $$;
select pg_temp.eq($$(select string_agg(pg_temp.n_events('Fall Musical', 20 + p)::text, ',' order by p) from generate_series(1, 6) p)$$, '3,3,3,3,3,3',
  'AC-M1-116 district 12:00 + TE 14:00 + TE 19:00 stay three events in every one of the six arrival orders');
-- District "Open House" 17:00 + NTHS "Open House" 17:00 (NTHS venue): one event in both orders; 17:00 vs 17:30: two.
select pg_temp.arrive('ttusd-district', pg_temp.ti('oh1-d', 'Open House', 30, 17, 'North Tahoe High School'));
select pg_temp.arrive('ttusd-nths', pg_temp.ti('oh1-n', 'Open House', 30, 17, 'North Tahoe High School'));
select pg_temp.arrive('ttusd-nths', pg_temp.ti('oh2-n', 'Open House', 31, 17, 'North Tahoe High School'));
select pg_temp.arrive('ttusd-district', pg_temp.ti('oh2-d', 'Open House', 31, 17, 'North Tahoe High School'));
select pg_temp.arrive('ttusd-district', pg_temp.ti('oh3-d', 'Open House', 32, 17, 'North Tahoe High School'));
select pg_temp.arrive('ttusd-nths', pg_temp.ti('oh3-n', 'Open House', 32, 17, 'North Tahoe High School', jsonb_build_object('startsAt', pg_temp.ts(32, 17, 30), 'endsAt', pg_temp.ts(32, 17, 30, 120))));
select pg_temp.eq($$pg_temp.n_events('Open House', 30)$$, '1', 'AC-M1-116 district + NTHS "Open House" at 17:00 (district first) -> one event');
select pg_temp.eq($$pg_temp.n_events('Open House', 31)$$, '1', 'AC-M1-116 ... and in the other arrival order -> one event');
select pg_temp.eq($$pg_temp.n_events('Open House', 32)$$, '2', 'AC-M1-116 17:00 and 17:30 -> two events');
-- all-day twins
select pg_temp.arrive('ttusd-district', pg_temp.tad('pp-d', 'Pumpkin Patch', 35, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-te', pg_temp.tad('pp-t', 'Pumpkin Patch', 35, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-district', pg_temp.tad('pq-d', 'Pumpkin Patch', 36, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-te', pg_temp.ti('pq-t', 'Pumpkin Patch', 36, 9, 'Truckee Elementary School'));
select pg_temp.eq($$pg_temp.n_events('Pumpkin Patch', 35)$$, '1', 'AC-M1-116 district all-day + TE all-day "Pumpkin Patch" on one date -> one event');
select pg_temp.eq($$pg_temp.n_events('Pumpkin Patch', 36)$$, '1', 'AC-M1-116/121 district all-day + TE 09:00 -> one listing (r4)');
select pg_temp.eq($$(select (not all_day)::text || '|' || time_known::text from public.events where title = 'Pumpkin Patch' and start_day = (now() at time zone 'America/Los_Angeles')::date + 36)$$, 'true|true', 'AC-M1-121 ... and it is the timed one');
-- timed first, then all-day (TE 9:00, then district all-day on another day) -> still one, timed wins
select pg_temp.arrive('ttusd-te', pg_temp.ti('pr-t', 'Pumpkin Patch', 37, 9, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-district', pg_temp.tad('pr-d', 'Pumpkin Patch', 37, 'Truckee Elementary School'));
select pg_temp.eq($$pg_temp.n_events('Pumpkin Patch', 37)$$, '1', 'AC-M1-121 timed first, all-day second -> one listing');
select pg_temp.eq($$(select (not all_day)::text from public.events where title = 'Pumpkin Patch' and start_day = (now() at time zone 'America/Los_Angeles')::date + 37)$$, 'true', 'AC-M1-121 ... the timed one');
-- AC-M1-122: 14:00 + 19:00 + 19:00 (district duplicate) -> two listings
select pg_temp.arrive('ttusd-te', pg_temp.ti('mu-1', 'School Musical', 39, 14, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-te', pg_temp.ti('mu-2', 'School Musical', 39, 19, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-district', pg_temp.ti('mu-3', 'School Musical', 39, 19, 'Truckee Elementary School'));
select pg_temp.eq($$pg_temp.n_events('School Musical', 39)$$, '2', 'AC-M1-122 14:00, 19:00 and 19:00 (duplicate) -> two listings');
-- same key at different venues -> two
select pg_temp.arrive('ttusd-district', pg_temp.ti('vx-d', 'Winter Concert', 38, 18, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-ths', pg_temp.ti('vx-t', 'Winter Concert', 38, 18, 'Truckee High School'));
select pg_temp.eq($$pg_temp.n_events('Winter Concert', 38)$$, '2', 'AC-M1-116 a TTUSD pair with an equal key at different venues -> two events');
-- a non-TTUSD pair keeps today's similarity rule
select pg_temp.mk_source('x-a', 'organizer', 'auto');
select pg_temp.mk_source('x-b', 'organizer', 'auto');
select pg_temp.rb('xa', 'x-a', jsonb_build_array(pg_temp.item('xa1', 'Truckee Oktoberfest 2026', 40, 18, '{"venueName":"Cluster Hall"}')));
select pg_temp.rb('xb', 'x-b', jsonb_build_array(jsonb_set(pg_temp.item('xb1', 'Oktoberfest Truckee 2026', 40, 18, '{"venueName":"Cluster Hall"}'), '{startsAt}', to_jsonb(pg_temp.ts(40, 18, 20)))));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('xa1', 'xb1'))$$, '1', 'AC-M1-116 a non-TTUSD pair keeps the similarity rule (20 minutes apart, same venue -> one event)');
-- a TTUSD item does not use the 30-minute window or similarity even against a non-TTUSD event at the same venue
select pg_temp.arrive('ttusd-district', pg_temp.ti('nx-d', 'Oktoberfest Truckee 2026', 40, 18, 'Truckee Elementary School', jsonb_build_object('venueName', 'Cluster Hall', 'address', '10 Main St')));
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('xa1', 'nx-d'))$$, '2', 'AC-M1-116 a TTUSD item never joins a non-TTUSD event by similarity');

-- AC-M1-117 all-day publish ------------------------------------------------------------------------------------------
select pg_temp.arrive('ttusd-district', pg_temp.tad('tb-d', 'Thanksgiving Break', 45, 'Tahoe Truckee Unified School District', '{"categoriesHint":["schools"]}'));
select pg_temp.eq($$pg_temp.ev_n('tb-d')$$, 'published', 'AC-M1-117 district all-day "Thanksgiving Break" at a geocoded office -> published');
select pg_temp.eq($$(select decided_by from public.event_changes where event_id = pg_temp.ev_id('tb-d') and field = 'status' and new_value = '"published"' order by id desc limit 1)$$, 'rule:publish', 'AC-M1-117 ... by rule:publish');
select pg_temp.eq($$pg_temp.open_cards('tb-d')$$, '0', 'AC-M1-117 ... with no open card');
-- a card opened while the source was under review is closed as auto_published once the source is trusted
update public.sources set enabled = true, trust = 'review' where slug = 'ttusd-kbe';
select pg_temp.arrive('ttusd-kbe', pg_temp.tad('kb-1', 'Winter Break', 46, 'Tahoe Truckee Unified School District', '{"categoriesHint":["schools"]}'));
select pg_temp.eq($$pg_temp.ev_n('kb-1')$$, 'pending', 'AC-M1-117 under trust review the same kind of item is pending');
update public.sources set trust = 'auto' where slug = 'ttusd-kbe';
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.ev_n('kb-1')$$, 'published', 'AC-M1-117 after the source becomes auto the all-day item is published');
select pg_temp.eq($$(select string_agg(decision, ',') from public.review_cards where event_id = pg_temp.ev_id('kb-1') and kind = 'event' and status = 'closed')$$, 'auto_published', 'AC-M1-117 ... and its card is closed auto_published');
update public.sources set enabled = false where slug = 'ttusd-kbe';
-- the same from a non-TTUSD auto source stays pending
select pg_temp.rb('xc', 'x-a', (select jsonb_agg(item order by k) from (select 'xa1' as k, pg_temp.item('xa1', 'Truckee Oktoberfest 2026', 40, 18, '{"venueName":"Cluster Hall"}') as item
  union all select 'xad', pg_temp.tad('xad', 'Thanksgiving Break', 50, 'Tahoe Truckee Unified School District', '{"categoriesHint":["community"]}')) q));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.ev_n('xad')$$, 'pending', 'AC-M1-117 an all-day item from a non-TTUSD auto source -> pending');
-- all caps -> pending; no coordinates -> pending
select pg_temp.arrive('ttusd-district', pg_temp.tad('caps', 'THANKSGIVING BREAK', 47, 'Tahoe Truckee Unified School District', '{"categoriesHint":["schools"]}'));
select pg_temp.eq($$pg_temp.ev_n('caps')$$, 'pending', 'AC-M1-117 TTUSD "THANKSGIVING BREAK" (all caps) -> pending');
select pg_temp.arrive('ttusd-district', pg_temp.tad('nolat', 'Spring Break', 48, 'Nowhere Annex', '{"categoriesHint":["schools"],"address":"1 Example Way, Truckee, CA 96161"}') - 'lat' - 'lng');
select pg_temp.eq($$pg_temp.ev_n('nolat')$$, 'pending', 'AC-M1-117 TTUSD all-day with a venue that has no coordinates -> pending');
-- a timed TTUSD item with coordinates + link publishes by the existing path (80)
select pg_temp.arrive('ttusd-te', pg_temp.ti('timed1', 'Fall Concert', 49, 18, 'Truckee Elementary School', '{"categoriesHint":["schools","arts","music"]}'));
select pg_temp.eq($$pg_temp.ev_n('timed1')$$, 'published', 'AC-M1-117 a timed TTUSD item with coordinates and a link -> published');
select pg_temp.eq($$pg_temp.ev_col('timed1', 'confidence')$$, '80', 'AC-M1-117 ... at confidence 80 (40 + 15 + 15 + 10)');

-- Review P2: contributor ordering and lifecycle -----------------------------------------------------------------------
-- (a) all-day only: source priority still decides. TE (organizer, 100) all-day wins over district (municipal, 80) all-day, with or without a non-TTUSD item.
select pg_temp.arrive('ttusd-district', pg_temp.tad('po-d', 'Spring Fair', 52, 'Truckee Elementary School', '{"categoriesHint":["schools"]}'));
select pg_temp.arrive('ttusd-te', pg_temp.tad('po-t', 'Spring Fair', 52, 'Truckee Elementary School', '{"categoriesHint":["schools"]}'));
select pg_temp.eq($$(select (select url from public.source_events where external_key = 'po-t') = organizer_url from public.events where id = pg_temp.ev_id('po-t'))$$, 'true',
  'review P2: in an all-day-only cluster the organizer school copy still outranks the district copy');
-- (b) a non-TTUSD organizer all-day and a TTUSD all-day at one venue keep source priority (no demotion without a timed TTUSD item)
select pg_temp.arrive('ttusd-te', pg_temp.tad('pn2', 'Autumn Fair', 53, 'Truckee Elementary School', '{"categoriesHint":["schools"]}'));
select pg_temp.mk_source('x-dmo', 'dmo', 'review');
select pg_temp.rb('pn', 'x-dmo', jsonb_build_array(pg_temp.tad('pn1', 'Autumn Fair', 53, 'Truckee Elementary School', '{"categoriesHint":["community"],"url":"https://example.test/e/pn1"}')));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(distinct cluster_id) from public.source_events where external_key in ('pn1', 'pn2'))$$, '1', 'review P2: fixture, the non-TTUSD copy joined the school event by the unchanged rule');
select pg_temp.eq($$(select e.organizer_url from public.events e where e.id = pg_temp.ev_id('pn2'))$$, 'https://te.ttusd.org/calendar', 'review P2: a TTUSD organizer all-day copy keeps source authority over a lower-priority non-TTUSD copy');
-- (c) removing a timed occurrence does not resurrect the all-day copy next to a sibling timed listing
select pg_temp.arrive('ttusd-district', pg_temp.tad('lc-a', 'Spring Musical', 55, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-te', pg_temp.ti('lc-1', 'Spring Musical', 55, 14, 'Truckee Elementary School'));
select pg_temp.arrive('ttusd-te', pg_temp.ti('lc-2', 'Spring Musical', 55, 19, 'Truckee Elementary School'));
select pg_temp.eq($$(select count(*) from public.events where title = 'Spring Musical' and status = 'published' and merged_into is null)$$, '2', 'review P2: all-day + 14:00 + 19:00 -> two published listings');
update public.source_events set source_status = 'gone', needs_cluster = true where external_key = 'lc-1';
select private.recompute_event(cluster_id) from public.source_events where external_key = 'lc-1';
select pg_temp.cluster_all();
select pg_temp.eq($$(select string_agg(to_char(starts_at at time zone 'America/Los_Angeles', 'HH24:MI') || case when all_day then 'A' else '' end, ',' order by starts_at)
   from public.events where title = 'Spring Musical' and status = 'published' and merged_into is null)$$, '19:00', 'review P2: after 14:00 goes away only the 19:00 listing remains (no resurrected all-day)');
update public.source_events set source_status = 'live', needs_cluster = true where external_key = 'lc-1';
select pg_temp.cluster_all();
select pg_temp.eq($$(select string_agg(to_char(starts_at at time zone 'America/Los_Angeles', 'HH24:MI'), ',' order by starts_at)
   from public.events where title = 'Spring Musical' and status = 'published' and merged_into is null)$$, '14:00,19:00', 'review P2: when 14:00 returns both timed listings are back, still no all-day');

-- AC-M1-118 public read -------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from public.list_events() where title = 'Thanksgiving Break' and all_day and categories = array['schools'])$$, '1', 'AC-M1-118 a published TTUSD notice is in list_events with all_day true and categories {schools}');
select is(pg_temp.q($$(select count(*) from public.list_events() where 'schools' = any (categories))$$),
  pg_temp.q($$(select count(*) from public.events e join public.event_categories c on c.event_id = e.id where c.category = 'schools' and e.status = 'published' and e.merged_into is null)$$),
  'AC-M1-118 school items are readable through list_events');
select pg_temp.eq($$(select count(*) from public.list_events() l where l.id = pg_temp.ev_id('xa1') and not ('schools' = any (l.categories)))$$, '1', 'AC-M1-118 a non-school (Chamber-style) event is listed without the schools category');

select * from finish();
rollback;
