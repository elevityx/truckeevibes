-- Sources V2 (Spec_Sources_V2; Plan_Sources_V2 r3 option A + the r3 rulings). Run now = a force-due stamp on the source; Read request =
-- a read stamp on a manual-only source. The existing grant paths serve both; only a batch that records a result clears them (the
-- used_at trigger runs inside svc_ingest_batch's own used_at update). No new table, no Edge Function or workflow change.
-- 1 columns + indexes; 2 sources_gate stamp-only exemption; 3 used_at trigger; 4 grant paths (force-due branch, request generation);
-- 5 svc_manual_grant_requested + three admin RPCs; 6 admin_source_health (+ last_grant_at); 7 self-check; 8 canonical block (+4 grants).

alter table public.sources add column if not exists force_due_at timestamptz;
alter table public.sources add column if not exists force_due_served_at timestamptz;
alter table public.sources add column if not exists read_requested_at timestamptz;
alter table public.sources add column if not exists read_request_served_at timestamptz;
alter table public.sources add column if not exists force_due_gen bigint not null default 0;
alter table public.sources add column if not exists read_request_gen bigint not null default 0;
alter table private.ingest_grants add column if not exists force_due_gen bigint;
alter table private.ingest_grants add column if not exists read_request_gen bigint;
create index if not exists ingest_grants_source_issued_idx on private.ingest_grants (source_id, issued_at desc);
create index if not exists ingest_grants_issued_idx on private.ingest_grants (issued_at desc);

-- 2 The fail-closed gate (20261015000200_core.sql:129-147) plus one exemption: an update that changes only the stamp columns (times and
--   generations) and sets neither stamp to a new value (Cancel, the served clear) passes without the eligibility check. Else as before.
create or replace function private.sources_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (new.force_due_at, new.force_due_served_at, new.read_requested_at, new.read_request_served_at, new.force_due_gen, new.read_request_gen)
         is distinct from (old.force_due_at, old.force_due_served_at, old.read_requested_at, old.read_request_served_at, old.force_due_gen, old.read_request_gen)
     and (to_jsonb(new) - array['force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at', 'force_due_gen',
                                'read_request_gen', 'updated_at', 'priority'])
         = (to_jsonb(old) - array['force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at', 'force_due_gen',
                                  'read_request_gen', 'updated_at', 'priority'])
     and (new.force_due_at is null or new.force_due_at is not distinct from old.force_due_at)
     and (new.read_requested_at is null or new.read_requested_at is not distinct from old.read_requested_at) then
    new.updated_at := now();
    return new;
  end if;
  if new.opt_out and new.enabled then
    raise exception 'invalid_input' using errcode = '22023', detail = 'opt_out_enabled';
  end if;
  if new.enabled and not coalesce(
       new.ingest_disposition in ('permitted', 'official_api_only')
       and new.terms_recheck_at > now()
       and cardinality(new.allowed_methods) > 0
       and new.terms_hash is not null
       and new.terms_url is not null
       and new.terms_reviewed_at is not null, false) then
    raise exception 'source_not_permitted' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- 3 A recorded result (svc_ingest_batch sets used_at, realtime.sql:38) clears the request this grant was issued for: only while the
--   source still carries the same generation (a re-stamp or Cancel bumps it) and the stamp is still set. Served times are display only.
create or replace function private.ingest_grant_used() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.force_due_gen is null and new.read_request_gen is null then return null; end if;
  update public.sources s
     set force_due_at = case when s.force_due_at is not null and s.force_due_gen = new.force_due_gen then null else s.force_due_at end,
         force_due_served_at = case when s.force_due_at is not null and s.force_due_gen = new.force_due_gen
                                    then now() else s.force_due_served_at end,
         read_requested_at = case when s.read_requested_at is not null and s.read_request_gen = new.read_request_gen
                                  then null else s.read_requested_at end,
         read_request_served_at = case when s.read_requested_at is not null and s.read_request_gen = new.read_request_gen
                                       then now() else s.read_request_served_at end
   where s.id = new.source_id
     and ((s.force_due_at is not null and s.force_due_gen = new.force_due_gen)
       or (s.read_requested_at is not null and s.read_request_gen = new.read_request_gen));
  return null;
end $$;
create or replace trigger ingest_grants_used after update of used_at on private.ingest_grants
  for each row when (old.used_at is null and new.used_at is not null) execute function private.ingest_grant_used();

-- 4a The cron path: the 20261030000700_tdrpd_rec1.sql:35-57 body with two deltas: a pending stamp makes the source due unless it already
--    holds a live unused grant, and the grant records the generation it saw on the locked row. The grant never clears the stamp.
create or replace function public.svc_issue_run_grants() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid; v_out jsonb := '[]'::jsonb;
begin
  for s in
    select * from public.sources x
     where x.enabled and not x.opt_out and x.trust <> 'link_only' and not x.manual_only
       and x.ingest_disposition in ('permitted', 'official_api_only') and x.terms_recheck_at > now()
       and cardinality(x.allowed_methods) > 0
       and (x.next_due_at <= now()
            or (x.force_due_at > now() - interval '24 hours'
                and not exists (select 1 from private.ingest_grants g
                                 where g.source_id = x.id and g.used_at is null and g.expires_at > now())))
     order by x.next_due_at for update skip locked
  loop
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_run := gen_random_uuid();
    insert into private.ingest_grants (token_hash, source_id, run_id, expires_at, force_due_gen)
      values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes',
              case when s.force_due_at > now() - interval '24 hours' then s.force_due_gen end);
    update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
      'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
      'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'etag', s.etag, 'last_modified', s.last_modified,
      'content_hash', s.content_hash, 'ingest_disposition', s.ingest_disposition, 'terms_recheck_at', s.terms_recheck_at)));
  end loop;
  return jsonb_build_object('grants', v_out);
