-- AC-W3-01 ... 17 (Spec_Vibes_Widget W3): the Lights mirror write path. svc_issue_mirror_grant, svc_lights_mirror_apply (deletion guard
-- G1/G2/G3 with threshold greatest(2, 0.30 * |L|)), the five admin Lights RPCs, purge. Each call uses a fresh grant.
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
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_admin();
update public.events set status = 'hidden' where status <> 'hidden';   -- isolation (rolled back)

-- ---------------------------------------------------------------------------------------------------------------------
-- W3 helpers. Every scenario uses its own (truckee, <season>, <year>) pair, so pairs never interact; rows start in the
-- future (now() + 3 + n days), so they are live (in L) unless a case says otherwise. now() is fixed inside this transaction,
-- so the G2 span is simulated by moving first_obs_at back, as the spec says (fixture times set by updating first/last_obs_at).
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.lid(p_tag text, p_n int) returns uuid language sql as $$ select md5(p_tag || ':' || p_n)::uuid $$;
create function pg_temp.zts(p_t timestamptz) returns text language sql as $$
  select to_char(p_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') $$;
-- one Lights public row (the shape of GET /rest/v1/events?select=...)
create function pg_temp.lrow(p_tag text, p_n int, p_year int, p_season text default 'halloween', p_over jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('id', pg_temp.lid(p_tag, p_n), 'region_id', '7a1e0000-0000-4000-8000-000000000001', 'season', p_season,
      'year', p_year, 'title', 'Lights ' || p_tag || ' house ' || p_n, 'description', 'A synthetic house with lights for the mirror test.',
      'venue', 'Lights Venue ' || p_n, 'address', p_n || ' Donner Pass Rd, Truckee', 'lat', 39.328, 'lng', -120.1833,
      'starts_at', pg_temp.zts(now() + make_interval(days => 3 + p_n)), 'ends_at', null,
      'url', 'https://example.org/lights/' || p_n, 'adults_only', false) || p_over $$;
-- rows 1..n of a tag, except the listed numbers
create function pg_temp.lrows(p_tag text, p_n int, p_year int, p_except int[] default '{}', p_season text default 'halloween') returns jsonb
language sql as $$
  select coalesce(jsonb_agg(pg_temp.lrow(p_tag, n, p_year, p_season) order by n), '[]'::jsonb)
    from generate_series(1, p_n) n where not (n = any (p_except)) $$;
-- a fresh mirror grant (the source is made due first), as postgres
create function pg_temp.mgrant() returns text language plpgsql as $$
begin
  update public.sources set next_due_at = now() - interval '1 minute' where slug = 'truckee-lights';
  return public.svc_issue_mirror_grant() ->> 'grant';
end $$;
create temp table tres (label text primary key, res jsonb, err text);
-- apply a snapshot as service_role with a fresh grant; the outcome is recorded under a label (never raises)
create function pg_temp.ma(p_label text, p_rows jsonb, p_year int, p_season text default 'halloween', p_run jsonb default '{}',
                           p_grant text default null) returns void language plpgsql as $$
declare v_tok text; v_res jsonb; v_msg text; v_detail text;
begin
  v_tok := coalesce(p_grant, pg_temp.mgrant());
  perform set_config('role', 'service_role', true);
  v_res := public.svc_lights_mirror_apply(v_tok,
    jsonb_build_object('region', 'truckee', 'season', p_season, 'year', p_year, 'status', 'ok',
                       'total', coalesce(jsonb_array_length(case when jsonb_typeof(p_rows) = 'array' then p_rows end), 0)) || p_run, p_rows);
  perform set_config('role', 'postgres', true);
  insert into tres (label, res) values (p_label, v_res) on conflict (label) do update set res = excluded.res, err = null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'postgres', true);
  insert into tres (label, err) values (p_label, 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, ''))
    on conflict (label) do update set err = excluded.err, res = null;
end $$;
create function pg_temp.r(p_label text, p_key text) returns text language sql as $$
  select coalesce((select coalesce(res ->> p_key, err) from tres where label = p_label), '<no result>') $$;
create function pg_temp.rerr(p_label text) returns text language sql as $$
  select coalesce((select err from tres where label = p_label), '<no error>') $$;
-- pair state
create function pg_temp.nlive(p_year int, p_season text default 'halloween') returns int language sql as $$
  select count(*)::int from private.lights_mirror where region_slug = 'truckee' and season = p_season and year = p_year and removed_at is null $$;
create function pg_temp.nremoved(p_year int, p_season text default 'halloween') returns int language sql as $$
  select count(*)::int from private.lights_mirror where region_slug = 'truckee' and season = p_season and year = p_year and removed_at is not null $$;
create function pg_temp.hold(p_year int, p_season text default 'halloween') returns private.lights_mirror_holds language sql as $$
  select h from private.lights_mirror_holds h where region_slug = 'truckee' and season = p_season and year = p_year $$;
create function pg_temp.hasHold(p_year int, p_season text default 'halloween') returns boolean language sql as $$
  select exists (select 1 from private.lights_mirror_holds where region_slug = 'truckee' and season = p_season and year = p_year) $$;
create function pg_temp.hold_obs(p_year int, p_season text default 'halloween') returns int language sql as $$
  select observations from private.lights_mirror_holds where region_slug = 'truckee' and season = p_season and year = p_year $$;
create function pg_temp.hold_set(p_tag text, p_ns int[]) returns uuid[] language sql as $$
  select array(select pg_temp.lid(p_tag, n) from unnest(p_ns) n order by 1) $$;
create function pg_temp.back(p_year int, p_minutes int, p_season text default 'halloween') returns void language sql as $$
  update private.lights_mirror_holds set first_obs_at = now() - make_interval(mins => p_minutes)
   where region_slug = 'truckee' and season = p_season and year = p_year $$;
create function pg_temp.removed_of(p_tag text, p_n int) returns boolean language sql as $$
  select removed_at is not null from private.lights_mirror where lights_id = pg_temp.lid(p_tag, p_n) $$;
create function pg_temp.mapi(p_year int, p_season text default 'halloween') returns jsonb language sql as $$
  select pg_temp.jb(pg_temp.v('anon', format('public.api_events_v1(p_scope => ''lights'', p_season => %L, p_year => %s)', p_season, p_year))) -> 'mirror' $$;
create function pg_temp.nruns(p_year int, p_status text, p_season text default 'halloween') returns int language sql as $$
  select count(*)::int from private.lights_mirror_runs where region_slug = 'truckee' and season = p_season and year = p_year and status = p_status $$;
-- run an expression as an authenticated caller with the given claim shape (03_admin_amr.test.sql); errors -> ERR:<state>
create function pg_temp.as_kind(p_kind text, p_expr text) returns text language plpgsql as $$
declare r text; v_sub text := 'e1500000-0000-4000-a000-000000000001'; v_aal text := 'aal2'; v_anon boolean := false;
        v_amr jsonb := '[{"method":"totp","timestamp":1791564301},{"method":"password","timestamp":1791564300}]';
begin
  if p_kind = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    if p_kind = 'user' then v_sub := 'e1500000-0000-4000-a000-000000000002';
    elsif p_kind = 'aal1' then v_aal := 'aal1';
    elsif p_kind = 'nototp' then v_amr := '[{"method":"password","timestamp":1791564300}]';
    elsif p_kind = 'anonymous' then v_anon := true;
    elsif p_kind <> 'admin' then raise exception 'bad kind %', p_kind;
    end if;
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_sub, 'role', 'authenticated', 'is_anonymous', v_anon,
                                                                'aal', v_aal, 'amr', v_amr)::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate || '|' || sqlerrm;
end $$;
create function pg_temp.adm(p_expr text) returns text language sql as $$ select pg_temp.as_kind('admin', p_expr) $$;

