-- AC-M1-76 (a-c): admin_owner_minutes_7d() gate, ACL and value (same formula as svc_weekly_report().review_minutes_7d).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.dml(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text;
  v_state := sqlstate;
  return v_state || '|' || coalesce(v_msg, '');
end $$;
create function pg_temp.q(p_expr text) returns text language plpgsql as $$
declare r text;
begin
  execute 'select (' || p_expr || ')::text' into r;
  return coalesce(r, '<null>');
exception when others then
  return 'ERR:' || sqlstate;
end $$;
-- run an expression as `authenticated` with the given claims (p_claims null = no claims at all); errors come back as ERR:<sqlstate>
create function pg_temp.as_user(p_uid text, p_aal text, p_amr text, p_anon boolean, p_expr text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then ''
    else (jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon, 'aal', p_aal)
      || case when p_amr is null then '{}'::jsonb else jsonb_build_object('amr', p_amr::jsonb) end)::text end, true);
  perform set_config('role', 'authenticated', true);
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate;
end $$;
create function pg_temp.pwtotp() returns text language sql as $$ select '[{"method":"totp","timestamp":1791564301},{"method":"password","timestamp":1791564300}]' $$;
create function pg_temp.mins(p_uid text, p_aal text, p_amr text, p_anon boolean default false) returns text language sql as $$
  select pg_temp.as_user(p_uid, p_aal, p_amr, p_anon, 'public.admin_owner_minutes_7d()') $$;

-- (a) shape and ACL
select is(pg_temp.q($$(select prosecdef from pg_proc where oid = 'public.admin_owner_minutes_7d()'::regprocedure)$$), 'true', 'admin_owner_minutes_7d is SECURITY DEFINER');
select is(pg_temp.q($$(select proconfig = array['search_path=""'] from pg_proc where oid = 'public.admin_owner_minutes_7d()'::regprocedure)$$), 'true', 'it pins search_path');
select is(pg_temp.q($$has_function_privilege('authenticated', 'public.admin_owner_minutes_7d()', 'EXECUTE')$$), 'true', 'authenticated can execute it');
select is(pg_temp.q($$has_function_privilege('anon', 'public.admin_owner_minutes_7d()', 'EXECUTE')$$), 'false', 'anon cannot');
select is(pg_temp.q($$has_function_privilege('service_role', 'public.admin_owner_minutes_7d()', 'EXECUTE')$$), 'false', 'service_role cannot');

-- fixtures: e1800000-...-1 admin, -2 plain user, a source for the cards
select is(pg_temp.dml($$insert into auth.users (id, aud, role, email)
  select ('e1800000-0000-4000-a000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'om' || n || '@example.test'
    from generate_series(1, 2) n$$), 'OK', 'fixture users');
select is(pg_temp.dml($$insert into public.admins (user_id, note) values ('e1800000-0000-4000-a000-000000000001', 'owner minutes test')$$), 'OK', 'fixture admin');
select is(pg_temp.dml($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class)
  values ('om-src', 'OM Source', 'https://example.test/', array['example.test'], 'ics', 'organizer')$$), 'OK', 'fixture source');

-- (b) gate matrix
select ok(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()) !~ '^ERR', 'admin aal2 password+totp -> a value');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal1', pg_temp.pwtotp()), 'ERR:42501', 'admin aal1 -> 42501');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', '[{"method":"totp","timestamp":1791564301}]'), 'ERR:42501', 'admin totp only -> 42501');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', '[{"method":"password","timestamp":1791564300}]'), 'ERR:42501', 'admin password only -> 42501');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000002', 'aal2', pg_temp.pwtotp()), 'ERR:42501', 'non-admin -> 42501');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp(), true), 'ERR:42501', 'anonymous -> 42501');
select is(pg_temp.mins(null, null, null), 'ERR:42501', 'no claims -> 42501');

-- (c) value. Empty history first.
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()), '0.0', 'empty history -> 0.0');

insert into public.review_cards (kind, status, source_id, decided_at, decided_by, review_seconds, decision)
  select 'source_budget', 'closed', (select id from public.sources where slug = 'om-src'), now() - interval '1 day',
         'e1800000-0000-4000-a000-000000000001', s, 'ack'
    from unnest(array[30, 60, 90]) s;
insert into public.owner_activity (kind, seconds, at) values ('featured', 60, now() - interval '2 days');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()), '4.0', '3 cards (30/60/90 s) + 60 s activity -> 4.0');

-- noise outside the window or without a decider must not count
insert into public.review_cards (kind, status, source_id, decided_at, decided_by, review_seconds, decision)
  values ('source_budget', 'closed', (select id from public.sources where slug = 'om-src'), now() - interval '8 days', 'e1800000-0000-4000-a000-000000000001', 600, 'ack');
insert into public.owner_activity (kind, seconds, at) values ('other', 3600, now() - interval '8 days');
insert into public.review_cards (kind, status, source_id, decided_at, decided_by, review_seconds, decision)
  values ('source_budget', 'closed', (select id from public.sources where slug = 'om-src'), now() - interval '1 day', null, 100, 'expired');
select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()), '4.0', 'old rows and a job-expired card do not count -> still 4.0');

select is(pg_temp.mins('e1800000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()),
  (select (public.svc_weekly_report() ->> 'review_minutes_7d')::numeric::text), 'equals svc_weekly_report().review_minutes_7d');

select * from finish();
rollback;
