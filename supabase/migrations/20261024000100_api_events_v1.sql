-- W1 (Spec_Vibes_Widget W1.1): the public events API v1 read model.
-- Adds events.lights_override_at, the three Lights mirror tables (SD3: the read predicate needs them; W3 adds the write path),
-- lights_pairs computed from the row as written (trigger events_zz_lights_pairs), shown_on_lights, and public.api_events_v1,
-- one jsonb envelope (SD2) for scope vibes (the TruckeeVibes list) and scope lights (one Truckee Lights season).

-- 1 Column: written only by admin_set_lights_override (W3). No grant.
alter table public.events add column lights_override_at timestamptz;

-- 2 Tables: RLS enabled and forced, no policies, no grants.
create table private.lights_mirror (
  lights_id uuid primary key, region_slug text not null, season text not null check (season in ('halloween','christmas')),
  year integer not null check (year between 2025 and 2100),
  title text not null, description text not null, venue text, address text not null,
  lat double precision not null, lng double precision not null, starts_at timestamptz not null, ends_at timestamptz,
  url text, adults_only boolean not null,
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  removed_at timestamptz, removed_run uuid);
create index lights_mirror_pair_idx on private.lights_mirror (region_slug, season, year, starts_at);
create table private.lights_mirror_runs (
  id uuid primary key default gen_random_uuid(), region_slug text not null, season text not null, year integer not null,
  status text not null check (status in ('ok','held','aborted')), abort_code text check (abort_code ~ '^[a-z_]{1,40}$'),
  seen int not null default 0, added int not null default 0, changed int not null default 0, removed int not null default 0,
  held int not null default 0, invalid int not null default 0, finished_at timestamptz not null default now());
create index lights_mirror_runs_pair_idx on private.lights_mirror_runs (region_slug, season, year, finished_at desc);
create table private.lights_mirror_holds (
  region_slug text not null, season text not null, year integer not null,
  removal_set uuid[] not null, first_obs_at timestamptz not null, last_obs_at timestamptz not null,
  observations int not null check (observations >= 1), opened_at timestamptz not null default now(),
  primary key (region_slug, season, year));   -- at most one open hold per pair; a closed hold is deleted
create index events_starts_idx on public.events (starts_at) where merged_into is null and status = 'published';

alter table private.lights_mirror enable row level security;       alter table private.lights_mirror force row level security;
alter table private.lights_mirror_runs enable row level security;  alter table private.lights_mirror_runs force row level security;
alter table private.lights_mirror_holds enable row level security; alter table private.lights_mirror_holds force row level security;

-- 3 Helpers (no grants)
-- The season window as Pacific midnights: Halloween [Sep 15, Nov 2), Christmas [Nov 15, Jan 7 of the next year).
create function private.lights_window(p_season text, p_year int) returns tstzrange
language sql stable set search_path = '' as $$
  select case p_season
    when 'halloween' then tstzrange(make_date(p_year, 9, 15)::timestamp at time zone 'America/Los_Angeles',
                                    make_date(p_year, 11, 2)::timestamp at time zone 'America/Los_Angeles', '[)')
    when 'christmas' then tstzrange(make_date(p_year, 11, 15)::timestamp at time zone 'America/Los_Angeles',
                                    make_date(p_year + 1, 1, 7)::timestamp at time zone 'America/Los_Angeles', '[)')
  end
$$;

-- SD6: the seasonal keyword list (whole words over private.normalize_title output). Edits = a migration.
create function private.lights_keyword_hit(p_season text, p_norm_title text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case p_season
    when 'halloween' then p_norm_title ~ '\m(halloween|haunted|haunt|trick or treat|trunk or treat|pumpkin|costume|spooky|monster mash|dia de los muertos|harvest festival)\M'
    when 'christmas' then p_norm_title ~ '\m(christmas|holiday lights|tree lighting|santa|menorah|hanukkah|chanukah|carol|caroling|nutcracker|winter wonderland|light parade|new year)\M'
  end, false)
