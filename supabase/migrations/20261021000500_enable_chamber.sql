-- Rollout step 4: enable the Truckee Chamber source (ChamberMaster HTML discovery plus per-event ICS, cadence 72h).
-- Trust stays 'review' until its first run is reviewed; every other source keeps its state.
-- The sources gate trigger validates this update; no bypass.
update public.sources set enabled = true where slug = 'truckee-chamber';

-- Self-check (true on a fresh reset and on the hosted DB).
do $$ begin
  if (select count(*) from public.sources where enabled) <> 2
     or not exists (select 1 from public.sources where slug = 'alibi-truckee' and enabled and trust = 'auto' and not strict_auto)
     or not exists (select 1 from public.sources where slug = 'truckee-chamber' and enabled and trust = 'review' and not strict_auto)
     or (select count(*) from public.sources where trust = 'auto') <> 1 then
    raise exception 'chamber_enable_state';
  end if;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist (unchanged; this migration adds no function).
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
