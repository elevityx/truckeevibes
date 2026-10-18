-- W3 (Spec_Vibes_Widget W3.1): the Lights mirror write path. The three mirror tables and the read predicate shipped in W1 (SD3);
-- this adds the truckee-lights source (SD1) with its own 10-minute grant, svc_lights_mirror_apply (one transaction per snapshot,
-- with the deletion guard G1/G2/G3), the five admin Lights RPCs (SD5) and the purge. Lights events never enter ingest/cluster.

-- 1 The source family and the source row. The sources gate validates the insert (terms evidence, permitted disposition).
alter table public.sources drop constraint sources_family_check;
alter table public.sources add constraint sources_family_check check (family in ('tribe','ics','ics_chambermaster','ics_civicplus',
  'ics_eventsmanager','rss','squarespace','jsonld','html','llm','lights_mirror'));
-- terms_hash: the gate requires evidence; the sister site's terms are the owner's own, so the hash records the reviewed note.
insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust, enabled, cadence, ingest_disposition,
    allowed_methods, terms_url, terms_hash, terms_reviewed_by, terms_reviewed_at, terms_recheck_at, terms_note)
  values ('truckee-lights', 'Truckee Lights', 'https://truckeelights.com/', array['supabase.co'], 'lights_mirror', 'organizer', 'review',
          true, '6h', 'permitted', array['api'], 'https://truckeelights.com/about/',
          encode(extensions.digest('Sister site; public event list read through its public API.', 'sha256'), 'hex'),
          'owner', now(), now() + interval '1 year', 'Sister site; public event list read through its public API.');

-- 2 The 3-hourly ingest never picks up the mirror source: verbatim copy of 20261020000200_ingest_rpcs.sql:395-420 plus one predicate.
create or replace function public.svc_issue_run_grants() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid; v_out jsonb := '[]'::jsonb;
begin
  for s in
    select * from public.sources x
     where x.enabled and not x.opt_out and x.trust <> 'link_only'
       and x.ingest_disposition in ('permitted', 'official_api_only') and x.terms_recheck_at > now()
       and cardinality(x.allowed_methods) > 0 and x.next_due_at <= now()
       and x.family <> 'lights_mirror'   -- W3
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

-- 3 The mirror's own grant: at most one per 10 minutes, the PoliteSource field set for the runner's legal gate.
create function public.svc_issue_mirror_grant() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid;
begin
  select * into s from public.sources x where x.slug = 'truckee-lights' for update skip locked;
  if not found or not coalesce(private.source_ingest_permitted(s), false) or s.next_due_at > now() then
    return jsonb_build_object('grant', null);
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_run := gen_random_uuid();
  insert into private.ingest_grants (token_hash, source_id, run_id, expires_at)
    values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes');
  update public.sources set next_due_at = now() + interval '10 minutes' where id = s.id;
  return jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
    'slug', s.slug, 'allowed_hosts', to_jsonb(s.allowed_hosts), 'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap,
    'etag', s.etag, 'last_modified', s.last_modified, 'ingest_disposition', s.ingest_disposition, 'terms_recheck_at', s.terms_recheck_at));
end $$;

-- A mirrored URL: https, a DNS host with a dot (last label starts with a letter, so never an IP literal), no userinfo, no port.
-- No host allowlist: Lights events link anywhere.
create function private.lights_url_ok(p text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(char_length(p) <= 300
     and p ~* '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?([/?#][^\s<>"\\]*)?$', false)
$$;

-- The pair lock key (also taken by admin_accept_lights_removals).
create function private.lights_pair_lock(p_region text, p_season text, p_year int) returns void
language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('tv:lights_mirror:' || p_region || ':' || p_season || ':' || p_year::text))
$$;

