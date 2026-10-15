-- M0 core: regions, areas, admins, categories, sources and the fail-closed source gate.

-- (1) helpers with no table dependencies (a CHECK that calls a function needs the function to exist first)
-- The one URL validator for every URL column.
create function private.valid_event_url(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_host text;
begin
  if p is null or char_length(p) > 300 or left(p, 8) <> 'https://' then return false; end if;
  -- userinfo, backslash, whitespace/control, quotes and angle brackets anywhere
  if p ~ '[@\\[:space:][:cntrl:]"''<>`]' then return false; end if;
  v_host := lower(substring(p from 9 for char_length(p)));
  v_host := split_part(split_part(split_part(v_host, '/', 1), '?', 1), '#', 1);
  -- explicit port and IPv6 literals ([..] / ':'), then DNS labels with a letters-only TLD. The TLD rule also
  -- rejects every IPv4 notation (dotted, decimal, hex, octal), single-label hosts and a trailing dot.
  if v_host ~ '[:\[\]]' then return false; end if;
  if v_host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then return false; end if;
  if v_host = 'localhost' or v_host like '%.localhost' then return false; end if;
  if exists (select 1 from unnest(array['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
                                        'rebrand.ly']) s
              where v_host = s or v_host like '%.' || s) then
    return false;
  end if;
  return true;
end $$;

create function private.normalize_title(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
$$;

-- (2) types and tables
create table public.regions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null check (char_length(name) between 2 and 60),
  tz text not null,
  local_min_lat double precision not null, local_max_lat double precision not null,
  local_min_lng double precision not null, local_max_lng double precision not null,
  drive_min_lat double precision not null, drive_max_lat double precision not null,
  drive_min_lng double precision not null, drive_max_lng double precision not null);
create table public.areas (
  slug text primary key check (slug in ('truckee','donner_lake','tahoe_city_west_shore','olympic_valley_northstar',
                                        'kings_beach_north_shore','incline_crystal_bay','reno_carson')),
  label text not null, sort smallint not null, priority smallint not null,
  min_lat double precision not null, max_lat double precision not null,
  min_lng double precision not null, max_lng double precision not null);
create table public.admins (user_id uuid primary key references auth.users(id) on delete cascade,
  note text check (note is null or char_length(note) <= 100), created_at timestamptz not null default now());
create table private.blocked_terms (term text primary key check (term ~ '^[a-z0-9 ]{2,40}$'));
create table public.categories (slug text primary key, label text not null, sort smallint not null, noun text not null);
create type public.source_trust as enum ('auto','review','link_only');
create type public.source_class as enum ('organizer','municipal','venue','dmo','aggregator','community','llm');
create type public.ingest_disposition as enum ('unknown','permitted','permission_required','prohibited','official_api_only');
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name text not null check (char_length(name) between 2 and 80),
  homepage_url text not null check (private.valid_event_url(homepage_url)),
  allowed_hosts text[] not null check (cardinality(allowed_hosts) between 1 and 5),
  family text not null check (family in ('tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager',
                                         'rss','squarespace','jsonld','html','llm')),
  config jsonb not null default '{}' check (octet_length(config::text) <= 8192),
  class public.source_class not null,
  priority smallint generated always as (case class when 'organizer' then 100 when 'municipal' then 80
     when 'venue' then 70 when 'dmo' then 50 when 'aggregator' then 20 else 10 end) stored,
  trust public.source_trust not null default 'review',
  enabled boolean not null default false,
  opt_out boolean not null default false,
  cadence text not null default '24h' check (cadence in ('6h','12h','24h','168h')),
  next_due_at timestamptz not null default now(),
  page_cap smallint not null default 30 check (page_cap between 1 and 200),
  ingest_disposition public.ingest_disposition not null default 'unknown',
  allowed_methods text[] not null default '{}' check (allowed_methods <@ array['feed','api','html']),
  terms_url text check (terms_url is null or private.valid_event_url(terms_url)),
  terms_hash text check (terms_hash is null or terms_hash ~ '^[0-9a-f]{64}$'),
  terms_reviewed_by text check (terms_reviewed_by is null or char_length(terms_reviewed_by) <= 40),
  terms_reviewed_at timestamptz, terms_recheck_at timestamptz,
  terms_note text check (terms_note is null or char_length(terms_note) <= 200),   -- neutral, public-safe
  robots_checked_at timestamptz, robots_hash text, ai_bots_blocked boolean,
  etag text check (etag is null or char_length(etag) <= 200),
  last_modified text check (last_modified is null or char_length(last_modified) <= 100),
  content_hash text, last_success_at timestamptz, consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ingest_disposition <> 'official_api_only' or allowed_methods <@ array['api']),
  check (terms_recheck_at is null or terms_reviewed_at is null
         or terms_recheck_at <= terms_reviewed_at + interval '12 months'));

alter table public.regions       enable row level security; alter table public.regions       force row level security;
alter table public.areas         enable row level security; alter table public.areas         force row level security;
alter table public.admins        enable row level security; alter table public.admins        force row level security;
alter table private.blocked_terms enable row level security; alter table private.blocked_terms force row level security;
alter table public.categories    enable row level security; alter table public.categories    force row level security;
alter table public.sources       enable row level security; alter table public.sources       force row level security;

