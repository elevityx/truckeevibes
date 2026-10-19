-- AC-M1-99 ... 103 (Amendment 11): geocode request carries the street address; the geocode-attempt reset; a held run superseded by a newer ok run does not demote its source.
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
create function pg_temp.mk_run(p_src text, p_status text, p_finished interval) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.source_runs (id, source_id, started_at, finished_at, status)
    values (v_id, (select id from public.sources where slug = p_src), now() + p_finished - interval '1 minute', now() + p_finished, p_status);
  return v_id;
end $$;
create function pg_temp.mk_held(p_run uuid, p_src text, p_age interval) returns void language plpgsql as $$
declare v_card uuid;
begin
  insert into public.held_runs (run_id, source_id, items, summary, created_at)
    values (p_run, (select id from public.sources where slug = p_src), '[]'::jsonb, '{}'::jsonb, now() - p_age);
  insert into public.review_cards (kind, held_run_id, source_id) values ('held_run', p_run, (select id from public.sources where slug = p_src));
end $$;
create function pg_temp.mk_v(p_name text, p_addr text, p_town text, p_attempts int, p_live boolean default true) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.venues (name, normalized_name, address, town, geocode_attempts) values (p_name, lower(p_name), p_addr, p_town, p_attempts) returning id into v_id;
  if p_live is not null then
    insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, all_day, time_known, start_day, venue_id, source_status)
      values ((select id from public.sources where slug = 'g-src'), 'k-' || p_name, '{}'::jsonb, 'h', 't', 't', now() + interval '3 days', false, true, (now() + interval '3 days')::date, v_id,
              case when p_live then 'live' else 'gone' end);
  end if;
  return v_id;
end $$;

select pg_temp.mk_source('g-src', 'organizer', 'auto');

-- AC-M1-99 (SQL side): the request carries `address` only for a street address ---------------------------------------
select pg_temp.mk_v('Street Hall', '12593 Donner Pass Rd, Truckee, CA 96161', 'Truckee', 0);
select pg_temp.mk_v('Named Place', 'Downtown Square', 'Truckee', 0);
select pg_temp.mk_v('No Address', null, 'Truckee', 0);
select pg_temp.eq($$(select e ->> 'address' from jsonb_array_elements(private.take_geocode_budget(array[(select id from public.venues where name = 'Street Hall')])) e)$$,
  '12593 Donner Pass Rd, Truckee, CA 96161', 'AC-M1-99 a street address is sent as its own field');
select pg_temp.eq($$(select e ->> 'query' from jsonb_array_elements(private.take_geocode_budget(array[(select id from public.venues where name = 'Street Hall')])) e)$$,
  'Street Hall, 12593 Donner Pass Rd, Truckee, CA 96161, Truckee', 'AC-M1-99 the query is unchanged');
select pg_temp.eq($$(select (e ? 'address')::text from jsonb_array_elements(private.take_geocode_budget(array[(select id from public.venues where name = 'Named Place')])) e)$$,
  'false', 'AC-M1-99 a non-numeric address sends no address field');
select pg_temp.eq($$(select (e ? 'address')::text from jsonb_array_elements(private.take_geocode_budget(array[(select id from public.venues where name = 'No Address')])) e)$$,
  'false', 'AC-M1-99 a null address sends no address field');

-- AC-M1-102 reset ---------------------------------------------------------------------------------------------------
select pg_temp.mk_v('R Live1', null, 'Truckee', 1);
select pg_temp.mk_v('R Live3', null, 'Truckee', 3);
select pg_temp.mk_v('R Gone', null, 'Truckee', 2, false);
select pg_temp.mk_v('R NoEvents', null, 'Truckee', 2, null);
select pg_temp.mk_v('R Solved', null, 'Truckee', 1);
update public.venues set lat = 39.3, lng = -120.2 where name = 'R Solved';
select pg_temp.eq($$private.reset_geocode_attempts()$$, '1', 'AC-M1-102 the reset returns the number of venues changed (only R Live1; venues already at 0 are not counted)');
select pg_temp.eq($$(select geocode_attempts::text from public.venues where name = 'R Live1')$$, '0', 'AC-M1-102 attempts 1 with a future live event -> 0');
select pg_temp.eq($$(select geocode_attempts::text from public.venues where name = 'R Live3')$$, '3', 'AC-M1-102 attempts 3 untouched');
select pg_temp.eq($$(select geocode_attempts::text from public.venues where name = 'R Gone')$$, '2', 'AC-M1-102 only gone events -> untouched');
select pg_temp.eq($$(select geocode_attempts::text from public.venues where name = 'R NoEvents')$$, '2', 'AC-M1-102 no events -> untouched');
select pg_temp.eq($$(select geocode_attempts::text from public.venues where name = 'R Solved')$$, '1', 'AC-M1-102 already geocoded -> untouched');

