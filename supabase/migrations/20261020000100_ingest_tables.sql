-- M1 ingest tables (spec S1.1): runs, venues, source events, events, review queue, retention-guarded history.
-- Every table: RLS enabled and forced, no grants, no policies. Writes happen only through security definer RPCs.

create table private.ingest_nonces (nonce text primary key check (nonce ~ '^[0-9a-f]{32}$'),
  seen_at timestamptz not null default now());
create index ingest_nonces_seen_at_idx on private.ingest_nonces (seen_at);
create table private.ingest_grants (token_hash bytea primary key, source_id uuid not null references public.sources(id),
  run_id uuid not null unique, issued_at timestamptz not null default now(),
  expires_at timestamptz not null, used_at timestamptz);
create table public.source_runs (id uuid primary key,                      -- = grant run_id
  source_id uuid not null references public.sources(id), started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  status text not null check (status in ('ok','not_modified','robots_blocked','http_error','parse_error','anomaly','skipped')),
  http_status smallint, items_found int not null default 0, items_new int not null default 0,
  items_changed int not null default 0, items_gone int not null default 0, items_invalid int not null default 0,
  items_suppressed int not null default 0, bytes int, duration_ms int, content_hash text,
  parser_version text check (parser_version ~ '^[a-z0-9._-]{1,40}$'),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,40}$'),
  error_detail text check (error_detail is null or char_length(error_detail) <= 300),
  anomaly_reasons text[] not null default '{}');
create index source_runs_source_finished_idx on public.source_runs (source_id, finished_at desc);
create table public.venues (id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80 and name !~ '[<>]'),
  normalized_name text not null, aliases text[] not null default '{}',
  address text check (address is null or char_length(address) <= 160), town text check (char_length(town) <= 60),
  area text references public.areas(slug), lat double precision, lng double precision,
  place_id text, geocoder text check (geocoder in ('source','nominatim','google','admin')),
  geocode_attempts smallint not null default 0, verified boolean not null default false,
  outside_region boolean not null default false,          -- A2: geocoder put it outside the drive box
  created_at timestamptz not null default now(), unique nulls not distinct (normalized_name, town));
create table public.geocode_usage (month date primary key, units int not null default 0, cap int not null default 300);
create table public.series (id uuid primary key default gen_random_uuid(), source_id uuid not null references public.sources(id),
  source_uid text not null check (char_length(source_uid) <= 300), title text not null, unique (source_id, source_uid));
create table public.source_events (id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id),
  external_key text not null check (char_length(external_key) between 1 and 400),
  facts jsonb not null, content_hash text not null,
  title text not null, normalized_title text not null,
  starts_at timestamptz not null, ends_at timestamptz, all_day boolean not null,
  start_date date, end_date date, time_known boolean not null, start_day date not null,
  venue_id uuid references public.venues(id), url text, ticket_url text,
  price_kind text not null default 'unknown', price_min numeric(8,2), price_max numeric(8,2),
  age text not null default 'unknown', categories text[] not null default '{}',
  series_id uuid references public.series(id),
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  missing_runs smallint not null default 0,
  source_status text not null default 'live' check (source_status in ('live','gone','cancelled_by_source')),
  cluster_id uuid, needs_cluster boolean not null default true,
  unique (source_id, external_key));
create index source_events_outbox_idx on public.source_events (id) where needs_cluster;
create index source_events_day_idx on public.source_events (start_day);
create index source_events_cluster_idx on public.source_events (cluster_id);
create table public.source_event_versions (id bigint generated always as identity primary key,
  source_event_id uuid not null references public.source_events(id) on delete cascade,
  run_id uuid not null, normalized jsonb not null, normalized_hash text not null,
  parser_version text not null, accepted_at timestamptz not null default now());
