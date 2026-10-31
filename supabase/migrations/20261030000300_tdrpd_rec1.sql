-- Kids live K3 (Spec_Kids_Live Amendment K3): TDRPD youth programs from the Rec1 catalog, read only on request.
-- The owner accepted the CivicPlus Terms of Use risk (2026-10-30); TDRPD has not given permission, and the terms note says so.
-- 1. `sources.manual_only` + `sources.automation_restricted` (CHECK: restricted => manual only). The scheduled path never grants a
--    manual-only source; 2. `svc_issue_run_grants()` replaced with that one extra predicate (same signature); 3. `svc_manual_grant(text)`
--    issues one grant for one due manual-only source (cadence 24h => at most one read a day); 4. family `rec1_catalog` (widen only);
-- 5. the `tdrpd-rec1` row at trust 'review' with its terms record; 6. self-check; 7. canonical block + allowlist (+ svc_manual_grant).

alter table public.sources add column if not exists manual_only boolean not null default false;
alter table public.sources add column if not exists automation_restricted boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_restricted_manual_check') then
    alter table public.sources add constraint sources_restricted_manual_check check (not automation_restricted or manual_only);
  end if;
end $$;

-- Family CHECK, widen only (A14 r3-7 pattern).
do $$
declare
  want text[] := array['tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager','rss','squarespace','jsonld','html','llm',
                       'html_finalsite','html_tahoedonner','wprest_crystalbay','curated_dates','rss_libcal','rec1_catalog'];
  def  text;
  cur  text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.sources'::regclass and c.conname = 'sources_family_check';
  cur := coalesce((select array_agg(m[1]) from regexp_matches(coalesce(def, ''), '''([a-z][a-z0-9_]*)''', 'g') m), '{}');
  if def is not null and cardinality(cur) = 0 then raise exception 'family_check_unparsed'; end if;
  if def is not null and want <@ cur then return; end if;
  alter table public.sources drop constraint if exists sources_family_check;
  execute format('alter table public.sources add constraint sources_family_check check (family in (%s))',
                 (select string_agg(quote_literal(f), ',' order by f) from (select unnest(cur) union select unnest(want)) u(f)));
end $$;

-- The scheduled (cron) path: the 20261020000200 body plus `and not x.manual_only`.
create or replace function public.svc_issue_run_grants() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid; v_out jsonb := '[]'::jsonb;
begin
  for s in
    select * from public.sources x
     where x.enabled and not x.opt_out and x.trust <> 'link_only' and not x.manual_only
       and x.ingest_disposition in ('permitted', 'official_api_only') and x.terms_recheck_at > now()
       and cardinality(x.allowed_methods) > 0 and x.next_due_at <= now()
     order by x.next_due_at for update skip locked
  loop
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_run := gen_random_uuid();
    insert into private.ingest_grants (token_hash, source_id, run_id, expires_at)
      values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes');
    update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
      'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
      'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'etag', s.etag, 'last_modified', s.last_modified,
      'content_hash', s.content_hash, 'ingest_disposition', s.ingest_disposition, 'terms_recheck_at', s.terms_recheck_at)));
  end loop;
  return jsonb_build_object('grants', v_out);
end $$;

-- The on-request path: one grant for one manual-only source that is ingest-permitted and due (same grant shape as above).
create or replace function public.svc_manual_grant(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid;
begin
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found or not s.manual_only or not private.source_ingest_permitted(s) or s.next_due_at > now() then
    raise exception 'manual_grant_refused' using errcode = 'P0001';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_run := gen_random_uuid();
  insert into private.ingest_grants (token_hash, source_id, run_id, expires_at)
    values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes');
  update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
  return jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
    'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
    'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'ingest_disposition', s.ingest_disposition,
    'terms_recheck_at', s.terms_recheck_at));
end $$;

-- Setup runs only when the row is new (review r2-7): a re-apply never re-enables a source the kill switch disabled, never resets trust
-- after the first-run check, and never overwrites newer terms evidence.
do $$ begin
  if exists (select 1 from public.sources where slug = 'tdrpd-rec1') then return; end if;
  insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, cadence, page_cap, config) values
    ('tdrpd-rec1', 'Truckee Donner Recreation & Park District programs', 'https://secure.rec1.com/CA/tdrpd/catalog',
     array['secure.rec1.com'], 'rec1_catalog', 'municipal'::public.source_class, '24h', 12,
     '{"catalogUrl":"https://secure.rec1.com/CA/tdrpd/catalog","tz":"America/Los_Angeles","town":"Truckee","venues":[{"match":"community pool|swimming pool|aquatic","name":"Truckee Community Pool","address":"10939 Truckee Way, Truckee, CA 96161","lat":39.3384825,"lng":-120.1719775},{"match":"rec(reation)? center|community center|steve randall|\\bcrc\\b","name":"Truckee Community Recreation Center","address":"10981 Truckee Way, Truckee, CA 96161","lat":39.3393187,"lng":-120.1720436},{"match":"regional park","name":"Truckee River Regional Park","lat":39.3279814,"lng":-120.1743139},{"match":"veterans hall","name":"Veterans Hall","address":"10214 High St, Truckee, CA 96161","lat":39.3278638,"lng":-120.1886426}]}'::jsonb);
  perform private.record_source_terms('tdrpd-rec1', 'permitted', array['html','api']::text[],
    'https://www.civicplus.help/legal-center/docs/civicplus-terms-of-use',
    'b0f1ea35ac30d7127d7b9d38e83fe5d29712a8e5e2d32b1ee6a34031b02ca0b9', 'owner', '2026-10-30', '2027-10-30',
    'CivicPlus ToU restricts automated access; owner accepted risk 2026-10-30; no agency OK yet');
  update public.sources set manual_only = true, automation_restricted = true, robots_checked_at = '2026-10-30',
         robots_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', ai_bots_blocked = false
   where slug = 'tdrpd-rec1';
  update public.sources set enabled = true where slug = 'tdrpd-rec1';
end $$;

-- Self-check: identity and the manual-only flags (not enabled/trust, which operations may change later).
do $$ begin
  if not exists (select 1 from public.sources s where s.slug = 'tdrpd-rec1' and s.family = 'rec1_catalog' and s.class = 'municipal'
                   and s.allowed_hosts = array['secure.rec1.com'] and s.manual_only and s.automation_restricted and not s.strict_auto
                   and s.terms_note like 'CivicPlus ToU restricts automated access; owner accepted risk%')
     or exists (select 1 from public.sources where automation_restricted and not manual_only) then
    raise exception 'tdrpd_rec1_state';
  end if;
end $$;

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
grant execute on function public.api_events_v1(text, text, integer, date, date, text[], text[], integer, text) to anon, authenticated;
grant execute on function public.svc_manual_grant(text) to service_role;
