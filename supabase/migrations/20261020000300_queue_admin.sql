-- M1 queue and admin RPCs (spec S1.4). Every admin_* starts with the private.is_admin() gate and is granted to
-- `authenticated` on its exact signature.

-- Shared by the admin decisions below: status change with its journal row, in one place.
create function private.admin_set_status(p_event uuid, p_status public.event_status, p_reason text, p_uid uuid) returns void
language plpgsql set search_path = '' as $$
declare e public.events;
begin
  select * into e from public.events x where x.id = p_event for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'event'; end if;
  update public.events set status = p_status, status_by_admin = true,
      reject_reason = case when p_status in ('hidden', 'rejected') then left(p_reason, 200) else null end,
      published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
      moderated_by = p_uid, moderated_at = now()
    where id = e.id;
  insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
    values (e.id, 'status', to_jsonb(e.status::text), to_jsonb(p_status::text), 'admin:' || p_uid::text);
end $$;

create function public.admin_queue(p_kind text default null, p_limit integer default 50) returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'created_at', c.created_at, 'opened_at', c.opened_at, 'source_id', c.source_id,
      'event', case when e.id is null then null else jsonb_build_object(
          'id', e.id, 'slug', e.slug, 'title', e.title, 'summary', e.summary, 'status', e.status, 'starts_at', e.starts_at,
          'ends_at', e.ends_at, 'all_day', e.all_day, 'time_known', e.time_known, 'confidence', e.confidence,
          'venue', v.name, 'address', v.address, 'town', v.town, 'area', e.area,
          'categories', (select coalesce(jsonb_agg(ec.category order by ec.category), '[]') from public.event_categories ec where ec.event_id = e.id),
          'price_kind', e.price_kind, 'age', e.age, 'organizer_url', e.organizer_url, 'ticket_url', e.ticket_url,
          'locked_fields', to_jsonb(e.locked_fields)) end,
      'sources', case when e.id is null then '[]'::jsonb else
          (select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'class', s.class, 'trust', s.trust, 'source_url', se.url)
                                     order by s.priority desc, se.first_seen_at), '[]')
             from public.source_events se join public.sources s on s.id = se.source_id
            where se.cluster_id = e.id and se.source_status <> 'gone') end,
      'duplicates', case when e.id is null then '[]'::jsonb else
          (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'starts_at', d.starts_at, 'status', d.status)), '[]')
             from (select x.id, x.title, x.starts_at, x.status from public.events x
                    where x.id <> e.id and x.start_day = e.start_day and x.merged_into is null order by x.starts_at limit 5) d) end,
      'other_event', case when o.id is null then null else jsonb_build_object('id', o.id, 'title', o.title, 'starts_at', o.starts_at, 'status', o.status) end,
      'held_run', case when h.run_id is null then null else jsonb_build_object(
          'run_id', h.run_id, 'status', h.status, 'summary', h.summary, 'item_count', jsonb_array_length(h.items),
          'sample', (select coalesce(jsonb_agg(i #>> '{facts,title}'), '[]') from (select i from jsonb_array_elements(h.items) i limit 5) q)) end)
    from public.review_cards c
    left join public.events e on e.id = c.event_id
    left join public.venues v on v.id = e.venue_id
    left join public.events o on o.id = c.other_event_id
    left join public.held_runs h on h.run_id = c.held_run_id
   where c.status = 'open' and (coalesce(p_kind, '') in ('', 'all') or c.kind = p_kind)
   order by e.starts_at nulls last, c.created_at
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

create function public.admin_card_open(p_card uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.review_cards set opened_at = coalesce(opened_at, now()) where id = p_card;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'card'; end if;
end $$;

create function public.admin_decide_card(p_card uuid, p_decision text, p_reason text, p_review_seconds integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.review_cards; h public.held_runs; s public.sources; v_uid uuid := auth.uid(); v_secs int; v_reason text;
  v_parser text; v_r jsonb; i int; v_held_at timestamptz;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into c from public.review_cards x where x.id = p_card for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'card'; end if;
  if c.status <> 'open' then raise exception 'not_pending' using errcode = 'P0001'; end if;
  v_secs := least(greatest(coalesce(p_review_seconds, 0), 0), 600);
  v_reason := left(p_reason, 200);

  if c.kind = 'event' then
    if p_decision not in ('approve', 'reject') then raise exception 'invalid_input' using errcode = '22023', detail = 'decision'; end if;
    perform private.admin_set_status(c.event_id, case p_decision when 'approve' then 'published' else 'rejected' end::public.event_status, v_reason, v_uid);
  elsif c.kind = 'possible_duplicate' then
    if p_decision not in ('merge', 'distinct') then raise exception 'invalid_input' using errcode = '22023', detail = 'decision'; end if;
    if p_decision = 'merge' then perform public.admin_merge_events(c.event_id, c.other_event_id); end if;
  elsif c.kind = 'held_run' then
    if p_decision not in ('accept', 'discard') then raise exception 'invalid_input' using errcode = '22023', detail = 'decision'; end if;
    select * into h from public.held_runs x where x.run_id = c.held_run_id for update;
    if not found or h.status <> 'pending' then raise exception 'not_pending' using errcode = 'P0001'; end if;
    if p_decision = 'accept' then
      select * into s from public.sources x where x.id = h.source_id for update;   -- A5-3: lock FIRST, hold to commit
      select r0.finished_at into v_held_at from public.source_runs r0 where r0.id = h.run_id;
      if exists (select 1 from public.source_runs r
                  where r.source_id = h.source_id and r.id <> h.run_id and r.status in ('anomaly', 'ok')
                    and r.finished_at >= v_held_at) then
        raise exception 'stale' using errcode = 'P0001', detail = 'newer_run';
      end if;
      if not private.source_ingest_permitted(s) then
        raise exception 'source_not_permitted' using errcode = '23514';
      end if;
      select r.parser_version into v_parser from public.source_runs r where r.id = h.run_id;
      perform private.apply_items(s, h.run_id, v_parser, h.items);
      update public.held_runs set status = 'accepted', decided_by = v_uid, decided_at = now() where run_id = h.run_id;
      for i in 1 .. 20 loop
        v_r := private.cluster_and_publish(500);
        exit when (v_r ->> 'remaining')::int = 0;
      end loop;
    else
      update public.held_runs set status = 'discarded', decided_by = v_uid, decided_at = now() where run_id = h.run_id;
    end if;
  else
    if p_decision <> 'ack' then raise exception 'invalid_input' using errcode = '22023', detail = 'decision'; end if;
  end if;

  update public.review_cards set status = 'closed', decided_at = now(), review_seconds = v_secs, decision = p_decision,
      reason = v_reason, decided_by = v_uid
    where id = c.id;
end $$;

create function public.admin_update_event(p_event uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.events; r public.events; v_uid uuid := auth.uid(); v_by text; k text; v_keys text[];
  v_allowed text[] := array['title', 'summary', 'starts_at', 'ends_at', 'all_day', 'start_date', 'end_date', 'time_known', 'venue_id',
                            'categories', 'price_kind', 'price_min', 'price_max', 'age', 'organizer_url', 'ticket_url'];
  v_cats text[]; v_old jsonb; v_new jsonb; v_old_cats text[];
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'invalid_input' using errcode = '22023', detail = 'patch'; end if;
  v_keys := array(select jsonb_object_keys(p_patch));
  if cardinality(v_keys) = 0 then raise exception 'invalid_input' using errcode = '22023', detail = 'patch'; end if;
  foreach k in array v_keys loop
    if k <> all (v_allowed) then raise exception 'invalid_input' using errcode = '22023', detail = 'key'; end if;
  end loop;
  select * into e from public.events x where x.id = p_event for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'event'; end if;
  v_by := 'admin:' || v_uid::text;

  begin
    r := jsonb_populate_record(e, p_patch - 'categories');
    if p_patch ? 'title' and r.title is not null and (r.title ~ '[<>]' or private.has_blocked_term(r.title) or char_length(private.normalize_title(r.title)) < 3) then
      raise exception 'invalid_input' using errcode = '22023', detail = 'title';
    end if;
    if p_patch ? 'summary' and (r.summary ~ '[<>]' or private.has_blocked_term(r.summary)) then
      raise exception 'invalid_input' using errcode = '22023', detail = 'summary';
    end if;
    if (p_patch ?| array['price_min','price_max']) and r.price_min is not null and r.price_max is not null
       and r.price_min > r.price_max then
      raise exception 'invalid_input' using errcode = '22023', detail = 'price';
    end if;
    if (p_patch ?| array['starts_at','ends_at']) and r.ends_at is not null
       and (r.ends_at <= r.starts_at or r.ends_at > r.starts_at + interval '120 days') then
      raise exception 'invalid_input' using errcode = '22023', detail = 'ends_at';
    end if;
    if p_patch ? 'categories' then
      if jsonb_typeof(p_patch -> 'categories') <> 'array' then raise exception 'invalid_input' using errcode = '22023', detail = 'categories'; end if;
      v_cats := array(select distinct c from jsonb_array_elements_text(p_patch -> 'categories') c order by c);
      if exists (select 1 from unnest(v_cats) c where c not in (select k2.slug from public.categories k2)) then
        raise exception 'invalid_input' using errcode = '22023', detail = 'categories';
      end if;
    end if;
    update public.events set title = r.title, summary = r.summary, starts_at = r.starts_at, ends_at = r.ends_at, all_day = r.all_day,
        start_date = r.start_date, end_date = r.end_date, time_known = r.time_known, venue_id = r.venue_id,
        price_kind = r.price_kind, price_min = r.price_min, price_max = r.price_max, age = r.age,
        organizer_url = r.organizer_url, ticket_url = r.ticket_url,
        locked_fields = array(select distinct f from unnest(locked_fields || v_keys) f order by f),
        field_sources = field_sources || (select jsonb_object_agg(f, 'admin'::text) from unnest(v_keys) f)
      where id = e.id;
  exception when data_exception or integrity_constraint_violation then
    if sqlerrm = 'invalid_input' then raise; end if;
    raise exception 'invalid_input' using errcode = '22023', detail = 'patch';
  end;

  if p_patch ? 'categories' then
    v_old_cats := array(select ec.category from public.event_categories ec where ec.event_id = e.id order by ec.category);
    delete from public.event_categories ec where ec.event_id = e.id and ec.category <> all (v_cats);
    insert into public.event_categories (event_id, category) select e.id, c from unnest(v_cats) c on conflict do nothing;
    if v_old_cats is distinct from v_cats then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
        values (e.id, 'categories', to_jsonb(v_old_cats), to_jsonb(v_cats), v_by);
    end if;
  end if;
  foreach k in array v_keys loop
    if k = 'categories' then continue; end if;
    v_old := to_jsonb(e) -> k; v_new := to_jsonb(r) -> k;
    if v_old is distinct from v_new then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, k, v_old, v_new, v_by);
    end if;
  end loop;
  perform private.recompute_event(e.id);
end $$;

create function public.admin_set_event_status(p_event uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('hidden', 'published', 'rejected') then
    raise exception 'invalid_input' using errcode = '22023', detail = 'status';
  end if;
  perform private.admin_set_status(p_event, p_status::public.event_status, p_reason, auth.uid());
  update public.review_cards set status = 'closed', decision = 'status_set', decided_at = now(), decided_by = auth.uid()
   where event_id = p_event and kind = 'event' and status = 'open';
end $$;

create function public.admin_unlock_field(p_event uuid, p_field text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.events set locked_fields = array_remove(locked_fields, p_field), field_sources = field_sources - p_field where id = p_event;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'event'; end if;
  perform private.recompute_event(p_event);
end $$;

create function public.admin_source_health() returns setof jsonb
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
      'held_runs_pending', (select count(*) from public.held_runs h where h.source_id = s.id and h.status = 'pending'))
    from public.sources s order by s.name;
end $$;

create function public.admin_add_suppression(p_kind text, p_value text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_value text; v_uid uuid := auth.uid(); ev record;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('host', 'url_prefix', 'event') or p_value is null or btrim(p_value) = ''
     or char_length(p_value) > 300 then
    raise exception 'invalid_input' using errcode = '22023', detail = 'suppression';
  end if;
  v_value := case p_kind when 'host' then lower(btrim(p_value)) else btrim(p_value) end;
  if p_kind = 'event' and v_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input' using errcode = '22023', detail = 'suppression';
  end if;
  insert into public.suppressions (kind, value, reason) values (p_kind, v_value, left(p_reason, 200)) on conflict (kind, value) do nothing;
  for ev in
    select e.id, e.status from public.events e
     where e.status in ('published', 'pending', 'unlisted', 'cancelled')
       and ((p_kind = 'event' and e.id::text = v_value)
         or (p_kind = 'url_prefix' and e.organizer_url is not null and left(e.organizer_url, char_length(v_value)) = v_value)
         or (p_kind = 'host' and e.organizer_url is not null
             and (substring(lower(e.organizer_url) from '^https://([^/?#]+)') = v_value
                  or right(substring(lower(e.organizer_url) from '^https://([^/?#]+)'), char_length(v_value) + 1) = '.' || v_value)))
     for update
  loop
    update public.events set status = 'hidden', status_by_admin = true, reject_reason = 'suppressed', moderated_by = v_uid, moderated_at = now()
     where id = ev.id;
    insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
      values (ev.id, 'status', to_jsonb(ev.status::text), to_jsonb('hidden'::text), 'admin:' || v_uid::text);
    update public.review_cards set status = 'closed', decision = 'suppressed', decided_at = now(), decided_by = v_uid
     where event_id = ev.id and kind = 'event' and status = 'open';
  end loop;
  insert into public.owner_activity (kind, seconds, by) values ('takedown', 0, v_uid);
end $$;

create function public.admin_log_activity(p_kind text, p_seconds integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('featured', 'takedown', 'source_decision', 'other') then
    raise exception 'invalid_input' using errcode = '22023', detail = 'kind';
  end if;
  insert into public.owner_activity (kind, seconds, by) values (p_kind, least(greatest(coalesce(p_seconds, 0), 0), 3600), auth.uid());
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
