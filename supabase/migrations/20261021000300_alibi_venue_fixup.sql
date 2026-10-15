-- A8-2 / A8.1: Alibi venue fix-up and the non-place guard (spec Amendment 8 / 8.1).
-- Conductor-verified addresses, geocoded on Nominatim: Truckee Public House 10069 Bridge St, Truckee CA 96161 -> 39.3291704, -120.1843897;
-- Incline Public House 931 Tahoe Blvd, Incline Village NV 89451 -> 39.2490880, -119.9489837 (OSM names it as the Alibi pub).
-- The logic lives in private functions (no grant) so pgTAP runs the exact code on fixture rows; on a fresh reset the run below is a no-op.

-- A8.1: one rule for "is this text a place?", shared with the parser's isNonPlaceLocation.
create function private.is_non_place(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and (btrim(p) ~* '^https?://' or btrim(p) !~ '[[:alpha:]]')
$$;

-- A8.1-3: server-side guard. Verbatim copy of 20261020000200_ingest_rpcs.sql clean_source_item plus ONE marked line
-- (the is_non_place line after the address block). A non-place venueName (and its address) is dropped, the item is kept.
create or replace function private.clean_source_item(s public.sources, item jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_tz text := private.region_tz();
  v_iso text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  v_key text; v_title text; v_cut text;
  v_start timestamptz; v_end timestamptz; v_all_day boolean := false; v_sd date; v_ed date; v_tk boolean := true;
  v_url text; v_host text; v_turl text; v_vn text; v_addr text; v_town text; v_lat double precision; v_lng double precision;
  v_pk text := 'unknown'; v_pmin numeric; v_pmax numeric; v_age text := 'unknown'; v_cats text[] := '{}';
  v_cancel boolean := false; v_series text;
begin
  if jsonb_typeof(item) is distinct from 'object' then return jsonb_build_object('reject', 'item'); end if;

  -- externalKey: 1-400 chars
  if private.jt(item, 'externalKey') <> 'string' then return jsonb_build_object('reject', 'external_key'); end if;
  v_key := item ->> 'externalKey';
  if char_length(v_key) not between 1 and 400 then return jsonb_build_object('reject', 'external_key'); end if;

  -- title: strip control chars, collapse spaces, no markup, no blocked term, >= 3 chars, cut to 80 at a word boundary
  if private.jt(item, 'title') <> 'string' then return jsonb_build_object('reject', 'title'); end if;
  v_title := private.clean_text(item ->> 'title');
  if v_title ~ '[<>]' or private.has_blocked_term(v_title) or char_length(v_title) < 3 then
    return jsonb_build_object('reject', 'title');
  end if;
  if char_length(v_title) > 80 then
    v_cut := left(v_title, 80);
    if substr(v_title, 81, 1) <> ' ' then v_cut := regexp_replace(v_cut, '\s+\S*$', ''); end if;
    v_cut := btrim(v_cut);
    v_title := case when v_cut = '' then left(v_title, 80) else v_cut end;
  end if;
  if char_length(private.normalize_title(v_title)) < 3 then return jsonb_build_object('reject', 'title'); end if;

  -- allDay, startsAt, endsAt
  if private.jt(item, 'allDay') = 'boolean' then v_all_day := (item ->> 'allDay')::boolean;
  elsif private.jt(item, 'allDay') <> 'null' then return jsonb_build_object('reject', 'all_day'); end if;

  if v_all_day then
    if private.jt(item, 'startDate') <> 'string' or private.jt(item, 'endDate') <> 'string'
       or (item ->> 'startDate') !~ '^\d{4}-\d{2}-\d{2}$' or (item ->> 'endDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('reject', 'dates');
    end if;
    begin
      v_sd := (item ->> 'startDate')::date; v_ed := (item ->> 'endDate')::date;
    exception when others then return jsonb_build_object('reject', 'dates');
    end;
    if v_ed <= v_sd or v_ed - v_sd > 120 then return jsonb_build_object('reject', 'dates'); end if;
    v_start := v_sd::timestamp at time zone v_tz;       -- local midnight of the first day
    v_end := v_ed::timestamp at time zone v_tz;         -- exclusive end, local midnight
    v_tk := false;
  else
    if private.jt(item, 'startsAt') <> 'string' or (item ->> 'startsAt') !~ v_iso then return jsonb_build_object('reject', 'starts_at'); end if;
    begin
      v_start := (item ->> 'startsAt')::timestamptz;
    exception when others then return jsonb_build_object('reject', 'starts_at');
    end;
    if private.jt(item, 'endsAt') <> 'null' then
      if private.jt(item, 'endsAt') <> 'string' or (item ->> 'endsAt') !~ v_iso then return jsonb_build_object('reject', 'ends_at'); end if;
      begin
        v_end := (item ->> 'endsAt')::timestamptz;
      exception when others then return jsonb_build_object('reject', 'ends_at');
      end;
    end if;
    if private.jt(item, 'timeKnown') = 'boolean' then v_tk := (item ->> 'timeKnown')::boolean;
    elsif private.jt(item, 'timeKnown') <> 'null' then return jsonb_build_object('reject', 'time_known'); end if;
  end if;
  if v_start < now() - interval '1 day' or v_start > now() + interval '120 days' then return jsonb_build_object('reject', 'window'); end if;
  if v_end is not null and (v_end <= v_start or v_end > v_start + interval '120 days') then return jsonb_build_object('reject', 'ends_at'); end if;

  -- url must be https, valid, and on an allowed host (or a subdomain of one); ticketUrl only needs to be valid
  if private.jt(item, 'url') <> 'null' then
    if private.jt(item, 'url') <> 'string' or not private.valid_event_url(item ->> 'url') then return jsonb_build_object('reject', 'url'); end if;
    v_url := item ->> 'url';
    v_host := substring(lower(v_url) from '^https://([^/?#]+)');
    if not exists (select 1 from unnest(s.allowed_hosts) h where v_host = lower(h) or v_host like '%.' || lower(h)) then
      return jsonb_build_object('reject', 'url_host');
    end if;
  end if;
  if private.jt(item, 'ticketUrl') <> 'null' then
    if private.jt(item, 'ticketUrl') <> 'string' or not private.valid_event_url(item ->> 'ticketUrl') then return jsonb_build_object('reject', 'ticket_url'); end if;
    v_turl := item ->> 'ticketUrl';
  end if;

  -- venue
  if private.jt(item, 'venueName') <> 'null' then
    if private.jt(item, 'venueName') <> 'string' then return jsonb_build_object('reject', 'venue'); end if;
    v_vn := nullif(private.clean_text(item ->> 'venueName'), '');
    if v_vn is not null and (char_length(v_vn) > 80 or v_vn ~ '[<>]') then return jsonb_build_object('reject', 'venue'); end if;
  end if;
  if private.jt(item, 'address') <> 'null' then
    if private.jt(item, 'address') <> 'string' then return jsonb_build_object('reject', 'address'); end if;
    v_addr := nullif(private.clean_text(item ->> 'address'), '');
    if v_addr is not null and (char_length(v_addr) > 160 or v_addr ~ '[<>]') then return jsonb_build_object('reject', 'address'); end if;
  end if;
  if private.is_non_place(v_vn) then v_vn := null; v_addr := null; end if;   -- A8.1: a URL or letterless LOCATION is not a venue
  if private.jt(item, 'town') <> 'null' then
    if private.jt(item, 'town') <> 'string' then return jsonb_build_object('reject', 'town'); end if;
    v_town := nullif(private.clean_text(item ->> 'town'), '');
    if v_town is not null and (char_length(v_town) > 60 or v_town ~ '[<>]') then return jsonb_build_object('reject', 'town'); end if;
  end if;
  if private.jt(item, 'lat') = 'number' and private.jt(item, 'lng') = 'number' then
    v_lat := (item ->> 'lat')::double precision; v_lng := (item ->> 'lng')::double precision;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then return jsonb_build_object('reject', 'coords'); end if;
  elsif private.jt(item, 'lat') <> 'null' or private.jt(item, 'lng') <> 'null' then
    return jsonb_build_object('reject', 'coords');      -- both or neither, numbers only
  end if;

  -- price and age: text hints are length-checked (classified in the runner); the enums are re-validated here
  if private.jt(item, 'priceText') <> 'null' and (private.jt(item, 'priceText') <> 'string' or char_length(item ->> 'priceText') > 80) then
    return jsonb_build_object('reject', 'price_text');
  end if;
  if private.jt(item, 'ageText') <> 'null' and (private.jt(item, 'ageText') <> 'string' or char_length(item ->> 'ageText') > 80) then
    return jsonb_build_object('reject', 'age_text');
  end if;
  if private.jt(item, 'priceKind') <> 'null' then
    if private.jt(item, 'priceKind') <> 'string' or (item ->> 'priceKind') not in ('free', 'paid', 'donation', 'unknown') then return jsonb_build_object('reject', 'price_kind'); end if;
    v_pk := item ->> 'priceKind';
  end if;
  if private.jt(item, 'priceMin') <> 'null' then
    if private.jt(item, 'priceMin') <> 'number' or (item ->> 'priceMin')::numeric not between 0 and 99999.99 then return jsonb_build_object('reject', 'price'); end if;
    v_pmin := (item ->> 'priceMin')::numeric;
  end if;
  if private.jt(item, 'priceMax') <> 'null' then
    if private.jt(item, 'priceMax') <> 'number' or (item ->> 'priceMax')::numeric not between 0 and 99999.99 then return jsonb_build_object('reject', 'price'); end if;
    v_pmax := (item ->> 'priceMax')::numeric;
  end if;
  if v_pmin is not null and v_pmax is not null and v_pmin > v_pmax then return jsonb_build_object('reject', 'price'); end if;
  if private.jt(item, 'age') <> 'null' then
    if private.jt(item, 'age') <> 'string' or (item ->> 'age') not in ('all_ages', 'family', '18_plus', '21_plus', 'unknown') then return jsonb_build_object('reject', 'age'); end if;
    v_age := item ->> 'age';
  end if;

  -- categories: only known slugs survive
  if private.jt(item, 'categoriesHint') <> 'null' then
    if private.jt(item, 'categoriesHint') <> 'array' then return jsonb_build_object('reject', 'categories'); end if;
    if exists (select 1 from jsonb_array_elements(item -> 'categoriesHint') c where jsonb_typeof(c) <> 'string') then return jsonb_build_object('reject', 'categories'); end if;
    v_cats := array(select distinct c from jsonb_array_elements_text(item -> 'categoriesHint') c
                     where c in (select k.slug from public.categories k) order by c);
  end if;

  if private.jt(item, 'cancelled') = 'boolean' then v_cancel := (item ->> 'cancelled')::boolean;
  elsif private.jt(item, 'cancelled') <> 'null' then return jsonb_build_object('reject', 'cancelled'); end if;
  if private.jt(item, 'seriesUid') <> 'null' then
    if private.jt(item, 'seriesUid') <> 'string' or char_length(item ->> 'seriesUid') not between 1 and 300 then return jsonb_build_object('reject', 'series'); end if;
    v_series := item ->> 'seriesUid';
  end if;

  -- suppressions (host / url_prefix on the link)
  if v_url is not null and exists (
       select 1 from public.suppressions x
        where (x.kind = 'host' and (v_host = lower(x.value) or right(v_host, char_length(x.value) + 1) = '.' || lower(x.value)))
           or (x.kind = 'url_prefix' and left(v_url, char_length(x.value)) = x.value)) then
    return jsonb_build_object('reject', 'suppressed');
  end if;

  return jsonb_build_object('external_key', v_key, 'series_uid', v_series, 'facts', jsonb_build_object(
    'title', v_title,
    'starts_at', to_char(v_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ends_at', case when v_end is null then null else to_char(v_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'all_day', v_all_day, 'start_date', v_sd, 'end_date', v_ed, 'time_known', v_tk,
    'venue_name', v_vn, 'address', v_addr, 'town', v_town, 'lat', v_lat, 'lng', v_lng,
    'url', v_url, 'ticket_url', v_turl, 'price_kind', v_pk, 'price_min', v_pmin, 'price_max', v_pmax,
    'age', v_age, 'categories', to_jsonb(v_cats), 'cancelled', v_cancel));
end $$;

-- S1.13 step 4 as a reusable helper. Returns 1 when a venue was updated (and its live source_events re-queued), else 0.
create function private.venue_admin_fix(p_name text, p_address text, p_town text, p_lat double precision, p_lng double precision)
returns integer
language plpgsql set search_path = '' as $$
declare v_nn text; v_ids uuid[]; v_id uuid; v_n integer;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or not private.in_drive_box(private.region_id(), p_lat, p_lng) then
    raise exception 'venue_fixup_outside_box';
  end if;
  v_nn := private.normalize_title(p_name);
  v_ids := array(select v.id from public.venues v where v.normalized_name = v_nn and (v.town is null or v.town = p_town) order by v.id for update);
  if cardinality(v_ids) = 0 then return 0; end if;
  if cardinality(v_ids) > 1 then raise exception 'venue_fixup_ambiguous'; end if;
  v_id := v_ids[1];
  update public.venues v set lat = p_lat, lng = p_lng, area = private.area_for(p_lat, p_lng), geocoder = 'admin', verified = true,
      outside_region = false, town = p_town, address = p_address
    where v.id = v_id
      and (v.lat, v.lng, v.geocoder, v.verified, v.outside_region, v.town, v.address)
          is distinct from (p_lat, p_lng, 'admin', true, false, p_town, p_address);
  get diagnostics v_n = row_count;
  if v_n = 0 then return 0; end if;
  update public.source_events set needs_cluster = true where venue_id = v_id and source_status <> 'gone';
  return 1;
end $$;

-- The A8-1 rule applied to stored rows. Re-runnable by the conductor at any time (as postgres). Never touches an event's
-- id, slug, status or cluster_id; the drain recomputes the rest.
create function private.drop_non_place_venues() returns integer
language plpgsql set search_path = '' as $$
declare v_ids uuid[];
begin
  v_ids := array(select v.id from public.venues v where private.is_non_place(v.name));
  if cardinality(v_ids) = 0 then return 0; end if;
  update public.source_events set venue_id = null, needs_cluster = needs_cluster or source_status <> 'gone' where venue_id = any (v_ids);
  update public.events set venue_id = null, area = null where venue_id = any (v_ids);
  delete from public.venues where id = any (v_ids);
  return cardinality(v_ids);
end $$;

create function private.a8_alibi_venue_fixup() returns jsonb
language plpgsql set search_path = '' as $$
begin
  return jsonb_build_object(
    'truckee', private.venue_admin_fix('Alibi Ale Works - Truckee Public House', '10069 Bridge St, Truckee, CA 96161', 'Truckee', 39.3291704, -120.1843897),
    'incline', private.venue_admin_fix('Alibi Ale Works - Incline Public House', '931 Tahoe Blvd, Incline Village, NV 89451', 'Incline Village', 39.2490880, -119.9489837),
    'dropped', private.drop_non_place_venues());
end $$;

do $$ declare r jsonb; begin r := private.a8_alibi_venue_fixup(); raise notice 'a8_alibi_venue_fixup %', r; end $$;

-- Self-check (true on a fresh reset and on the hosted DB).
do $$ begin
  if exists (select 1 from public.venues where private.is_non_place(name))
     or exists (select 1 from public.venues where normalized_name in (private.normalize_title('Alibi Ale Works - Truckee Public House'), private.normalize_title('Alibi Ale Works - Incline Public House'))
                  and not (verified and geocoder = 'admin' and lat is not null))
     or not exists (select 1 from public.sources where slug = 'alibi-truckee' and enabled and trust = 'review' and not strict_auto) then
    raise exception 'a8_state';
  end if;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist (the same 23 as owner_minutes; this migration adds no public function).
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
