-- Redesign R2a-db (Amendment 10): the event-pages manifest RPC and the write-once published_at marker.
-- (a) published_at is write-once; (b) a suppression helper (no grant); (c) public.list_event_pages(); (d) the cumulative allowlist plus that one function.

-- (a) private.events_before_write: verbatim copy of 20261020000100_ingest_tables.sql plus the marked R2a block before return new.
create or replace function private.events_before_write() returns trigger
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
  -- R2a begin
  if tg_op = 'INSERT' and new.published_at is not null and new.status <> 'published' then
    raise exception 'published_at_immutable' using errcode = '22023', detail = 'published_at';
  end if;
  if tg_op = 'UPDATE' and new.published_at is distinct from old.published_at
     and (old.published_at is not null or new.status <> 'published') then
    raise exception 'published_at_immutable' using errcode = '22023', detail = 'published_at';
  end if;
  -- R2a end
  return new;
end $$;

-- (b) The same predicate as admin_add_suppression (20261020000300_queue_admin.sql). No grant.
create function private.event_matches_suppression(e public.events) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.suppressions x where
       (x.kind = 'event' and x.value = e.id::text)
    or (x.kind = 'url_prefix' and e.organizer_url is not null and left(e.organizer_url, char_length(x.value)) = x.value)
    or (x.kind = 'host' and e.organizer_url is not null
        and (substring(lower(e.organizer_url) from '^https://([^/?#]+)') = x.value
             or right(substring(lower(e.organizer_url) from '^https://([^/?#]+)'), char_length(x.value) + 1) = '.' || x.value)))
$$;

-- (c) The manifest: one jsonb envelope (DR15), so PostgREST max_rows cannot cut it.
create function public.list_event_pages()
returns jsonb
language sql stable security definer set search_path = '' as $$
  with recursive pg as (
    select e.*, case when e.status = 'cancelled' then 'cancelled'
                     when coalesce(e.ends_at, e.starts_at + interval '3 hours') > now() - interval '1 hour' then 'upcoming'
                     else 'ended' end as st
      from public.events e
     where e.merged_into is null and e.published_at is not null and e.status in ('published', 'cancelled')
       and e.starts_at < now() + interval '120 days'
       and coalesce(e.ends_at, e.starts_at + interval '3 hours') > now() - interval '30 days'),
  pages as (select * from pg order by pg.starts_at, pg.slug limit 3000),
  rd0 as (
    select l.id, l.slug as loser, l.merged_into
      from public.events l
     where l.merged_into is not null and l.published_at is not null and not private.event_matches_suppression(l)
       and exists (select 1 from public.event_changes c1 join public.event_changes c2
                     on c2.event_id = c1.event_id and c2.at = c1.at and c2.decided_by = c1.decided_by
                    where c1.event_id = l.id and c1.field = 'status' and c1.new_value = '"hidden"'::jsonb
                      and c1.old_value in ('"published"'::jsonb, '"cancelled"'::jsonb)
                      and c2.field = 'merged_into' and c2.new_value = to_jsonb(l.merged_into))),
  chain as (
    select r.loser, r.merged_into as cur, 1 as depth, array[r.id, r.merged_into] as seen
      from rd0 r
    union all
    select c.loser, e.merged_into, c.depth + 1, c.seen || e.merged_into
      from chain c join public.events e on e.id = c.cur
     where e.merged_into is not null and c.depth < 10 and e.merged_into <> all (c.seen)),
  rd as (
    select ch.loser, s.slug as survivor from chain ch join pages s on s.id = ch.cur),
  redirects as (select * from rd order by rd.loser limit 1000),
  page_json as (
    select p.starts_at, p.slug,
           case when p.st = 'upcoming' then jsonb_build_object('slug', p.slug, 'pageState', p.st)
           else jsonb_build_object(
             'slug', p.slug, 'pageState', p.st, 'title', p.title, 'summary', p.summary,
             'startsAt', p.starts_at, 'endsAt', p.ends_at, 'allDay', p.all_day, 'startDate', p.start_date,
             'endDate', p.end_date, 'timeKnown', p.time_known, 'venue', v.name, 'address', v.address,
             'town', v.town, 'lat', v.lat, 'lng', v.lng,
             'categories', coalesce((select array_agg(c.category order by k.sort, c.category) from public.event_categories c
                              join public.categories k on k.slug = c.category where c.event_id = p.id), '{}'::text[]),
             'priceKind', p.price_kind, 'priceMin', p.price_min, 'priceMax', p.price_max, 'age', p.age,
             'url', p.organizer_url,
             'sources', coalesce((select array_agg(n order by n) from (select distinct s.name as n from public.source_events se
                              join public.sources s on s.id = se.source_id where se.cluster_id = p.id and se.source_status <> 'gone') x), '{}'::text[]))
           end as j
      from pages p left join public.venues v on v.id = p.venue_id)
  select jsonb_build_object(
    'v', 1,
    'pageTotal', (select count(*) from pg),
    'redirectTotal', (select count(*) from rd),
    'pageCapHit', (select count(*) from pg) > 3000,
    'redirectCapHit', (select count(*) from rd) > 1000,
    'pages', coalesce((select jsonb_agg(pj.j order by pj.starts_at, pj.slug) from page_json pj), '[]'::jsonb),
    'redirects', coalesce((select jsonb_agg(jsonb_build_object('slug', r.loser, 'redirectSlug', r.survivor) order by r.loser)
                             from redirects r), '[]'::jsonb))
$$;

-- (d) Grants: deny everything, then the exact cumulative allowlist (the 23 existing + list_event_pages).
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
