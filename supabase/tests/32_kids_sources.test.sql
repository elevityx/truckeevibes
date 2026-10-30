-- AC-K-26 (Spec_Kids_Live K1): the three LibCal source rows, their terms record, the rss_libcal family, and tdrpd disabled.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is((select count(*) from public.sources where family = 'rss_libcal'), 3::bigint, 'three rss_libcal sources');
select is((select string_agg(slug || ':' || trust::text || ':' || enabled::text || ':' || class::text || ':' || page_cap || ':' || cadence, ',' order by slug)
             from public.sources where family = 'rss_libcal'),
  'libcal-kings-beach:auto:true:municipal:1:24h,libcal-tahoe-city:auto:true:municipal:1:24h,libcal-truckee:auto:true:municipal:1:24h',
  'slug, trust auto, enabled, municipal, page_cap 1, cadence 24h');
select is((select count(*) from public.sources where family = 'rss_libcal' and ingest_disposition = 'permitted' and allowed_methods = array['feed']::text[]
             and (terms_recheck_at at time zone 'UTC')::date = date '2027-10-30' and not strict_auto and ai_bots_blocked
             and terms_url like 'https://%.libcal.com/robots.txt' and char_length(terms_note) <= 200), 3::bigint,
  'record_source_terms: permitted, {feed}, recheck 2027-10-30, robots URL as evidence, ai_bots_blocked');
select is((select config ->> 'feedUrl' from public.sources where slug = 'libcal-truckee'),
  'https://nevadacountyca.libcal.com/rss.php?cid=20247&m=month&cam=8465', 'Truckee reads the Truckee campus month feed');
select is((select string_agg(config ->> 'campus', ',' order by slug) from public.sources where family = 'rss_libcal'),
  'Kings Beach Library,Tahoe City Library,Truckee Library', 'each source pins its branch');
select is((select enabled from public.sources where slug = 'tdrpd'), false, 'tdrpd is disabled (DR-K5)');
select is((select robots_hash from public.sources where slug = 'tdrpd'), 'e4a649eaffd96bdf90c5355da98e1cb3aaab71860e2b66c332ef53a8071bc825', 'tdrpd robots hash is the 2026-10-30 file');
select is((select trust::text from public.sources where slug = 'tdrpd'), 'auto', 'tdrpd trust is unchanged');

select lives_ok($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('k1-probe', 'Probe', 'https://x.libcal.com/', array['x.libcal.com'], 'rss_libcal', 'municipal')$$,
  'the family CHECK accepts rss_libcal');
select throws_ok($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('k1-bogus', 'Bogus', 'https://example.test/', array['example.test'], 'rss_bogus', 'municipal')$$,
  '23514', null, 'the family CHECK still refuses an unknown family');

-- grants are issued for the three libraries (enabled, permitted, recheck in the future, due)
select is((select count(*) from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' like 'libcal-%'), 3::bigint,
  'each library gets a run grant');

select * from finish();
rollback;
