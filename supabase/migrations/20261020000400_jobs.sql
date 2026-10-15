-- M1 scheduled jobs (spec S1.5): queue hygiene, retention, the heartbeat and the weekly email. pg_cron runs in UTC.
-- Nothing here holds a secret or a URL: the notify function URL, project URL and bearer live in Vault.

create function private.expire_queue() returns void
language plpgsql security definer set search_path = '' as $$
begin
  with ex as (
    update public.events e set status = 'rejected', reject_reason = 'expired'
     where e.status = 'pending' and e.merged_into is null and coalesce(e.ends_at, e.starts_at) < now()
    returning e.id),
  ch as (
    insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
      select ex.id, 'status', to_jsonb('pending'::text), to_jsonb('rejected'::text), 'rule:expire' from ex returning 1)
  update public.review_cards c set status = 'closed', decision = 'expired', decided_at = now()
   where c.status = 'open' and c.kind in ('event', 'possible_duplicate') and c.event_id in (select id from ex);
end $$;

create function private.queue_budget() returns void
language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  for s in
    select x.id from public.sources x
     where x.trust <> 'link_only'
       and (select count(*) from public.review_cards c where c.source_id = x.id and c.kind in ('event', 'held_run')
               and c.created_at > now() - interval '7 days') > 5
       and (select count(*) from public.review_cards c where c.source_id = x.id and c.kind in ('event', 'held_run')
               and c.created_at <= now() - interval '7 days' and c.created_at > now() - interval '14 days') > 5
     for update
  loop
    update public.sources set trust = 'link_only' where id = s.id;
    update public.review_cards set status = 'closed', decision = 'source_budget', decided_at = now()
     where source_id = s.id and kind = 'event' and status = 'open';
    insert into public.review_cards (kind, source_id) values ('source_budget', s.id);
  end loop;
end $$;

create function private.expire_held_runs() returns void
language plpgsql security definer set search_path = '' as $$
declare h record;
begin
  for h in select x.run_id, x.source_id from public.held_runs x where x.status = 'pending' and x.created_at < now() - interval '7 days' for update
  loop
    update public.held_runs set status = 'expired', decided_at = now() where run_id = h.run_id;
    update public.review_cards set status = 'closed', decision = 'expired', decided_at = now()
     where held_run_id = h.run_id and status = 'open';
    update public.sources set trust = 'review' where id = h.source_id and trust = 'auto';
  end loop;
end $$;

-- Terms due within 14 days are listed in the weekly report; past due disables the source (the gate trigger allows disabling).
create function private.terms_recheck() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.sources set enabled = false where enabled and terms_recheck_at is not null and terms_recheck_at <= now();
end $$;

-- Child-first deletes under the transaction-local tv.retention flag; no FK is changed to cascade.
create function private.retention_sweep() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('tv.retention', 'on', true);
  delete from public.review_cards c
   where (c.status = 'closed' and c.created_at < now() - interval '400 days')
      or c.held_run_id in (select h.run_id from public.held_runs h where h.created_at < now() - interval '400 days');
  delete from public.held_runs h where h.created_at < now() - interval '400 days';
  delete from public.source_runs r
   where r.finished_at < now() - interval '90 days'
     and not exists (select 1 from public.held_runs h where h.run_id = r.id);
  delete from private.ingest_grants g where g.issued_at < now() - interval '30 days';
  delete from private.ingest_nonces n where n.seen_at < now() - interval '1 day';
  delete from public.source_event_versions v where v.accepted_at < now() - interval '400 days';
  delete from public.event_changes ec where ec.at < now() - interval '400 days';
  delete from public.source_events se where se.source_status = 'gone' and se.starts_at < now() - interval '30 days';
  perform set_config('tv.retention', 'off', true);
end $$;