-- Vibes-side fixtures (26_api_events_v1.test.sql shapes)
create function pg_temp.z(p_t timestamptz) returns text language sql as $$
  select to_char(p_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
create function pg_temp.sday() returns date language sql as $$
  select d::date from generate_series(pg_temp.today() + 2, pg_temp.today() + 400, interval '1 day') d
   where (extract(month from d) = 9 and extract(day from d) >= 15) or extract(month from d) = 10
      or (extract(month from d) = 11 and (extract(day from d) <= 1 or extract(day from d) >= 15))
      or extract(month from d) = 12 or (extract(month from d) = 1 and extract(day from d) <= 6)
   order by d limit 1 $$;
create function pg_temp.sseason() returns text language sql as $$
  select case when extract(month from pg_temp.sday()) in (9, 10)
                or (extract(month from pg_temp.sday()) = 11 and extract(day from pg_temp.sday()) <= 1) then 'halloween' else 'christmas' end $$;
create function pg_temp.syear() returns int language sql as $$
  select extract(year from pg_temp.sday())::int - case when extract(month from pg_temp.sday()) = 1 then 1 else 0 end $$;
create function pg_temp.venue(p_name text, p_lat double precision, p_lng double precision, p_area text) returns uuid language sql as $$
  insert into public.venues (name, normalized_name, address, town, area, lat, lng)
    values (p_name, lower(p_name), '10 Main St', 'Truckee', p_area, p_lat, p_lng) returning id $$;
create function pg_temp.ev(p_title text, p_starts timestamptz, p_venue uuid) returns uuid language sql as $$
  insert into public.events (region_id, title, summary, starts_at, ends_at, time_known, venue_id, area, status, published_at,
                             lights_include, organizer_url)
    select r.id, p_title, 'Synthetic summary for ' || p_title, p_starts, p_starts + interval '2 hours', true, p_venue, 'truckee',
           'published', now() - interval '1 day', 'auto', 'https://example.test/w3'
      from public.regions r where r.slug = 'truckee'
    returning id $$;
create function pg_temp.lev(p_season text, p_year int, p_id uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(pg_temp.jb(pg_temp.adm(format('public.admin_lights_events(%L, %s)', p_season, p_year)))) x
   where x ->> 'id' = p_id::text $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- W3.1 step 1: the source row
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.t($$(select count(*) = 1 from public.sources where slug = 'truckee-lights' and name = 'Truckee Lights'
   and homepage_url = 'https://truckeelights.com/' and allowed_hosts = array['supabase.co'] and family = 'lights_mirror'
   and class = 'organizer' and trust = 'review' and enabled and cadence = '6h' and ingest_disposition = 'permitted'
   and allowed_methods = array['api'] and terms_url = 'https://truckeelights.com/about/' and terms_reviewed_by = 'owner'
   and terms_recheck_at > now() + interval '11 months')$$, 'W3.1 the truckee-lights source row (SD1)');
select pg_temp.t($$(select pg_get_constraintdef(c.oid) like '%lights_mirror%' from pg_constraint c
   where c.conrelid = 'public.sources'::regclass and c.conname = 'sources_family_check')$$, 'W3.1 sources.family accepts lights_mirror');
select pg_temp.t($$(select count(*) = 1 from cron.job where jobname = 'tv-lights-mirror-purge' and schedule = '40 10 * * *')$$,
  'W3.1 step 10 cron tv-lights-mirror-purge at 40 10 * * *');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-13 grants
-- ---------------------------------------------------------------------------------------------------------------------
create temp table g13 (k text primary key, v text);
insert into g13 values ('tok', pg_temp.mgrant());
select ok((select v from g13 where k = 'tok') ~ '^[0-9a-f]{64}$', 'AC-W3-13 svc_issue_mirror_grant issues a grant when due');
select pg_temp.t($$(select (public.svc_issue_mirror_grant() -> 'grant') = 'null'::jsonb)$$, 'AC-W3-13 a second call within 10 min returns a null grant');
select pg_temp.t($$(select next_due_at between now() + interval '9 minutes' and now() + interval '11 minutes' from public.sources where slug = 'truckee-lights')$$,
  'AC-W3-13 the grant sets next_due_at = now() + 10 minutes');
update public.sources set next_due_at = now() - interval '1 minute' where slug = 'truckee-lights';
select pg_temp.eq($$(select string_agg(k, ',' order by k) from jsonb_object_keys(public.svc_issue_mirror_grant() -> 'source') k)$$,
  'allowed_hosts,allowed_methods,etag,ingest_disposition,last_modified,page_cap,slug,terms_recheck_at',
  'W3.1 step 3 the grant carries the full PoliteSource field set');
select pg_temp.ma('13a', pg_temp.lrows('g13', 2, 2041), 2041, 'halloween', '{}', (select v from g13 where k = 'tok'));
select is(pg_temp.r('13a', 'status'), 'ok', 'AC-W3-13 a fresh grant applies');
select pg_temp.ma('13b', pg_temp.lrows('g13', 2, 2041), 2041, 'halloween', '{}', (select v from g13 where k = 'tok'));
select ok(pg_temp.err(pg_temp.rerr('13b'), 'P0001', 'grant_used'), 'AC-W3-13 a used grant -> P0001 grant_used');
insert into g13 values ('exp', pg_temp.mgrant());
update private.ingest_grants set expires_at = now() - interval '1 second'
 where token_hash = extensions.digest((select v from g13 where k = 'exp'), 'sha256');
select pg_temp.ma('13c', pg_temp.lrows('g13', 2, 2041), 2041, 'halloween', '{}', (select v from g13 where k = 'exp'));
select ok(pg_temp.err(pg_temp.rerr('13c'), 'P0001', 'grant_expired'), 'AC-W3-13 an expired grant -> P0001 grant_expired');
select pg_temp.ma('13d', pg_temp.lrows('g13', 2, 2041), 2041, 'halloween', '{}', repeat('0', 64));
select ok(pg_temp.err(pg_temp.rerr('13d'), 'P0001', 'grant_invalid'), 'AC-W3-13 an unknown grant -> P0001 grant_invalid');
select pg_temp.mk_source('w3-other-src');
update public.sources set next_due_at = now() + interval '1 day' where slug <> 'w3-other-src' and next_due_at <= now();
update public.sources set next_due_at = now() where slug = 'w3-other-src';
insert into g13 select 'other', g ->> 'grant' from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'w3-other-src';
select pg_temp.ma('13e', pg_temp.lrows('g13', 2, 2041), 2041, 'halloween', '{}', (select v from g13 where k = 'other'));
select ok(pg_temp.err(pg_temp.rerr('13e'), '42501', 'forbidden'), 'AC-W3-13 / AC-W3-26 a normal ingest grant (another source) -> 42501 forbidden (Amendment W3-1)');
update public.sources set next_due_at = now() - interval '1 minute' where slug = 'truckee-lights';
select pg_temp.t($$(not exists (select 1 from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'truckee-lights'))$$,
  'AC-W3-13 svc_issue_run_grants() never returns truckee-lights, even when due');
-- ---------------------------------------------------------------------------------------------------------------------
-- Amendment W3-1: mirror grants are mirror-only (AC-W3-25, AC-W3-26)
-- ---------------------------------------------------------------------------------------------------------------------
create temp table w31 as select
  pg_temp.snap('public.source_runs') as sr, pg_temp.snap('public.held_runs') as hr, pg_temp.snap('public.source_events') as se,
  pg_temp.snap('public.events') as ev, pg_temp.snap('private.lights_mirror') as lm, pg_temp.snap('private.lights_mirror_runs') as lr;
insert into g13 values ('w31m', pg_temp.mgrant());
select is(pg_temp.v('service_role', format($$public.svc_ingest_batch(%L, jsonb_build_object('status', 'ok', 'started_at',
    to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'http_status', 200, 'parser_version', 'test-1'),
    jsonb_build_array(jsonb_build_object('externalKey', 'w31', 'title', 'W31 Probe Event', 'startsAt', to_char((now() + interval '3 days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'allDay', false, 'timeKnown', true, 'venueName', 'Test Hall', 'address', '10 Main St', 'town', 'Truckee', 'lat', 39.328, 'lng', -120.1833,
      'url', 'https://example.test/e/w31', 'priceKind', 'free', 'age', 'unknown', 'categoriesHint', jsonb_build_array('music'))))::text$$,
    (select v from g13 where k = 'w31m'))) like 'ERR:42501|forbidden|%', true, 'AC-W3-25 svc_ingest_batch with a valid mirror grant -> 42501 forbidden');
select is(pg_temp.snap('public.source_runs') || pg_temp.snap('public.held_runs') || pg_temp.snap('public.source_events') || pg_temp.snap('public.events'),
  (select sr || hr || se || ev from w31), 'AC-W3-25 ... and writes nothing (source_runs, held_runs, source_events, events)');
select ok((select used_at is null from private.ingest_grants where token_hash = extensions.digest((select v from g13 where k = 'w31m'), 'sha256')),
  'AC-W3-25 ... and the mirror grant is not spent');
select pg_temp.mk_source('w31-src');
update public.sources set next_due_at = now() + interval '1 day' where slug <> 'w31-src' and next_due_at <= now();
update public.sources set next_due_at = now() where slug = 'w31-src';
insert into g13 select 'w31i', g ->> 'grant' from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'w31-src';
select pg_temp.ma('w31a', pg_temp.lrows('w31', 3, 2069), 2069, 'halloween', '{}', (select v from g13 where k = 'w31i'));
select ok(pg_temp.err(pg_temp.rerr('w31a'), '42501', 'forbidden'), 'AC-W3-26 svc_lights_mirror_apply with a normal ingest grant -> 42501 forbidden');
select is(pg_temp.snap('private.lights_mirror') || pg_temp.snap('private.lights_mirror_runs'), (select lm || lr from w31),
  'AC-W3-26 ... and writes nothing (mirror rows, runs)');
select ok((select used_at is null from private.ingest_grants where token_hash = extensions.digest((select v from g13 where k = 'w31i'), 'sha256')),
  'AC-W3-26 ... and the ingest grant is not spent');
insert into g13 values ('dis', pg_temp.mgrant());
update public.sources set enabled = false where slug = 'truckee-lights';
select pg_temp.ma('13f', pg_temp.lrows('g13', 2, 2041), 2041, 'halloween', '{}', (select v from g13 where k = 'dis'));
select ok(pg_temp.rerr('13f') like 'ERR:23514|%', 'W3.1 step 4 a mirror grant whose source was disabled since -> 23514');
select pg_temp.t($$(select public.svc_issue_mirror_grant() -> 'grant' = 'null'::jsonb)$$, 'W3.1 step 3 a disabled source gets no grant');
update public.sources set enabled = true where slug = 'truckee-lights';
select pg_temp.t($$(not has_function_privilege('anon', 'public.svc_lights_mirror_apply(text, jsonb, jsonb)', 'EXECUTE')
   and not has_function_privilege('authenticated', 'public.svc_issue_mirror_grant()', 'EXECUTE')
   and has_function_privilege('service_role', 'public.svc_issue_mirror_grant()', 'EXECUTE'))$$, 'AC-W3-13 the svc mirror RPCs are service_role only');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-01 first run
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('01', pg_temp.lrows('w01', 5, 2042), 2042);
select is(pg_temp.r('01', 'status') || ' added=' || pg_temp.r('01', 'added') || ' removed=' || pg_temp.r('01', 'removed') || ' seen=' || pg_temp.r('01', 'seen'),
  'ok added=5 removed=0 seen=5', 'AC-W3-01 first run: 5 added, run ok, nothing removed');
select is(pg_temp.nlive(2042), 5, 'AC-W3-01 five live mirror rows');
select is(pg_temp.mapi(2042) ->> 'state', 'confirmed', 'AC-W3-01 API mirror.state = confirmed');
select ok(pg_temp.mapi(2042) ->> 'confirmedAt' is not null, 'AC-W3-01 confirmedAt is set');
select is((select row(r.status, r.seen, r.added, r.changed, r.removed, r.held, r.invalid)::text from private.lights_mirror_runs r where year = 2042),
  '(ok,5,5,0,0,0,0)', 'AC-W3-01 one run row with the counts');
select pg_temp.ma('01c', jsonb_set(pg_temp.lrows('w01', 5, 2042), '{0,title}', '"Lights w01 house 1 renamed"'), 2042);
select is(pg_temp.r('01c', 'changed') || '/' || pg_temp.r('01c', 'added'), '1/0', 'W3.1 step 4 a changed field counts as changed, not added');
select is((select title from private.lights_mirror where lights_id = pg_temp.lid('w01', 1)), 'Lights w01 house 1 renamed', 'W3.1 step 4 the changed field is stored');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-02 one-off empty read
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('02a', pg_temp.lrows('w02', 5, 2043), 2043);
update private.lights_mirror_runs set finished_at = now() - interval '20 minutes' where year = 2043;
create temp table c02 as select pg_temp.mapi(2043) ->> 'confirmedAt' as c;
select pg_temp.ma('02b', '[]'::jsonb, 2043);
select is(pg_temp.r('02b', 'status') || ' held=' || pg_temp.r('02b', 'held') || ' removed=' || pg_temp.r('02b', 'removed'), 'held held=5 removed=0',
  'AC-W3-02 an empty read after a non-empty run -> G1 hold, run held');
select is(pg_temp.nlive(2043), 5, 'AC-W3-02 nothing removed');
select is((pg_temp.hold(2043)).observations, 1, 'AC-W3-02 hold opened with observations 1');
select is(pg_temp.mapi(2043) ->> 'state', 'held', 'AC-W3-02 API mirror.state = held');
select is(pg_temp.mapi(2043) ->> 'confirmedAt', (select c from c02), 'AC-W3-02 confirmedAt unchanged by the held run');
select is((pg_temp.mapi(2043) ->> 'heldCount'), '5', 'AC-W3-02 heldCount = 5');
select pg_temp.ma('02c', pg_temp.lrows('w02', 5, 2043), 2043);
select is(pg_temp.r('02c', 'status') || ' removed=' || pg_temp.r('02c', 'removed'), 'ok removed=0', 'AC-W3-02 all rows back -> run ok, nothing removed');
select ok(not pg_temp.hasHold(2043), 'AC-W3-02 hold closed');
select is(pg_temp.mapi(2043) ->> 'state', 'confirmed', 'AC-W3-02 API state back to confirmed');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-03 mass hide with continued polling (10 live, 6 absent)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('03a', pg_temp.lrows('w03', 10, 2044), 2044);
select pg_temp.ma('03b', pg_temp.lrows('w03', 10, 2044, array[1,2,3,4,5,6]), 2044);
select is(pg_temp.r('03b', 'status') || ' obs=' || pg_temp.hold_obs(2044), 'held obs=1', 'AC-W3-03 t0 held (obs 1)');
select is((pg_temp.hold(2044)).removal_set, pg_temp.hold_set('w03', array[1,2,3,4,5,6]), 'AC-W3-03 the hold set is the 6 absent ids, sorted');
select pg_temp.back(2044, 15);
select pg_temp.ma('03c', pg_temp.lrows('w03', 10, 2044, array[1,2,3,4,5,6]), 2044);
select is(pg_temp.r('03c', 'status') || ' obs=' || pg_temp.hold_obs(2044), 'held obs=2', 'AC-W3-03 t15 held (obs 2)');
select is(pg_temp.nremoved(2044), 0, 'AC-W3-03 nothing removed at t15');
select pg_temp.back(2044, 30);
select pg_temp.ma('03d', pg_temp.lrows('w03', 10, 2044, array[1,2,3,4,5,6]), 2044);
select is(pg_temp.r('03d', 'status') || ' removed=' || pg_temp.r('03d', 'removed'), 'ok removed=6', 'AC-W3-03 t30 accepted (obs 3, span 30 min)');
select is(pg_temp.nremoved(2044), 6, 'AC-W3-03 six removed_at set');
select ok(not pg_temp.hasHold(2044), 'AC-W3-03 hold deleted');
select is((select count(*)::int from private.lights_mirror where year = 2044 and removed_run is not null), 6, 'AC-W3-03 removed_run recorded');
-- a read at t15 alone (obs 3 but span 15 min) never accepts
select pg_temp.ma('03e', pg_temp.lrows('w03b', 10, 2045), 2045);
select pg_temp.ma('03f', pg_temp.lrows('w03b', 10, 2045, array[1,2,3,4,5,6]), 2045);
select pg_temp.ma('03g', pg_temp.lrows('w03b', 10, 2045, array[1,2,3,4,5,6]), 2045);
select pg_temp.back(2045, 15);
select pg_temp.ma('03h', pg_temp.lrows('w03b', 10, 2045, array[1,2,3,4,5,6]), 2045);
select is(pg_temp.r('03h', 'status') || ' obs=' || pg_temp.hold_obs(2045) || ' removed=' || pg_temp.nremoved(2045), 'held obs=3 removed=0',
  'AC-W3-03 three reads within 15 min never accept');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-04 span rule: t0, t10, t20 held; t30 accepts
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('04a', pg_temp.lrows('w04', 10, 2046), 2046);
select pg_temp.ma('04b', pg_temp.lrows('w04', 10, 2046, array[1,2,3,4]), 2046);
select pg_temp.back(2046, 10);
select pg_temp.ma('04c', pg_temp.lrows('w04', 10, 2046, array[1,2,3,4]), 2046);
select pg_temp.back(2046, 20);
select pg_temp.ma('04d', pg_temp.lrows('w04', 10, 2046, array[1,2,3,4]), 2046);
select is(pg_temp.r('04d', 'status') || ' obs=' || pg_temp.hold_obs(2046) || ' removed=' || pg_temp.nremoved(2046), 'held obs=3 removed=0',
  'AC-W3-04 3 matching reads at t0, t10, t20 -> still held');
select pg_temp.back(2046, 30);
select pg_temp.ma('04e', pg_temp.lrows('w04', 10, 2046, array[1,2,3,4]), 2046);
select is(pg_temp.r('04e', 'status') || ' removed=' || pg_temp.nremoved(2046), 'ok removed=4', 'AC-W3-04 the 4th read at t30 accepts');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-05 restore during a hold
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('05a', pg_temp.lrows('w05', 10, 2047), 2047);
select pg_temp.ma('05b', pg_temp.lrows('w05', 10, 2047, array[1,2,3,4,5,6]), 2047);
select pg_temp.ma('05c', pg_temp.lrows('w05', 10, 2047), 2047);
select is(pg_temp.r('05c', 'status') || ' removed=' || pg_temp.r('05c', 'removed') || ' hold=' || pg_temp.hasHold(2047), 'ok removed=0 hold=false',
  'AC-W3-05 full restore -> hold closed, 0 removed');
select pg_temp.ma('05d', pg_temp.lrows('w05b', 10, 2048), 2048);
select pg_temp.ma('05e', pg_temp.lrows('w05b', 10, 2048, array[1,2,3,4,5,6]), 2048);
select pg_temp.ma('05f', pg_temp.lrows('w05b', 10, 2048, array[6]), 2048);
select is(pg_temp.r('05f', 'status') || ' removed=' || pg_temp.r('05f', 'removed') || ' hold=' || pg_temp.hasHold(2048), 'ok removed=1 hold=false',
  'AC-W3-05 partial restore leaving 1 absent -> hold closed and G3 removes it');
select ok(pg_temp.removed_of('w05b', 6) and not pg_temp.removed_of('w05b', 1), 'AC-W3-05 exactly the one absent row is removed');
select pg_temp.ma('05g', pg_temp.lrows('w05c', 10, 2049), 2049);
select pg_temp.ma('05h', pg_temp.lrows('w05c', 10, 2049, array[1,2,3,4,5,6]), 2049);
select pg_temp.back(2049, 20);
select pg_temp.ma('05i', pg_temp.lrows('w05c', 10, 2049, array[1,2,3,4,5,7]), 2049);
select is(pg_temp.r('05i', 'status') || ' obs=' || pg_temp.hold_obs(2049) || ' removed=' || pg_temp.nremoved(2049), 'held obs=1 removed=0',
  'AC-W3-05 partial restore leaving a large different set -> reset to obs 1');
select is((pg_temp.hold(2049)).removal_set, pg_temp.hold_set('w05c', array[1,2,3,4,5,7]), 'AC-W3-05 ... with the new set');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-06 a different large set mid-hold
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('06a', pg_temp.lrows('w06', 10, 2050), 2050);
select pg_temp.ma('06b', pg_temp.lrows('w06', 10, 2050, array[1,2,3,4,5]), 2050);
select pg_temp.back(2050, 15);
select pg_temp.ma('06c', pg_temp.lrows('w06', 10, 2050, array[1,2,3,4,5]), 2050);
update private.lights_mirror_holds set first_obs_at = now() - interval '25 minutes', last_obs_at = now() - interval '10 minutes' where year = 2050;
select pg_temp.ma('06d', pg_temp.lrows('w06', 10, 2050, array[6,7,8,9,10]), 2050);
select is((select row(h.removal_set = pg_temp.hold_set('w06', array[6,7,8,9,10]), h.observations, h.first_obs_at = now(), h.last_obs_at = now())::text
             from private.lights_mirror_holds h where year = 2050), '(t,1,t,t)',
  'AC-W3-06 removal_set replaced, observations = 1, first_obs_at = last_obs_at = now');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-07 aborted submit during a hold
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('07a', pg_temp.lrows('w07', 10, 2051), 2051);
select pg_temp.ma('07b', pg_temp.lrows('w07', 10, 2051, array[1,2,3,4,5]), 2051);
update private.lights_mirror_holds set first_obs_at = now() - interval '7 minutes', last_obs_at = now() - interval '3 minutes' where year = 2051;
create temp table h07 as select pg_temp.snap('private.lights_mirror_holds') as s, pg_temp.snap('private.lights_mirror') as m;
select pg_temp.ma('07c', '[]'::jsonb, 2051, 'halloween', '{"status":"aborted","abort_code":"partial"}');
select is(pg_temp.r('07c', 'status'), 'aborted', 'AC-W3-07 an aborted submit returns status aborted');
select is((select string_agg(status || ':' || coalesce(abort_code, '-'), ',') from private.lights_mirror_runs where year = 2051 and status = 'aborted'),
  'aborted:partial', 'AC-W3-07 run row aborted with its code');
select is(pg_temp.snap('private.lights_mirror_holds'), (select s from h07), 'AC-W3-07 hold row byte-identical');
select is(pg_temp.snap('private.lights_mirror'), (select m from h07), 'AC-W3-07 mirror rows untouched');
select pg_temp.ma('07d', '[]'::jsonb, 2051, 'halloween', '{"status":"aborted","abort_code":"Bad-Code"}');
select ok(pg_temp.err(pg_temp.rerr('07d'), '22023', 'invalid_input', 'run'), 'W3.1 step 4 a malformed abort_code -> 22023 run');
-- review fix 2: the runner's HTTP codes (http_<n>) are one vocabulary from client to table
select pg_temp.ma('07e', '[]'::jsonb, 2051, 'halloween', '{"status":"aborted","abort_code":"http_503"}');
select is(pg_temp.r('07e', 'status'), 'aborted', 'W3.3 an aborted run with abort_code http_503 is accepted');
select is((select count(*)::int from private.lights_mirror_runs where year = 2051 and abort_code = 'http_503'), 1, 'W3.3 ... and recorded with its code');
select is(pg_temp.snap('private.lights_mirror_holds'), (select s from h07), 'W3.3 ... the hold still byte-identical');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-08 admin accept
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('08a', pg_temp.lrows('w08', 10, 2052), 2052);
select pg_temp.ma('08b', pg_temp.lrows('w08', 10, 2052, array[1,2,3,4,5]), 2052);
update private.lights_mirror_holds set last_obs_at = now() - interval '4 minutes' where year = 2052;
select ok(pg_temp.adm(format($$public.admin_accept_lights_removals('truckee', 'halloween', 2052, %L::uuid[])$$,
                              pg_temp.hold_set('w08', array[1,2,3,4]))) like 'ERR:22023|stale_set%', 'AC-W3-08 a stale set -> 22023 stale_set');
select is(pg_temp.nremoved(2052), 0, 'AC-W3-08 the stale accept removed nothing');
select is(pg_temp.adm(format($$public.admin_accept_lights_removals('truckee', 'halloween', 2052, %L::uuid[])$$,
                              array(select x from unnest(pg_temp.hold_set('w08', array[1,2,3,4,5])) x order by x desc))), '',
  'AC-W3-08 an aal2 admin with the matching set (any order) accepts');
select is(pg_temp.nremoved(2052), 5, 'AC-W3-08 the set is removed');
select ok(not pg_temp.hasHold(2052), 'AC-W3-08 the hold is gone');
select is((select max(finished_at) from private.lights_mirror_runs where year = 2052 and status = 'ok' and removed = 5), now() - interval '4 minutes',
  'AC-W3-08 the latest ok run finished_at = last_obs_at');
select is(pg_temp.mapi(2052) ->> 'state', 'confirmed', 'AC-W3-08 API state confirmed after accept');
select ok(pg_temp.adm($$public.admin_accept_lights_removals('truckee', 'halloween', 2052, array[]::uuid[])$$) like 'ERR:P0002|%',
  'AC-W3-08 no hold -> P0002');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-08b rejection matrix for the five admin RPCs
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('8ba', pg_temp.lrows('w8b', 10, 2053), 2053);
select pg_temp.ma('8bb', pg_temp.lrows('w8b', 10, 2053, array[1,2,3,4,5]), 2053);
select pg_temp.venue('W3 Matrix Hall', 39.328, -120.1833, 'truckee');
create temp table e8b as select pg_temp.ev('W3 Matrix Event', now() + interval '5 days',
  (select id from public.venues where name = 'W3 Matrix Hall' order by created_at limit 1)) as id;
create temp table snap8b as
  select pg_temp.snap('(select id, lights_include, lights_override_at, lights_season from public.events)') as ev,
         pg_temp.snap('private.lights_mirror_holds') as h, pg_temp.snap('private.lights_mirror') as m, pg_temp.snap('private.lights_mirror_runs') as r;
create temp table calls8b (name text, expr text);
insert into calls8b values
  ('admin_lights_mirror_status', 'public.admin_lights_mirror_status()'),
  ('admin_accept_lights_removals', format($$public.admin_accept_lights_removals('truckee', 'halloween', 2053, %L::uuid[])$$, pg_temp.hold_set('w8b', array[1,2,3,4,5]))),
  ('admin_set_lights_include', format($$public.admin_set_lights_include(%L::uuid, 'no')$$, (select id from e8b))),
  ('admin_set_lights_override', format($$public.admin_set_lights_override(%L::uuid)$$, (select id from e8b))),
  ('admin_lights_events', $$public.admin_lights_events('halloween', 2053)$$);
select is(
  array(select c.name || ':' || k.kind || ':' || split_part(pg_temp.as_kind(k.kind, c.expr), '|', 1)
          from calls8b c cross join (values ('anon'), ('user'), ('aal1'), ('nototp'), ('anonymous')) k(kind)
         where split_part(pg_temp.as_kind(k.kind, c.expr), '|', 1) <> 'ERR:42501' order by 1),
  '{}'::text[], 'AC-W3-08b every admin Lights RPC refuses anon / non-admin / aal1 / amr without totp / anonymous JWT with 42501 (25 calls)');
select is((select count(*)::int from calls8b c cross join (values ('anon'), ('user'), ('aal1'), ('nototp'), ('anonymous')) k(kind)), 25,
  'AC-W3-08b the matrix is 5 x 5 (non-vacuous)');
select is(pg_temp.snap('(select id, lights_include, lights_override_at, lights_season from public.events)'), (select ev from snap8b),
  'AC-W3-08b lights_include / lights_override_at unchanged after the refused calls');
select is(pg_temp.snap('private.lights_mirror_holds') || pg_temp.snap('private.lights_mirror') || pg_temp.snap('private.lights_mirror_runs'),
  (select h || m || r from snap8b), 'AC-W3-08b holds, mirror rows and runs unchanged after the refused calls');
select ok(pg_temp.adm('public.admin_lights_mirror_status()') like '{%', 'AC-W3-08b (control) the aal2 admin can read the status');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-09 confirmedAt across 3 held runs
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('09a', pg_temp.lrows('w09', 10, 2054), 2054);
update private.lights_mirror_runs set finished_at = now() - interval '1 hour' where year = 2054;
create temp table c09 as select pg_temp.mapi(2054) ->> 'confirmedAt' as c;
select pg_temp.ma('09b', pg_temp.lrows('w09', 10, 2054, array[1,2,3,4,5]), 2054);
select pg_temp.ma('09c', pg_temp.lrows('w09', 10, 2054, array[1,2,3,4,5]), 2054);
select pg_temp.ma('09d', pg_temp.lrows('w09', 10, 2054, array[1,2,3,4,5]), 2054);
select is(pg_temp.nruns(2054, 'held'), 3, 'AC-W3-09 three held runs');
select is(pg_temp.mapi(2054) ->> 'confirmedAt', (select c from c09), 'AC-W3-09 confirmedAt unchanged across 3 consecutive held runs');
select is(pg_temp.mapi(2054) ->> 'confirmedAt', pg_temp.z(now() - interval '1 hour'), 'AC-W3-09 ... and equals the last ok run');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-10 small removals (10 live: threshold 3.0)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('10a', pg_temp.lrows('w10a', 10, 2055), 2055);
select pg_temp.ma('10b', pg_temp.lrows('w10a', 10, 2055, array[1,2]), 2055);
select is(pg_temp.r('10b', 'status') || ' removed=' || pg_temp.r('10b', 'removed') || ' hold=' || pg_temp.hasHold(2055), 'ok removed=2 hold=false',
  'AC-W3-10 2 of 10 missing, no hold -> removed immediately (G3)');
select pg_temp.ma('10c', pg_temp.lrows('w10b', 10, 2056), 2056);
select pg_temp.ma('10d', pg_temp.lrows('w10b', 10, 2056, array[1,2,3]), 2056);
select is(pg_temp.r('10d', 'status') || ' removed=' || pg_temp.r('10d', 'removed'), 'ok removed=3', 'AC-W3-10 3 of 10 -> G3 (3 <= 3.0)');
select pg_temp.ma('10e', pg_temp.lrows('w10c', 10, 2057), 2057);
select pg_temp.ma('10f', pg_temp.lrows('w10c', 10, 2057, array[1,2,3,4]), 2057);
select is(pg_temp.r('10f', 'status') || ' removed=' || pg_temp.nremoved(2057) || ' hold=' || pg_temp.hasHold(2057), 'held removed=0 hold=true',
  'AC-W3-10 4 of 10 -> hold');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-10b exact threshold (greatest(2, 0.30 * |L|), numeric, never rounded)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('xa', pg_temp.lrows('wxa', 8, 2058), 2058);
select pg_temp.ma('xb', pg_temp.lrows('wxa', 8, 2058, array[1,2,3]), 2058);
select is(pg_temp.r('xb', 'status') || ' removed=' || pg_temp.nremoved(2058), 'held removed=0', 'AC-W3-10b 8 live, 3 missing, no hold -> hold (3 > 2.4)');
select pg_temp.ma('xc', pg_temp.lrows('wxc', 8, 2059), 2059);
select pg_temp.ma('xd', pg_temp.lrows('wxc', 8, 2059, array[1,2]), 2059);
select is(pg_temp.r('xd', 'status') || ' removed=' || pg_temp.nremoved(2059), 'ok removed=2', 'AC-W3-10b 8 live, 2 missing -> G3');
select pg_temp.ma('xe', pg_temp.lrows('wxe', 8, 2060), 2060);
select pg_temp.ma('xf', pg_temp.lrows('wxe', 8, 2060, array[1,2,3]), 2060);
select pg_temp.ma('xg', pg_temp.lrows('wxe', 8, 2060, array[4,5,6]), 2060);
select is(pg_temp.r('xg', 'status') || ' obs=' || pg_temp.hold_obs(2060) || ' removed=' || pg_temp.nremoved(2060), 'held obs=1 removed=0',
  'AC-W3-10b hold on set A (3 of 8), a read missing a different set B of 3 -> hold reset to B (obs 1), not G3');
select is((pg_temp.hold(2060)).removal_set, pg_temp.hold_set('wxe', array[4,5,6]), 'AC-W3-10b ... the hold now holds B');
select pg_temp.ma('xh', pg_temp.lrows('wxe', 8, 2060, array[7,8]), 2060);
select is(pg_temp.r('xh', 'status') || ' removed=' || pg_temp.r('xh', 'removed') || ' hold=' || pg_temp.hasHold(2060), 'ok removed=2 hold=false',
  'AC-W3-10b a different set of 2 -> hold closed and G3 removes those 2');
select ok(pg_temp.removed_of('wxe', 7) and pg_temp.removed_of('wxe', 8) and not pg_temp.removed_of('wxe', 4), 'AC-W3-10b ... exactly 7 and 8');
select pg_temp.ma('xi', pg_temp.lrows('wxi', 7, 2061), 2061);
select pg_temp.ma('xj', pg_temp.lrows('wxi', 7, 2061, array[1,2]), 2061);
select is(pg_temp.r('xj', 'status') || ' removed=' || pg_temp.nremoved(2061), 'ok removed=2', 'AC-W3-10b 7 live, 2 missing -> G3 (2 <= 2.1)');
select pg_temp.ma('xk', pg_temp.lrows('wxk', 7, 2062), 2062);
select pg_temp.ma('xl', pg_temp.lrows('wxk', 7, 2062, array[1,2,3]), 2062);
select is(pg_temp.r('xl', 'status') || ' removed=' || pg_temp.nremoved(2062), 'held removed=0', 'AC-W3-10b 7 live, 3 missing -> hold');
-- the empty-read rule stays first: one live row and an empty read is a hold, even though 1 <= 2
select pg_temp.ma('xm', pg_temp.lrows('wxm', 1, 2063), 2063);
select pg_temp.ma('xn', '[]'::jsonb, 2063);
select is(pg_temp.r('xn', 'status') || ' removed=' || pg_temp.nremoved(2063), 'held removed=0', 'W3.1 step 4 1 live row + an empty read -> G1 hold');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-11 validation
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('11a', pg_temp.lrows('w11', 10, 2064), 2064);
create temp table v11 as select pg_temp.snap('(select * from private.lights_mirror where lights_id in (' ||
  (select string_agg(quote_literal(pg_temp.lid('w11', n)), ',') from generate_series(1, 4) n) || '))') as s;
select pg_temp.ma('11b', (select jsonb_agg(case n
    when 1 then pg_temp.lrow('w11', 1, 2064, 'halloween', '{"title":"Bold <b>house</b>"}')
    when 2 then pg_temp.lrow('w11', 2, 2064, 'halloween', '{"lat":38.9}')
    when 3 then pg_temp.lrow('w11', 3, 2064, 'halloween', jsonb_build_object('ends_at', pg_temp.zts(now() + interval '6 days')))
    when 4 then pg_temp.lrow('w11', 4, 2064, 'halloween', '{"url":"https://1.2.3.4/"}')
    when 5 then pg_temp.lrow('w11', 5, 2064, 'halloween', '{"url":"https://tickets.thirdparty.example.com/a?b=1"}')
    else pg_temp.lrow('w11', n, 2064) end order by n) from generate_series(1, 10) n), 2064);
select is(pg_temp.r('11b', 'status') || ' invalid=' || pg_temp.r('11b', 'invalid') || ' removed=' || pg_temp.r('11b', 'removed') || ' changed=' || pg_temp.r('11b', 'changed'),
  'ok invalid=4 removed=0 changed=1', 'AC-W3-11 <b> title, lat outside the box, ends_at <= starts_at, IP-literal url -> 4 invalid; a third-party https url passes');
select is(pg_temp.snap('(select * from private.lights_mirror where lights_id in (' ||
  (select string_agg(quote_literal(pg_temp.lid('w11', n)), ',') from generate_series(1, 4) n) || '))'), (select s from v11),
  'AC-W3-11 the previous versions of the invalid rows are kept as they were');
select is(pg_temp.nlive(2064), 10, 'AC-W3-11 invalid rows are never removed');
select is((select url from private.lights_mirror where lights_id = pg_temp.lid('w11', 5)), 'https://tickets.thirdparty.example.com/a?b=1',
  'AC-W3-11 url on any third-party https host is stored (no allowlist)');
create temp table bad11 (label text, over jsonb);
insert into bad11 values ('u1', '{"url":"http://example.org/x"}'), ('u2', '{"url":"https://user@example.org/x"}'), ('u3', '{"url":"https://example.org:8443/x"}'),
  ('u4', '{"url":"https://localhost/x"}'), ('u5', '{"url":"https://[::1]/x"}'), ('t1', '{"title":"ab"}'), ('d1', '{"description":"short"}'),
  ('v1', '{"venue":"<x>"}'), ('a1', '{"address":""}'), ('g1', '{"lng":-121.0}'), ('s1', '{"starts_at":"not a date"}'), ('o1', '{"adults_only":"yes"}');
select pg_temp.ma('11x' || b.label, jsonb_build_array(pg_temp.lrow('w11n' || b.label, 1, 2065, 'halloween', b.over)), 2065) from bad11 b;
select is(array(select b.label || '=' || pg_temp.r('11x' || b.label, 'invalid') from bad11 b where pg_temp.r('11x' || b.label, 'invalid') <> '1' order by 1),
  '{}'::text[], 'W3.1 step 4 each malformed field makes the row invalid (12 cases)');
select is(pg_temp.nlive(2065), 0, 'W3.1 step 4 an invalid new row is never stored');
select pg_temp.ma('11c', jsonb_build_array(pg_temp.lrow('w11c', 1, 2066), pg_temp.lrow('w11c', 2, 2066, 'christmas')), 2066);
select ok(pg_temp.err(pg_temp.rerr('11c'), '22023', 'invalid_input', 'rows'), 'AC-W3-11 a row whose season differs from p_run -> 22023 rows');
select pg_temp.ma('11d', pg_temp.lrows('w11d', 3, 2066), 2066, 'halloween', '{"total": 4}');
select ok(pg_temp.err(pg_temp.rerr('11d'), '22023', 'invalid_input', 'rows'), 'AC-W3-11 total <> array length -> 22023 rows');
select pg_temp.ma('11e', jsonb_build_array(pg_temp.lrow('w11e', 1, 2066), pg_temp.lrow('w11e', 1, 2066)), 2066);
select ok(pg_temp.err(pg_temp.rerr('11e'), '22023', 'invalid_input', 'rows'), 'W3.1 step 4 duplicate ids -> 22023 rows');
select pg_temp.ma('11f', jsonb_build_array(pg_temp.lrow('w11f', 1, 2066, 'halloween', '{"id":"not-a-uuid"}')), 2066);
select ok(pg_temp.err(pg_temp.rerr('11f'), '22023', 'invalid_input', 'rows'), 'W3.1 step 4 a non-uuid id -> 22023 rows');
select pg_temp.ma('11g', '{"a":1}'::jsonb, 2066);
select ok(pg_temp.err(pg_temp.rerr('11g'), '22023', 'invalid_input', 'rows'), 'W3.1 step 4 rows not an array -> 22023 rows');
select pg_temp.ma('11h', (select jsonb_agg(pg_temp.lrow('w11h', n, 2066)) from generate_series(1, 1001) n), 2066);
select ok(pg_temp.err(pg_temp.rerr('11h'), '22023', 'invalid_input', 'rows'), 'W3.1 step 4 1,001 rows -> 22023 rows');
select pg_temp.ma('11i', '[]'::jsonb, 2066, 'halloween', '{"region":"reno"}');
select ok(pg_temp.err(pg_temp.rerr('11i'), '22023', 'invalid_input', 'run'), 'W3.1 step 4 a region with no box -> 22023 run');
select pg_temp.ma('11j', '[]'::jsonb, 2066, 'halloween', '{"status":"done"}');
select ok(pg_temp.err(pg_temp.rerr('11j'), '22023', 'invalid_input', 'run'), 'W3.1 step 4 an unknown run status -> 22023 run');
select is(pg_temp.n('private.lights_mirror_runs where year = 2066'), 0::bigint, 'W3.1 step 4 refused submits record no run');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-12 pair scoping and ended rows
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.ma('12a', pg_temp.lrows('w12h', 3, 2067), 2067);
create temp table s12 as select pg_temp.snap('(select * from private.lights_mirror where season = ''halloween'' and year = 2067)') as s,
                                pg_temp.snap('(select * from private.lights_mirror_runs where season = ''halloween'' and year = 2067)') as r;
select pg_temp.ma('12b', pg_temp.lrows('w12c', 3, 2067, '{}', 'christmas'), 2067, 'christmas');
select pg_temp.ma('12c', pg_temp.lrows('w12c', 3, 2067, array[1,2,3], 'christmas'), 2067, 'christmas');
select is(pg_temp.snap('(select * from private.lights_mirror where season = ''halloween'' and year = 2067)') ||
          pg_temp.snap('(select * from private.lights_mirror_runs where season = ''halloween'' and year = 2067)'),
  (select s || r from s12), 'AC-W3-12 halloween rows and runs untouched by christmas submits of the same year');
select is(pg_temp.r('12c', 'status'), 'held', 'AC-W3-12 (the christmas pair holds its own empty read)');
select ok(not pg_temp.hasHold(2067, 'halloween'), 'AC-W3-12 no hold on the halloween pair');
select pg_temp.ma('12d', pg_temp.lrows('w12e', 6, 2068) || jsonb_build_array(
    pg_temp.lrow('w12e', 7, 2068, 'halloween', jsonb_build_object('starts_at', pg_temp.zts(now() - interval '6 hours'))),
    pg_temp.lrow('w12e', 8, 2068, 'halloween', jsonb_build_object('starts_at', pg_temp.zts(now() - interval '9 hours'),
                                                                   'ends_at', pg_temp.zts(now() - interval '2 hours')))), 2068);
select pg_temp.ma('12e', pg_temp.lrows('w12e', 6, 2068), 2068);
select is(pg_temp.r('12e', 'status') || ' removed=' || pg_temp.r('12e', 'removed') || ' held=' || pg_temp.r('12e', 'held'), 'ok removed=0 held=0',
  'AC-W3-12 ended rows absent from the snapshot are not in L');
select ok(not pg_temp.removed_of('w12e', 7) and not pg_temp.removed_of('w12e', 8), 'AC-W3-12 ... and are never removed');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-14 authority through the admin RPCs (the one eligibility predicate, shown_on_lights)
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.at14() returns timestamptz language sql as $$
  select (pg_temp.sday() + time '18:00') at time zone 'America/Los_Angeles' $$;
select pg_temp.venue('W3 Lights Hall', 39.328, -120.1833, 'truckee');
create temp table e14 as select pg_temp.ev('W3 Glow Walk', pg_temp.at14(),
  (select id from public.venues where name = 'W3 Lights Hall' order by created_at limit 1)) as id;
-- the covering mirror row (#10: same title, same start, same place) and 9 unrelated rows of the same pair
create function pg_temp.rows14(p_except int[] default '{}') returns jsonb language sql as $$
  select coalesce(jsonb_agg(case when n = 10 then pg_temp.lrow('w14', 10, pg_temp.syear(), pg_temp.sseason(),
           jsonb_build_object('title', 'W3 Glow Walk', 'starts_at', pg_temp.zts(pg_temp.at14())))
         else pg_temp.lrow('w14', n, pg_temp.syear(), pg_temp.sseason()) end order by n), '[]'::jsonb)
    from generate_series(1, 10) n where not (n = any (p_except)) $$;
create function pg_temp.sh14() returns text language sql as $$
  select coalesce((select format('shown=%s covered=%s vetoed=%s', x ->> 'shown', x ->> 'coveredLive', x ->> 'vetoed')
                     from (select pg_temp.lev(pg_temp.sseason(), pg_temp.syear(), (select id from e14)) as x) q), '<absent>') $$;
select is(pg_temp.adm(format($$public.admin_set_lights_include(%L::uuid, 'yes')$$, (select id from e14))), '', 'AC-W3-14 admin_set_lights_include(e, yes) as an aal2 admin');
select is((select lights_include || ' ' || coalesce(lights_override_at::text, 'null') from public.events where id = (select id from e14)), 'yes null',
  'AC-W3-14 include yes leaves lights_override_at null');
select is((select count(*)::int from public.event_changes where event_id = (select id from e14) and field = 'lights_include'
            and new_value = '"yes"'::jsonb and decided_by = 'admin:e1500000-0000-4000-a000-000000000001'), 1, 'W3.1 step 7 the change is logged in event_changes');
select ok((select lights_season @> jsonb_build_array(jsonb_build_object('season', pg_temp.sseason(), 'year', pg_temp.syear())) from public.events where id = (select id from e14)),
  'W3.1 step 7 lights_season recomputed (the pair is in it)');
select is(pg_temp.sh14(), 'shown=true covered=false vetoed=false', 'AC-W3-14 with no mirror row the event shows');
select pg_temp.ma('14a', pg_temp.rows14(), pg_temp.syear(), pg_temp.sseason());
select is(pg_temp.sh14(), 'shown=false covered=true vetoed=false', 'AC-W3-14 a live covering mirror row hides it (dedupe)');
select pg_temp.ma('14b', pg_temp.rows14(array[10]), pg_temp.syear(), pg_temp.sseason());
select is(pg_temp.r('14b', 'status') || ' removed=' || pg_temp.r('14b', 'removed'), 'ok removed=1', 'AC-W3-14 (Lights removes the covering row: G3)');
update private.lights_mirror set removed_at = now() - interval '1 hour' where lights_id = pg_temp.lid('w14', 10);
select is(pg_temp.sh14(), 'shown=false covered=false vetoed=true', 'AC-W3-14 a removed covering row with no override vetoes it');
select is(pg_temp.adm(format($$public.admin_set_lights_override(%L::uuid)$$, (select id from e14))), '', 'AC-W3-14 admin_set_lights_override(e)');
select is((select lights_include || ' ' || (lights_override_at = now())::text from public.events where id = (select id from e14)), 'yes true',
  'AC-W3-14 the override sets lights_override_at = now() and yes');
select is((select count(*)::int from public.event_changes where event_id = (select id from e14) and field = 'lights_override_at'), 1,
  'W3.1 step 8 the override is logged');
select is(pg_temp.sh14(), 'shown=true covered=false vetoed=false', 'AC-W3-14 a removal older than the override: the event shows');
select ok(exists (select 1 from jsonb_array_elements(pg_temp.jb(pg_temp.v('anon', format('public.api_events_v1(p_scope => ''lights'', p_season => %L, p_year => %s)',
  pg_temp.sseason(), pg_temp.syear()))) -> 'events') x where x ->> 'id' = (select id from e14)::text), 'AC-W3-14 ... and scope=lights returns it');
select pg_temp.ma('14c', pg_temp.rows14(), pg_temp.syear(), pg_temp.sseason());
select is(pg_temp.sh14(), 'shown=false covered=true vetoed=false', 'AC-W3-14 restored on Lights: live dedupe hides the Vibes copy');
update public.events set lights_override_at = now() - interval '30 minutes' where id = (select id from e14);
select pg_temp.ma('14d', pg_temp.rows14(array[10]), pg_temp.syear(), pg_temp.sseason());
select is(pg_temp.sh14(), 'shown=false covered=false vetoed=true', 'AC-W3-14 a later removal (G3, newer than the override) re-vetoes it');
select ok(pg_temp.adm(format($$public.admin_set_lights_include(%L::uuid, 'maybe')$$, (select id from e14))) like 'ERR:22023|%', 'W3.1 step 7 a bad value -> 22023');
select ok(pg_temp.adm($$public.admin_set_lights_include('00000000-0000-4000-8000-0000000000ff'::uuid, 'no')$$) like 'ERR:P0002|%', 'W3.1 step 7 an unknown event -> P0002');
select ok(pg_temp.adm($$public.admin_set_lights_override('00000000-0000-4000-8000-0000000000ff'::uuid)$$) like 'ERR:P0002|%', 'W3.1 step 8 an unknown event -> P0002');
select ok(pg_temp.adm($$public.admin_lights_events('easter', 2026)$$) like 'ERR:22023|%', 'W3.1 step 9 a bad season -> 22023');
-- review fix 1: an excluded event keeps its admin control (auto -> no -> auto through the RPCs)
select is(pg_temp.adm(format($$public.admin_set_lights_include(%L::uuid, 'no')$$, (select id from e14))), '', 'W3.4 set the event to no');
select is(pg_temp.lev(pg_temp.sseason(), pg_temp.syear(), (select id from e14)) ->> 'lightsInclude', 'no',
  'W3.4 an event set to no is still listed by admin_lights_events (its lights_season is empty)');
select is(pg_temp.lev(pg_temp.sseason(), pg_temp.syear(), (select id from e14)) ->> 'shown', 'false', 'W3.4 ... and is not shown');
select is(pg_temp.adm(format($$public.admin_set_lights_include(%L::uuid, 'auto')$$, (select id from e14))), '', 'W3.4 set it back to auto');
select is(pg_temp.lev(pg_temp.sseason(), pg_temp.syear(), (select id from e14)) ->> 'lightsInclude', 'auto', 'W3.4 ... still listed, now auto');
create temp table e14b as select pg_temp.ev('W3 Plain Talk', pg_temp.at14() + interval '1 hour',
  (select id from public.venues where name = 'W3 Lights Hall' order by created_at limit 1)) as id;
select is(pg_temp.lev(pg_temp.sseason(), pg_temp.syear(), (select id from e14b)) ->> 'lightsInclude', 'auto',
  'W3.4 a published event in the window that fails auto eligibility is listed, so it can be set to yes');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.lev(pg_temp.sseason(), pg_temp.syear(), (select id from e14))) k),
  'coveredLive,id,lightsInclude,shown,startsAt,title,vetoed', 'W3.1 step 9 admin_lights_events row keys');

-- ---------------------------------------------------------------------------------------------------------------------
-- W3.1 step 5 admin_lights_mirror_status
-- ---------------------------------------------------------------------------------------------------------------------
create temp table st as select pg_temp.jb(pg_temp.adm('public.admin_lights_mirror_status()')) as j;
create function pg_temp.sthold(p_year int) returns jsonb language sql as $$
  select x from jsonb_array_elements((select j from st) -> 'holds') x where (x ->> 'year')::int = p_year $$;
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.sthold(2053)) k),
  'firstObsAt,lastObsAt,observations,region,removalSet,season,year', 'W3.1 step 5 a hold entry carries the spec keys');