-- 4 Apply one Lights snapshot of one (region, season, year) pair. One transaction; only rows of that pair are touched.
create function public.svc_lights_mirror_apply(p_grant text, p_run jsonb, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g private.ingest_grants; s public.sources;
  v_region text; v_season text; v_year int; v_status text; v_abort text; v_total int; v_n int;
  v_ids uuid[] := '{}'; v_live uuid[]; v_r uuid[]; v_thr numeric; v_large boolean;
  v_added int := 0; v_changed int := 0; v_invalid int := 0; v_removed int := 0; v_held int := 0; v_out text;
  h private.lights_mirror_holds; x jsonb; v_id uuid; v_ok boolean; m private.lights_mirror;
  v_title text; v_desc text; v_venue text; v_addr text; v_lat double precision; v_lng double precision;
  v_start timestamptz; v_end timestamptz; v_url text; v_adults boolean;
begin
  -- grant: exactly svc_ingest_batch steps 1-3
  select * into g from private.ingest_grants t where t.token_hash = extensions.digest(coalesce(p_grant, ''), 'sha256') for update;
  if not found then raise exception 'grant_invalid' using errcode = 'P0001'; end if;
  if g.used_at is not null then raise exception 'grant_used' using errcode = 'P0001'; end if;
  if g.expires_at <= now() then raise exception 'grant_expired' using errcode = 'P0001'; end if;
  -- for share, not for update: a concurrent revocation still waits for this transaction, while two applies meet first at the
  -- pair's advisory lock (AC-W3-17)
  select * into s from public.sources t where t.id = g.source_id for share;
  if s.slug is distinct from 'truckee-lights' or not coalesce(private.source_ingest_permitted(s), false) then
    raise exception 'source_not_permitted' using errcode = '23514';
  end if;
  update private.ingest_grants set used_at = now() where token_hash = g.token_hash;

  -- p_run = {region:'truckee', season, year, status:'ok'|'aborted', abort_code?, total}
  begin
    if jsonb_typeof(p_run) is distinct from 'object' then raise exception 'x'; end if;
    v_status := p_run ->> 'status';
    if v_status is null or v_status not in ('ok', 'aborted') or jsonb_typeof(p_run -> 'status') <> 'string' then raise exception 'x'; end if;
    v_region := p_run ->> 'region';
    if jsonb_typeof(p_run -> 'region') is distinct from 'string' or not exists (select 1 from private.lights_mirror_box(v_region)) then raise exception 'x'; end if;
    if v_status = 'aborted' then
      v_abort := p_run ->> 'abort_code';
      if jsonb_typeof(p_run -> 'abort_code') is distinct from 'string' or v_abort !~ '^[a-z_]{1,40}$' then raise exception 'x'; end if;
    end if;
    -- an aborted read may come before the pair is known (the context call failed): season and year then stay null
    if v_status = 'ok' or p_run ? 'season' or p_run ? 'year' then
      v_season := p_run ->> 'season';
      if jsonb_typeof(p_run -> 'season') is distinct from 'string' or v_season not in ('halloween', 'christmas') then raise exception 'x'; end if;
      if jsonb_typeof(p_run -> 'year') is distinct from 'number' then raise exception 'x'; end if;
      v_year := (p_run ->> 'year')::int;
      if v_year::text <> (p_run ->> 'year') or v_year not between 2025 and 2100 then raise exception 'x'; end if;
    end if;
    if v_status = 'ok' then
      if jsonb_typeof(p_run -> 'total') is distinct from 'number' then raise exception 'x'; end if;
      v_total := (p_run ->> 'total')::int;
      if v_total::text <> (p_run ->> 'total') or v_total < 0 then raise exception 'x'; end if;
    end if;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', detail = 'run';
  end;

  if v_season is null then
    return jsonb_build_object('status', 'aborted');              -- no pair to record a run under; the grant is spent
  end if;

  perform private.lights_pair_lock(v_region, v_season, v_year);

  if v_status = 'aborted' then                                   -- not an observation: the hold is untouched
    insert into private.lights_mirror_runs (id, region_slug, season, year, status, abort_code)
      values (g.run_id, v_region, v_season, v_year, 'aborted', v_abort);
    return jsonb_build_object('status', 'aborted');
  end if;

  -- rows: an array of exactly `total` objects (<= 1000) of this pair, with unique uuid ids
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'invalid_input' using errcode = '22023', detail = 'rows'; end if;
  v_n := jsonb_array_length(p_rows);
  if v_n <> v_total or v_n > 1000 then raise exception 'invalid_input' using errcode = '22023', detail = 'rows'; end if;
  begin
    for x in select e from jsonb_array_elements(p_rows) e loop
      if jsonb_typeof(x) <> 'object' or jsonb_typeof(x -> 'id') is distinct from 'string'
         or (x ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or (x ->> 'season') is distinct from v_season or jsonb_typeof(x -> 'year') is distinct from 'number'
         or (x ->> 'year') is distinct from v_year::text then
        raise exception 'x';
      end if;
      v_ids := v_ids || (x ->> 'id')::uuid;
    end loop;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', detail = 'rows';
  end;
  if (select count(distinct u) from unnest(v_ids) u) <> v_n then raise exception 'invalid_input' using errcode = '22023', detail = 'rows'; end if;

  -- L: the pair's live, not-ended rows before this snapshot; R: the ones the snapshot does not list (valid or invalid ids count as seen)
  select coalesce(array_agg(t.lights_id order by t.lights_id), '{}') into v_live from private.lights_mirror t
   where t.region_slug = v_region and t.season = v_season and t.year = v_year and t.removed_at is null
     and coalesce(t.ends_at, t.starts_at + interval '3 hours') + interval '1 hour' > now();
  select coalesce(array_agg(u order by u), '{}') into v_r from unnest(v_live) u where not (u = any (v_ids));
  v_thr := greatest(2::numeric, 0.30 * cardinality(v_live));     -- exact plan rule max(2, 30% of L); numeric, never rounded
  -- the empty-read rule (G1) counts as large wherever the size of R is weighed, so an empty read never removes anything
  v_large := (v_n = 0 and cardinality(v_live) >= 1) or cardinality(v_r) > v_thr;

  -- upsert the valid rows; an invalid row keeps any existing row as is (never a removal)
  for x in select e from jsonb_array_elements(p_rows) e loop
    v_id := (x ->> 'id')::uuid;
    v_ok := true;
    begin
      v_title := case when jsonb_typeof(x -> 'title') = 'string' then x ->> 'title' end;
      v_desc := case when jsonb_typeof(x -> 'description') = 'string' then x ->> 'description' end;
      v_venue := case when jsonb_typeof(x -> 'venue') = 'string' then x ->> 'venue' end;
      v_addr := case when jsonb_typeof(x -> 'address') = 'string' then x ->> 'address' end;
      v_url := case when jsonb_typeof(x -> 'url') = 'string' then x ->> 'url' end;
      if not coalesce(char_length(v_title) between 3 and 80 and v_title !~ '[<>]'
                      and char_length(v_desc) between 10 and 600 and v_desc !~ '[<>]'
                      and (jsonb_typeof(x -> 'venue') = 'null' or (v_venue is not null and char_length(v_venue) <= 120 and v_venue !~ '[<>]'))
                      and char_length(v_addr) between 1 and 200 and v_addr !~ '[<>]'
                      and jsonb_typeof(x -> 'lat') = 'number' and jsonb_typeof(x -> 'lng') = 'number'
                      and jsonb_typeof(x -> 'starts_at') = 'string'
                      and jsonb_typeof(x -> 'ends_at') in ('null', 'string')
                      and (jsonb_typeof(x -> 'url') = 'null' or private.lights_url_ok(v_url))
                      and jsonb_typeof(x -> 'adults_only') = 'boolean', false) then
        raise exception 'x';
      end if;
      v_lat := (x ->> 'lat')::double precision;
      v_lng := (x ->> 'lng')::double precision;
      v_start := (x ->> 'starts_at')::timestamptz;
      v_end := (x ->> 'ends_at')::timestamptz;
      v_adults := (x ->> 'adults_only')::boolean;
      if not coalesce(v_lat <> 'NaN'::double precision and v_lng <> 'NaN'::double precision
                      and v_lat not in ('Infinity', '-Infinity') and v_lng not in ('Infinity', '-Infinity')
                      and exists (select 1 from private.lights_mirror_box(v_region) bx
                                   where v_lat between bx.min_lat and bx.max_lat and v_lng between bx.min_lng and bx.max_lng)
                      and (v_end is null or v_end > v_start), false) then
        raise exception 'x';
      end if;
    exception when others then
      v_ok := false;
    end;
    select * into m from private.lights_mirror t where t.lights_id = v_id for update;
    if found and (m.region_slug, m.season, m.year) is distinct from (v_region, v_season, v_year) then
      v_ok := false;                                             -- the id belongs to another pair: never touched from here
    end if;
    if not v_ok then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    if m.lights_id is null then
      insert into private.lights_mirror (lights_id, region_slug, season, year, title, description, venue, address, lat, lng,
                                         starts_at, ends_at, url, adults_only)
        values (v_id, v_region, v_season, v_year, v_title, v_desc, v_venue, v_addr, v_lat, v_lng, v_start, v_end, v_url, v_adults);
      v_added := v_added + 1;
    else
      if (m.title, m.description, m.venue, m.address, m.lat, m.lng, m.starts_at, m.ends_at, m.url, m.adults_only)
         is distinct from (v_title, v_desc, v_venue, v_addr, v_lat, v_lng, v_start, v_end, v_url, v_adults)
         or m.removed_at is not null then
        v_changed := v_changed + 1;
      end if;
      update private.lights_mirror set title = v_title, description = v_desc, venue = v_venue, address = v_addr, lat = v_lat, lng = v_lng,
          starts_at = v_start, ends_at = v_end, url = v_url, adults_only = v_adults,
          last_seen_at = now(), removed_at = null, removed_run = null
        where lights_id = v_id;
    end if;
    m := null;
  end loop;

  -- the deletion guard
  select * into h from private.lights_mirror_holds t where t.region_slug = v_region and t.season = v_season and t.year = v_year for update;
  if h.region_slug is null then
    if v_large then                                              -- G1: open a hold, remove nothing
      insert into private.lights_mirror_holds (region_slug, season, year, removal_set, first_obs_at, last_obs_at, observations)
        values (v_region, v_season, v_year, v_r, now(), now(), 1);
      v_out := 'held'; v_held := cardinality(v_r);
    else                                                         -- G3: a small removal applies at once
      v_out := 'ok';
    end if;
  elsif v_r = h.removal_set then                                 -- G2: the same set seen again
    update private.lights_mirror_holds set observations = observations + 1, last_obs_at = now()
     where region_slug = v_region and season = v_season and year = v_year
    returning * into h;
    if h.observations >= 3 and h.last_obs_at - h.first_obs_at >= interval '30 minutes' then
      delete from private.lights_mirror_holds where region_slug = v_region and season = v_season and year = v_year;
      v_out := 'ok';
    else
      v_out := 'held'; v_held := cardinality(v_r);
    end if;
  elsif cardinality(v_r) = 0 then                                -- everything back: close, remove nothing
    delete from private.lights_mirror_holds where region_slug = v_region and season = v_season and year = v_year;
    v_out := 'ok';
  elsif not v_large then                                         -- a different, small set: close and G3 on it
    delete from private.lights_mirror_holds where region_slug = v_region and season = v_season and year = v_year;
    v_out := 'ok';
  else                                                           -- a different, large set: start over with it
    update private.lights_mirror_holds set removal_set = v_r, observations = 1, first_obs_at = now(), last_obs_at = now()
     where region_slug = v_region and season = v_season and year = v_year;
    v_out := 'held'; v_held := cardinality(v_r);
  end if;
  if v_out = 'ok' and cardinality(v_r) > 0 then
    update private.lights_mirror set removed_at = now(), removed_run = g.run_id
     where region_slug = v_region and season = v_season and year = v_year and lights_id = any (v_r) and removed_at is null;
    get diagnostics v_removed = row_count;
  end if;

  insert into private.lights_mirror_runs (id, region_slug, season, year, status, seen, added, changed, removed, held, invalid)
    values (g.run_id, v_region, v_season, v_year, v_out, v_n, v_added, v_changed, v_removed, v_held, v_invalid);
  return jsonb_build_object('status', v_out, 'seen', v_n, 'added', v_added, 'changed', v_changed, 'removed', v_removed,
                            'held', v_held, 'invalid', v_invalid);
end $$;

-- A pair is active until 30 days after its window ends (the purge horizon).
create function private.lights_pair_active(p_season text, p_year int) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(upper(private.lights_window(p_season, p_year)) + interval '30 days' >= now(), false)
$$;

-- 5 Status for the admin Lights tab: every open hold with its titles, and the last 10 runs per active pair (counts and status only).
create function public.admin_lights_mirror_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'holds', coalesce((select jsonb_agg(jsonb_build_object(
        'region', h.region_slug, 'season', h.season, 'year', h.year,
        'removalSet', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'title', m.title, 'startsAt', private.api_ts(m.starts_at))
                                                  order by m.starts_at nulls last, u.id)
                                  from unnest(h.removal_set) u(id) left join private.lights_mirror m on m.lights_id = u.id), '[]'::jsonb),
        'observations', h.observations, 'firstObsAt', private.api_ts(h.first_obs_at), 'lastObsAt', private.api_ts(h.last_obs_at))
        order by h.year desc, h.season) from private.lights_mirror_holds h), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('region', p.region_slug, 'season', p.season, 'year', p.year,
        'runs', (select jsonb_agg(jsonb_build_object('status', r.status, 'abortCode', r.abort_code, 'seen', r.seen, 'added', r.added,
                                                     'changed', r.changed, 'removed', r.removed, 'held', r.held, 'invalid', r.invalid,
                                                     'finishedAt', private.api_ts(r.finished_at)) order by r.finished_at desc)
                   from (select * from private.lights_mirror_runs r2
                          where r2.region_slug = p.region_slug and r2.season = p.season and r2.year = p.year
                          order by r2.finished_at desc limit 10) r))
        order by p.year desc, p.season)
      from (select distinct r.region_slug, r.season, r.year from private.lights_mirror_runs r
             where private.lights_pair_active(r.season, r.year)) p), '[]'::jsonb));
