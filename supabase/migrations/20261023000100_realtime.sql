-- Amendment 10: real-time publishing. Chamber to trust 'auto', faster cadences, auto sources apply new/edit surges
-- (found_drop and found_zero still hold for every source), and the queued backlog is drained at push time.

-- 1 Chamber auto: normal UPDATE path (sources gate, aggregator CHECK, trust re-queue trigger), as in 20261021000400_alibi_auto.sql.
update public.sources set trust = 'auto' where slug = 'truckee-chamber';

-- 2 Cadence.
update public.sources set cadence = '6h'  where slug = 'alibi-truckee';
update public.sources set cadence = '12h' where slug = 'visit-lake-tahoe';
update public.sources set cadence = '24h' where slug = 'truckee-chamber';
update public.sources set cadence = '24h' where slug = 'tdrpd';

-- 3 Surge guard: svc_ingest_batch copied from 20261020000200_ingest_rpcs.sql; the only change is the A10 block in step 8.
create or replace function public.svc_ingest_batch(p_grant text, p_run jsonb, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g private.ingest_grants; s public.sources;
  v_status text; v_started timestamptz; v_http int; v_bytes int; v_dur int; v_etag text; v_lm text; v_chash text;
  v_parser text; v_ecode text; v_edetail text; v_rhash text; v_ai boolean; v_robots boolean := false;
  v_found int; v_clean jsonb; v_inv int; v_sup int;
  v_new int; v_changed int; v_live int; v_gone_cand int;
  v_med_new numeric; v_med_found numeric; v_runs int; v_week_changed int; v_prior_ok boolean; v_last2_zero boolean; v_pos30 boolean;
  v_reasons text[] := '{}'; v_keys text[]; v_ap jsonb; v_geo jsonb; v_ok boolean;
begin
  -- 1 grant
  select * into g from private.ingest_grants x where x.token_hash = extensions.digest(coalesce(p_grant, ''), 'sha256') for update;
  if not found then raise exception 'grant_invalid' using errcode = 'P0001'; end if;
  if g.used_at is not null then raise exception 'grant_used' using errcode = 'P0001'; end if;
  if g.expires_at <= now() then raise exception 'grant_expired' using errcode = 'P0001'; end if;

  -- 2 the source, re-checked at use time (the due predicate minus next_due_at)
  select * into s from public.sources x where x.id = g.source_id for update;
  if not private.source_ingest_permitted(s) then
    raise exception 'source_not_permitted' using errcode = '23514';
  end if;

  -- 3
  update private.ingest_grants set used_at = now() where token_hash = g.token_hash;

  -- 4 run fields
  if jsonb_typeof(p_run) is distinct from 'object' then raise exception 'invalid_input' using errcode = '22023', detail = 'run'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'invalid_input' using errcode = '22023', detail = 'items'; end if;
  if private.jt(p_run, 'status') <> 'string' then raise exception 'invalid_input' using errcode = '22023', detail = 'status'; end if;
  v_status := p_run ->> 'status';
  if v_status not in ('ok', 'not_modified', 'robots_blocked', 'http_error', 'parse_error', 'skipped') then
    raise exception 'invalid_input' using errcode = '22023', detail = 'status';
  end if;
  if private.jt(p_run, 'started_at') <> 'string' then raise exception 'invalid_input' using errcode = '22023', detail = 'started_at'; end if;
  begin
    v_started := (p_run ->> 'started_at')::timestamptz;
  exception when others then raise exception 'invalid_input' using errcode = '22023', detail = 'started_at';
  end;
  if v_started < now() - interval '2 hours' or v_started > now() then raise exception 'invalid_input' using errcode = '22023', detail = 'started_at'; end if;
  begin
    if private.jt(p_run, 'http_status') <> 'null' then
      if private.jt(p_run, 'http_status') <> 'number' then raise exception 'x'; end if;
      v_http := (p_run ->> 'http_status')::int;
      if v_http not between 100 and 599 then raise exception 'x'; end if;
    end if;
    if private.jt(p_run, 'bytes') <> 'null' then
      if private.jt(p_run, 'bytes') <> 'number' then raise exception 'x'; end if;
      v_bytes := (p_run ->> 'bytes')::int;
      if v_bytes < 0 then raise exception 'x'; end if;
    end if;
    if private.jt(p_run, 'duration_ms') <> 'null' then
      if private.jt(p_run, 'duration_ms') <> 'number' then raise exception 'x'; end if;
      v_dur := (p_run ->> 'duration_ms')::int;
      if v_dur < 0 then raise exception 'x'; end if;
    end if;
    foreach v_etag in array array['etag', 'last_modified', 'content_hash', 'parser_version', 'error_code', 'error_detail'] loop
      if private.jt(p_run, v_etag) not in ('null', 'string') then raise exception 'x'; end if;
    end loop;
    v_etag := p_run ->> 'etag'; v_lm := p_run ->> 'last_modified'; v_chash := p_run ->> 'content_hash';
    v_parser := p_run ->> 'parser_version'; v_ecode := p_run ->> 'error_code'; v_edetail := p_run ->> 'error_detail';
    if char_length(v_etag) > 200 or char_length(v_lm) > 100 or char_length(v_chash) > 200 or char_length(v_edetail) > 300
       or v_parser !~ '^[a-z0-9._-]{1,40}$' or v_ecode !~ '^[a-z0-9_]{1,40}$' then
      raise exception 'x';
    end if;
    if private.jt(p_run, 'robots') = 'object' then
      v_robots := true;
      if private.jt(p_run -> 'robots', 'hash') <> 'null' then
        if private.jt(p_run -> 'robots', 'hash') <> 'string' or (p_run -> 'robots' ->> 'hash') !~ '^[0-9a-f]{64}$' then raise exception 'x'; end if;
        v_rhash := p_run -> 'robots' ->> 'hash';
      end if;
      if private.jt(p_run -> 'robots', 'ai_bots_blocked') <> 'null' then
        if private.jt(p_run -> 'robots', 'ai_bots_blocked') <> 'boolean' then raise exception 'x'; end if;
        v_ai := (p_run -> 'robots' ->> 'ai_bots_blocked')::boolean;
      end if;
    elsif private.jt(p_run, 'robots') <> 'null' then
      raise exception 'x';
    end if;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', detail = 'run';
  end;

  v_found := jsonb_array_length(p_items);
  if v_found > 1000 then raise exception 'invalid_input' using errcode = '22023', detail = 'items'; end if;

  -- NON-OK GATE: a non-ok run records itself and touches nothing else
  if v_status <> 'ok' then
    if v_found <> 0 then raise exception 'invalid_input' using errcode = '22023', detail = 'items_nonok'; end if;
    insert into public.source_runs (id, source_id, started_at, finished_at, status, http_status, bytes, duration_ms, content_hash,
        parser_version, error_code, error_detail)
      values (g.run_id, s.id, v_started, clock_timestamp(), v_status, v_http, v_bytes, v_dur, v_chash, v_parser, v_ecode, v_edetail);
    update public.sources set
        last_success_at = case when v_status = 'not_modified' then now() else last_success_at end,
        consecutive_failures = case when v_status = 'not_modified' then 0 else consecutive_failures + 1 end,
        etag = case when v_status = 'not_modified' then coalesce(v_etag, etag) else etag end,
        last_modified = case when v_status = 'not_modified' then coalesce(v_lm, last_modified) else last_modified end,
        content_hash = case when v_status = 'not_modified' then coalesce(v_chash, content_hash) else content_hash end,
        robots_checked_at = case when v_robots then now() else robots_checked_at end,
        robots_hash = coalesce(v_rhash, robots_hash), ai_bots_blocked = coalesce(v_ai, ai_bots_blocked)
      where id = s.id;
    return jsonb_build_object('run_id', g.run_id, 'status', v_status, 'new', 0, 'changed', 0, 'gone', 0, 'geocode', '[]'::jsonb);
  end if;

  -- 5 clean (set-based), dedupe by external key (the last occurrence wins; the others count as invalid)
  with raw as (
    select t.ord, private.clean_source_item(s, t.value) as r from jsonb_array_elements(p_items) with ordinality t(value, ord)),
  good as (select ord, r from raw where not (r ? 'reject')),
  dedup as (select distinct on (r ->> 'external_key') ord, r from good order by r ->> 'external_key', ord desc)
  select coalesce((select jsonb_agg(r order by ord) from dedup), '[]'::jsonb),
         (select count(*) from raw where r ->> 'reject' = 'suppressed'),
         (select count(*) from raw where r ? 'reject' and r ->> 'reject' <> 'suppressed') + (select count(*) from good) - (select count(*) from dedup)
    into v_clean, v_sup, v_inv;
  v_keys := array(select r ->> 'external_key' from jsonb_array_elements(v_clean) r);

  -- 7 diff against stored occurrences
  select count(*) filter (where se.id is null),
         count(*) filter (where se.id is not null and se.content_hash <> x.h)
    into v_new, v_changed
    from (select r ->> 'external_key' as k, private.facts_hash(r -> 'facts') as h from jsonb_array_elements(v_clean) r) x
    left join public.source_events se on se.source_id = s.id and se.external_key = x.k;
  select count(*) into v_gone_cand from public.source_events se
   where se.source_id = s.id and se.source_status = 'live' and se.starts_at > now() and se.external_key <> all (v_keys);

  -- 8 surge guard
  select count(*) into v_live from public.source_events se where se.source_id = s.id and se.source_status = 'live' and se.starts_at > now();
  select percentile_cont(0.5) within group (order by q.items_new), percentile_cont(0.5) within group (order by q.items_found), count(*)
    into v_med_new, v_med_found, v_runs
    from (select r.items_new, r.items_found from public.source_runs r where r.source_id = s.id and r.status = 'ok'
           order by r.finished_at desc limit 7) q;
  v_med_new := coalesce(v_med_new, 0);
  if v_runs < 3 then v_med_found := null; end if;
  select coalesce(sum(r.items_changed), 0) into v_week_changed from public.source_runs r
   where r.source_id = s.id and r.status = 'ok' and r.finished_at > now() - interval '7 days';
  v_prior_ok := exists (select 1 from public.source_runs r where r.source_id = s.id and r.status = 'ok');

  -- A10 begin: auto sources apply new/edit surges; found_drop and found_zero below still hold for every source
  if s.trust <> 'auto' then
  if v_new > greatest(20, 3 * v_med_new) and not (not v_prior_ok and s.trust <> 'auto' and not s.strict_auto) then
    v_reasons := array_append(v_reasons, 'new_surge');
  end if;
  if v_changed > greatest(5, ceil(0.20 * v_live)) then v_reasons := array_append(v_reasons, 'edit_surge'); end if;
  if v_changed + v_week_changed > greatest(10, ceil(0.40 * v_live)) then v_reasons := array_append(v_reasons, 'edit_surge_7d'); end if;
  end if;
  -- A10 end
  if v_med_found >= 4 and v_found < 0.5 * v_med_found then v_reasons := array_append(v_reasons, 'found_drop'); end if;
  if v_found = 0 then
    select coalesce(bool_and(q.items_found = 0), false) and count(*) = 2 into v_last2_zero
      from (select r.items_found from public.source_runs r where r.source_id = s.id and r.status = 'ok' order by r.finished_at desc limit 2) q;
    v_pos30 := exists (select 1 from public.source_runs r where r.source_id = s.id and r.status = 'ok'
                          and r.finished_at > now() - interval '30 days' and r.items_found > 0);
    if v_last2_zero and v_pos30 then v_reasons := array_append(v_reasons, 'found_zero'); end if;
  end if;

  if cardinality(v_reasons) > 0 then
    insert into public.source_runs (id, source_id, started_at, finished_at, status, http_status, items_found, items_new, items_changed,
        items_gone, items_invalid, items_suppressed, bytes, duration_ms, content_hash, parser_version, error_code, error_detail, anomaly_reasons)
      values (g.run_id, s.id, v_started, clock_timestamp(), 'anomaly', v_http, v_found, v_new, v_changed, 0, v_inv, v_sup, v_bytes, v_dur,
              v_chash, v_parser, v_ecode, v_edetail, v_reasons);
    insert into public.held_runs (run_id, source_id, items, summary)
      values (g.run_id, s.id, v_clean, jsonb_build_object('new', v_new, 'changed', v_changed, 'gone_candidates', v_gone_cand, 'reasons', to_jsonb(v_reasons)));
    insert into public.review_cards (kind, held_run_id, source_id) values ('held_run', g.run_id, s.id);
    update public.sources set robots_checked_at = case when v_robots then now() else robots_checked_at end,
        robots_hash = coalesce(v_rhash, robots_hash), ai_bots_blocked = coalesce(v_ai, ai_bots_blocked)
      where id = s.id;
    return jsonb_build_object('run_id', g.run_id, 'status', 'anomaly', 'reasons', to_jsonb(v_reasons),
                              'new', 0, 'changed', 0, 'gone', 0, 'geocode', '[]'::jsonb);
  end if;

  -- 9 apply
  v_ap := private.apply_items(s, g.run_id, v_parser, v_clean);
  insert into public.source_runs (id, source_id, started_at, finished_at, status, http_status, items_found, items_new, items_changed,
      items_gone, items_invalid, items_suppressed, bytes, duration_ms, content_hash, parser_version, error_code, error_detail)
    values (g.run_id, s.id, v_started, clock_timestamp(), 'ok', v_http, v_found, (v_ap ->> 'new')::int, (v_ap ->> 'changed')::int,
            (v_ap ->> 'gone')::int, v_inv, v_sup, v_bytes, v_dur, v_chash, v_parser, v_ecode, v_edetail);
  update public.sources set last_success_at = now(), consecutive_failures = 0,
      etag = v_etag, last_modified = v_lm, content_hash = v_chash,
      robots_checked_at = case when v_robots then now() else robots_checked_at end,
      robots_hash = coalesce(v_rhash, robots_hash), ai_bots_blocked = coalesce(v_ai, ai_bots_blocked)
    where id = s.id;

  -- 10 geocode budget
  v_geo := private.take_geocode_budget(array(select jsonb_array_elements_text(v_ap -> 'venue_ids'))::uuid[]);
  return jsonb_build_object('run_id', g.run_id, 'status', 'ok', 'new', (v_ap ->> 'new')::int, 'changed', (v_ap ->> 'changed')::int,
                            'gone', (v_ap ->> 'gone')::int, 'invalid', v_inv, 'suppressed', v_sup, 'geocode', v_geo);
end $$;

-- 4 Drain the backlog now (max 20 x 500) so queued live occurrences of the newly auto Chamber publish at push time.
do $$ declare i int; r jsonb; begin
  for i in 1..20 loop
    r := private.cluster_and_publish(500);
    exit when (r ->> 'remaining')::int = 0;
  end loop;
end $$;

-- Self-check (true on a fresh reset and on the hosted DB).
do $$ begin
  if not exists (select 1 from public.sources where slug = 'truckee-chamber' and trust = 'auto')
     or not exists (select 1 from public.sources where slug = 'alibi-truckee' and cadence = '6h')
     or not exists (select 1 from public.sources where slug = 'visit-lake-tahoe' and cadence = '12h' and trust = 'review' and strict_auto)
     or not exists (select 1 from public.sources where slug = 'truckee-chamber' and cadence = '24h')
     or not exists (select 1 from public.sources where slug = 'tdrpd' and cadence = '24h') then
    raise exception 'realtime_state';
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
grant execute on function public.list_event_pages() to anon, authenticated;
