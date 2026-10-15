-- AC-M0-10: admin gate (password + totp, aal2, non-anonymous, in public.admins).
-- JWT claim shapes follow the captured GoTrue shapes used by the sister project's admin test.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
create function pg_temp.dml(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_detail text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  v_state := sqlstate;
  return v_state || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
-- Scalar expression -> text; any error comes back as ERR:<sqlstate>, so one missing object fails one assertion.
create function pg_temp.q(p_expr text) returns text language plpgsql as $$
declare r text;
begin
  execute 'select (' || p_expr || ')::text' into r;
  return coalesce(r, '<null>');
exception when others then
  return 'ERR:' || sqlstate;
end $$;
-- run an expression as `authenticated` with the given claims; errors come back as ERR:<sqlstate>
create function pg_temp.as_user(p_uid text, p_aal text, p_amr text, p_anon boolean, p_expr text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anon, 'aal', p_aal)
      || case when p_amr is null then '{}'::jsonb else jsonb_build_object('amr', p_amr::jsonb) end)::text, true);
  perform set_config('role', 'authenticated', true);
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate;
end $$;

-- e1500000-...-1 is an admin, -2 is a plain user
select is(pg_temp.dml($$insert into auth.users (id, aud, role, email)
  select ('e1500000-0000-4000-a000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'amr' || n || '@example.test'
    from generate_series(1, 2) n$$), 'OK', 'fixture users insert');
select is(pg_temp.dml($$insert into public.admins (user_id, note) values ('e1500000-0000-4000-a000-000000000001', 'amr test')$$),
  'OK', 'fixture admin row inserts');
select is(pg_temp.dml($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class)
  values ('amr-src', 'Amr Source', 'https://example.test/', array['example.test'], 'ics', 'organizer')$$), 'OK', 'fixture source inserts');

-- the function itself
select is(pg_temp.q($$(select prosecdef from pg_proc where oid = 'private.is_admin()'::regprocedure)$$), 'true', 'is_admin() is SECURITY DEFINER');
select is(pg_temp.q($$(select proconfig from pg_proc where oid = 'private.is_admin()'::regprocedure)$$), '{search_path=""}', 'is_admin() pins search_path');
select ok(pg_temp.q($$has_function_privilege('anon', 'private.is_admin()', 'EXECUTE')$$) = 'false', 'anon cannot execute is_admin()');

-- matrix
create function pg_temp.pwtotp() returns text language sql as $$ select '[{"method":"totp","timestamp":1791564301},{"method":"password","timestamp":1791564300}]' $$;
create function pg_temp.whoami(p_uid text, p_aal text, p_amr text, p_anon boolean default false) returns text language sql as $$
  select pg_temp.as_user(p_uid, p_aal, p_amr, p_anon, 'public.admin_whoami()') $$;
create function pg_temp.trust(p_uid text, p_aal text, p_amr text, p_anon boolean default false) returns text language sql as $$
  select pg_temp.as_user(p_uid, p_aal, p_amr, p_anon, $e$public.admin_set_source_trust('amr-src', 'auto')$e$) $$;

select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()), 'true', 'AC-M0-10 password+totp aal2 admin -> whoami true');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', '[{"method":"password","timestamp":1791564300},{"method":"totp","timestamp":1791564301}]'),
  'true', 'amr order does not matter');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal1', pg_temp.pwtotp()), 'false', 'aal1 -> whoami false');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', '[{"method":"totp","timestamp":1791564303},{"method":"otp","timestamp":1791564302}]'),
  'false', 'otp+totp -> whoami false');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', '[{"method":"password","timestamp":1791564302}]'), 'false', 'password only -> false');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', null), 'false', 'amr missing -> false (fails closed)');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', '"password totp"'), 'false', 'amr a string -> false, no error');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp(), true), 'false', 'anonymous JWT -> false');
select is(pg_temp.whoami('e1500000-0000-4000-a000-000000000002', 'aal2', pg_temp.pwtotp()), 'false', 'non-admin aal2 password+totp -> false');

-- admin_set_source_trust
select is(pg_temp.trust('e1500000-0000-4000-a000-000000000001', 'aal1', pg_temp.pwtotp()), 'ERR:42501', 'AC-M0-10 aal1 -> forbidden (42501)');
select is(pg_temp.trust('e1500000-0000-4000-a000-000000000001', 'aal2', '[{"method":"totp","timestamp":1791564303},{"method":"otp","timestamp":1791564302}]'),
  'ERR:42501', 'AC-M0-10 amr [otp,totp] -> forbidden');
select is(pg_temp.trust('e1500000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp(), true), 'ERR:42501', 'AC-M0-10 anonymous -> forbidden');
select is(pg_temp.trust('e1500000-0000-4000-a000-000000000002', 'aal2', pg_temp.pwtotp()), 'ERR:42501', 'AC-M0-10 non-admin aal2 -> forbidden');
select is(pg_temp.q($$(select trust from public.sources where slug = 'amr-src')$$), 'review', 'forbidden attempts changed nothing');
select is(pg_temp.trust('e1500000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp()), '', 'AC-M0-10 admin aal2 password+totp -> admin_set_source_trust works');
select is(pg_temp.q($$(select trust from public.sources where slug = 'amr-src')$$), 'auto', 'trust is now auto');

-- the other admin RPCs share the gate
select is(pg_temp.as_user('e1500000-0000-4000-a000-000000000002', 'aal2', pg_temp.pwtotp(), false, '(select count(*) from public.admin_list_sources())'),
  'ERR:42501', 'admin_list_sources forbidden for a non-admin');
select is(pg_temp.as_user('e1500000-0000-4000-a000-000000000001', 'aal2', pg_temp.pwtotp(), false, '(select count(*) >= 1 from public.admin_list_sources())'),
  'true', 'admin_list_sources works for the admin');
select is(pg_temp.as_user('e1500000-0000-4000-a000-000000000002', 'aal2', pg_temp.pwtotp(), false,
  $e$public.admin_set_source_enabled('amr-src', false)$e$), 'ERR:42501', 'admin_set_source_enabled forbidden for a non-admin');

select * from finish();
rollback;