$$;

-- The M1 stub, now real (same signature). Inside the trigger below `e` is the NEW row, so a status change is seen as written.
create or replace function private.lights_pairs(e public.events) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_day date; v_y int; v_out jsonb := '[]'::jsonb; s text; v_lat double precision; v_lng double precision;
begin
  if e.lights_include is null or e.lights_include = 'no' or e.starts_at is null then return '[]'::jsonb; end if;
  v_day := (e.starts_at at time zone 'America/Los_Angeles')::date;
  v_y := extract(year from v_day)::int - case when extract(month from v_day) = 1 and extract(day from v_day) <= 6 then 1 else 0 end;
  if e.lights_include = 'auto' then
    if e.status is distinct from 'published'::public.event_status or e.time_known is not true then return '[]'::jsonb; end if;
    if e.area is not distinct from 'reno_carson' and e.featured is not true then return '[]'::jsonb; end if;
    select v.lat, v.lng into v_lat, v_lng from public.venues v where v.id = e.venue_id;
    if v_lat is null or v_lng is null or not private.in_drive_box(e.region_id, v_lat, v_lng) then return '[]'::jsonb; end if;
  end if;
  foreach s in array array['halloween', 'christmas'] loop
    if e.starts_at <@ private.lights_window(s, v_y)
       and (e.lights_include = 'yes'
            or exists (select 1 from public.event_categories c
                        where c.event_id = e.id and c.category = case s when 'halloween' then 'halloween-fall' else 'holiday' end)
            or private.lights_keyword_hit(s, e.normalized_title)) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('season', s, 'year', v_y));
    end if;
  end loop;
  return v_out;
end $$;

-- r2: lights_season from the row as written, for every writer (recompute_event passes its pre-update record). The name sorts
-- after events_before_write, so start_day and normalized_title are already set.
create function private.events_lights_pairs() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.lights_season := private.lights_pairs(new);
  return new;
end $$;
create trigger events_zz_lights_pairs before insert or update on public.events
  for each row execute function private.events_lights_pairs();

-- Nightly: dates move into windows and venue geocodes change without an event write.
create function private.refresh_lights_pairs() returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  update public.events e set lights_season = private.lights_pairs(e)
   where e.merged_into is null and e.starts_at > now() - interval '1 day' and e.starts_at < now() + interval '120 days'
     and e.lights_season is distinct from private.lights_pairs(e);
  get diagnostics n = row_count;
  return n;
end $$;

-- A mirror row covers a Vibes event: the cluster rule of 20261020000200_ingest_rpcs.sql (same Pacific day, <= 150 m, <= 30 min,
-- title similarity >= 0.6 or token containment), read-only.
create function private.lights_covers(m private.lights_mirror, v public.events, vlat double precision, vlng double precision) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
       (m.starts_at at time zone 'America/Los_Angeles')::date = (v.starts_at at time zone 'America/Los_Angeles')::date
       and private.dist_m(m.lat, m.lng, vlat, vlng) <= 150
       and abs(extract(epoch from m.starts_at - v.starts_at)) <= 1800
       and (extensions.similarity(private.normalize_title(m.title), v.normalized_title) >= 0.6
            or private.token_contained(private.normalize_title(m.title), v.normalized_title)), false)
$$;

-- Plan §3.4 shownOnLights: a Vibes event is added to a Lights season unless Lights already has it (live dedupe) or Lights removed
-- it after the last owner override (veto).
create function private.shown_on_lights(v public.events, p_region text, p_season text, p_year int,
                                        vlat double precision, vlng double precision) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
       v.status = 'published' and v.merged_into is null and v.lights_include <> 'no'
       and v.lights_season @> jsonb_build_array(jsonb_build_object('season', p_season, 'year', p_year))
       and vlat is not null and vlng is not null
       and not exists (select 1 from private.lights_mirror m
                        where m.region_slug = p_region and m.season = p_season and m.year = p_year and m.removed_at is null
                          and m.starts_at between v.starts_at - interval '30 minutes' and v.starts_at + interval '30 minutes'
                          and private.lights_covers(m, v, vlat, vlng))
       and not exists (select 1 from private.lights_mirror m
                        where m.region_slug = p_region and m.season = p_season and m.year = p_year and m.removed_at is not null
                          and m.removed_at > coalesce(v.lights_override_at, '-infinity'::timestamptz)
                          and m.starts_at between v.starts_at - interval '30 minutes' and v.starts_at + interval '30 minutes'
                          and private.lights_covers(m, v, vlat, vlng)), false)