-- AC-M1-101 expiry --------------------------------------------------------------------------------------------------
select pg_temp.mk_source('x-sup', 'organizer', 'auto');
select pg_temp.mk_source('x-old', 'organizer', 'auto');
select pg_temp.mk_source('x-new', 'organizer', 'auto');
select pg_temp.mk_source('x-fresh', 'organizer', 'auto');
-- x-sup: held 8 days ago, a newer ok run -> superseded, stays auto
select pg_temp.mk_held(pg_temp.mk_run('x-sup', 'anomaly', interval '-8 days'), 'x-sup', interval '8 days');
select pg_temp.mk_run('x-sup', 'ok', interval '-1 day');
-- x-old: held 8 days ago, only an OLDER ok run -> demoted
select pg_temp.mk_run('x-old', 'ok', interval '-9 days');
select pg_temp.mk_held(pg_temp.mk_run('x-old', 'anomaly', interval '-8 days'), 'x-old', interval '8 days');
-- x-new: held 8 days ago, a newer run that is NOT ok -> demoted
select pg_temp.mk_held(pg_temp.mk_run('x-new', 'anomaly', interval '-8 days'), 'x-new', interval '8 days');
select pg_temp.mk_run('x-new', 'http_error', interval '-1 day');
-- x-fresh: held 2 days ago -> untouched
select pg_temp.mk_held(pg_temp.mk_run('x-fresh', 'anomaly', interval '-2 days'), 'x-fresh', interval '2 days');
select pg_temp.mk_run('x-fresh', 'ok', interval '-1 day');
select is(pg_temp.x('postgres', $$select private.expire_held_runs()$$), 'OK', 'AC-M1-101 expire_held_runs runs');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'x-sup')$$, 'auto', 'AC-M1-101 superseded held run: source stays auto');
select pg_temp.eq($$(select h.status || '/' || c.decision from public.held_runs h join public.review_cards c on c.held_run_id = h.run_id where h.source_id = (select id from public.sources where slug = 'x-sup'))$$, 'expired/superseded', 'AC-M1-101 ... run expired, card closed as superseded');
select pg_temp.eq($$(select c.status from public.review_cards c where c.source_id = (select id from public.sources where slug = 'x-sup'))$$, 'closed', 'AC-M1-101 ... the card is closed');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'x-old')$$, 'review', 'AC-M1-101 only an older ok run: demoted (existing behavior)');
select pg_temp.eq($$(select c.decision from public.review_cards c where c.source_id = (select id from public.sources where slug = 'x-old'))$$, 'expired', 'AC-M1-101 ... card decision expired');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'x-new')$$, 'review', 'AC-M1-101 a newer non-ok run does not supersede: demoted');
select pg_temp.eq($$(select trust::text from public.sources where slug = 'x-fresh') || '/' || (select status from public.held_runs where source_id = (select id from public.sources where slug = 'x-fresh'))$$, 'auto/pending', 'AC-M1-101 a 2-day-old held run is untouched');

-- AC-M1-103 grants unchanged: the same 24 grant statements (27 role grants) as the predecessor (01_acl pins the exact list) ------
select pg_temp.eq($$(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace, lateral aclexplode(p.proacl) a
   where n.nspname in ('public', 'private') and a.privilege_type = 'EXECUTE' and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')))$$,
  '36', 'AC-M1-103 the explicit EXECUTE grant count is unchanged by A11 (27) + W1 api_events_v1 (+2 = 29) + W3 two svc mirror routines and five admin Lights RPCs (+7 = 36)');   -- W1, W3

select * from finish();
rollback;
