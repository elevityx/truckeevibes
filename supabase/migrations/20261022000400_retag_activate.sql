-- R4c: re-tag activation. (1) notice_sibling_exists compares the same-source source_events.title (not the cluster title) and adds the
-- series rule (>= 2 same-source occurrences within 14 days either side); (2) re-run the one-shot notice hide; (3) reset the sources'
-- fetch cache so the next ingest re-reads every feed with the c2 classifier. No public function; the 24-grant allowlist is unchanged.
create or replace function private.notice_sibling_exists(p_title text, p_source uuid, p_day date, p_exclude uuid default null) returns boolean
language sql stable set search_path = '' as $$
  select private.notice_rest(p_title) is not null and exists (
    select 1 from public.events e join public.source_events se on se.cluster_id = e.id
     where se.source_id = p_source and e.start_day = p_day and e.merged_into is null
       and e.status not in ('rejected', 'hidden') and (p_exclude is null or e.id <> p_exclude)
       and btrim(regexp_replace(lower(se.title), '\s+', ' ', 'g')) = private.notice_rest(p_title))   -- R4c
  -- R4c begin (Amendment R4b-1): or a series of <rest> from the same source (>= 2 events within 14 days either side); nothing to cancel
  or (select count(distinct e.id) from public.events e join public.source_events se on se.cluster_id = e.id
       where se.source_id = p_source and e.start_day between p_day - 14 and p_day + 14 and e.merged_into is null
         and e.status not in ('rejected', 'hidden') and (p_exclude is null or e.id <> p_exclude)
         and btrim(regexp_replace(lower(se.title), '\s+', ' ', 'g')) = private.notice_rest(p_title)) >= 2
  -- R4c end
$$;

select private.hide_notice_events();

update public.sources set etag = null, last_modified = null, content_hash = null, next_due_at = now() where enabled;

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
