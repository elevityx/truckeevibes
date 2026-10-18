-- Amendment 11: a working geocoder + no demotion by stale held runs.
-- (1) take_geocode_budget also sends the street address as its own field so the Edge function can try Census first.
-- (2) venues.geocoder accepts 'census'.  (3) one-time reset of geocode_attempts for venues still worth retrying.
-- (4) expire_held_runs() no longer demotes a source whose feed a newer ok run already applied.
-- (5) Grants: deny everything, then the exact cumulative allowlist (unchanged; this migration adds no granted function).

alter table public.venues drop constraint venues_geocoder_check;
alter table public.venues add constraint venues_geocoder_check check (geocoder in ('source','nominatim','google','admin','census'));   -- A11

-- take_geocode_budget, verbatim from 20261021000600_chamber_fixes.sql plus the marked address field.
create or replace function private.take_geocode_budget(p_venue_ids uuid[]) returns jsonb
language plpgsql set search_path = '' as $$
declare v_month date := date_trunc('month', now())::date; v_units int; v_cap int; v_n int; v_out jsonb;
begin
  insert into public.geocode_usage (month) values (v_month) on conflict do nothing;
  select u.units, u.cap into v_units, v_cap from public.geocode_usage u where u.month = v_month for update;
  v_n := least(20, greatest(v_cap - v_units, 0));
  if v_n <= 0 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('venue_id', x.id,
           'query', concat_ws(', ', x.name, x.address,
                              case when x.address is null then coalesce(x.town, x.hint) else x.town end)
           ) || case when x.address ~ '^\s*[0-9]' then jsonb_build_object('address', btrim(x.address)) else '{}'::jsonb end   -- A11
           order by x.id), '[]')   -- A9-4
    into v_out
    from (select v.id, v.name, v.address, v.town,
                 (select nullif(left(btrim(s.config ->> 'geocodeHint'), 60), '')
                    from public.source_events se join public.sources s on s.id = se.source_id
                   where se.venue_id = v.id and jsonb_typeof(s.config -> 'geocodeHint') = 'string'
                   order by se.last_seen_at desc, se.id limit 1) as hint                                                    -- A9-4
            from public.venues v
           where v.id = any (p_venue_ids) and v.lat is null and v.geocode_attempts < 3 and not v.outside_region
           order by v.id limit v_n) x;
  update public.geocode_usage set units = units + jsonb_array_length(v_out) where month = v_month;
  return v_out;
end $$;

-- A11: retry once with the new chain. A re-runnable helper; returns how many venues changed.
create function private.reset_geocode_attempts() returns integer
language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  update public.venues v set geocode_attempts = 0
   where v.lat is null and v.geocode_attempts > 0 and v.geocode_attempts < 3
     and exists (select 1 from public.source_events se
                  where se.venue_id = v.id and se.source_status = 'live' and se.starts_at > now());
  get diagnostics v_n = row_count;
  return v_n;
end $$;
select private.reset_geocode_attempts();

-- A11: expire_held_runs, verbatim from 20261020000400_jobs.sql except the marked supersede rule.
create or replace function private.expire_held_runs() returns void
language plpgsql security definer set search_path = '' as $$
declare h record; v_fin timestamptz;
begin
  for h in select x.run_id, x.source_id from public.held_runs x where x.status = 'pending' and x.created_at < now() - interval '7 days' for update
  loop
    update public.held_runs set status = 'expired', decided_at = now() where run_id = h.run_id;
    -- A11: superseded when an ok run for the source finished after the held run
    select r.finished_at into v_fin from public.source_runs r where r.id = h.run_id;
    if exists (select 1 from public.source_runs r2 where r2.source_id = h.source_id and r2.status = 'ok' and r2.finished_at > v_fin) then
      update public.review_cards set status = 'closed', decision = 'superseded', decided_at = now()
       where held_run_id = h.run_id and status = 'open';
    else
      update public.review_cards set status = 'closed', decision = 'expired', decided_at = now()
       where held_run_id = h.run_id and status = 'open';
      update public.sources set trust = 'review' where id = h.source_id and trust = 'auto';
    end if;
  end loop;
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
grant execute on function public.list_event_pages() to anon, authenticated;
