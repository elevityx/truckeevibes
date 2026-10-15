-- A9 / A9.1 Truckee Chamber fixes: windowed discovery config, details-page addresses, sentence-like locations, geocode hint.
-- Functions are create-or-replace copies of their earlier definitions plus the marked changes; no grant changes.

-- A9-3: the sentence-like non-place rule (the A8.1 rule plus an instruction, a schedule and a 10-word test on the name part).
create or replace function private.is_non_place(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and (
           btrim(p) ~* '^https?://' or btrim(p) !~ '[[:alpha:]]'
        or (a.h ~* '^(find|see|check|click|register|join|rsvp|contact|call)\M' and b.w >= 4)
        or a.h ~ '[0-9]\s*:'
        or b.w >= 10)
    from (select btrim(split_part(btrim(coalesce(p, '')), ',', 1)) as h) a,
         lateral (select coalesce(array_length(regexp_split_to_array(
                    nullif(btrim(regexp_replace(a.h, '\([^)]*\)', ' ', 'g')), ''), '\s+'), 1), 0) as w) b
$$;

-- A9-3: resolve_venue, verbatim from 20261020000200_ingest_rpcs.sql plus the marked fill block (A9.1-2: reset on address OR town fill).
create or replace function private.resolve_venue(p_facts jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_name text := p_facts ->> 'venue_name'; v_nn text; v_town text := p_facts ->> 'town';
  v_lat double precision := (p_facts ->> 'lat')::double precision; v_lng double precision := (p_facts ->> 'lng')::double precision;
  v_id uuid; v_in_box boolean := false; v_region uuid := private.region_id();
begin
  if v_name is null then return null; end if;
  v_nn := private.normalize_title(v_name);
  if v_nn = '' then return null; end if;
  if v_lat is not null then v_in_box := private.in_drive_box(v_region, v_lat, v_lng); end if;

  -- (1) normalized name (+ town) or an alias
  select v.id into v_id from public.venues v
   where (v.normalized_name = v_nn or v_nn = any (v.aliases))
     and (v_town is null or v.town is null or v.town = v_town)
   order by (v.town is not distinct from v_town) desc, v.created_at limit 1;

  -- (2) coordinates given: a venue within 50 m whose name is a variant of this one (a different business at the
  --     same corner is a different venue)
  if v_id is null and v_lat is not null then
    select v.id into v_id from public.venues v
     where v.lat is not null and abs(v.lat - v_lat) < 0.001 and abs(v.lng - v_lng) < 0.002
       and private.dist_m(v.lat, v.lng, v_lat, v_lng) <= 50
       and (extensions.similarity(v.normalized_name, v_nn) >= 0.6 or private.token_contained(v.normalized_name, v_nn))
     order by private.dist_m(v.lat, v.lng, v_lat, v_lng), v.created_at limit 1;
    if v_id is not null then
      update public.venues set aliases = array_append(aliases, v_nn) where id = v_id and not (v_nn = any (aliases));
    end if;
  end if;

  if v_id is not null then
    -- a venue still without coordinates takes the source's, when they are inside the drive box
    if v_in_box then
      update public.venues set lat = v_lat, lng = v_lng, geocoder = 'source', area = private.area_for(v_lat, v_lng)
       where id = v_id and lat is null and not outside_region;
    end if;
    -- A9-3 begin: a venue still without coordinates takes a missing address/town from the item once, with fresh attempts
    update public.venues w
       set address = coalesce(w.address, p_facts ->> 'address'),
           town = case when w.town is null and v_town is not null
                        and not exists (select 1 from public.venues o
                                         where o.normalized_name = w.normalized_name and o.town = v_town and o.id <> w.id)
                       then v_town else w.town end,
           geocode_attempts = case when (w.address is null and p_facts ->> 'address' is not null)
                                     or (w.town is null and v_town is not null
                                         and not exists (select 1 from public.venues o
                                                          where o.normalized_name = w.normalized_name and o.town = v_town and o.id <> w.id))
                                   then 0 else w.geocode_attempts end
     where w.id = v_id and w.lat is null and not w.outside_region
       and ((w.address is null and p_facts ->> 'address' is not null) or (w.town is null and v_town is not null));
    -- A9-3 end
    return v_id;
  end if;

  begin
    insert into public.venues (name, normalized_name, address, town, area, lat, lng, geocoder)
    values (v_name, v_nn, p_facts ->> 'address', v_town,
            case when v_in_box then private.area_for(v_lat, v_lng) end,
            case when v_in_box then v_lat end, case when v_in_box then v_lng end,
            case when v_in_box then 'source' end)
    returning id into v_id;
  exception when unique_violation then
    select v.id into v_id from public.venues v where v.normalized_name = v_nn and v.town is not distinct from v_town;
  end;
  return v_id;
end $$;

-- A9-4: take_geocode_budget, verbatim plus the marked source geocodeHint.
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
                              case when x.address is null then coalesce(x.town, x.hint) else x.town end)) order by x.id), '[]')   -- A9-4
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

