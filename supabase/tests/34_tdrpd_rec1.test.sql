-- Spec_Kids_Live Amendment K3 (AC-K3-01 .. 03): tdrpd-rec1 is manual-only; the cron grant path never grants it; svc_manual_grant
-- grants it at most once per cadence; a restricted source can never be scheduled.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- AC-K3-03 the row
select is((select string_agg(slug || ':' || family || ':' || trust::text || ':' || enabled::text || ':' || manual_only::text || ':' || automation_restricted::text || ':' || cadence || ':' || page_cap, ',')
             from public.sources where slug = 'tdrpd-rec1'),
  'tdrpd-rec1:rec1_catalog:review:true:true:true:24h:12', 'tdrpd-rec1: rec1_catalog, trust review, enabled, manual only, restricted, 24h, page_cap 12');
select is((select terms_note from public.sources where slug = 'tdrpd-rec1'),
  'CivicPlus ToU restricts automated access; owner accepted risk 2026-10-30; no agency OK yet', 'the terms note is honest (no agency permission claimed)');
select is((select terms_reviewed_by || ':' || ingest_disposition::text || ':' || array_to_string(allowed_methods, '+') from public.sources where slug = 'tdrpd-rec1'),
  'owner:permitted:html+api', 'reviewed by the owner (not the agency); methods html + api');
select is((select count(*) from public.sources where automation_restricted and not manual_only), 0::bigint, 'no restricted source is schedulable');
select throws_ok($$update public.sources set manual_only = false where slug = 'tdrpd-rec1'$$, '23514', null,
  'AC-K3-03 the CHECK refuses a restricted source that is not manual-only');
select lives_ok($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('k3-probe', 'Probe', 'https://secure.rec1.com/', array['secure.rec1.com'], 'rec1_catalog', 'municipal')$$,
  'the family CHECK accepts rec1_catalog');

-- AC-K3-01 the cron path skips it even when due
update public.sources set next_due_at = now() - interval '1 hour' where slug = 'tdrpd-rec1';
select is((select count(*) from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'tdrpd-rec1'), 0::bigint,
  'AC-K3-01 svc_issue_run_grants never grants a manual_only source');
select ok((select next_due_at <= now() from public.sources where slug = 'tdrpd-rec1'), 'and leaves its next_due_at alone');

-- AC-K3-02 the on-request path
select is((select g #>> '{source,slug}' from (select public.svc_manual_grant('tdrpd-rec1') g) x), 'tdrpd-rec1', 'AC-K3-02 svc_manual_grant grants it when due');
select ok((select next_due_at > now() + interval '23 hours' from public.sources where slug = 'tdrpd-rec1'), 'and moves next_due_at a cadence ahead');
select throws_ok($$select public.svc_manual_grant('tdrpd-rec1')$$, 'P0001', 'manual_grant_refused', 'a second read the same day is refused');
update public.sources set next_due_at = now() - interval '1 hour' where slug in ('tdrpd-rec1', 'alibi-truckee');
select throws_ok($$select public.svc_manual_grant('alibi-truckee')$$, 'P0001', 'manual_grant_refused', 'a scheduled source is refused');
select throws_ok($$select public.svc_manual_grant('no-such-source')$$, 'P0001', 'manual_grant_refused', 'an unknown slug is refused');
update public.sources set enabled = false where slug = 'tdrpd-rec1';
select throws_ok($$select public.svc_manual_grant('tdrpd-rec1')$$, 'P0001', 'manual_grant_refused', 'a disabled (kill-switched) source is refused');
update public.sources set enabled = true, terms_recheck_at = now() - interval '1 day' where slug = 'tdrpd-rec1';
select throws_ok($$select public.svc_manual_grant('tdrpd-rec1')$$, 'P0001', 'manual_grant_refused', 'a source whose terms recheck has passed is refused');

-- a non-ok, zero-item run through the manual grant records itself and touches no item (the kill-switch record)
update public.sources set terms_recheck_at = '2027-10-30', next_due_at = now() - interval '1 hour' where slug = 'tdrpd-rec1';
select is((select public.svc_ingest_batch((public.svc_manual_grant('tdrpd-rec1') ->> 'grant'),
             jsonb_build_object('status', 'http_error', 'started_at', now() - interval '1 minute', 'error_code', 'site_block', 'http_status', 403), '[]'::jsonb) ->> 'status'),
  'http_error', 'a site_block run records through the manual grant');
select is((select error_code from public.source_runs r join public.sources s on s.id = r.source_id where s.slug = 'tdrpd-rec1' order by r.finished_at desc limit 1),
  'site_block', 'the run carries error_code site_block');

select * from finish();
rollback;