-- (3) functions that need the tables
create function private.has_blocked_term(p text) returns boolean
language sql stable set search_path = '' as $$
  with s as (select lower(coalesce(p, '')) as v),
  joined as (
    select coalesce(string_agg(regexp_replace(m[1], '[^a-z0-9]', '', 'g'), ' '), '') as j
      from s, regexp_matches(s.v, '(\m[a-z0-9](?:[^a-z0-9[:space:]]+[a-z0-9])+\M)', 'g') as m
  )
  select exists (select 1 from private.blocked_terms t, s, joined
                  where regexp_replace(s.v, '[^a-z0-9]+', ' ', 'g') ~ ('\m' || t.term || '\M')
                     or btrim(regexp_replace(regexp_replace(regexp_replace(s.v, '[''’‘`]', ' ', 'g'),
                                                            '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
                        ~ ('\m' || t.term || '\M')
                     or joined.j ~ ('\m' || t.term || '\M'))
$$;

-- Admin gate: a non-anonymous aal2 session whose amr has BOTH a password and a totp entry, and an admins row.
-- A missing or non-array amr fails closed. Vibes admins are global.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  with j as (
    select case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
                else '[]'::jsonb end as amr
  )
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) = false
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from j, jsonb_array_elements(j.amr) e where e ->> 'method' = 'password')
     and exists (select 1 from j, jsonb_array_elements(j.amr) e where e ->> 'method' = 'totp')
     and exists (select 1 from public.admins a where a.user_id = auth.uid())
$$;

-- Fail-closed source gate: a source can be enabled only with a current, evidenced, permitting disposition.
create function private.sources_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.opt_out and new.enabled then
    raise exception 'invalid_input' using errcode = '22023', detail = 'opt_out_enabled';
  end if;
  -- coalesce: a null in any term must fail closed (not (null) is null, which would let the row through)
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
create trigger sources_gate before insert or update on public.sources
  for each row execute function private.sources_gate();

create function private.in_local_box(p_region_id uuid, p_lat double precision, p_lng double precision) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select p_lat between r.local_min_lat and r.local_max_lat
                       and p_lng between r.local_min_lng and r.local_max_lng
                     from public.regions r where r.id = p_region_id), false)
$$;
create function private.in_drive_box(p_region_id uuid, p_lat double precision, p_lng double precision) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select p_lat between r.drive_min_lat and r.drive_max_lat
                       and p_lng between r.drive_min_lng and r.drive_max_lng
                     from public.regions r where r.id = p_region_id), false)
$$;

-- The named area with the lowest priority number whose box holds the point; else 'truckee' inside a region's local box.
create function private.area_for(p_lat double precision, p_lng double precision) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select a.slug from public.areas a
      where p_lat between a.min_lat and a.max_lat and p_lng between a.min_lng and a.max_lng
      order by a.priority limit 1),
    (select 'truckee' from public.regions r where private.in_local_box(r.id, p_lat, p_lng) limit 1))
$$;

-- Evidence lands in a reviewed migration, never through an API role (no grants).
create function private.record_source_terms(
  p_slug text, p_disposition text, p_methods text[], p_terms_url text, p_terms_hash text,
  p_reviewed_by text, p_reviewed_at timestamptz, p_recheck_at timestamptz, p_note text) returns void
language plpgsql set search_path = '' as $$
begin
  update public.sources
     set ingest_disposition = p_disposition::public.ingest_disposition,
         allowed_methods = p_methods, terms_url = p_terms_url, terms_hash = p_terms_hash,
         terms_reviewed_by = p_reviewed_by, terms_reviewed_at = p_reviewed_at,
         terms_recheck_at = p_recheck_at, terms_note = p_note
   where slug = p_slug;
  if not found then
    raise exception 'not_found' using errcode = 'P0002', detail = 'source';
  end if;
end $$;

-- Public read: name, homepage and status only.
create function public.list_sources_public() returns table (name text, homepage_url text, status text)
language sql stable security definer set search_path = '' as $$
  select s.name, s.homepage_url,
         case when s.enabled then 'active' when s.trust = 'link_only' then 'link_only' else 'paused' end
    from public.sources s
   where not s.opt_out
   order by s.name
$$;

create function public.admin_whoami() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin()
$$;

create function public.admin_list_sources() returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select to_jsonb(s) - 'config' from public.sources s order by s.name;
end $$;

-- Disabling is always allowed; enabling goes through the sources_gate trigger.
create function public.admin_set_source_enabled(p_slug text, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.sources set enabled = p_enabled where slug = p_slug;
  if not found then
    raise exception 'not_found' using errcode = 'P0002', detail = 'source';
  end if;
end $$;

create function public.admin_set_source_trust(p_slug text, p_trust text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_trust is null or p_trust not in ('auto', 'review', 'link_only') then
    raise exception 'invalid_input' using errcode = '22023', detail = 'trust';
  end if;
  update public.sources set trust = p_trust::public.source_trust where slug = p_slug;
  if not found then
    raise exception 'not_found' using errcode = 'P0002', detail = 'source';
  end if;
end $$;

-- Grants: deny everything, then the exact allowlist.
revoke all on all tables    in schema public, private from service_role;
revoke all on all sequences in schema public, private from service_role;
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function public.list_sources_public() to anon, authenticated;
grant execute on function public.admin_whoami() to authenticated;
grant execute on function public.admin_list_sources() to authenticated;
grant execute on function public.admin_set_source_enabled(text, boolean) to authenticated;
grant execute on function public.admin_set_source_trust(text, text) to authenticated;
