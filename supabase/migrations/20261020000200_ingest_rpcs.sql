-- M1 ingest RPCs (spec S1.2, S1.3): run grants, batch ingest with the surge guard, geocode results, clustering and
-- publishing, the M3 stubs, the admin merge and the public read RPC. Every function pins search_path.

-- ---------------------------------------------------------------------------------------------------------------------
-- Small pure helpers
-- ---------------------------------------------------------------------------------------------------------------------
create function private.jt(item jsonb, k text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(item -> k), 'null')
$$;

create function private.clean_text(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- Haversine distance in metres; null when any coordinate is null.
create function private.dist_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable set search_path = '' as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null
    else 2 * 6371000 * asin(least(1, sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
           + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))) end
$$;

-- The token set of the shorter normalized title (>= 2 tokens, >= 8 chars) is a subset of the longer one's.
create function private.token_contained(a text, b text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare ta text[]; tb text[]; s text[]; l text[]; sn text;
begin
  ta := array(select distinct t from unnest(string_to_array(coalesce(a, ''), ' ')) t where t <> '');
  tb := array(select distinct t from unnest(string_to_array(coalesce(b, ''), ' ')) t where t <> '');
  if cardinality(ta) <= cardinality(tb) then s := ta; l := tb; sn := a; else s := tb; l := ta; sn := b; end if;
  return cardinality(s) >= 2 and char_length(coalesce(sn, '')) >= 8 and s <@ l;
end $$;

create function private.adult_signal(t text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(t ~ '\m(21|18|bar|bars|pub|pubs|crawl|cocktail|cocktails|happy hour|brewery|breweries|brewing|brewpub|taproom|tap room|alehouse|ale works|ale house|winery|wine|wines|beer|beers|saloon|tavern|lounge|cantina|casino|nightclub|club|burlesque|drag|speakeasy|distillery|spirits|tequila|whiskey|whisky|margarita|mimosa|bottomless)\M', false)
$$;

create function private.facts_hash(p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_facts::text, 'sha256'), 'hex')
$$;

create function private.region_id() returns uuid
language sql stable set search_path = '' as $$
  select r.id from public.regions r order by r.slug limit 1
$$;

create function private.cadence_interval(p_cadence text) returns interval
language sql immutable set search_path = '' as $$
  select case p_cadence when '6h' then interval '6 hours' when '12h' then interval '12 hours' when '24h' then interval '24 hours'
                        when '72h' then interval '72 hours' when '168h' then interval '168 hours' end
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- M1 stubs for M3 objects (created before recompute_event; M3 replaces both with `create or replace`, same signatures)
-- ---------------------------------------------------------------------------------------------------------------------
create function private.lights_pairs(e public.events) returns jsonb
  language sql stable set search_path = '' as $$ select '[]'::jsonb $$;
create function private.event_is_exported(p_event uuid) returns boolean
  language sql stable set search_path = '' as $$ select false $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Item cleaning (S1.2 step 5). Returns {reject: <reason>} or {external_key, series_uid, facts}.
-- ---------------------------------------------------------------------------------------------------------------------
create function private.clean_source_item(s public.sources, item jsonb) returns jsonb
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

-- ---------------------------------------------------------------------------------------------------------------------
-- Venues, series, geocode budget
-- ---------------------------------------------------------------------------------------------------------------------
create function private.resolve_venue(p_facts jsonb) returns uuid
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

create function private.take_geocode_budget(p_venue_ids uuid[]) returns jsonb
language plpgsql set search_path = '' as $$
declare v_month date := date_trunc('month', now())::date; v_units int; v_cap int; v_n int; v_out jsonb;
begin
  insert into public.geocode_usage (month) values (v_month) on conflict do nothing;
  select u.units, u.cap into v_units, v_cap from public.geocode_usage u where u.month = v_month for update;
  v_n := least(20, greatest(v_cap - v_units, 0));
  if v_n <= 0 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('venue_id', x.id, 'query', concat_ws(', ', x.name, x.address, x.town)) order by x.id), '[]')
    into v_out
    from (select v.id, v.name, v.address, v.town from public.venues v
           where v.id = any (p_venue_ids) and v.lat is null and v.geocode_attempts < 3 and not v.outside_region
           order by v.id limit v_n) x;
  update public.geocode_usage set units = units + jsonb_array_length(v_out) where month = v_month;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Apply cleaned items to source_events (S1.2 step 9). Also the replay path for an accepted held run.
