-- AC-M0-09. Exact ACL posture for M0 (updated by every later milestone's migration).
-- Failing-first: nothing exists until the M0 migrations land.
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

create function pg_temp.q(p_expr text) returns text language plpgsql as $$
declare r text;
begin
  execute 'select (' || p_expr || ')::text' into r;
  return coalesce(r, '<null>');
exception when others then
  return 'ERR:' || sqlstate;
end $$;

create function pg_temp.dml_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_detail text;
begin
  perform set_config('role', p_role, true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  v_state := sqlstate;
  perform set_config('role', 'postgres', true);
  return v_state || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;

-- (0) the M0 table set is exactly this (so the checks below are not vacuous)
select is(
  array(select format('%s.%s', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') order by 1),
  array['private.blocked_terms', 'public.admins', 'public.areas', 'public.categories', 'public.regions', 'public.sources'],
  'M0 tables in public + private are exactly the expected six');
select has_extension('pg_trgm', 'pg_trgm extension is installed');
select has_extension('pg_cron', 'pg_cron extension is installed');
select has_extension('pg_net', 'pg_net extension is installed');

-- (1) RLS enabled and forced on every table
select is(
  array(select format('%s.%s', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1),
  '{}'::text[], 'every table has RLS enabled');
select is(
  array(select format('%s.%s', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relforcerowsecurity order by 1),
  '{}'::text[], 'every table has RLS forced');

-- (2) anon/authenticated: no table privilege of any kind, no column privilege, no sequence privilege
select is(
  array(select format('%s:%s.%s:%s', r.role, n.nspname, c.relname, p.priv)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) r(role)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and has_table_privilege(r.role, c.oid, p.priv) order by 1),
  '{}'::text[], 'anon/authenticated have no table privilege');
select is(
  array(select format('%s:%s.%s.%s:%s', r.role, n.nspname, c.relname, a.attname, p.priv)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     cross join (values ('anon'), ('authenticated')) r(role)
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(priv)
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
      and has_column_privilege(r.role, c.oid, a.attnum, p.priv) order by 1),
  '{}'::text[], 'anon/authenticated have no column privilege');
select is(
  array(select format('%s:%s.%s:%s', r.role, n.nspname, c.relname, p.priv)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
     cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(priv)
    where n.nspname in ('public', 'private') and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.priv) order by 1),
  '{}'::text[], 'anon/authenticated/service_role have no sequence privilege');

-- (3) service_role: no privilege on any table in public/private
select is(
  array(select format('%s.%s:%s', n.nspname, c.relname, p.priv)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and has_table_privilege('service_role', c.oid, p.priv) order by 1),
  '{}'::text[], 'service_role has no table privilege');
select is(split_part(pg_temp.dml_as('service_role', $$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class)
  values ('acl-probe', 'ACL Probe', 'https://example.test/', array['example.test'], 'ics', 'organizer')$$), '|', 1),
  '42501', 'direct insert into public.sources as service_role -> 42501');

-- (4) schema USAGE
select is(pg_temp.q($$has_schema_privilege('anon', 'private', 'USAGE')$$), 'false', 'anon has no USAGE on private (schema exists)');
select is(pg_temp.q($$has_schema_privilege('authenticated', 'private', 'USAGE')$$), 'false', 'authenticated has no USAGE on private (schema exists)');

-- (5) exact EXECUTE allowlists (public schema; extension-owned functions excluded)
create function pg_temp.fn_list(p_role text, p_schema text) returns text[] language sql as $$
  select array(select format('%s(%s)', p.proname, oidvectortypes(p.proargtypes))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and has_function_privilege(p_role, p.oid, 'EXECUTE')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1)
$$;
select is(pg_temp.fn_list('anon', 'public'), array['list_sources_public()'], 'anon EXECUTE is exactly list_sources_public()');
select is(pg_temp.fn_list('authenticated', 'public'),
  array['admin_list_sources()', 'admin_set_source_enabled(text, boolean)', 'admin_set_source_trust(text, text)',
        'admin_whoami()', 'list_sources_public()'],
  'authenticated EXECUTE is list_sources_public + the four M0 admin RPCs');
select is(pg_temp.fn_list('anon', 'private'), '{}'::text[], 'anon executes nothing in private');
select is(pg_temp.fn_list('authenticated', 'private'), '{}'::text[], 'authenticated executes nothing in private');

-- (6) every SECURITY DEFINER function is owned by postgres
select is(
  array(select format('%s.%s', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef and pg_get_userbyid(p.proowner) <> 'postgres' order by 1),
  '{}'::text[], 'every SECURITY DEFINER function is owned by postgres');
select ok(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef) >= 5,
  'M0 defines its security definer functions (non-vacuous owner check)');
select is(
  array(select format('%s.%s', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef and p.proconfig is distinct from array['search_path=""'] order by 1),
  '{}'::text[], 'every SECURITY DEFINER function pins search_path = ''''');

select * from finish();
rollback;