end $$;

-- 6 Accept a held removal set as shown (set-bound): removes it, closes the hold, confirms the pair as of the last observation.
create function public.admin_accept_lights_removals(p_region text, p_season text, p_year integer, p_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare h private.lights_mirror_holds; v_run uuid := gen_random_uuid(); v_n int;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_region is null or p_season is null or p_year is null then raise exception 'not_found' using errcode = 'P0002', detail = 'hold'; end if;
  perform private.lights_pair_lock(p_region, p_season, p_year);
  select * into h from private.lights_mirror_holds t where t.region_slug = p_region and t.season = p_season and t.year = p_year for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'hold'; end if;
  if array(select u from unnest(coalesce(p_ids, '{}')) u order by u) is distinct from h.removal_set then
    raise exception 'stale_set' using errcode = '22023', detail = 'ids';
  end if;
  update private.lights_mirror set removed_at = now(), removed_run = v_run
   where region_slug = p_region and season = p_season and year = p_year and lights_id = any (h.removal_set) and removed_at is null;
  get diagnostics v_n = row_count;
  delete from private.lights_mirror_holds where region_slug = p_region and season = p_season and year = p_year;
  insert into private.lights_mirror_runs (id, region_slug, season, year, status, removed, finished_at)
    values (v_run, p_region, p_season, p_year, 'ok', v_n, h.last_obs_at);
end $$;

-- 7 The per-event include control. Never touches lights_override_at.
create function public.admin_set_lights_include(p_event uuid, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.events;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_value is null or p_value not in ('auto', 'yes', 'no') then raise exception 'invalid_input' using errcode = '22023', detail = 'value'; end if;
  select * into e from public.events x where x.id = p_event for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'event'; end if;
  update public.events set lights_include = p_value where id = e.id;
  insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
    values (e.id, 'lights_include', to_jsonb(e.lights_include), to_jsonb(p_value), 'admin:' || auth.uid()::text);
  perform private.recompute_event(e.id);
end $$;

-- 8 "Show on Lights anyway": the override must postdate a Lights removal to win (shown_on_lights), and sets yes.
create function public.admin_set_lights_override(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.events;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into e from public.events x where x.id = p_event for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'event'; end if;
  update public.events set lights_override_at = now(), lights_include = 'yes' where id = e.id;
  insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
    values (e.id, 'lights_override_at', to_jsonb(e.lights_override_at), to_jsonb(now()), 'admin:' || auth.uid()::text),
           (e.id, 'lights_include', to_jsonb(e.lights_include), to_jsonb('yes'::text), 'admin:' || auth.uid()::text);
  perform private.recompute_event(e.id);
end $$;

-- 9 Vibes events eligible for a pair, with the one Lights predicate (shown_on_lights) and why one is not shown.
create function public.admin_lights_events(p_season text, p_year integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not coalesce(p_season in ('halloween', 'christmas'), false) then raise exception 'invalid_input' using errcode = '22023', detail = 'season'; end if;
  if not coalesce(p_year between 2025 and 2100, false) then raise exception 'invalid_input' using errcode = '22023', detail = 'year'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'title', e.title, 'startsAt', private.api_ts(e.starts_at), 'lightsInclude', e.lights_include,
      'shown', private.shown_on_lights(e, 'truckee', p_season, p_year, v.lat, v.lng),
      'coveredLive', coalesce(v.lat is not null and exists (select 1 from private.lights_mirror m
          where m.region_slug = 'truckee' and m.season = p_season and m.year = p_year and m.removed_at is null
            and private.lights_covers(m, e, v.lat, v.lng)), false),
      'vetoed', coalesce(v.lat is not null and exists (select 1 from private.lights_mirror m
          where m.region_slug = 'truckee' and m.season = p_season and m.year = p_year and m.removed_at is not null
            and m.removed_at > coalesce(e.lights_override_at, '-infinity'::timestamptz)
            and private.lights_covers(m, e, v.lat, v.lng)), false))
      order by e.starts_at, e.id)
    from public.events e left join public.venues v on v.id = e.venue_id
   where e.merged_into is null
     and e.lights_season @> jsonb_build_array(jsonb_build_object('season', p_season, 'year', p_year))), '[]'::jsonb);