-- ---------------------------------------------------------------------------------------------------------------------
create function private.apply_items(p_source public.sources, p_run_id uuid, p_parser text, p_items jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  rec jsonb; f jsonb; v_key text; v_hash text; se public.source_events; v_venue uuid; v_series uuid; v_status text;
  v_new int := 0; v_changed int := 0; v_gone int := 0; v_keys text[] := '{}'; v_venues uuid[] := '{}';
  v_cats text[]; v_parser text := coalesce(p_parser, 'unknown'); v_exists boolean;
begin
  for rec in select value from jsonb_array_elements(p_items) loop
    f := rec -> 'facts';
    v_key := rec ->> 'external_key';
    v_keys := array_append(v_keys, v_key);
    v_hash := private.facts_hash(f);
    v_status := case when (f ->> 'cancelled')::boolean then 'cancelled_by_source' else 'live' end;
    select * into se from public.source_events x where x.source_id = p_source.id and x.external_key = v_key for update;
    v_exists := found;
    if v_exists and se.content_hash = v_hash then
      -- unchanged: seen again; a row that had gone comes back live
      update public.source_events x set last_seen_at = now(), missing_runs = 0,
             source_status = case when x.source_status = 'gone' then v_status else x.source_status end,
             needs_cluster = x.needs_cluster or x.source_status = 'gone'
       where x.id = se.id;
      if se.venue_id is not null then v_venues := array_append(v_venues, se.venue_id); end if;
      continue;
    end if;

    v_venue := private.resolve_venue(f);
    if v_venue is not null then v_venues := array_append(v_venues, v_venue); end if;
    v_series := null;
    if rec ->> 'series_uid' is not null then
      insert into public.series (source_id, source_uid, title) values (p_source.id, rec ->> 'series_uid', f ->> 'title')
        on conflict (source_id, source_uid) do update set title = excluded.title returning id into v_series;
    end if;
    v_cats := array(select jsonb_array_elements_text(f -> 'categories'));

    if not v_exists then
      insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, ends_at,
          all_day, start_date, end_date, time_known, start_day, venue_id, url, ticket_url, price_kind, price_min, price_max,
          age, categories, series_id, source_status, needs_cluster)
        values (p_source.id, v_key, f, v_hash, f ->> 'title', '', (f ->> 'starts_at')::timestamptz, (f ->> 'ends_at')::timestamptz,
          (f ->> 'all_day')::boolean, (f ->> 'start_date')::date, (f ->> 'end_date')::date, (f ->> 'time_known')::boolean,
          current_date, v_venue, f ->> 'url', f ->> 'ticket_url', f ->> 'price_kind', (f ->> 'price_min')::numeric,
          (f ->> 'price_max')::numeric, f ->> 'age', v_cats, v_series, v_status, true)
        returning * into se;
      v_new := v_new + 1;
    else
      update public.source_events x set facts = f, content_hash = v_hash, title = f ->> 'title',
          starts_at = (f ->> 'starts_at')::timestamptz, ends_at = (f ->> 'ends_at')::timestamptz,
          all_day = (f ->> 'all_day')::boolean, start_date = (f ->> 'start_date')::date, end_date = (f ->> 'end_date')::date,
          time_known = (f ->> 'time_known')::boolean, venue_id = v_venue, url = f ->> 'url', ticket_url = f ->> 'ticket_url',
          price_kind = f ->> 'price_kind', price_min = (f ->> 'price_min')::numeric, price_max = (f ->> 'price_max')::numeric,
          age = f ->> 'age', categories = v_cats, series_id = v_series, last_seen_at = now(), missing_runs = 0,
          source_status = v_status, needs_cluster = true
        where x.id = se.id;
      v_changed := v_changed + 1;
    end if;
    insert into public.source_event_versions (source_event_id, run_id, normalized, normalized_hash, parser_version)
      values (se.id, p_run_id, f, v_hash, v_parser);
  end loop;

  -- live, future occurrences missing from this batch: one more missed run; the third marks them gone
  with g as (
    update public.source_events x
       set missing_runs = (x.missing_runs + 1)::smallint,
           source_status = case when x.missing_runs + 1 >= 3 then 'gone' else x.source_status end,
           needs_cluster = x.needs_cluster or x.missing_runs + 1 >= 3
     where x.source_id = p_source.id and x.source_status = 'live' and x.starts_at > now()
       and x.external_key <> all (v_keys)
    returning x.source_status)
  select count(*) filter (where source_status = 'gone') into v_gone from g;

  return jsonb_build_object('new', v_new, 'changed', v_changed, 'gone', v_gone,
                            'venue_ids', to_jsonb((select coalesce(array_agg(distinct vv), '{}') from unnest(v_venues) vv)));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- svc_ingest_nonce, svc_issue_run_grants
-- ---------------------------------------------------------------------------------------------------------------------
create function public.svc_ingest_nonce(p_nonce text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into private.ingest_nonces (nonce) values (p_nonce) on conflict do nothing;
  get diagnostics v_n = row_count;
  delete from private.ingest_nonces where seen_at < now() - interval '1 day';
  return v_n = 1;
end $$;

create function public.svc_issue_run_grants() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid; v_out jsonb := '[]'::jsonb;
begin
  for s in
    select * from public.sources x
     where x.enabled and not x.opt_out and x.trust <> 'link_only'
       and x.ingest_disposition in ('permitted', 'official_api_only') and x.terms_recheck_at > now()
       and cardinality(x.allowed_methods) > 0 and x.next_due_at <= now()
     order by x.next_due_at for update skip locked
  loop
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_run := gen_random_uuid();
    insert into private.ingest_grants (token_hash, source_id, run_id, expires_at)
      values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes');
    update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
      'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
      'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'etag', s.etag, 'last_modified', s.last_modified,
      'content_hash', s.content_hash, 'ingest_disposition', s.ingest_disposition, 'terms_recheck_at', s.terms_recheck_at)));
  end loop;
  return jsonb_build_object('grants', v_out);
end $$;

-- One permission predicate for ingest and held-run accept (A5-3).
create function private.source_ingest_permitted(s public.sources) returns boolean
language sql stable set search_path = '' as $$
  select s.enabled and not s.opt_out and s.trust <> 'link_only' and s.ingest_disposition in ('permitted', 'official_api_only')
         and s.terms_recheck_at > now() and cardinality(s.allowed_methods) > 0
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- svc_ingest_batch (S1.2): one transaction; counters are always server-computed
-- ---------------------------------------------------------------------------------------------------------------------
create function public.svc_ingest_batch(p_grant text, p_run jsonb, p_items jsonb) returns jsonb
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

  if v_new > greatest(20, 3 * v_med_new) and not (not v_prior_ok and s.trust <> 'auto' and not s.strict_auto) then
    v_reasons := array_append(v_reasons, 'new_surge');
  end if;
  if v_changed > greatest(5, ceil(0.20 * v_live)) then v_reasons := array_append(v_reasons, 'edit_surge'); end if;
  if v_changed + v_week_changed > greatest(10, ceil(0.40 * v_live)) then v_reasons := array_append(v_reasons, 'edit_surge_7d'); end if;
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