create index source_event_versions_se_idx on public.source_event_versions (source_event_id);
create type public.event_status as enum ('pending','published','hidden','rejected','unlisted','cancelled');
create table public.events (id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,60}-[a-z0-9]{6}$'),
  title text not null check (char_length(title) between 3 and 80 and title !~ '[<>]'),
  normalized_title text not null,
  summary text not null check (char_length(summary) between 10 and 600 and summary !~ '[<>]'),
  starts_at timestamptz not null, ends_at timestamptz check (ends_at is null or ends_at > starts_at),
  all_day boolean not null default false, start_date date, end_date date,
  check (not all_day or (start_date is not null and end_date > start_date)),
  time_known boolean not null, start_day date not null,
  merged_into uuid references public.events(id), venue_id uuid references public.venues(id),
  area text references public.areas(slug),
  price_kind text not null default 'unknown' check (price_kind in ('free','paid','donation','unknown')),
  price_min numeric(8,2) check (price_min is null or price_min between 0 and 99999.99),
  price_max numeric(8,2) check (price_max is null or price_max between 0 and 99999.99),
  age text not null default 'unknown' check (age in ('all_ages','family','18_plus','21_plus','unknown')),
  indoor_outdoor text check (indoor_outdoor in ('indoor','outdoor','both')),
  organizer_url text check (organizer_url is null or private.valid_event_url(organizer_url)),
  ticket_url text check (ticket_url is null or private.valid_event_url(ticket_url)),
  series_id uuid references public.series(id),
  status public.event_status not null default 'pending', status_by_admin boolean not null default false,
  origin text not null default 'ingest' check (origin in ('ingest','community','admin')),
  source_class text,                                  -- class of the winning time/title source, or 'admin'
  confidence smallint not null default 0 check (confidence between 0 and 100),
  featured boolean not null default false,
  lights_include text not null default 'auto' check (lights_include in ('auto','yes','no')),
  lights_season jsonb not null default '[]',          -- M3: [{"season":"halloween","year":2026}, ...]
  field_sources jsonb not null default '{}', locked_fields text[] not null default '{}',
  reject_reason text check (char_length(reject_reason) <= 200),
  published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  moderated_by uuid references auth.users(id) on delete set null, moderated_at timestamptz);
create index events_list_idx on public.events (status, starts_at) where merged_into is null;
create index events_cluster_idx on public.events (start_day, area);
create index events_trgm_idx on public.events using gin (normalized_title extensions.gin_trgm_ops);
alter table public.source_events add constraint source_events_cluster_fk foreign key (cluster_id) references public.events(id);
create table public.event_categories (event_id uuid references public.events(id) on delete cascade,
  category text references public.categories(slug), primary key (event_id, category));
create table public.event_changes (id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade, at timestamptz not null default now(),
  field text not null, old_value jsonb, new_value jsonb,
  decided_by text not null check (decided_by ~ '^(sev:[0-9]+|admin:[0-9a-f-]{36}|rule:[a-z_]{1,40})$'));
create index event_changes_event_idx on public.event_changes (event_id);
create table public.suppressions (id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('host','url_prefix','event')), value text not null check (char_length(value) <= 300),
  reason text check (char_length(reason) <= 200), created_at timestamptz not null default now(), unique (kind, value));
create table public.held_runs (run_id uuid primary key references public.source_runs(id),
  source_id uuid not null references public.sources(id), items jsonb not null, summary jsonb not null,
  status text not null default 'pending' check (status in ('pending','accepted','discarded','expired')),
  decided_by uuid, decided_at timestamptz, created_at timestamptz not null default now());
create table public.review_cards (id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('event','possible_duplicate','held_run','source_budget')),
  status text not null default 'open' check (status in ('open','closed')),
  event_id uuid references public.events(id) on delete cascade, other_event_id uuid references public.events(id) on delete cascade,
  held_run_id uuid references public.held_runs(run_id), source_id uuid references public.sources(id),
  created_at timestamptz not null default now(), opened_at timestamptz, decided_at timestamptz,
  review_seconds smallint check (review_seconds between 0 and 600),
  decision text check (decision ~ '^[a-z_]{1,30}$'), reason text check (char_length(reason) <= 200), decided_by uuid);
create unique index review_cards_open_event_idx on public.review_cards (kind, event_id) where status = 'open' and kind = 'event';
create index review_cards_source_idx on public.review_cards (source_id, created_at);
create table public.owner_activity (id bigint generated always as identity primary key,
  kind text not null check (kind in ('featured','takedown','source_decision','other')),
  seconds smallint not null check (seconds between 0 and 3600), at timestamptz not null default now(), by uuid);
create table private.notify_log (kind text not null, sent_at timestamptz not null default now());

alter table private.ingest_nonces enable row level security;       alter table private.ingest_nonces force row level security;
alter table private.ingest_grants enable row level security;       alter table private.ingest_grants force row level security;
alter table private.notify_log enable row level security;          alter table private.notify_log force row level security;
alter table public.source_runs enable row level security;          alter table public.source_runs force row level security;
alter table public.venues enable row level security;               alter table public.venues force row level security;
alter table public.geocode_usage enable row level security;        alter table public.geocode_usage force row level security;
alter table public.series enable row level security;               alter table public.series force row level security;
alter table public.source_events enable row level security;        alter table public.source_events force row level security;
alter table public.source_event_versions enable row level security; alter table public.source_event_versions force row level security;
alter table public.events enable row level security;               alter table public.events force row level security;
alter table public.event_categories enable row level security;     alter table public.event_categories force row level security;
alter table public.event_changes enable row level security;        alter table public.event_changes force row level security;
alter table public.suppressions enable row level security;         alter table public.suppressions force row level security;
alter table public.held_runs enable row level security;            alter table public.held_runs force row level security;
alter table public.review_cards enable row level security;         alter table public.review_cards force row level security;
alter table public.owner_activity enable row level security;       alter table public.owner_activity force row level security;