select is(jsonb_array_length(pg_temp.sthold(2053) -> 'removalSet'), 5, 'W3.1 step 5 removalSet lists the held rows');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(pg_temp.sthold(2053) -> 'removalSet' -> 0) k), 'id,startsAt,title',
  'W3.1 step 5 removalSet entries are {id, title, startsAt}');
select ok((select bool_and(x ->> 'id' = any (array(select unnest(pg_temp.hold_set('w8b', array[1,2,3,4,5]))::text)))
             from jsonb_array_elements(pg_temp.sthold(2053) -> 'removalSet') x), 'W3.1 step 5 ... exactly the held ids');
select ok((select bool_and(jsonb_array_length(x -> 'runs') <= 10) and count(*) > 0 from jsonb_array_elements((select j from st) -> 'runs') x),
  'W3.1 step 5 at most the last 10 runs per pair');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys((select j from st) -> 'runs' -> 0 -> 'runs' -> 0) k),
  'abortCode,added,changed,finishedAt,held,invalid,removed,seen,status', 'W3.1 step 5 run entries carry counts and status only');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-15 new functions: owner, search_path, security definer
-- ---------------------------------------------------------------------------------------------------------------------
select is(array(select p.oid::regprocedure::text from pg_proc p
   where p.oid in ('public.svc_issue_mirror_grant()'::regprocedure, 'public.svc_lights_mirror_apply(text, jsonb, jsonb)'::regprocedure,
                   'public.admin_lights_mirror_status()'::regprocedure, 'public.admin_accept_lights_removals(text, text, integer, uuid[])'::regprocedure,
                   'public.admin_set_lights_include(uuid, text)'::regprocedure, 'public.admin_set_lights_override(uuid)'::regprocedure,
                   'public.admin_lights_events(text, integer)'::regprocedure)
     and not (p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' and p.proconfig = array['search_path=""']) order by 1),
  '{}'::text[], 'AC-W3-15 the seven new RPCs are security definer, postgres-owned, search_path = ''''');
select is((select proconfig from pg_proc where oid = 'private.purge_lights_mirror()'::regprocedure), array['search_path=""'], 'AC-W3-15 purge pins search_path');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-W3-16 purge
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.put16(p_season text, p_year int, p_tag text) returns void language sql as $$
  insert into private.lights_mirror (lights_id, region_slug, season, year, title, description, venue, address, lat, lng, starts_at, url, adults_only)
    values (pg_temp.lid(p_tag, 1), 'truckee', p_season, p_year, 'Purge house', 'A synthetic house for the purge test.', null, '1 Main St',
            39.328, -120.1833, now(), null, false);
  insert into private.lights_mirror_holds (region_slug, season, year, removal_set, first_obs_at, last_obs_at, observations)
    values ('truckee', p_season, p_year, array[pg_temp.lid(p_tag, 1)], now(), now(), 1);
  insert into private.lights_mirror_runs (region_slug, season, year, status) values ('truckee', p_season, p_year, 'held');
$$;
select pg_temp.put16('christmas', 2025, 'p25');
select pg_temp.put16('halloween', extract(year from now())::int + 1, 'pnext');
select ok(private.purge_lights_mirror() >= 3, 'AC-W3-16 purge reports what it deleted');
select is(pg_temp.n('private.lights_mirror where season = ''christmas'' and year = 2025') + pg_temp.n('private.lights_mirror_holds where season = ''christmas'' and year = 2025')
          + pg_temp.n('private.lights_mirror_runs where season = ''christmas'' and year = 2025'), 0::bigint,
  'AC-W3-16 the 2025 christmas pair (window end Jan 7 2026 + 30 days < now) is purged: rows, holds, runs');
select is(pg_temp.n(format('private.lights_mirror where season = ''halloween'' and year = %s', extract(year from now())::int + 1))
          + pg_temp.n(format('private.lights_mirror_holds where season = ''halloween'' and year = %s', extract(year from now())::int + 1))
          + pg_temp.n(format('private.lights_mirror_runs where season = ''halloween'' and year = %s', extract(year from now())::int + 1)), 3::bigint,
  'AC-W3-16 a future halloween pair is kept');
select ok(pg_temp.nlive(2042) = 5, 'AC-W3-16 other live pairs are kept');

-- aborted read whose pair is unknown (the context call itself failed): recorded nowhere, grant consumed, nothing touched
create temp table s99 as select pg_temp.snap('private.lights_mirror_runs') as r;
insert into g13 values ('nopair', pg_temp.mgrant());
select is(pg_temp.v('service_role', format($$public.svc_lights_mirror_apply(%L, '{"region":"truckee","status":"aborted","abort_code":"timeout"}'::jsonb, '[]'::jsonb) ->> 'status'$$,
  (select v from g13 where k = 'nopair'))), 'aborted', 'W3.3 an aborted read with no known pair is accepted as aborted');
select is(pg_temp.snap('private.lights_mirror_runs'), (select r from s99), 'W3.3 ... and records no run (no pair to record it under)');
select ok((select used_at is not null from private.ingest_grants where token_hash = extensions.digest((select v from g13 where k = 'nopair'), 'sha256')),
  'W3.3 ... the grant is used');

select * from finish();
rollback;