-- ---------------------------------------------------------------------------------------------------------------------
-- svc_set_venue_geocode
-- ---------------------------------------------------------------------------------------------------------------------
create function public.svc_set_venue_geocode(p_venue_id uuid, p_lat double precision, p_lng double precision, p_geocoder text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.venues; v_region uuid := private.region_id(); v_finite boolean;
begin
  select * into v from public.venues x where x.id = p_venue_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'venue'; end if;
  v_finite := p_lat is not null and p_lng is not null and p_lat between -90 and 90 and p_lng between -180 and 180;
  if v_finite and private.in_drive_box(v_region, p_lat, p_lng) then
    update public.venues set lat = p_lat, lng = p_lng, area = private.area_for(p_lat, p_lng), geocoder = p_geocoder,
        geocode_attempts = least(geocode_attempts + 1, 3)::smallint, outside_region = false
      where id = p_venue_id;
    update public.source_events set needs_cluster = true where venue_id = p_venue_id and source_status <> 'gone';
  elsif v_finite then
    -- a real place outside the region: no retries, and its events are rejected by rule
    update public.venues set outside_region = true, geocode_attempts = 3 where id = p_venue_id;
    update public.source_events set needs_cluster = true where venue_id = p_venue_id and source_status <> 'gone';
  else
    update public.venues set geocode_attempts = least(geocode_attempts + 1, 3)::smallint where id = p_venue_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Confidence, strict rule, card policy, summary
-- ---------------------------------------------------------------------------------------------------------------------
create function private.confidence_flags(e public.events) returns text[]
language plpgsql stable set search_path = '' as $$
declare v_flags text[] := '{}'; v_tz text := private.region_tz();
begin
  if char_length(regexp_replace(e.title, '[^A-Za-z]', '', 'g')) >= 5 and e.title = upper(e.title) then v_flags := array_append(v_flags, 'all_caps'); end if;
  if e.title ~* 'https?://|www\.' then v_flags := array_append(v_flags, 'url_title'); end if;
  if e.ends_at is not null and e.ends_at - e.starts_at > interval '14 days' and e.series_id is null then v_flags := array_append(v_flags, 'long_unseries'); end if;
  if extract(hour from e.starts_at at time zone v_tz) < 6 and e.title !~* 'late night|after ?party|midnight|new year|nye' then
    v_flags := array_append(v_flags, 'early_hour');
  end if;
  return v_flags;
end $$;

create function private.confidence(e public.events) returns smallint
language plpgsql stable set search_path = '' as $$
declare v_n int; v_auto boolean; v_score int := 0;
begin
  select count(distinct se.source_id), coalesce(bool_or(s.trust = 'auto'), false) into v_n, v_auto
    from public.source_events se join public.sources s on s.id = se.source_id
   where se.cluster_id = e.id and se.source_status <> 'gone';
  if v_auto then v_score := v_score + 40; end if;
  if e.time_known then v_score := v_score + 15; end if;
  if exists (select 1 from public.venues v where v.id = e.venue_id and v.lat is not null and private.in_drive_box(e.region_id, v.lat, v.lng)) then
    v_score := v_score + 15;
  end if;
  v_score := v_score + 10 * least(greatest(v_n - 1, 0), 2);
  if e.organizer_url is not null then v_score := v_score + 10; end if;
  v_score := v_score - 20 * cardinality(private.confidence_flags(e));
  return least(greatest(v_score, 0), 100)::smallint;
end $$;

create function private.strict_auto_fails(e public.events) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  v_fails text[] := '{}'; v public.venues; v_cats text[]; v_tokens text[];
  v_generic text[] := array['live','music','event','events','show','shows','night','nights','party','special','fun','community',
                            'weekly','daily','open','the','a','an','at','and','of','with','on'];
begin
  if e.venue_id is not null then select * into v from public.venues x where x.id = e.venue_id; end if;
  v_cats := array(select c.category from public.event_categories c where c.event_id = e.id);
  if not e.time_known or e.all_day then v_fails := array_append(v_fails, 'time_unknown'); end if;
  if e.ends_at is not null and e.ends_at - e.starts_at > interval '12 hours' then v_fails := array_append(v_fails, 'long'); end if;
  if e.venue_id is null then v_fails := array_append(v_fails, 'no_venue'); end if;
  if e.venue_id is not null and v.lat is null then
    v_fails := array_append(v_fails, case when v.geocode_attempts < 3 then 'geocode_pending' else 'no_coords' end);
  end if;
  if e.venue_id is not null and v.lat is not null and not private.in_local_box(e.region_id, v.lat, v.lng) then
    v_fails := array_append(v_fails, 'outside_local');
  end if;
  if cardinality(private.confidence_flags(e)) > 0 then v_fails := array_append(v_fails, 'flags'); end if;
  if e.age not in ('all_ages', '18_plus', '21_plus')
     and (v_cats && array['nightlife', 'food-drink'] or private.adult_signal(e.normalized_title)
          or (e.venue_id is not null and private.adult_signal(v.normalized_name))) then
    v_fails := array_append(v_fails, 'age_ambiguous');
  end if;
  v_tokens := array(select t from unnest(string_to_array(e.normalized_title, ' ')) t where t <> '');
  if cardinality(v_tokens) < 2 or char_length(e.normalized_title) < 8
     or e.normalized_title ~ '\m(tbd|tba|tbc|untitled|placeholder|test|private|closed|cancelled|canceled|postponed|rescheduled|sold out|members only|member only|save the date|coming soon|see website|more info|details)\M'
     or not exists (select 1 from unnest(v_tokens) t where t <> all (v_generic)) then
    v_fails := array_append(v_fails, 'placeholder_title');
  end if;
  if e.organizer_url is null then v_fails := array_append(v_fails, 'no_link'); end if;
  return v_fails;
end $$;

-- 'open' | 'capped' | 'defer' (S1.2 card_policy). The card source is the source that won starts_at.
create function private.card_policy(e public.events) returns text
language plpgsql stable set search_path = '' as $$
declare v_src public.sources; v_all_strict boolean;
begin
  if exists (select 1 from public.review_cards c where c.event_id = e.id and c.kind = 'event' and c.status = 'open') then return 'open'; end if;
  select s.* into v_src from public.source_events se join public.sources s on s.id = se.source_id
   where se.cluster_id = e.id and se.source_status <> 'gone'
   order by s.priority desc, se.first_seen_at, se.id limit 1;   -- the one contributor order (A5-5); keep in sync with recompute_event
  select coalesce(bool_and(s.strict_auto), false) into v_all_strict
    from public.source_events se join public.sources s on s.id = se.source_id
   where se.cluster_id = e.id and se.source_status <> 'gone';
  if v_all_strict and private.strict_auto_fails(e) = array['geocode_pending'] then return 'defer'; end if;
  if v_src.max_cards_7d is not null and (select count(*) from public.review_cards c
        where c.kind = 'event' and c.source_id = v_src.id and c.created_at > now() - interval '7 days') >= v_src.max_cards_7d then
    return 'capped';
  end if;
  return 'open';
end $$;

create function private.template_summary(e public.events) returns text
language plpgsql stable set search_path = '' as $$
declare v public.venues; v_noun text; v_price text; v_place text := ''; v_age text; v_tail text; v_s text;
begin
  if e.venue_id is not null then select * into v from public.venues x where x.id = e.venue_id; end if;
  v_price := case e.price_kind when 'free' then 'Free' when 'paid' then 'Ticketed' when 'donation' then 'Donation-based' else '' end;
  select k.noun into v_noun from public.event_categories c join public.categories k on k.slug = c.category
   where c.event_id = e.id order by k.sort limit 1;
  v_noun := coalesce(v_noun, 'event');
  if e.venue_id is not null then v_place := ' at ' || v.name; end if;
  if e.venue_id is not null and v.town is not null then v_place := v_place || ' in ' || v.town; end if;
  v_age := case e.age when 'all_ages' then ' All ages.' when 'family' then ' Family-friendly.' when '18_plus' then ' 18+.'
                      when '21_plus' then ' 21+.' else '' end;
  v_tail := case when e.ticket_url is not null then ' Details and tickets on the organizer''s site.' else ' Details on the organizer''s site.' end;
  v_s := btrim(v_price || ' ' || v_noun) || v_place || '.' || v_age || v_tail;
  v_s := regexp_replace(v_s, ' +', ' ', 'g');
  return upper(left(v_s, 1)) || substr(v_s, 2);
end $$;

-- A change signature of everything list_events shows, so recompute can tell whether the public site changed.
create function private.event_public_sig(e public.events) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('pub', e.status = 'published' and e.merged_into is null,
    'title', e.title, 'summary', e.summary, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'all_day', e.all_day,
    'start_date', e.start_date, 'end_date', e.end_date, 'time_known', e.time_known, 'venue_id', e.venue_id, 'area', e.area,
    'price_kind', e.price_kind, 'price_min', e.price_min, 'price_max', e.price_max, 'age', e.age, 'featured', e.featured,
    'organizer_url', e.organizer_url, 'ticket_url', e.ticket_url,
    'categories', (select coalesce(jsonb_agg(c.category order by c.category), '[]') from public.event_categories c where c.event_id = e.id),
    'sources', (select coalesce(jsonb_agg(n order by n), '[]') from (select distinct s.name as n from public.source_events se
                  join public.sources s on s.id = se.source_id where se.cluster_id = e.id and se.source_status <> 'gone') x),
    'venue', (select jsonb_build_array(v.name, v.address, v.town, v.lat, v.lng) from public.venues v where v.id = e.venue_id))
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- recompute_event (S1.2): fold the contributing occurrences into the event, then decide its status
-- ---------------------------------------------------------------------------------------------------------------------
create function private.recompute_event(p_event_id uuid) returns boolean
language plpgsql set search_path = '' as $$
declare
  e public.events; c public.source_events[]; r public.source_events; i int; v_n int;
  v_title text; v_starts timestamptz; v_ends timestamptz; v_all_day boolean; v_sd date; v_ed date; v_tk boolean; v_venue uuid;
  v_url text; v_turl text; v_pk text; v_pmin numeric; v_pmax numeric; v_age text;
  w_title uuid; w_starts uuid; w_ends uuid; w_all_day uuid; w_sd uuid; w_ed uuid; w_tk uuid; w_venue uuid;
  w_url uuid; w_turl uuid; w_pk uuid; w_pmin uuid; w_pmax uuid; w_age uuid;
  v_ver jsonb; v_fs jsonb; v_cats text[]; v_area text; v_class text;
  v_sig_before jsonb; v_sig_after jsonb;
  v_conf smallint; v_summary text; v_status public.event_status; v_reason text; v_rule text; v_published timestamptz;
  v_all_cancelled boolean; v_card text; v_card_src uuid; v_close_decision text;
  v_locked text[];
begin
  select * into e from public.events x where x.id = p_event_id for update;
  if not found then return false; end if;
  v_sig_before := private.event_public_sig(e);
  v_locked := e.locked_fields;

  select array_agg(se order by s.priority desc, se.first_seen_at, se.id) into c
    from public.source_events se join public.sources s on s.id = se.source_id
   where se.cluster_id = e.id and se.source_status <> 'gone';
  v_n := coalesce(cardinality(c), 0);

  if v_n > 0 then
    -- first non-null among the contributors, ordered by source priority then first seen
    for i in 1 .. v_n loop
      r := c[i];
      if w_title is null and r.title is not null then v_title := r.title; w_title := r.id; end if;
      if w_starts is null then v_starts := r.starts_at; w_starts := r.id; end if;
      if w_ends is null and r.ends_at is not null then v_ends := r.ends_at; w_ends := r.id; end if;
      if w_all_day is null then v_all_day := r.all_day; w_all_day := r.id; end if;
      if w_sd is null and r.start_date is not null then v_sd := r.start_date; w_sd := r.id; end if;
      if w_ed is null and r.end_date is not null then v_ed := r.end_date; w_ed := r.id; end if;
      if w_tk is null then v_tk := r.time_known; w_tk := r.id; end if;
      if w_venue is null and r.venue_id is not null then v_venue := r.venue_id; w_venue := r.id; end if;
      if w_url is null and r.url is not null then v_url := r.url; w_url := r.id; end if;
      if w_turl is null and r.ticket_url is not null then v_turl := r.ticket_url; w_turl := r.id; end if;
      if w_pk is null and r.price_kind <> 'unknown' then v_pk := r.price_kind; w_pk := r.id; end if;
      if w_pmin is null and r.price_min is not null then v_pmin := r.price_min; w_pmin := r.id; end if;
      if w_pmax is null and r.price_max is not null then v_pmax := r.price_max; w_pmax := r.id; end if;
      if w_age is null and r.age <> 'unknown' then v_age := r.age; w_age := r.id; end if;
    end loop;
    v_pk := coalesce(v_pk, 'unknown'); v_age := coalesce(v_age, 'unknown');

    -- locked fields keep the event's value
    if 'title' = any (v_locked) then v_title := e.title; w_title := null; end if;
    if 'starts_at' = any (v_locked) then v_starts := e.starts_at; w_starts := null; end if;
    if 'ends_at' = any (v_locked) then v_ends := e.ends_at; w_ends := null; end if;
    if 'all_day' = any (v_locked) then v_all_day := e.all_day; w_all_day := null; end if;
    if 'start_date' = any (v_locked) then v_sd := e.start_date; w_sd := null; end if;
    if 'end_date' = any (v_locked) then v_ed := e.end_date; w_ed := null; end if;
    if 'time_known' = any (v_locked) then v_tk := e.time_known; w_tk := null; end if;
    if 'venue_id' = any (v_locked) then v_venue := e.venue_id; w_venue := null; end if;
    if 'organizer_url' = any (v_locked) then v_url := e.organizer_url; w_url := null; end if;
    if 'ticket_url' = any (v_locked) then v_turl := e.ticket_url; w_turl := null; end if;
    if 'price_kind' = any (v_locked) then v_pk := e.price_kind; w_pk := null; end if;
    if 'price_min' = any (v_locked) then v_pmin := e.price_min; w_pmin := null; end if;
    if 'price_max' = any (v_locked) then v_pmax := e.price_max; w_pmax := null; end if;
    if 'age' = any (v_locked) then v_age := e.age; w_age := null; end if;

    -- mixed-source fields must still satisfy the table's invariants
    if v_ends is not null and v_ends <= v_starts then v_ends := null; end if;
    if v_all_day and (v_sd is null or v_ed is null or v_ed <= v_sd) then v_all_day := false; end if;

    -- the latest accepted version of each winning occurrence, for field_sources
    select coalesce(jsonb_object_agg(q.se_id::text, q.v_id), '{}') into v_ver
      from (select vv.source_event_id as se_id, max(vv.id) as v_id from public.source_event_versions vv
             where vv.source_event_id = any (array[w_title, w_starts, w_ends, w_all_day, w_sd, w_ed, w_tk, w_venue, w_url, w_turl,
                                                   w_pk, w_pmin, w_pmax, w_age]) group by vv.source_event_id) q;
    v_fs := e.field_sources;
    if w_title is not null and v_ver ? w_title::text then v_fs := v_fs || jsonb_build_object('title', 'sev:' || (v_ver ->> w_title::text)); end if;
    if w_starts is not null and v_ver ? w_starts::text then v_fs := v_fs || jsonb_build_object('starts_at', 'sev:' || (v_ver ->> w_starts::text)); end if;
    if w_ends is not null and v_ver ? w_ends::text then v_fs := v_fs || jsonb_build_object('ends_at', 'sev:' || (v_ver ->> w_ends::text)); end if;
    if w_all_day is not null and v_ver ? w_all_day::text then v_fs := v_fs || jsonb_build_object('all_day', 'sev:' || (v_ver ->> w_all_day::text)); end if;
    if w_sd is not null and v_ver ? w_sd::text then v_fs := v_fs || jsonb_build_object('start_date', 'sev:' || (v_ver ->> w_sd::text)); end if;
    if w_ed is not null and v_ver ? w_ed::text then v_fs := v_fs || jsonb_build_object('end_date', 'sev:' || (v_ver ->> w_ed::text)); end if;
    if w_tk is not null and v_ver ? w_tk::text then v_fs := v_fs || jsonb_build_object('time_known', 'sev:' || (v_ver ->> w_tk::text)); end if;
    if w_venue is not null and v_ver ? w_venue::text then v_fs := v_fs || jsonb_build_object('venue_id', 'sev:' || (v_ver ->> w_venue::text)); end if;
    if w_url is not null and v_ver ? w_url::text then v_fs := v_fs || jsonb_build_object('organizer_url', 'sev:' || (v_ver ->> w_url::text)); end if;
    if w_turl is not null and v_ver ? w_turl::text then v_fs := v_fs || jsonb_build_object('ticket_url', 'sev:' || (v_ver ->> w_turl::text)); end if;
    if w_pk is not null and v_ver ? w_pk::text then v_fs := v_fs || jsonb_build_object('price_kind', 'sev:' || (v_ver ->> w_pk::text)); end if;
    if w_pmin is not null and v_ver ? w_pmin::text then v_fs := v_fs || jsonb_build_object('price_min', 'sev:' || (v_ver ->> w_pmin::text)); end if;
    if w_pmax is not null and v_ver ? w_pmax::text then v_fs := v_fs || jsonb_build_object('price_max', 'sev:' || (v_ver ->> w_pmax::text)); end if;
    if w_age is not null and v_ver ? w_age::text then v_fs := v_fs || jsonb_build_object('age', 'sev:' || (v_ver ->> w_age::text)); end if;

    -- journal each changed (unlocked) field with the version that decided it
    if v_title is distinct from e.title and w_title is not null and v_ver ? w_title::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'title', to_jsonb(e.title), to_jsonb(v_title), v_fs ->> 'title'); end if;
    if v_starts is distinct from e.starts_at and w_starts is not null and v_ver ? w_starts::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'starts_at', to_jsonb(e.starts_at), to_jsonb(v_starts), v_fs ->> 'starts_at'); end if;
    if v_ends is distinct from e.ends_at and w_ends is not null and v_ver ? w_ends::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'ends_at', to_jsonb(e.ends_at), to_jsonb(v_ends), v_fs ->> 'ends_at'); end if;
    if v_all_day is distinct from e.all_day and w_all_day is not null and v_ver ? w_all_day::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'all_day', to_jsonb(e.all_day), to_jsonb(v_all_day), v_fs ->> 'all_day'); end if;
    if v_sd is distinct from e.start_date and w_sd is not null and v_ver ? w_sd::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'start_date', to_jsonb(e.start_date), to_jsonb(v_sd), v_fs ->> 'start_date'); end if;
    if v_ed is distinct from e.end_date and w_ed is not null and v_ver ? w_ed::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'end_date', to_jsonb(e.end_date), to_jsonb(v_ed), v_fs ->> 'end_date'); end if;
    if v_tk is distinct from e.time_known and w_tk is not null and v_ver ? w_tk::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'time_known', to_jsonb(e.time_known), to_jsonb(v_tk), v_fs ->> 'time_known'); end if;
    if v_venue is distinct from e.venue_id and w_venue is not null and v_ver ? w_venue::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'venue_id', to_jsonb(e.venue_id), to_jsonb(v_venue), v_fs ->> 'venue_id'); end if;
    if v_url is distinct from e.organizer_url and w_url is not null and v_ver ? w_url::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'organizer_url', to_jsonb(e.organizer_url), to_jsonb(v_url), v_fs ->> 'organizer_url'); end if;
    if v_turl is distinct from e.ticket_url and w_turl is not null and v_ver ? w_turl::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'ticket_url', to_jsonb(e.ticket_url), to_jsonb(v_turl), v_fs ->> 'ticket_url'); end if;
    if v_pk is distinct from e.price_kind and w_pk is not null and v_ver ? w_pk::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'price_kind', to_jsonb(e.price_kind), to_jsonb(v_pk), v_fs ->> 'price_kind'); end if;
    if v_pmin is distinct from e.price_min and w_pmin is not null and v_ver ? w_pmin::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'price_min', to_jsonb(e.price_min), to_jsonb(v_pmin), v_fs ->> 'price_min'); end if;
    if v_pmax is distinct from e.price_max and w_pmax is not null and v_ver ? w_pmax::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'price_max', to_jsonb(e.price_max), to_jsonb(v_pmax), v_fs ->> 'price_max'); end if;
    if v_age is distinct from e.age and w_age is not null and v_ver ? w_age::text then
      insert into public.event_changes (event_id, field, old_value, new_value, decided_by) values (e.id, 'age', to_jsonb(e.age), to_jsonb(v_age), v_fs ->> 'age'); end if;

    -- categories: the union of the contributors' (unless an admin locked them)
    if not ('categories' = any (v_locked)) then
      v_cats := array(select distinct cat from (select unnest(x.categories) as cat from unnest(c) x) u order by cat);
      delete from public.event_categories ec where ec.event_id = e.id and ec.category <> all (v_cats);
      insert into public.event_categories (event_id, category) select e.id, cat from unnest(v_cats) cat on conflict do nothing;
    end if;

    v_area := (select v.area from public.venues v where v.id = v_venue);
    v_class := case when e.origin = 'admin' then 'admin'
                    else (select s.class::text from public.source_events se join public.sources s on s.id = se.source_id where se.id = w_starts) end;
    if 'starts_at' = any (v_locked) then v_class := coalesce(e.source_class, v_class); end if;

    update public.events set title = v_title, starts_at = v_starts, ends_at = v_ends, all_day = v_all_day, start_date = v_sd,
        end_date = v_ed, time_known = v_tk, venue_id = v_venue, area = v_area, organizer_url = v_url, ticket_url = v_turl,
        price_kind = v_pk, price_min = v_pmin, price_max = v_pmax, age = v_age, field_sources = v_fs, source_class = v_class
      where id = e.id;
    select * into e from public.events x where x.id = p_event_id;
  end if;

  v_conf := private.confidence(e);
  v_summary := case when 'summary' = any (v_locked) then e.summary else private.template_summary(e) end;

  -- status
  v_status := e.status; v_reason := e.reject_reason; v_rule := 'rule:lifecycle'; v_published := e.published_at; v_card := null; v_close_decision := null;
  select coalesce(bool_and(x.source_status = 'cancelled_by_source'), false) into v_all_cancelled
    from unnest(coalesce(c, '{}'::public.source_events[])) x;
  if e.status in ('hidden', 'rejected') and e.status_by_admin then
    null;                                                       -- an admin's hide/reject stands
  elsif v_n = 0 then
    if e.origin = 'ingest' and e.starts_at > now() and exists (select 1 from public.source_events se where se.cluster_id = e.id) then
      v_status := 'unlisted'; v_reason := null;
    end if;
  elsif v_all_cancelled then
    v_status := 'cancelled'; v_reason := null;
  elsif e.status = 'published' and e.status_by_admin then
    null;                                                       -- an admin's approval stands
  elsif exists (select 1 from public.venues v where v.id = e.venue_id and v.outside_region) then
    v_status := 'rejected'; v_reason := 'out_of_region'; v_rule := 'rule:region'; v_close_decision := 'out_of_region';
  elsif v_conf >= 70 and e.time_known
        and exists (select 1 from public.venues v where v.id = e.venue_id and v.lat is not null and private.in_drive_box(e.region_id, v.lat, v.lng))
        and exists (select 1 from unnest(c) x join public.sources s on s.id = x.source_id where s.trust = 'auto' and s.class <> 'aggregator') then
    v_status := 'published'; v_reason := null; v_rule := 'rule:publish'; v_close_decision := 'auto_published';
  elsif exists (select 1 from unnest(c) x join public.sources s on s.id = x.source_id where s.trust = 'review' and s.strict_auto)
        and private.strict_auto_fails(e) = '{}'::text[] then
    v_status := 'published'; v_reason := null; v_rule := 'rule:strict_auto'; v_close_decision := 'auto_published';
  else
    v_status := 'pending'; v_reason := null;
    v_card := private.card_policy(e);
    v_card_src := case when v_n > 0 then c[1].source_id end;
  end if;
  if v_status = 'published' and e.status <> 'published' then v_published := coalesce(e.published_at, now()); end if;

  update public.events set summary = v_summary, confidence = v_conf, status = v_status, reject_reason = v_reason,
      published_at = v_published, lights_season = private.lights_pairs(e)
    where id = e.id;
  if v_status <> e.status then
    insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
      values (e.id, 'status', to_jsonb(e.status::text), to_jsonb(v_status::text), v_rule);
  end if;
  if v_close_decision is not null then
    update public.review_cards set status = 'closed', decision = v_close_decision, decided_at = now()
     where event_id = e.id and kind = 'event' and status = 'open';
  end if;
  if v_card = 'open' then
    insert into public.review_cards (kind, event_id, source_id) values ('event', e.id, v_card_src)
      on conflict (kind, event_id) where (status = 'open' and kind = 'event') do nothing;
  end if;

  select * into e from public.events x where x.id = p_event_id;
  v_sig_after := private.event_public_sig(e);
  return (v_sig_before ->> 'pub' = 'true' or v_sig_after ->> 'pub' = 'true') and v_sig_before is distinct from v_sig_after;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Cluster and publish (the outbox drain)
