-- Rollout step 3: Visit Lake Tahoe gets the strict auto-publish rule (Amendment 2, D13: owner-approved). strict_auto is migration-only.
-- Trust stays 'review' (an aggregator is never at 'auto'). Its first run was reviewed on hosted: 3 items, all held by the strict rule as age_ambiguous.
-- The sources gate applies, and the re-queue trigger (private.sources_trust_requeue) queues the source's live occurrences so the next drain re-evaluates them.
update public.sources set strict_auto = true where slug = 'visit-lake-tahoe';

-- Self-check (true on a fresh reset and on the hosted DB). Asserts the Visit Lake Tahoe row only.
do $$ begin
  if not exists (select 1 from public.sources where slug = 'visit-lake-tahoe' and enabled and class = 'aggregator' and trust = 'review' and strict_auto) then
    raise exception 'vlt_strict_auto_state';
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