-- A9.1-1: scrub pending held runs stored before the rule existed (a re-runnable helper).
create function private.scrub_held_non_place() returns integer
language plpgsql set search_path = '' as $$
declare h record; v_items jsonb; v_c int; v_n int := 0;
begin
  for h in select x.run_id, x.items from public.held_runs x where x.status = 'pending' order by x.run_id for update loop
    select jsonb_agg(case when private.is_non_place(e #>> '{facts,venue_name}')
                          then jsonb_set(jsonb_set(e, '{facts,venue_name}', 'null'::jsonb), '{facts,address}', 'null'::jsonb)
                          else e end order by o),
           count(*) filter (where private.is_non_place(e #>> '{facts,venue_name}'))
      into v_items, v_c
      from jsonb_array_elements(h.items) with ordinality t(e, o);
    if v_c > 0 then
      update public.held_runs set items = v_items where run_id = h.run_id;
      v_n := v_n + v_c;
    end if;
  end loop;
  return v_n;
end $$;

-- A9-5: source config. The sources gate trigger validates this update; no bypass.
update public.sources
   set config = config || '{"listUrl":"https://chamber.truckee.com/events","windowDays":45,"geocodeHint":"Truckee, CA"}'::jsonb,
       page_cap = 200, next_due_at = now()
 where slug = 'truckee-chamber';

-- Stored sentence venues and pending held payloads (hosted DB: also judges venues created before this push).
do $$ declare n int; begin n := private.drop_non_place_venues(); raise notice 'a9_chamber_fixes dropped=%', n; end $$;
do $$ declare n int; begin n := private.scrub_held_non_place(); raise notice 'a9_held_scrubbed=%', n; end $$;

-- Self-check (true on a fresh reset and on the hosted DB, whether or not enable_vlt ran first): asserts only what this migration changes.
do $$ begin
  if not private.is_non_place('Find participating spots on Visit Truckee-Tahoe Taste of Truckee.')
     or not private.is_non_place('Night 1: Oct 16 at Alpenglow Sports (Tahoe City) Night 2: Oct 17 at Tahoe Mountain Sports')
     or private.is_non_place('Truckee Community Recreation Center')
     or private.is_non_place('Town Corp Yard (located next to the Humane Society)')
     or not exists (select 1 from public.sources where slug = 'truckee-chamber' and enabled and trust = 'review' and not strict_auto and page_cap = 200
                       and config ->> 'listUrl' = 'https://chamber.truckee.com/events' and (config ->> 'windowDays')::int = 45
                       and config ->> 'geocodeHint' = 'Truckee, CA' and 'chamber.truckee.com' = any (allowed_hosts))
     or exists (select 1 from public.venues where private.is_non_place(name))
     or exists (select 1 from public.held_runs h, jsonb_array_elements(h.items) e
                 where h.status = 'pending' and private.is_non_place(e #>> '{facts,venue_name}')) then
    raise exception 'a9_state';
  end if;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist (unchanged; this migration adds no public function).
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
