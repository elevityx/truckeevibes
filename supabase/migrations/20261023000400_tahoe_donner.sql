-- A13: Tahoe Donner events as a source (spec Amendment 13 r6).
-- 1. the `members-only` label category; 2. the `html_tahoedonner` family; 3. the tahoe-donner row (html, 24h, page_cap 45);
-- 4. the terms evidence for html only; 5. enabled at trust 'review'; 'auto' comes only from a separate follow-up migration after the conductor's post-deploy gate (A13 r7-2).
-- No SQL function changes: svc_ingest_batch keeps only known category slugs and recompute_event already writes event_categories.

insert into public.categories (slug, label, sort, noun) values ('members-only', 'Members only', 15, 'members-only event')
  on conflict (slug) do nothing;

-- Family CHECK, widen only (A14 r3-7): keep every family the live constraint already allows (a later amendment's, on a reapply) and add ours.
do $$
declare
  want text[] := array['tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager','rss','squarespace','jsonld','html','llm',
                       'html_finalsite','html_tahoedonner'];
  def  text;
  cur  text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.sources'::regclass and c.conname = 'sources_family_check';
  cur := coalesce((select array_agg(m[1]) from regexp_matches(coalesce(def, ''), '''([a-z][a-z0-9_]*)''', 'g') m), '{}');
  if def is not null and cardinality(cur) = 0 then raise exception 'family_check_unparsed'; end if;
  if def is not null and want <@ cur then return; end if;               -- nothing missing: leave the constraint untouched
  alter table public.sources drop constraint if exists sources_family_check;
  execute format('alter table public.sources add constraint sources_family_check check (family in (%s))',
                 (select string_agg(quote_literal(f), ',' order by f) from (select unnest(cur) union select unnest(want)) u(f)));
end $$;

update public.sources set family = 'html_tahoedonner', allowed_hosts = array['www.tahoedonner.com'], cadence = '24h', page_cap = 45,
  config = '{"listUrl":"https://www.tahoedonner.com/events/","tz":"America/Los_Angeles"}'::jsonb
 where slug = 'tahoe-donner';

-- Terms evidence through the gate (sets allowed_methods = {html}). The note stays in the neutral form 16_sources_seed.test.sql enforces (A5-10); the evidence: no terms-of-use page found, robots allows /events/ and event pages, calendar action views and the ai1ec ICS exporter are disallowed and not used. The hash is the robots.txt of 2026-10-19 (unchanged since A2); re-hash at the first hosted run.
select private.record_source_terms('tahoe-donner', 'permitted', array['html']::text[], 'https://www.tahoedonner.com/robots.txt', '0fe5c745546c76471ae5c41caeede4f3e6bf08a51c87aaf8bc6fd22b0ad11eb9', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted.');
update public.sources set robots_checked_at = '2026-10-19', robots_hash = '0fe5c745546c76471ae5c41caeede4f3e6bf08a51c87aaf8bc6fd22b0ad11eb9', ai_bots_blocked = false where slug = 'tahoe-donner';

update public.sources set enabled = true, trust = 'review' where slug = 'tahoe-donner';

-- Self-check (scoped: the tahoe-donner row and the members-only category only; global totals are asserted only in fresh-DB tests).
do $$ begin
  if (select count(*) from public.sources
       where slug = 'tahoe-donner' and enabled and trust = 'review' and not strict_auto and cadence = '24h' and family = 'html_tahoedonner'
         and ingest_disposition = 'permitted' and allowed_methods = array['html']::text[] and terms_recheck_at > now() and page_cap = 45) <> 1
     or not exists (select 1 from public.categories
                      where slug = 'members-only' and label = 'Members only' and sort = 15 and noun = 'members-only event') then
    raise exception 'tahoe_donner_state';
  end if;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist (unchanged: no function is added or redefined).
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
grant execute on function public.admin_owner_minutes_7d() to authenticated;
grant execute on function public.list_event_pages() to anon, authenticated;