end $$;

-- 10 Purge pairs 30 days after their window ends.
create function private.purge_lights_mirror() returns int
language plpgsql set search_path = '' as $$
declare a int; b int; c int;
begin
  delete from private.lights_mirror where not private.lights_pair_active(season, year);
  get diagnostics a = row_count;
  delete from private.lights_mirror_holds where not private.lights_pair_active(season, year);
  get diagnostics b = row_count;
  delete from private.lights_mirror_runs where not private.lights_pair_active(season, year);
  get diagnostics c = row_count;
  return a + b + c;
end $$;
select cron.schedule('tv-lights-mirror-purge', '40 10 * * *', $$select private.purge_lights_mirror()$$);

-- 11 Grants: deny everything, then the exact cumulative allowlist (W1's 25 + the two svc mirror RPCs + the five admin Lights RPCs).
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
grant execute on function public.svc_issue_mirror_grant() to service_role;
grant execute on function public.svc_lights_mirror_apply(text, jsonb, jsonb) to service_role;
grant execute on function public.admin_lights_mirror_status() to authenticated;
grant execute on function public.admin_accept_lights_removals(text, text, integer, uuid[]) to authenticated;
grant execute on function public.admin_set_lights_include(uuid, text) to authenticated;
grant execute on function public.admin_set_lights_override(uuid) to authenticated;
grant execute on function public.admin_lights_events(text, integer) to authenticated;