$$;

-- The bounds a mirrored Lights event must fall in (Lights eventBoundsAdmin for Truckee); any other slug -> no row.
create function private.lights_mirror_box(p_region text)
returns table (min_lat double precision, max_lat double precision, min_lng double precision, max_lng double precision)
language sql immutable set search_path = '' as $$
  select 39.09::double precision, 39.60::double precision, -120.47::double precision, -119.60::double precision where p_region = 'truckee'
$$;

-- ISO 8601 UTC with a Z (seconds), null-safe.
create function private.api_ts(p timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

-- 4 The read model. Every bound is enforced here (D11), NULL-safe; a failure raises invalid_input (22023) with detail = the param.
create function public.api_events_v1(p_scope text default null, p_season text default null, p_year integer default null,
                                     p_from date default null, p_to date default null, p_areas text[] default null,
                                     p_categories text[] default null, p_limit integer default null, p_cursor text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz constant text := 'America/Los_Angeles';
  v_scope text := coalesce(p_scope, 'vibes');
  v_limit int; v_lo timestamptz; v_hi timestamptz;
  v_raw text; v_b64 text; v_cur_ts timestamptz; v_cur_id uuid;
  v_area_f boolean; v_cat_f boolean;
  v_n int; v_next text; v_rows jsonb; v_mirror jsonb; v_region jsonb;
  v_confirmed timestamptz; v_held_n int; v_held_since timestamptz; v_has_hold boolean := false;
begin
  -- bounds
  if not coalesce(v_scope in ('vibes', 'lights'), false) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'scope';
  end if;
  if v_scope = 'lights' then
    if not coalesce(p_season in ('halloween', 'christmas'), false) then raise exception 'invalid_input' using errcode = '22023', detail = 'season'; end if;
    if not coalesce(p_year between 2025 and 2100, false) then raise exception 'invalid_input' using errcode = '22023', detail = 'year'; end if;
    if p_areas is not null then raise exception 'invalid_input' using errcode = '22023', detail = 'area'; end if;
    if p_categories is not null then raise exception 'invalid_input' using errcode = '22023', detail = 'category'; end if;
  else
    if p_season is not null then raise exception 'invalid_input' using errcode = '22023', detail = 'season'; end if;
    if p_year is not null then raise exception 'invalid_input' using errcode = '22023', detail = 'year'; end if;
  end if;
  if p_areas is not null then
    if not coalesce(cardinality(p_areas) <= 10, false)
       or exists (select 1 from unnest(p_areas) x
                   where x is null or char_length(x) > 64 or not exists (select 1 from public.areas a where a.slug = x)) then
      raise exception 'invalid_input' using errcode = '22023', detail = 'area';
    end if;
  end if;
  if p_categories is not null then
    if not coalesce(cardinality(p_categories) <= 10, false)
       or exists (select 1 from unnest(p_categories) x
                   where x is null or char_length(x) > 64 or not exists (select 1 from public.categories k where k.slug = x)) then
      raise exception 'invalid_input' using errcode = '22023', detail = 'category';
    end if;
  end if;
  if p_limit is null then
    v_limit := case when v_scope = 'lights' then 500 else 200 end;
  elsif not coalesce(p_limit between 1 and 500, false) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'limit';
  else
    v_limit := p_limit;
  end if;
  if p_cursor is not null then
    begin
      if not coalesce(char_length(p_cursor) <= 200 and p_cursor ~ '^[A-Za-z0-9_-]+$', false) then raise exception 'bad_cursor'; end if;
      v_b64 := translate(p_cursor, '-_', '+/');
      v_b64 := v_b64 || repeat('=', (4 - char_length(v_b64) % 4) % 4);
      v_raw := convert_from(decode(v_b64, 'base64'), 'UTF8');
      if not coalesce(v_raw ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\|[0-9a-f-]{36}$', false) then raise exception 'bad_cursor'; end if;
      v_cur_ts := split_part(v_raw, '|', 1)::timestamptz;
      v_cur_id := split_part(v_raw, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', detail = 'cursor';
    end;
  end if;
  if p_from is not null and p_to is not null and p_to < p_from then
    raise exception 'invalid_input' using errcode = '22023', detail = 'to';
  end if;

  -- window (plan §3.1): lo never before now; hi exclusive at the Pacific midnight after `to`; hi - lo <= 120 days
  v_lo := greatest(now(), coalesce(p_from::timestamp at time zone v_tz, now()));
  v_hi := coalesce((p_to + 1)::timestamp at time zone v_tz, now() + interval '120 days');
  v_hi := least(v_hi, v_lo + interval '120 days');
  v_area_f := coalesce(cardinality(p_areas), 0) > 0;
  v_cat_f := coalesce(cardinality(p_categories), 0) > 0;

  -- one page (limit + 1 to know whether another follows), then JSON for the returned rows only
  with recursive
  base as (
    select e.starts_at, e.id, 'v'::text as k
      from public.events e left join public.venues v on v.id = e.venue_id
     where e.status = 'published' and e.merged_into is null
       and (case when e.all_day then (e.end_date::timestamp at time zone v_tz)
                 else coalesce(e.ends_at, e.starts_at + interval '3 hours') end) + interval '1 hour' > v_lo
       and e.starts_at < v_hi
       and ((v_scope = 'vibes'
             and (not v_area_f or e.area = any (p_areas))
             and (not v_cat_f or exists (select 1 from public.event_categories c where c.event_id = e.id and c.category = any (p_categories))))
         or (v_scope = 'lights' and private.shown_on_lights(e, 'truckee', p_season, p_year, v.lat, v.lng)))
    union all
    select m.starts_at, m.lights_id, 'l'::text
      from private.lights_mirror m
     where v_scope = 'lights' and m.region_slug = 'truckee' and m.season = p_season and m.year = p_year and m.removed_at is null
       and coalesce(m.ends_at, m.starts_at + interval '3 hours') + interval '1 hour' > v_lo
       and m.starts_at < v_hi),
  page as (
    select b.starts_at, b.id, b.k, row_number() over (order by b.starts_at, b.id) as rn
      from (select * from base x
             where v_cur_ts is null or (x.starts_at, x.id) > (v_cur_ts, v_cur_id)
             order by x.starts_at, x.id limit v_limit + 1) b),
  merged as (select x.id, x.merged_into from public.events x where x.merged_into is not null),
  former as (
    select m.merged_into as root, m.id, 1 as depth from merged m join page p on p.id = m.merged_into and p.k = 'v'
    union all
    select f.root, m.id, f.depth + 1 from former f join merged m on m.merged_into = f.id where f.depth < 5)
  select
    (select count(*)::int from page),
    (select rtrim(translate(encode(convert_to(to_char(p.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.id::text,
                                              'UTF8'), 'base64'), E'+/\n', '-_'), '=')
       from page p where p.rn = v_limit and exists (select 1 from page q where q.rn = v_limit + 1)),
    coalesce((select jsonb_agg(case when p.k = 'l' then
        (select jsonb_build_object(
            'id', m.lights_id, 'origin', 'lights', 'formerIds', '[]'::jsonb, 'pageUrl', null, 'title', m.title,
            'description', m.description, 'summary', null, 'startsAt', private.api_ts(m.starts_at), 'endsAt', private.api_ts(m.ends_at),
            'allDay', false, 'startDate', null, 'endDate', null, 'timeKnown', true, 'venue', m.venue, 'address', m.address,
            'town', null, 'lat', m.lat, 'lng', m.lng, 'categories', '[]'::jsonb, 'age', 'unknown', 'adultsOnly', m.adults_only,
            'url', m.url, 'ticketUrl', null)
           from private.lights_mirror m where m.lights_id = p.id)
      else
        (select jsonb_build_object(
            'id', e.id, 'origin', 'vibes',
            'formerIds', coalesce((select jsonb_agg(s.x order by s.x)
                                     from (select distinct f.id::text as x from former f where f.root = e.id order by 1 limit 10) s), '[]'::jsonb),
            'pageUrl', case when e.published_at is not null then 'https://truckeevibes.com/e/' || e.slug || '/' end,
            'title', e.title, 'description', null, 'summary', e.summary,
            'startsAt', private.api_ts(e.starts_at),
            'endsAt', private.api_ts(case when e.all_day then (e.end_date::timestamp at time zone v_tz) else e.ends_at end),
            'allDay', e.all_day, 'startDate', e.start_date, 'endDate', e.end_date, 'timeKnown', e.time_known,
            'venue', v.name,
            'address', case when v_scope = 'lights' then coalesce(nullif(v.address, ''), v.name || coalesce(', ' || v.town, '')) else v.address end,
            'town', v.town, 'lat', v.lat, 'lng', v.lng,
            'categories', coalesce((select jsonb_agg(c.category order by k.sort, c.category) from public.event_categories c
                                      join public.categories k on k.slug = c.category where c.event_id = e.id), '[]'::jsonb),
            'age', e.age, 'adultsOnly', e.age = '21_plus', 'url', e.organizer_url, 'ticketUrl', e.ticket_url)
           from public.events e left join public.venues v on v.id = e.venue_id where e.id = p.id)
      end order by p.rn) from page p where p.rn <= v_limit), '[]'::jsonb)
  into v_n, v_next, v_rows;

  -- envelope
  if v_scope = 'lights' then
    select max(r.finished_at) into v_confirmed from private.lights_mirror_runs r
     where r.region_slug = 'truckee' and r.season = p_season and r.year = p_year and r.status = 'ok';
    select cardinality(h.removal_set), h.first_obs_at into v_held_n, v_held_since from private.lights_mirror_holds h
     where h.region_slug = 'truckee' and h.season = p_season and h.year = p_year;
    v_has_hold := found;
  end if;
  v_mirror := jsonb_build_object(
    'state', case when v_has_hold then 'held' when v_confirmed is not null then 'confirmed' else 'none' end,
    'confirmedAt', private.api_ts(v_confirmed), 'heldSince', private.api_ts(v_held_since), 'heldCount', coalesce(v_held_n, 0));
  select jsonb_build_object('tz', r.tz, 'localBox', jsonb_build_object('minLat', r.local_min_lat, 'maxLat', r.local_max_lat,
                                                                       'minLng', r.local_min_lng, 'maxLng', r.local_max_lng))
    into v_region from public.regions r where r.slug = 'truckee';

  -- dataAt doubles as the cache generation (Amendment W1-1): fixed-width microseconds, so string order = time order
  return jsonb_build_object('dataAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'mirror', v_mirror, 'region', v_region,
                            'count', least(v_n, v_limit), 'nextCursor', v_next, 'events', v_rows);
end $$;

-- 5 Statement timeouts for the API roles (r2): explicit, not the platform default. PostgREST applies them per role.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

-- Nightly refresh of lights_pairs, and once now.
select cron.schedule('tv-lights-pairs', '50 10 * * *', $$select private.refresh_lights_pairs()$$);
select private.refresh_lights_pairs();

-- 6 Grants: deny everything, then the exact cumulative allowlist (the 24 existing + api_events_v1).
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
