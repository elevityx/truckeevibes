-- S1.13 step 3 rollout state after all migrations: Alibi Ale Works and TDRPD are enabled at trust 'auto' (first runs reviewed); Truckee Chamber is enabled at trust 'auto' (A10);
-- Visit Lake Tahoe (aggregator) stays at trust 'review' with the owner-approved strict_auto rule (Amendment 2, D13).
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
select is((select trust::text from public.sources where slug = 'truckee-chamber'), 'auto', 'truckee-chamber trust is auto (A10)');
select is((select strict_auto from public.sources where slug = 'truckee-chamber'), false, 'truckee-chamber has no strict auto rule');
select is((select ingest_disposition::text from public.sources where slug = 'truckee-chamber'), 'permitted', 'truckee-chamber is permitted');
select is((select enabled from public.sources where slug = 'visit-lake-tahoe'), true, 'visit-lake-tahoe is enabled');
select is((select trust::text from public.sources where slug = 'visit-lake-tahoe'), 'review', 'visit-lake-tahoe trust stays review');
select is((select strict_auto from public.sources where slug = 'visit-lake-tahoe'), true, 'visit-lake-tahoe has the strict auto rule (Amendment 2 D13)');
select is((select ingest_disposition::text from public.sources where slug = 'visit-lake-tahoe'), 'permitted', 'visit-lake-tahoe is permitted');
select is((select class::text from public.sources where slug = 'visit-lake-tahoe'), 'aggregator', 'visit-lake-tahoe is an aggregator');
select is((select config #>> '{filter,excludeCategorySlugs}' from public.sources where slug = 'visit-lake-tahoe'), '["attractions-events", "wellness", "tahoe-blue-event-center"]', 'visit-lake-tahoe excludeCategorySlugs are still the exact three');
select is((select enabled from public.sources where slug = 'tdrpd'), true, 'tdrpd is enabled');
select is((select trust::text from public.sources where slug = 'tdrpd'), 'auto', 'tdrpd trust is auto');
select is((select strict_auto from public.sources where slug = 'tdrpd'), false, 'tdrpd has no strict auto rule');
select is((select ingest_disposition::text from public.sources where slug = 'tdrpd'), 'permitted', 'tdrpd is permitted');
select is((select count(*) from public.sources where enabled), 12::bigint, 'exactly twelve sources are enabled (four rollout sources + seven TTUSD sources + Tahoe Donner, A12, A13)');
select is((select string_agg(slug, ',' order by slug) from public.sources where enabled), 'alibi-truckee,tahoe-donner,tdrpd,truckee-chamber,ttusd-acms,ttusd-district,ttusd-nths,ttusd-nts,ttusd-te,ttusd-ths,ttusd-tle,visit-lake-tahoe', 'the enabled sources are the four rollout sources, Tahoe Donner and the seven TTUSD sources');
select is((select count(*) from public.sources where enabled and slug not in ('alibi-truckee','tahoe-donner','tdrpd','truckee-chamber','visit-lake-tahoe') and slug not like 'ttusd-%'), 0::bigint, 'every other source is still disabled');
select is((select string_agg(slug, ',' order by slug) from public.sources where trust::text = 'auto'), 'alibi-truckee,tdrpd,truckee-chamber,ttusd-acms,ttusd-district,ttusd-nths,ttusd-nts,ttusd-te,ttusd-ths,ttusd-tle', 'alibi-truckee, tdrpd, truckee-chamber and the seven TTUSD sources are the only sources at trust auto (A10, A12)');
select is((select count(*) from public.sources where trust::text = 'auto'), 10::bigint, 'exactly ten sources are at trust auto (A10, A12; A13 ships Tahoe Donner at review)');
select is((select string_agg(slug, ',' order by slug) from public.sources where strict_auto), 'visit-lake-tahoe', 'visit-lake-tahoe is the only source with strict_auto');
select is((select count(*) from public.sources where trust::text = 'auto' and class = 'aggregator'), 0::bigint, 'no aggregator is at trust auto');

-- the gate still refuses enabling a permission_required source (and the row stays disabled)
select ok((select count(*) from public.sources where ingest_disposition = 'permission_required') > 0, 'there is a permission_required source to try');
select is(
  pg_temp.x($q$update public.sources set enabled = true where slug = (select slug from public.sources where ingest_disposition = 'permission_required' order by slug limit 1)$q$),
  'ERR:23514|source_not_permitted',
  'the source gate refuses enabling a permission_required source');
select is((select count(*) from public.sources where enabled), 12::bigint, 'still exactly twelve sources enabled after the refused attempt');

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

-- Fixture: Visit Lake Tahoe (aggregator, trust review, strict_auto true). An item that passes the strict rule publishes through rule:strict_auto;
-- an item that fails it (age ambiguous at a nightlife-category event) stays pending with an open card.
create function pg_temp.ingest_vlt() returns void language plpgsql as $$
declare v_tok text; v_host text;
begin
  select allowed_hosts[1] into v_host from public.sources where slug = 'visit-lake-tahoe';
  update public.sources set next_due_at = now() + interval '1 day' where slug <> 'visit-lake-tahoe' and next_due_at <= now();
  update public.sources set next_due_at = now() where slug = 'visit-lake-tahoe';
  select g ->> 'grant' into v_tok from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'visit-lake-tahoe';
  perform public.svc_ingest_batch(v_tok,
    jsonb_build_object('status', 'ok', 'started_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'http_status', 200, 'parser_version', 'test-1'),
    jsonb_build_array(
      jsonb_build_object('externalKey', 'vlt-pass', 'title', 'Rollout Lakeside Concert Series', 'startsAt', pg_temp.ts(4, 18),
        'endsAt', pg_temp.ts(4, 18, 120), 'allDay', false, 'timeKnown', true, 'venueName', 'Strict Test Park', 'address', '20 Main St', 'town', 'Truckee',
        'lat', 39.328, 'lng', -120.1833, 'url', 'https://' || v_host || '/e/vlt-pass', 'priceKind', 'free', 'age', 'all_ages',
        'categoriesHint', jsonb_build_array('music')),
      jsonb_build_object('externalKey', 'vlt-fail', 'title', 'Rollout Brewery Tasting Night', 'startsAt', pg_temp.ts(5, 19),
        'endsAt', pg_temp.ts(5, 19, 120), 'allDay', false, 'timeKnown', true, 'venueName', 'Strict Test Brewery', 'address', '30 Main St', 'town', 'Truckee',
        'lat', 39.329, 'lng', -120.1834, 'url', 'https://' || v_host || '/e/vlt-fail', 'priceKind', 'paid', 'age', 'unknown',
        'categoriesHint', jsonb_build_array('nightlife'))));
end $$;
select pg_temp.ingest_vlt();
select pg_temp.drain();
select is((select string_agg(slug || ':' || trust::text || ':' || strict_auto::text, ',') from public.sources where slug = 'visit-lake-tahoe'), 'visit-lake-tahoe:review:true', 'vlt fixture: trust review and strict_auto true during ingest');
select is((select e.status::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'vlt-pass'), 'published', 'strict_auto: the VLT item that passes the strict rule is published');
select is((select count(*) from public.event_changes ec join public.source_events se on se.cluster_id = ec.event_id where se.external_key = 'vlt-pass' and ec.field = 'status' and ec.decided_by = 'rule:strict_auto'), 1::bigint, 'it is journaled decided_by rule:strict_auto');
select is((select e.status::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'vlt-fail'), 'pending', 'strict_auto: the VLT item that fails the strict rule stays pending');
select is((select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = 'vlt-fail' and c.kind = 'event' and c.status = 'open'), 1::bigint, 'and it has one open event card');
select is(private.strict_auto_fails((select e from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'vlt-fail')), array['age_ambiguous'], 'the failing item fails the strict rule only on age_ambiguous');

select * from finish();
rollback;