-- Notifications: the function URL is accepted only when it is EXACTLY https://<project host>/functions/v1/weekly-email,
-- where the project host comes from the Vault secret `project_url`. Exact equality rules out other hosts, userinfo,
-- ports, extra path segments, prefixes/suffixes, query strings and fragments.
create function private.notify_project_host() returns text
language sql stable set search_path = '' as $$
  select substring(s.decrypted_secret from '^https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/?$')
    from vault.decrypted_secrets s where s.name = 'project_url'
$$;

create function private.notify_url_ok(p_url text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_url = 'https://' || private.notify_project_host() || '/functions/v1/weekly-email', false)
$$;

create function private.run_notify(p_kind text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_key text;
begin
  if p_kind is null or p_kind not in ('weekly', 'heartbeat') then return null; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'notify_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'notify_cron_secret';
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then return null; end if;   -- not configured: no-op
  if not private.notify_url_ok(v_url) then return null; end if;                        -- only ever this project's function
  return net.http_post(
    url := v_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('kind', p_kind),
    timeout_milliseconds := 30000);
end $$;

-- Idempotent Vault writer for the notify secrets (update if present, else create).
create function private.set_notify_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_name is null or p_name not in ('project_url', 'notify_function_url', 'notify_cron_secret') or p_value is null or p_value = '' then
    raise exception 'invalid_input' using errcode = '22023', detail = 'notify_secret';
  end if;
  if p_name = 'notify_function_url' and not private.notify_url_ok(p_value) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'notify_function_url';
  end if;
  if p_name = 'project_url' and p_value !~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/?$' then
    raise exception 'invalid_input' using errcode = '22023', detail = 'project_url';
  end if;
  select id into v_id from vault.secrets where name = p_name;
  if found then perform vault.update_secret(v_id, p_value);
  else perform vault.create_secret(p_value, p_name); end if;
end $$;

-- Alert once a day when no ingest run has succeeded for 36 hours.
create function private.check_heartbeat() returns text
language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  select max(r.finished_at) into v_last from public.source_runs r where r.status in ('ok', 'not_modified');
  if v_last is null or v_last >= now() - interval '36 hours' then return 'ok'; end if;
  if exists (select 1 from private.notify_log n where n.kind = 'heartbeat' and n.sent_at > now() - interval '24 hours') then return 'suppressed'; end if;
  insert into private.notify_log (kind) values ('heartbeat');
  perform private.run_notify('heartbeat');
  return 'alert';
end $$;

-- The weekly report (and the heartbeat's hours): numbers and source names only.
create function public.svc_weekly_report() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; v_last timestamptz; v_month date := date_trunc('month', now())::date;
begin
  select max(r.finished_at) into v_last from public.source_runs r where r.status in ('ok', 'not_modified');
  select jsonb_build_object(
    'queue_open', (select count(*) from public.review_cards c where c.status = 'open'),
    'oldest_card_age_hours', coalesce((select round(extract(epoch from now() - min(c.created_at)) / 3600.0, 1) from public.review_cards c where c.status = 'open'), 0),
    'cards_created_by_source_7d', (select coalesce(jsonb_agg(jsonb_build_object('source', q.name, 'n', q.n) order by q.n desc, q.name), '[]')
        from (select s.name, count(*) as n from public.review_cards c join public.sources s on s.id = c.source_id
               where c.created_at > now() - interval '7 days' and c.kind in ('event', 'held_run') group by s.name) q),
    'review_minutes_7d', round(((select coalesce(sum(c.review_seconds), 0) from public.review_cards c
                                  where c.decided_by is not null and c.decided_at > now() - interval '7 days')
                              + (select coalesce(sum(a.seconds), 0) from public.owner_activity a where a.at > now() - interval '7 days')) / 60.0, 1),
    'decisions_7d', (select count(*) from public.review_cards c where c.decided_by is not null and c.decided_at > now() - interval '7 days'),
    'published_7d', (select count(*) from public.events e where e.status = 'published' and e.published_at > now() - interval '7 days'),
    'auto_published_share_7d', coalesce((select round(count(*) filter (where not e.status_by_admin)::numeric / nullif(count(*), 0), 3)
                                           from public.events e where e.status = 'published' and e.published_at > now() - interval '7 days'), 0),
    'broken_sources', (select coalesce(jsonb_agg(jsonb_build_object('source', s.name,
          'status', (select r.status from public.source_runs r where r.source_id = s.id order by r.finished_at desc limit 1),
          'consecutive_failures', s.consecutive_failures, 'last_success_at', s.last_success_at) order by s.name), '[]')
        from public.sources s
       where s.enabled and (s.consecutive_failures >= 2
          or s.last_success_at < now() - greatest(interval '48 hours', private.cadence_interval(s.cadence) + interval '12 hours'))),
    'held_runs_pending', (select count(*) from public.held_runs h where h.status = 'pending'),
    'link_only_by_budget_7d', (select count(*) from public.review_cards c where c.kind = 'source_budget' and c.created_at > now() - interval '7 days'),
    'uncarded_pending', (select coalesce(jsonb_agg(jsonb_build_object('source', q.name, 'n', q.n) order by q.name), '[]')
        from (select s.name, count(*) as n from public.events e
                join lateral (select se.source_id from public.source_events se join public.sources s2 on s2.id = se.source_id
                               where se.cluster_id = e.id and se.source_status <> 'gone'
                               order by s2.priority desc, se.first_seen_at, se.id limit 1) w on true
                join public.sources s on s.id = w.source_id
               where e.status = 'pending' and e.merged_into is null and coalesce(e.ends_at, e.starts_at) > now()
                 and not exists (select 1 from public.review_cards c where c.event_id = e.id and c.kind = 'event' and c.status = 'open')
               group by s.name) q),
    'rejected_out_of_region_7d', (select count(*) from public.event_changes ec where ec.field = 'status' and ec.decided_by = 'rule:region'
                                    and ec.at > now() - interval '7 days'),
    'published_by_rule_7d', jsonb_build_object(
        'publish', (select count(*) from public.event_changes ec where ec.field = 'status' and ec.new_value = '"published"'::jsonb
                      and ec.decided_by = 'rule:publish' and ec.at > now() - interval '7 days'),
        'strict_auto', (select count(*) from public.event_changes ec where ec.field = 'status' and ec.new_value = '"published"'::jsonb
                      and ec.decided_by = 'rule:strict_auto' and ec.at > now() - interval '7 days')),
    'terms_recheck_due', (select coalesce(jsonb_agg(jsonb_build_object('source', s.name, 'terms_recheck_at', s.terms_recheck_at) order by s.terms_recheck_at), '[]')
        from public.sources s where s.enabled and s.terms_recheck_at <= now() + interval '14 days'),
    'geocode_month', coalesce((select jsonb_build_object('units', u.units, 'cap', u.cap) from public.geocode_usage u where u.month = v_month),
                              jsonb_build_object('units', 0, 'cap', 300)),
    'heartbeat_hours', case when v_last is null then null else floor(extract(epoch from now() - v_last) / 3600.0)::int end)
  into v_out;
  insert into private.notify_log (kind) values ('weekly');
  return v_out;
end $$;

-- Schedules (UTC). The weekly fire is posted twice (14:07 and 15:07) so one lands at 07:xx Pacific in both PST and PDT;
-- the function's slot guard keeps only that one.
select cron.schedule('tv-expire-queue', '15 10 * * *', $$select private.expire_queue()$$);
select cron.schedule('tv-queue-budget', '25 10 * * *', $$select private.queue_budget()$$);
select cron.schedule('tv-expire-held', '35 10 * * *', $$select private.expire_held_runs()$$);
select cron.schedule('tv-terms-recheck', '45 10 * * *', $$select private.terms_recheck()$$);
select cron.schedule('tv-retention', '55 10 * * *', $$select private.retention_sweep()$$);
select cron.schedule('tv-heartbeat', '5 * * * *', $$select private.check_heartbeat()$$);
select cron.schedule('tv-weekly-email', '7 14,15 * * 4', $$select private.run_notify('weekly')$$);

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