end $$;

-- 4b The on-request path: the tdrpd_rec1.sql:60-77 body; the grant records the pending Read request's generation (locked row).
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
  insert into private.ingest_grants (token_hash, source_id, run_id, expires_at, read_request_gen)
    values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes',
            case when s.read_requested_at > now() - interval '7 days' then s.read_request_gen end);
  update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
  return jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
    'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
    'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'ingest_disposition', s.ingest_disposition,
    'terms_recheck_at', s.terms_recheck_at));
end $$;

-- 5a Request-bound manual grant (manual-read.sh requested): the request is re-checked under the row lock that Cancel also takes.
create or replace function public.svc_manual_grant_requested(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources;
begin
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found or not coalesce(s.read_requested_at > now() - interval '7 days', false) then
    raise exception 'manual_request_withdrawn' using errcode = 'P0001';
  end if;
  return public.svc_manual_grant(p_slug);
end $$;

-- 5b Run now: stamp (or re-stamp) a schedulable source; p_on = false clears and is always allowed (sources_gate exemption).
create or replace function public.admin_set_force_due(p_slug text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_last timestamptz; v_pending boolean;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_on is null then raise exception 'invalid_input' using errcode = '22023', detail = 'on'; end if;
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'source'; end if;
  select max(g.issued_at) into v_last from private.ingest_grants g where g.source_id = s.id;
  if not p_on then
    update public.sources set force_due_at = null, force_due_gen = force_due_gen + 1 where id = s.id and force_due_at is not null;
    return jsonb_build_object('slug', s.slug, 'force_due_at', null::timestamptz, 'already', false, 'next_due_at', s.next_due_at,
                              'last_grant_at', v_last);
  end if;
  if s.manual_only then raise exception 'invalid_input' using errcode = '22023', detail = 'manual_only'; end if;
  if s.trust = 'link_only' then raise exception 'invalid_input' using errcode = '22023', detail = 'link_only'; end if;
  if not s.enabled then raise exception 'invalid_input' using errcode = '22023', detail = 'disabled'; end if;
  if not private.source_ingest_permitted(s) then raise exception 'invalid_input' using errcode = '22023', detail = 'not_permitted'; end if;
  if v_last > now() - interval '30 minutes' then raise exception 'rate_limited' using errcode = 'P0001', detail = 'too_soon'; end if;
  v_pending := coalesce(s.force_due_at > now() - interval '24 hours', false);
  update public.sources set force_due_at = now(), force_due_gen = force_due_gen + 1 where id = s.id;
  return jsonb_build_object('slug', s.slug, 'force_due_at', now(), 'already', v_pending, 'next_due_at', s.next_due_at,
                            'last_grant_at', v_last);
end $$;

-- 5c Read request on a manual-only source (records only; the server never fetches it). No floor: the 24 h gate is in the grant.
create or replace function public.admin_set_read_request(p_slug text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_pending boolean;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_on is null then raise exception 'invalid_input' using errcode = '22023', detail = 'on'; end if;
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'source'; end if;
  if not p_on then
    update public.sources set read_requested_at = null, read_request_gen = read_request_gen + 1 where id = s.id and read_requested_at is not null;
    return jsonb_build_object('slug', s.slug, 'read_requested_at', null::timestamptz, 'already', false, 'next_due_at', s.next_due_at);
  end if;
  if not s.manual_only then raise exception 'invalid_input' using errcode = '22023', detail = 'not_manual'; end if;
  if not s.enabled then raise exception 'invalid_input' using errcode = '22023', detail = 'disabled'; end if;
  if not private.source_ingest_permitted(s) then raise exception 'invalid_input' using errcode = '22023', detail = 'not_permitted'; end if;
  v_pending := coalesce(s.read_requested_at > now() - interval '7 days', false);
  update public.sources set read_requested_at = now(), read_request_gen = read_request_gen + 1 where id = s.id;
  return jsonb_build_object('slug', s.slug, 'read_requested_at', now(), 'already', v_pending, 'next_due_at', s.next_due_at);
end $$;

-- 5d Jobs panel read (stable): grant batches of scheduled sources, manual reads, stamps. Never token_hash, tokens or user ids.
create or replace function public.admin_jobs(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_lim integer := least(20, greatest(1, coalesce(p_limit, 10)));
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'generated_at', now(),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object('issued_at', b.issued_at, 'grants', x.grants, 'pending', x.pending, 'unused', x.unused,
                                          'run_now', x.run_now, 'runs', x.runs) order by b.issued_at desc)
        from (select g.issued_at from private.ingest_grants g join public.sources s on s.id = g.source_id
               where not s.manual_only and g.issued_at > now() - interval '14 days'
               group by g.issued_at order by g.issued_at desc limit v_lim) b
        cross join lateral (
          select count(*)::integer as grants,
                 (count(*) filter (where g.used_at is null and g.expires_at > now()))::integer as pending,
                 (count(*) filter (where g.used_at is null and g.expires_at <= now()))::integer as unused,
                 coalesce(jsonb_agg(s.slug order by s.slug) filter (where g.force_due_gen is not null), '[]'::jsonb) as run_now,
                 coalesce((select jsonb_agg(jsonb_build_object('slug', q.slug, 'status', q.status, 'found', q.items_found, 'new', q.items_new,
                                    'changed', q.items_changed, 'error_code', q.error_code, 'finished_at', q.finished_at) order by q.slug)
                             from (select s2.slug, r.status, r.items_found, r.items_new, r.items_changed, r.error_code, r.finished_at
                                     from private.ingest_grants g2 join public.sources s2 on s2.id = g2.source_id
                                     join public.source_runs r on r.id = g2.run_id
                                    where g2.issued_at = b.issued_at and not s2.manual_only order by s2.slug limit 30) q),
                          '[]'::jsonb) as runs
            from private.ingest_grants g join public.sources s on s.id = g.source_id
           where g.issued_at = b.issued_at and not s.manual_only) x), '[]'::jsonb),
    'manual', coalesce((
      select jsonb_agg(jsonb_build_object('issued_at', m.issued_at, 'slug', m.slug, 'requested', m.read_request_gen is not null,
               'state', case when m.used_at is not null then 'done' when m.expires_at > now() then 'reading' else 'no_result' end,
               'run', case when m.rid is null then null else jsonb_build_object('slug', m.slug, 'status', m.status, 'found', m.items_found,
                        'new', m.items_new, 'changed', m.items_changed, 'error_code', m.error_code, 'finished_at', m.finished_at) end)
             order by m.issued_at desc)
        from (select g.issued_at, g.used_at, g.expires_at, g.read_request_gen, s.slug, r.id as rid, r.status, r.items_found, r.items_new,
                     r.items_changed, r.error_code, r.finished_at
                from private.ingest_grants g join public.sources s on s.id = g.source_id
                left join public.source_runs r on r.id = g.run_id
               where s.manual_only and g.issued_at > now() - interval '14 days'
               order by g.issued_at desc limit 20) m), '[]'::jsonb),
    'stamps', coalesce((
      select jsonb_agg(t.j order by t.at desc) from (
        select u.at, u.j from (
          select greatest(s.force_due_at, s.force_due_served_at) as at,
                 jsonb_build_object('slug', s.slug, 'name', s.name, 'kind', 'run_now', 'requested_at', s.force_due_at,
                   'served_at', s.force_due_served_at, 'pending', coalesce(s.force_due_at > now() - interval '24 hours', false),
                   'expired', coalesce(s.force_due_at <= now() - interval '24 hours', false)) as j
            from public.sources s
           where s.force_due_at > now() - interval '14 days' or s.force_due_served_at > now() - interval '14 days'
          union all
          select greatest(s.read_requested_at, s.read_request_served_at),
                 jsonb_build_object('slug', s.slug, 'name', s.name, 'kind', 'read_request', 'requested_at', s.read_requested_at,
                   'served_at', s.read_request_served_at, 'pending', coalesce(s.read_requested_at > now() - interval '7 days', false),
                   'expired', coalesce(s.read_requested_at <= now() - interval '7 days', false))
            from public.sources s
           where s.read_requested_at > now() - interval '14 days' or s.read_request_served_at > now() - interval '14 days') u
        order by u.at desc limit 40) t), '[]'::jsonb));
