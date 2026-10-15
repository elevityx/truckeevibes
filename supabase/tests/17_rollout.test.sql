-- S1.13 step 3 rollout state after all migrations: Alibi Ale Works is enabled at trust 'auto' (its first runs were reviewed); Truckee Chamber is enabled at trust 'review'.
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
select is((select trust::text from public.sources where slug = 'alibi-truckee'), 'auto', 'alibi-truckee trust is auto');
select is((select strict_auto from public.sources where slug = 'alibi-truckee'), false, 'alibi-truckee has no strict auto rule yet');
select is((select ingest_disposition::text from public.sources where slug = 'alibi-truckee'), 'permitted', 'alibi-truckee is still permitted');
select is((select enabled from public.sources where slug = 'truckee-chamber'), true, 'truckee-chamber is enabled');
select is((select trust::text from public.sources where slug = 'truckee-chamber'), 'review', 'truckee-chamber trust stays review');
select is((select strict_auto from public.sources where slug = 'truckee-chamber'), false, 'truckee-chamber has no strict auto rule');
select is((select ingest_disposition::text from public.sources where slug = 'truckee-chamber'), 'permitted', 'truckee-chamber is permitted');
select is((select count(*) from public.sources where enabled), 2::bigint, 'exactly two sources are enabled');
select is((select string_agg(slug, ',' order by slug) from public.sources where enabled), 'alibi-truckee,truckee-chamber', 'the enabled sources are alibi-truckee and truckee-chamber');
select is((select count(*) from public.sources where enabled and slug not in ('alibi-truckee','truckee-chamber')), 0::bigint, 'every other source is still disabled');
select is((select string_agg(slug, ',' order by slug) from public.sources where trust::text = 'auto'), 'alibi-truckee', 'alibi-truckee is the only source at trust auto');
select is((select count(*) from public.sources where trust::text = 'auto' and class = 'aggregator'), 0::bigint, 'no aggregator is at trust auto');

-- the gate still refuses enabling a permission_required source (and the row stays disabled)
select ok((select count(*) from public.sources where ingest_disposition = 'permission_required') > 0, 'there is a permission_required source to try');
select is(
  pg_temp.x($q$update public.sources set enabled = true where slug = (select slug from public.sources where ingest_disposition = 'permission_required' order by slug limit 1)$q$),
  'ERR:23514|source_not_permitted',
  'the source gate refuses enabling a permission_required source');
select is((select count(*) from public.sources where enabled), 2::bigint, 'still exactly two sources enabled after the refused attempt');

-- Fixture: a pending Alibi event with an open card is published, and the card closes auto_published, after a trust change + drain.
create function pg_temp.ts(p_days int, p_hh int, p_plus int default 0) returns text language sql as $$
  select to_char(((((now() at time zone 'America/Los_Angeles')::date + p_days) + make_time(p_hh, 0, 0)
                   + make_interval(mins => p_plus)) at time zone 'America/Los_Angeles') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.drain() returns void language plpgsql as $$
declare r jsonb; i int := 0;
begin
  loop r := public.svc_cluster_and_publish(500); i := i + 1; exit when (r ->> 'remaining')::int = 0 or i > 10; end loop;
end $$;
-- ingest one item as alibi-truckee (trust is put back to review first, so the event lands pending with a card)
update public.sources set trust = 'review' where slug = 'alibi-truckee';
create function pg_temp.ingest_fixture() returns void language plpgsql as $$
declare v_tok text; v_host text;
begin
  select allowed_hosts[1] into v_host from public.sources where slug = 'alibi-truckee';
  update public.sources set next_due_at = now() + interval '1 day' where slug <> 'alibi-truckee' and next_due_at <= now();
  update public.sources set next_due_at = now() where slug = 'alibi-truckee';
  select g ->> 'grant' into v_tok from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'alibi-truckee';
  perform public.svc_ingest_batch(v_tok,
    jsonb_build_object('status', 'ok', 'started_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'http_status', 200, 'parser_version', 'test-1'),
    jsonb_build_array(jsonb_build_object('externalKey', 'rollout-fx1', 'title', 'Rollout Fixture Night', 'startsAt', pg_temp.ts(3, 18),
      'endsAt', pg_temp.ts(3, 18, 120), 'allDay', false, 'timeKnown', true, 'venueName', 'Test Hall', 'address', '10 Main St', 'town', 'Truckee',
      'lat', 39.328, 'lng', -120.1833, 'url', 'https://' || v_host || '/e/rollout-fx1', 'priceKind', 'free', 'age', 'unknown',
      'categoriesHint', jsonb_build_array('music'))));
end $$;
select pg_temp.ingest_fixture();
select pg_temp.drain();
select is((select e.status::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'rollout-fx1'), 'pending', 'fixture: under review trust the Alibi event is pending');
select is((select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = 'rollout-fx1' and c.kind = 'event' and c.status = 'open'), 1::bigint, 'fixture: it has one open event card');
update public.sources set trust = 'auto' where slug = 'alibi-truckee';
select pg_temp.drain();
select is((select e.status::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'rollout-fx1'), 'published', 'after the trust change + drain the event is published');
select is((select c.decision::text from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = 'rollout-fx1' and c.kind = 'event'), 'auto_published', 'its card is closed auto_published');
select is((select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = 'rollout-fx1' and c.status = 'open'), 0::bigint, 'and no card is left open');

select * from finish();
rollback;
