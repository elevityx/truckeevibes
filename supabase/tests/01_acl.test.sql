-- AC-M0-09 / AC-M1-05. Exact ACL posture, updated for M1 (spec: "updated each milestone").
-- M1 PR 1: the table set, the anon/authenticated allowlists and the service_role svc_* list now include the ingest objects.
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

-- (0) the M0 + M1 table set is exactly this (so the checks below are not vacuous)
select is(
  array(select format('%s.%s', n.nspname, c.relname)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') order by 1),
  (select array_agg(x order by x) from unnest(array[
     'private.blocked_terms', 'private.ingest_grants', 'private.ingest_nonces', 'private.lights_mirror', 'private.lights_mirror_holds',
     'private.lights_mirror_runs', 'private.notify_log',
     'public.admins', 'public.areas', 'public.categories', 'public.event_categories', 'public.event_changes', 'public.events',
     'public.geocode_usage', 'public.held_runs', 'public.owner_activity', 'public.regions', 'public.review_cards', 'public.series',
     'public.source_event_versions', 'public.source_events', 'public.source_runs', 'public.sources', 'public.suppressions',
     'public.venues']) x),
  'M0 + M1 + W1 tables in public + private are exactly the expected set (25)');
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
select is(split_part(pg_temp.dml_as('service_role', $$insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, all_day, time_known)
  values (gen_random_uuid(), 'acl-probe', '{}', 'x', 'ACL Probe', 'acl probe', now(), false, true)$$), '|', 1),
  '42501', 'AC-M1-05 direct insert into public.source_events as service_role -> 42501');
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
select is(pg_temp.fn_list('anon', 'public'),
  array['api_events_v1(text, text, integer, date, date, text[], text[], integer, text)', 'list_event_pages()', 'list_events(integer)', 'list_sources_public()'],
  'anon EXECUTE is exactly api_events_v1(...) + list_event_pages() + list_events(integer) + list_sources_public() (W1: 4)');
select is(pg_temp.fn_list('authenticated', 'public'),
  (select array_agg(x order by x) from unnest(array[
     'admin_add_suppression(text, text, text)', 'admin_card_open(uuid)', 'admin_decide_card(uuid, text, text, integer)', 'admin_list_sources()',
     'admin_log_activity(text, integer)', 'admin_merge_events(uuid, uuid)', 'admin_owner_minutes_7d()', 'admin_queue(text, integer)', 'admin_set_event_status(uuid, text, text)',
     'admin_set_source_enabled(text, boolean)', 'admin_set_source_trust(text, text)', 'admin_source_health()', 'admin_unlock_field(uuid, text)',
     'admin_update_event(uuid, jsonb)', 'admin_whoami()', 'api_events_v1(text, text, integer, date, date, text[], text[], integer, text)',
     'list_event_pages()', 'list_events(integer)', 'list_sources_public()']) x),
  'authenticated EXECUTE is the four public reads + the M0 and M1 admin RPCs (exact, W1: 19)');
select is(cardinality(pg_temp.fn_list('authenticated', 'public')), 19, 'AC-W1-17 authenticated EXECUTE count is 19');
select is(pg_temp.fn_list('service_role', 'public'),
  (select array_agg(x order by x) from unnest(array[
     'svc_cluster_and_publish(integer)', 'svc_ingest_batch(text, jsonb, jsonb)', 'svc_ingest_nonce(text)', 'svc_issue_run_grants()',
     'svc_manual_grant(text)', 'svc_set_venue_geocode(uuid, double precision, double precision, text)', 'svc_weekly_report()']) x),
  'AC-M1-05 service_role EXECUTE in public is exactly the seven svc_* routines (K3 adds svc_manual_grant)');
select is(pg_temp.fn_list('service_role', 'private'), '{}'::text[], 'service_role executes nothing in private');
select is(pg_temp.fn_list('anon', 'private'), '{}'::text[], 'anon executes nothing in private');
select is(pg_temp.fn_list('authenticated', 'private'), '{}'::text[], 'authenticated executes nothing in private');

-- (5b) AC-W1-17 role statement timeouts, set by the W1 migration (not the platform default)
select ok((select 'statement_timeout=3s' = any (rolconfig) from pg_roles where rolname = 'anon'), 'AC-W1-17 anon has statement_timeout=3s');
select ok((select 'statement_timeout=8s' = any (rolconfig) from pg_roles where rolname = 'authenticated'), 'AC-W1-17 authenticated has statement_timeout=8s');

-- (6) every SECURITY DEFINER function is owned by postgres
select is(
  array(select format('%s.%s', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef and pg_get_userbyid(p.proowner) <> 'postgres' order by 1),
  '{}'::text[], 'every SECURITY DEFINER function is owned by postgres');
select ok(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef) >= 20,
  'M0 + M1 define their security definer functions (non-vacuous owner check)');
select is(
  array(select format('%s.%s', n.nspname, p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef and p.proconfig is distinct from array['search_path=""'] order by 1),
  '{}'::text[], 'every SECURITY DEFINER function pins search_path = ''''');

select * from finish();
rollback;
