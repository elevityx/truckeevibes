-- AC-M0-13: list_sources_public() as anon.
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
create function pg_temp.q_as(p_role text, p_expr text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('role', p_role, true);
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate;
end $$;

-- fixtures: active (enabled), link_only, paused (disabled), opt_out (hidden)
select is(pg_temp.dml($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, ingest_disposition,
    allowed_methods, terms_url, terms_hash, terms_reviewed_at, terms_recheck_at, enabled, trust, opt_out)
  values
  ('pub-active', 'B Active', 'https://example.test/a', array['example.test'], 'ics', 'organizer', 'permitted', '{feed}',
     'https://example.test/t', repeat('a', 64), now(), now() + interval '30 days', true, 'auto', false),
  ('pub-linkonly', 'C Link Only', 'https://example.test/l', array['example.test'], 'html', 'community', 'unknown', '{}',
     null, null, null, null, false, 'link_only', false),
  ('pub-paused', 'A Paused', 'https://example.test/p', array['example.test'], 'ics', 'venue', 'unknown', '{}',
     null, null, null, null, false, 'review', false),
  ('pub-optout', 'D Opt Out', 'https://example.test/o', array['example.test'], 'ics', 'venue', 'unknown', '{}',
     null, null, null, null, false, 'review', true)$$), 'OK', 'fixture sources insert');

select is(pg_temp.q_as('anon', $$(select count(*) from public.list_sources_public() s where s.name like any (array['A %', 'B %', 'C %', 'D %']))$$),
  '3', 'AC-M0-13 three fixture rows visible (opt_out hidden)');
select is(pg_temp.q_as('anon', $$(select string_agg(s.name || '=' || s.status, ',' order by s.name)
  from public.list_sources_public() s where s.name like any (array['A %', 'B %', 'C %', 'D %']))$$),
  'A Paused=paused,B Active=active,C Link Only=link_only', 'AC-M0-13 statuses active / link_only / paused, ordered by name');
select is(pg_temp.q_as('anon', $$(select count(*) from public.list_sources_public() s where s.name = 'D Opt Out')$$),
  '0', 'AC-M0-13 opt_out source is absent');
select is(
  array(select x.n from (select unnest(p.proargnames) as n, unnest(p.proargmodes) as m
                           from pg_proc p
                          where p.proname = 'list_sources_public' and p.pronamespace = 'public'::regnamespace) x
         where x.m in ('t', 'o')),
  array['name', 'homepage_url', 'status'],
  'AC-M0-13 result columns are exactly (name, homepage_url, status)');
select is(pg_temp.q_as('anon', $$(select count(*) from public.sources)$$), 'ERR:42501', 'anon cannot select from sources');

select * from finish();
rollback;
