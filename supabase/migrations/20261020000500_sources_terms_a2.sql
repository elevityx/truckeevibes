-- M1 source terms and configuration (spec S1.13a, Amendment 2). Disposition, URLs, hashes and dates from the terms review in the private vault; the reasoning is not in this repo;
-- every row stays disabled (enabling is the rollout in S1.13 step 3). The M0 seed values that M1 overrides
-- (Visit Lake Tahoe class, the squarespace family on two rows, the cadence check) change here, never in the M0 files.

select private.record_source_terms('diamond-peak', 'permission_required', array[]::text[],
  'https://www.diamondpeak.com/terms-of-use/', 'c6a2153ed976b16eabe72e2de17f8de2435d9b4130692b14a3bbc4136dcf8c79',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permission_required.');
select private.record_source_terms('ivgid', 'permission_required', array[]::text[],
  'https://www.yourtahoeplace.com/terms-of-use/', '969431a2694ad39bbff526c0b9d393ad335386527c9c31d914140c80cc6657f2',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permission_required.');
select private.record_source_terms('visit-lake-tahoe', 'permitted', array['api']::text[],
  'https://visitlaketahoe.com/legal-disclaimer/', '526a7ab4b0a99768dc56b658f10e9db71c2c4ccc10cf4553e5561e7a0cc1cd8d',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permitted.');
select private.record_source_terms('truckee-chamber', 'permitted', array['feed','html']::text[],
  'https://business.truckee.com/robots.txt', '0072b765859b8159c8b9d70a73c1799224b6f5f310dfdd8d5cf323050b778904',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permitted.');
select private.record_source_terms('tdrpd', 'permitted', array['feed']::text[],
  'https://www.tdrpd.org/copyright', 'deb626d8f72b009ac6527869f74931383ca362b844f010f454f07cb2ade6b4bc',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permitted.');
select private.record_source_terms('alibi-truckee', 'permitted', array['feed']::text[],
  'https://www.alibialeworks.com/robots.txt', 'afa0c964be19495d2199bd3fa1059db5954695bd478ba703f6c510220804238c',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permitted.');
select private.record_source_terms('tahoe-donner', 'permitted', array['feed','html']::text[],
  'https://www.tahoedonner.com/robots.txt', '0fe5c745546c76471ae5c41caeede4f3e6bf08a51c87aaf8bc6fd22b0ad11eb9',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permitted.');
select private.record_source_terms('truckee-roundhouse', 'permission_required', array[]::text[],
  'https://www.truckeeroundhouse.org/robots.txt', '664a025b29efffc7d65b6a7ffdb932d1031659b7a6d143f713744dc7df070fd9',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permission_required.');
select private.record_source_terms('arts-for-the-schools', 'permitted', array['html']::text[],
  'https://www.artsfortheschools.org/robots.txt', 'b8b63967ce1926c88db1906602669b6b215ef81944f72cc5d9b26b6c1b03124d',
  'conductor', '2026-10-15', '2027-10-14',
  'Terms review 2026-10-15: permitted.');

update public.sources set robots_checked_at = '2026-10-15', robots_hash = 'ffa73966140ab72cda294ac88c5545fcea51131380e62465d48c4ae52654c192', ai_bots_blocked = false where slug = 'diamond-peak';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = 'efaea693d63f2a9b1944315ca15ea720c3b7a933f701e94cacb6d75d3f96e013', ai_bots_blocked = false where slug = 'ivgid';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = '02929bea400b32e8906d800bc23440937081e5e558ad6b6965e24ac63ac30df8', ai_bots_blocked = false where slug = 'visit-lake-tahoe';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = '0072b765859b8159c8b9d70a73c1799224b6f5f310dfdd8d5cf323050b778904', ai_bots_blocked = false where slug = 'truckee-chamber';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = 'a69dc067955787eb71580a86ac6877948ca5a641360c95e6655fc30ab87d749e', ai_bots_blocked = false where slug = 'tdrpd';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = 'afa0c964be19495d2199bd3fa1059db5954695bd478ba703f6c510220804238c', ai_bots_blocked = false where slug = 'alibi-truckee';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = '0fe5c745546c76471ae5c41caeede4f3e6bf08a51c87aaf8bc6fd22b0ad11eb9', ai_bots_blocked = false where slug = 'tahoe-donner';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = '664a025b29efffc7d65b6a7ffdb932d1031659b7a6d143f713744dc7df070fd9', ai_bots_blocked = false where slug = 'truckee-roundhouse';
update public.sources set robots_checked_at = '2026-10-15', robots_hash = 'b8b63967ce1926c88db1906602669b6b215ef81944f72cc5d9b26b6c1b03124d', ai_bots_blocked = false where slug = 'arts-for-the-schools';

-- Configuration per source (S1.13a table). Tahoe Donner keeps its recorded evidence and nothing else (deferred to M4).
update public.sources set config = '{"icsUrl":"https://alibialeworks.com/events.ics"}', cadence = '24h' where slug = 'alibi-truckee';
update public.sources set config = '{"listUrl":"https://business.truckee.com/events"}', cadence = '72h' where slug = 'truckee-chamber';
update public.sources set class = 'aggregator', max_cards_7d = 3, cadence = '24h',
  config = '{"base":"https://visitlaketahoe.com","tz":"America/Los_Angeles","filter":{"windowDays":45,"towns":["truckee","tahoe city","kings beach","tahoe vista","carnelian bay","incline village","crystal bay","olympic valley","soda springs"],"maxDurationDays":14,"excludeCategorySlugs":["attractions-events","wellness","tahoe-blue-event-center"],"maxItems":300}}'
  where slug = 'visit-lake-tahoe';
update public.sources set config = '{"base":"https://www.tdrpd.org","catIds":[14,23,24,25,26,27,28]}', cadence = '168h' where slug = 'tdrpd';
update public.sources set family = 'html', config = '{}' where slug = 'arts-for-the-schools';
update public.sources set trust = 'link_only' where slug in ('diamond-peak', 'ivgid');
update public.sources set trust = 'link_only', family = 'html' where slug = 'truckee-roundhouse';

-- Boundary self-check: the pre-rollout snapshot (nothing enabled, no strict rule, six permitted) is proven when applied.
do $$ begin
  if exists (select 1 from public.sources where slug in ('alibi-truckee','truckee-chamber','visit-lake-tahoe','tdrpd','tahoe-donner','arts-for-the-schools','diamond-peak','ivgid','truckee-roundhouse') and (enabled or strict_auto))
     or (select count(*) from public.sources where slug in ('alibi-truckee','truckee-chamber','visit-lake-tahoe','tdrpd','tahoe-donner','arts-for-the-schools','diamond-peak','ivgid','truckee-roundhouse') and ingest_disposition = 'permitted') <> 6 then
    raise exception 'seed_state';
  end if;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist.
revoke all on all tables    in schema public, private from service_role;
revoke all on all sequences in schema public, private from service_role;
revoke execute on all functions in schema public  from public, anon, authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;

grant execute on function public.list_sources_public() to anon, authenticated;
grant execute on function public.list_events(integer) to anon, authenticated;
grant execute on function public.admin_whoami() to authenticated;
grant execute on function public.admin_list_sources() to authenticated;
grant execute on function public.admin_set_source_enabled(text, boolean) to authenticated;
grant execute on function public.admin_set_source_trust(text, text) to authenticated;
grant execute on function public.admin_merge_events(uuid, uuid) to authenticated;
grant execute on function public.admin_queue(text, integer) to authenticated;
grant execute on function public.admin_card_open(uuid) to authenticated;
grant execute on function public.admin_decide_card(uuid, text, text, integer) to authenticated;
grant execute on function public.admin_update_event(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_event_status(uuid, text, text) to authenticated;
grant execute on function public.admin_unlock_field(uuid, text) to authenticated;
grant execute on function public.admin_source_health() to authenticated;
grant execute on function public.admin_add_suppression(text, text, text) to authenticated;
grant execute on function public.admin_log_activity(text, integer) to authenticated;
grant execute on function public.svc_ingest_nonce(text) to service_role;
grant execute on function public.svc_issue_run_grants() to service_role;
grant execute on function public.svc_ingest_batch(text, jsonb, jsonb) to service_role;
grant execute on function public.svc_set_venue_geocode(uuid, double precision, double precision, text) to service_role;
grant execute on function public.svc_cluster_and_publish(integer) to service_role;
grant execute on function public.svc_weekly_report() to service_role;