-- ---------------------------------------------------------------------------------------------------------------------
create function private.cluster_and_publish(p_limit int) returns jsonb
language plpgsql set search_path = '' as $$
declare
  se public.source_events; src public.sources; best record; v_new uuid; v_area text; v_lat double precision; v_lng double precision;
  v_changed boolean := false; v_processed int := 0; v_remaining int; v_region uuid := private.region_id();
begin
  perform pg_advisory_xact_lock(7311046001);   -- cluster drain lock (A5-2); held to commit, re-entrant inside one transaction
  for se in select * from public.source_events x where x.needs_cluster order by x.id limit least(greatest(coalesce(p_limit, 500), 1), 500)
              for update skip locked
  loop
    v_processed := v_processed + 1;
    select * into src from public.sources s where s.id = se.source_id;
    if src.trust = 'link_only' then
      update public.source_events set needs_cluster = false where id = se.id;
      continue;
    end if;
    if se.cluster_id is null then
      select v.area, v.lat, v.lng into v_area, v_lat, v_lng from public.venues v where v.id = se.venue_id;
      select e.id, e.normalized_title, extensions.similarity(e.normalized_title, se.normalized_title) as sim into best
        from public.events e left join public.venues ev on ev.id = e.venue_id
       where e.merged_into is null and e.start_day = se.start_day and e.area is not distinct from v_area
         and (e.venue_id = se.venue_id or private.dist_m(ev.lat, ev.lng, v_lat, v_lng) <= 150)
         and ((e.all_day and se.all_day) or abs(extract(epoch from e.starts_at - se.starts_at)) <= 1800)
       order by sim desc, e.created_at, e.id limit 1;
      if found and (best.sim >= 0.6 or private.token_contained(best.normalized_title, se.normalized_title)) then
        update public.source_events set cluster_id = best.id where id = se.id;
        se.cluster_id := best.id;
      else
        insert into public.events (region_id, title, summary, starts_at, ends_at, all_day, start_date, end_date, time_known, venue_id,
            area, price_kind, price_min, price_max, age, organizer_url, ticket_url, series_id, status, origin)
          values (v_region, se.title, 'Details on the organizer''s site.', se.starts_at, se.ends_at, se.all_day, se.start_date,
                  se.end_date, se.time_known, se.venue_id, v_area, se.price_kind, se.price_min, se.price_max, se.age, se.url,
                  se.ticket_url, se.series_id, 'pending', 'ingest')
          returning id into v_new;
        update public.source_events set cluster_id = v_new where id = se.id;
        se.cluster_id := v_new;
        if best.id is not null and best.sim between 0.45 and 0.6 then
          insert into public.review_cards (kind, event_id, other_event_id, source_id) values ('possible_duplicate', v_new, best.id, se.source_id);
        end if;
      end if;
    end if;
    v_changed := private.recompute_event(se.cluster_id) or v_changed;
    update public.source_events set needs_cluster = false where id = se.id;
  end loop;
  select count(*) into v_remaining from public.source_events x where x.needs_cluster;
  return jsonb_build_object('processed', v_processed, 'remaining', v_remaining, 'public_changed', v_changed);
