-- S1.13 step 3 rollout state after all migrations: only the Alibi Ale Works source is enabled, at trust 'review'.
-- The source gate is still the only way in: it keeps refusing a source whose disposition is permission_required.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local check_function_bodies = off;

-- statement -> 'OK' or 'ERR:<state>|<msg>' (the error is caught, so a refusal is one assertion, not an abort)
create function pg_temp.x(p_sql text) returns text language plpgsql as $$
declare v_msg text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text;
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '');
end $$;

select is((select enabled from public.sources where slug = 'alibi-truckee'), true, 'alibi-truckee is enabled');
select is((select trust::text from public.sources where slug = 'alibi-truckee'), 'review', 'alibi-truckee trust is still review');
select is((select strict_auto from public.sources where slug = 'alibi-truckee'), false, 'alibi-truckee has no strict auto rule yet');
select is((select ingest_disposition::text from public.sources where slug = 'alibi-truckee'), 'permitted', 'alibi-truckee is still permitted');
select is((select count(*) from public.sources where enabled), 1::bigint, 'exactly one source is enabled');
select is((select count(*) from public.sources where enabled and slug <> 'alibi-truckee'), 0::bigint, 'every other source is still disabled');
select is((select count(*) from public.sources where trust::text = 'auto'), 0::bigint, 'no source is at trust auto');

-- the gate still refuses enabling a permission_required source (and the row stays disabled)
select ok((select count(*) from public.sources where ingest_disposition = 'permission_required') > 0, 'there is a permission_required source to try');
select is(
  pg_temp.x($q$update public.sources set enabled = true where slug = (select slug from public.sources where ingest_disposition = 'permission_required' order by slug limit 1)$q$),
  'ERR:23514|source_not_permitted',
  'the source gate refuses enabling a permission_required source');
select is((select count(*) from public.sources where enabled), 1::bigint, 'still exactly one source enabled after the refused attempt');

select * from finish();
rollback;