end $$;

-- 6 The 20261020000300_queue_admin.sql:212-225 body plus last_grant_at and request_grant (the newest unused grant issued for the
--   source's current pending request, matched by generation); the new columns already arrive through to_jsonb(s).
create or replace function public.admin_source_health() returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select (to_jsonb(s) - 'config') || jsonb_build_object(
      'last_runs', (select coalesce(jsonb_agg(jsonb_build_object('status', q.status, 'finished_at', q.finished_at, 'found', q.items_found,
                                'new', q.items_new, 'changed', q.items_changed, 'error_code', q.error_code) order by q.finished_at desc), '[]')
                      from (select r.* from public.source_runs r where r.source_id = s.id order by r.finished_at desc limit 7) q),
      'open_cards_7d', (select count(*) from public.review_cards c where c.source_id = s.id and c.status = 'open' and c.created_at > now() - interval '7 days'),
      'open_cards_14d', (select count(*) from public.review_cards c where c.source_id = s.id and c.status = 'open' and c.created_at > now() - interval '14 days'),
      'held_runs_pending', (select count(*) from public.held_runs h where h.source_id = s.id and h.status = 'pending'),
      'last_grant_at', (select max(g.issued_at) from private.ingest_grants g where g.source_id = s.id),
      'request_grant', (select jsonb_build_object('issued_at', g.issued_at, 'live', g.expires_at > now())
                          from private.ingest_grants g
                         where g.source_id = s.id and g.used_at is null
                           and ((s.force_due_at is not null and g.force_due_gen = s.force_due_gen)
                             or (s.read_requested_at is not null and g.read_request_gen = s.read_request_gen))
                         order by g.issued_at desc limit 1))
    from public.sources s order by s.name;
end $$;

-- 7 Self-check (true on a fresh reset and on the hosted DB).
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sources'
        and column_name in ('force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at')
        and data_type = 'timestamp with time zone' and is_nullable = 'YES') <> 4
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sources'
           and column_name in ('force_due_gen', 'read_request_gen') and data_type = 'bigint' and is_nullable = 'NO') <> 2
     or (select count(*) from information_schema.columns where table_schema = 'private' and table_name = 'ingest_grants'
           and column_name in ('force_due_gen', 'read_request_gen') and data_type = 'bigint' and is_nullable = 'YES') <> 2
     or (select count(*) from pg_trigger where tgrelid = 'private.ingest_grants'::regclass and tgname = 'ingest_grants_used' and not tgisinternal) <> 1
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname::text, p.proname::text, p.provolatile::text) in (
                ('public', 'admin_jobs', 's'), ('public', 'admin_source_health', 's'), ('public', 'admin_set_force_due', 'v'),
                ('public', 'admin_set_read_request', 'v'), ('public', 'svc_manual_grant_requested', 'v'), ('public', 'svc_issue_run_grants', 'v'),
                ('public', 'svc_manual_grant', 'v'), ('private', 'ingest_grant_used', 'v'), ('private', 'sources_gate', 'v'))) <> 9
     or exists (select 1 from public.sources where manual_only and force_due_at is not null)
     or exists (select 1 from public.sources where not manual_only and read_requested_at is not null) then
    raise exception 'sources_v2_state';
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
grant execute on function public.admin_set_force_due(text, boolean) to authenticated;
grant execute on function public.admin_set_read_request(text, boolean) to authenticated;
grant execute on function public.admin_jobs(integer) to authenticated;
grant execute on function public.svc_manual_grant_requested(text) to service_role;