-- Append-only guards: history is immutable except inside private.retention_sweep() (tv.retention = on, transaction-local).
create function private.append_only_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('tv.retention', true), '') <> 'on' then
    raise exception 'forbidden' using errcode = '42501', detail = tg_table_name;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger source_event_versions_append_only before update or delete on public.source_event_versions
  for each row execute function private.append_only_guard();
create trigger event_changes_append_only before update or delete on public.event_changes
  for each row execute function private.append_only_guard();

-- The region's time zone for local dates (Vibes v1 has one region).
create function private.region_tz() returns text
language sql stable set search_path = '' as $$
  select coalesce((select r.tz from public.regions r order by r.slug limit 1), 'America/Los_Angeles')
$$;

-- Derived columns on events: normalized_title, region-local start_day, updated_at, an immutable slug.
create function private.events_before_write() returns trigger
language plpgsql set search_path = '' as $$
declare v_tz text;
begin
  new.normalized_title := private.normalize_title(new.title);
  select r.tz into v_tz from public.regions r where r.id = new.region_id;
  new.start_day := (new.starts_at at time zone coalesce(v_tz, 'America/Los_Angeles'))::date;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.slug is null or new.slug = '' then
      new.slug := left(btrim(regexp_replace(new.normalized_title, ' +', '-', 'g'), '-'), 50)
                  || '-' || substr(replace(new.id::text, '-', ''), 1, 6);
    end if;
  elsif new.slug is distinct from old.slug then
    raise exception 'slug_immutable' using errcode = '22023', detail = 'slug';
  end if;
  return new;
end $$;
create trigger events_before_write before insert or update on public.events
  for each row execute function private.events_before_write();

create function private.source_events_before_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.normalized_title := private.normalize_title(new.title);
  new.start_day := (new.starts_at at time zone private.region_tz())::date;
  return new;
end $$;
create trigger source_events_before_write before insert or update on public.source_events
  for each row execute function private.source_events_before_write();

-- Source columns added by M1 (A2/A3). The M0 migration is not edited.
alter table public.sources
  add column strict_auto boolean not null default false,      -- owner-approved strict auto-publish (D13); migration-only
  add column max_cards_7d smallint check (max_cards_7d is null or max_cards_7d between 1 and 50),  -- null = no cap
  add constraint sources_aggregator_not_auto check (not (class = 'aggregator' and trust = 'auto')),   -- A3
  drop constraint sources_cadence_check,
  add constraint sources_cadence_check check (cadence in ('6h','12h','24h','72h','168h'));   -- 72h: ChamberMaster X-PUBLISHED-TTL P3D

-- A3: the admin trust control gets a mapped error for aggregators (same signature and grant as M0).
create or replace function public.admin_set_source_trust(p_slug text, p_trust text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_trust is null or p_trust not in ('auto', 'review', 'link_only') then
    raise exception 'invalid_input' using errcode = '22023', detail = 'trust';
  end if;
  if p_trust = 'auto' and (select s.class from public.sources s where s.slug = p_slug) = 'aggregator' then
    raise exception 'invalid_input' using errcode = '22023', detail = 'aggregator_auto';
  end if;
  update public.sources set trust = p_trust::public.source_trust where slug = p_slug;
  if not found then
    raise exception 'not_found' using errcode = 'P0002', detail = 'source';
  end if;
end $$;

-- Trust or strict_auto changes re-queue the source's live occurrences, so promotion publishes what is already ingested.
create function private.sources_trust_requeue() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.source_events se set needs_cluster = true
   where se.source_id = new.id and se.source_status <> 'gone'
     and coalesce(se.ends_at, se.starts_at + interval '3 hours') > now() - interval '1 day';
  return null;
end $$;
create trigger sources_trust_requeue after update of trust, strict_auto on public.sources
  for each row when (old.trust is distinct from new.trust or old.strict_auto is distinct from new.strict_auto)
  execute function private.sources_trust_requeue();

revoke all on all tables    in schema public, private from service_role;
revoke all on all sequences in schema public, private from service_role;
revoke execute on all functions in schema public  from public, anon, authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;

grant execute on function public.list_sources_public() to anon, authenticated;
grant execute on function public.admin_whoami() to authenticated;
grant execute on function public.admin_list_sources() to authenticated;
grant execute on function public.admin_set_source_enabled(text, boolean) to authenticated;
grant execute on function public.admin_set_source_trust(text, text) to authenticated;