end $$;

create function public.svc_cluster_and_publish(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('lock_timeout', '15s', true);
  return private.cluster_and_publish(p_limit);
exception when lock_not_available then
  return jsonb_build_object('processed', 0, 'public_changed', false, 'busy', true,
    'remaining', (select count(*) from public.source_events x where x.needs_cluster));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Admin merge (needed by the survivor rule)
-- ---------------------------------------------------------------------------------------------------------------------
create function public.admin_merge_events(p_a uuid, p_b uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.events; b public.events; v_surv public.events; v_loser public.events; v_uid uuid := auth.uid(); v_by text;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_a is null or p_b is null or p_a = p_b then raise exception 'invalid_input' using errcode = '22023', detail = 'events'; end if;
  perform 1 from public.events x where x.id in (p_a, p_b) order by x.id for update;
  select * into a from public.events x where x.id = p_a;
  select * into b from public.events x where x.id = p_b;
  if a.id is null or b.id is null then raise exception 'not_found' using errcode = 'P0002', detail = 'event'; end if;
  if a.merged_into is not null or b.merged_into is not null then raise exception 'invalid_input' using errcode = '22023', detail = 'already_merged'; end if;
  if private.event_is_exported(a.id) and not private.event_is_exported(b.id) then v_surv := a; v_loser := b;
  elsif private.event_is_exported(b.id) and not private.event_is_exported(a.id) then v_surv := b; v_loser := a;
  elsif (a.created_at, a.id) <= (b.created_at, b.id) then v_surv := a; v_loser := b;
  else v_surv := b; v_loser := a; end if;
  v_by := 'admin:' || v_uid::text;
  update public.events set merged_into = v_surv.id, status = 'hidden', status_by_admin = true where id = v_loser.id;
  insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
    values (v_loser.id, 'status', to_jsonb(v_loser.status::text), to_jsonb('hidden'::text), v_by),
           (v_loser.id, 'merged_into', null, to_jsonb(v_surv.id), v_by);
  update public.source_events set cluster_id = v_surv.id, needs_cluster = true where cluster_id = v_loser.id;
  update public.review_cards set status = 'closed', decision = 'merged', decided_at = now()
   where status = 'open' and kind in ('event', 'possible_duplicate') and (event_id = v_loser.id or other_event_id = v_loser.id);
  perform private.recompute_event(v_surv.id);
  return v_surv.id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Public read (S1.3, D3): the only read path for events
-- ---------------------------------------------------------------------------------------------------------------------
create function public.list_events(p_days integer default 120)
returns table (id uuid, slug text, title text, summary text, starts_at timestamptz, ends_at timestamptz, all_day boolean,
               start_date date, end_date date, time_known boolean, venue text, address text, town text, area text,
               lat double precision, lng double precision, categories text[], price_kind text, price_min numeric,
               price_max numeric, age text, featured boolean, url text, ticket_url text, sources text[])
language sql stable security definer set search_path = '' as $$
  select e.id, e.slug, e.title, e.summary, e.starts_at, e.ends_at, e.all_day, e.start_date, e.end_date, e.time_known,
         v.name, v.address, v.town, e.area, v.lat, v.lng,
         coalesce((select array_agg(c.category order by k.sort, c.category) from public.event_categories c
                    join public.categories k on k.slug = c.category where c.event_id = e.id), '{}'),
         e.price_kind, e.price_min, e.price_max, e.age, e.featured, e.organizer_url, e.ticket_url,
         coalesce((select array_agg(n order by n) from (select distinct s.name as n from public.source_events se
                    join public.sources s on s.id = se.source_id where se.cluster_id = e.id and se.source_status <> 'gone') x), '{}')
    from public.events e left join public.venues v on v.id = e.venue_id
   where e.status = 'published' and e.merged_into is null
     and coalesce(e.ends_at, e.starts_at + interval '3 hours') > now() - interval '1 hour'
     and e.starts_at < now() + make_interval(days => least(greatest(coalesce(p_days, 120), 1), 120))
   order by e.starts_at, e.id
   limit 2000
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants: deny everything, then the exact cumulative allowlist
-- ---------------------------------------------------------------------------------------------------------------------
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
grant execute on function public.svc_ingest_nonce(text) to service_role;
grant execute on function public.svc_issue_run_grants() to service_role;
grant execute on function public.svc_ingest_batch(text, jsonb, jsonb) to service_role;
grant execute on function public.svc_set_venue_geocode(uuid, double precision, double precision, text) to service_role;
grant execute on function public.svc_cluster_and_publish(integer) to service_role;
