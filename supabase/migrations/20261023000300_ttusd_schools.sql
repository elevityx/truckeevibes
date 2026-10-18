-- A12: TTUSD school calendars as sources (spec Amendment 12 r3).
-- 1. the `schools` category; 2. the `html_finalsite` family; 3. nine source rows (seven enabled, kbe and dte off); 4. the terms evidence;
-- 5. private.ttusd_twin + cluster_and_publish (exact-key dedupe for TTUSD items only); 6. recompute_event (TTUSD all-day items publish
-- without a time). The include grammar runs in the adapter (ingest/core/ttusd.ts) before anything reaches the database.

insert into public.categories (slug, label, sort, noun) values ('schools', 'Schools', 14, 'school calendar date');

alter table public.sources drop constraint sources_family_check;
alter table public.sources add constraint sources_family_check check (family in ('tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager',
                                         'rss','squarespace','jsonld','html','llm','html_finalsite'));

insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, cadence, page_cap, config) values
  ('ttusd-district', 'Tahoe Truckee Unified School District', 'https://www.ttusd.org/parents-students/calendars/calendars2', array['www.ttusd.org'], 'html_finalsite', 'municipal'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://www.ttusd.org/parents-students/calendars/calendars2","school":"district","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-ths', 'Truckee High School', 'https://ths.ttusd.org/calendar', array['ths.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://ths.ttusd.org/calendar","school":"ths","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-nths', 'North Tahoe High School', 'https://nths.ttusd.org/calendar', array['nths.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://nths.ttusd.org/calendar","school":"nths","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-acms', 'Alder Creek Middle School', 'https://acms.ttusd.org/calendar', array['acms.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://acms.ttusd.org/calendar","school":"acms","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-nts', 'North Tahoe School', 'https://nts.ttusd.org/calendar', array['nts.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://nts.ttusd.org/calendar","school":"nts","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-te', 'Truckee Elementary School', 'https://te.ttusd.org/calendar', array['te.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://te.ttusd.org/calendar","school":"te","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-tle', 'Tahoe Lake Elementary School', 'https://tle.ttusd.org/calendar', array['tle.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://tle.ttusd.org/calendar","school":"tle","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-kbe', 'Kings Beach Elementary School', 'https://kbe.ttusd.org/calendar', array['kbe.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://kbe.ttusd.org/calendar","school":"kbe","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb),
  ('ttusd-dte', 'Donner Trail Elementary School', 'https://dte.ttusd.org/calendar', array['dte.ttusd.org'], 'html_finalsite', 'organizer'::public.source_class, '24h', 6,
   '{"calendarUrl":"https://dte.ttusd.org/calendar","school":"dte","allowlist":"ttusd","tz":"America/Los_Angeles"}'::jsonb);

-- Terms evidence through the gate. The hash is the www robots.txt as of 2026-10-18 (spec A12); re-hash at the first hosted run.
select private.record_source_terms('ttusd-district', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-ths', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-nths', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-acms', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-nts', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-te', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-tle', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-kbe', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');
select private.record_source_terms('ttusd-dte', 'permitted', array['html']::text[], 'https://www.ttusd.org/robots.txt', '78f502f622f1a09c075230aa0074d6137c0b81a72b3b9ca3c171d24e6fc4f6ac', 'conductor', '2026-10-18', '2027-10-17', 'Terms review 2026-10-18: permitted (public calendar pages; robots allows them; ICS path /fs/ disallowed and not used).');

-- Seven sources go live on trust 'auto' (the grammar is the safeguard). Glenshire is skipped (empty); kbe (0 public items) and dte
-- (its page mixes in the district calendar) stay off.
update public.sources set enabled = true, trust = 'auto'
 where slug in ('ttusd-district', 'ttusd-ths', 'ttusd-nths', 'ttusd-acms', 'ttusd-nts', 'ttusd-te', 'ttusd-tle');

-- ---------------------------------------------------------------------------------------------------------------------
-- ttusd_twin: a pure lookup (r4). Same school venue, same normalized title, same local date, and the same exact start instant (timed);
-- an all-day copy joins the timed listing of its day (one listing per event per day or per distinct start). Equality is transitive and every TTUSD item joins only through it, so all copies with one key share
-- one event whatever the arrival order. No grant: only cluster_and_publish calls it.
-- ---------------------------------------------------------------------------------------------------------------------
create function private.ttusd_twin(p_se public.source_events) returns uuid
language sql stable set search_path = '' as $$
  select e.id
    from public.source_events y
    join public.sources ys on ys.id = y.source_id
    join public.events e on e.id = y.cluster_id
   where ys.slug like 'ttusd-%'
     and y.id <> p_se.id
     and y.source_status <> 'gone'
     and e.merged_into is null
     and y.venue_id = p_se.venue_id
     and y.normalized_title = p_se.normalized_title
     and y.start_day = p_se.start_day
     and (   (not y.all_day and not p_se.all_day and y.starts_at = p_se.starts_at)   -- same title, date and start
          or (y.all_day and p_se.all_day)                                            -- two all-day copies of one date
          or (p_se.all_day and not y.all_day)                                        -- r4: an all-day copy joins a timed listing
          or (not p_se.all_day and y.all_day                                         -- r4: a timed item joins an all-day-only listing
              and not exists (select 1 from public.source_events z where z.cluster_id = e.id and z.source_status <> 'gone'
                                 and not z.all_day and z.id <> p_se.id)))
   order by (y.all_day = p_se.all_day and not p_se.all_day) desc, e.id
   limit 1
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- cluster_and_publish: verbatim from 20261020000200_ingest_rpcs.sql:952 except the marked A12 block in the `se.cluster_id is null` branch.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.cluster_and_publish(p_limit int) returns jsonb
language plpgsql set search_path = '' as $$
declare
  se public.source_events; src public.sources; best record; v_new uuid; v_area text; v_lat double precision; v_lng double precision;
  v_twin uuid; v_changed boolean := false; v_processed int := 0; v_remaining int; v_region uuid := private.region_id();
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
      -- A12 begin: a TTUSD item joins only an exact-key twin (private.ttusd_twin); it never uses similarity or the 30-minute window.
      if src.slug like 'ttusd-%' then
        v_twin := private.ttusd_twin(se);
        if v_twin is not null then
          update public.source_events set cluster_id = v_twin where id = se.id;
          se.cluster_id := v_twin;
        else
            insert into public.events (region_id, title, summary, starts_at, ends_at, all_day, start_date, end_date, time_known, venue_id,
                area, price_kind, price_min, price_max, age, organizer_url, ticket_url, series_id, status, origin)
              values (v_region, se.title, 'Details on the organizer''s site.', se.starts_at, se.ends_at, se.all_day, se.start_date,
                      se.end_date, se.time_known, se.venue_id, v_area, se.price_kind, se.price_min, se.price_max, se.age, se.url,
                      se.ticket_url, se.series_id, 'pending', 'ingest')
              returning id into v_new;
            update public.source_events set cluster_id = v_new where id = se.id;
            se.cluster_id := v_new;
        end if;
      else
      -- A12 end
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
      end if;   -- A12
    end if;
    v_changed := private.recompute_event(se.cluster_id) or v_changed;
    update public.source_events set needs_cluster = false where id = se.id;
  end loop;
  select count(*) into v_remaining from public.source_events x where x.needs_cluster;
  return jsonb_build_object('processed', v_processed, 'remaining', v_remaining, 'public_changed', v_changed);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- recompute_event: verbatim from 20261020000200_ingest_rpcs.sql:760 except the marked A12 branch right after `rule:publish`.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.recompute_event(p_event_id uuid) returns boolean
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
  v_locked text[]; v_sib uuid;
begin
  select * into e from public.events x where x.id = p_event_id for update;
  if not found then return false; end if;
  v_sig_before := private.event_public_sig(e);
  v_locked := e.locked_fields;

  select array_agg(se order by
           -- A12: only inside a cluster that also holds a timed TTUSD item does a TTUSD all-day copy yield to it; everywhere else source priority rules
           (s.slug like 'ttusd-%' and se.all_day and exists (select 1 from public.source_events t join public.sources ts on ts.id = t.source_id
                                                             where t.cluster_id = se.cluster_id and t.source_status <> 'gone' and not t.all_day and ts.slug like 'ttusd-%')),
           s.priority desc, se.first_seen_at, se.id) into c
    from public.source_events se join public.sources s on s.id = se.source_id
   where se.cluster_id = e.id and se.source_status <> 'gone';
  v_n := coalesce(cardinality(c), 0);

  -- A12 begin (r4): a cluster left holding only TTUSD all-day copies (its timed contributor went away) must not list them next to a
  -- timed listing of the same event and day. Hand them to that listing; this cluster then has no live contributor and is unlisted.
  if v_n > 0 and not exists (select 1 from unnest(c) x join public.sources s on s.id = x.source_id where not (s.slug like 'ttusd-%' and x.all_day)) then
    select e2.id into v_sib
      from public.events e2
      join public.source_events y on y.cluster_id = e2.id
      join public.sources ys on ys.id = y.source_id
     where e2.id <> e.id and e2.merged_into is null and ys.slug like 'ttusd-%' and y.source_status <> 'gone' and not y.all_day
       and exists (select 1 from unnest(c) x where x.venue_id = y.venue_id and x.normalized_title = y.normalized_title and x.start_day = y.start_day)
     order by e2.id limit 1;
    if v_sib is not null then
      update public.source_events set cluster_id = v_sib, needs_cluster = true where id in (select x.id from unnest(c) x);
      return private.recompute_event(e.id);
    end if;
  end if;
  -- A12 end

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
  -- A12 begin: TTUSD all-day items (notices, all-day school events) publish without a time
  elsif e.all_day and v_n > 0
        and not exists (select 1 from unnest(c) x join public.sources s on s.id = x.source_id
                         where not (s.slug like 'ttusd-%' and s.trust = 'auto'))
        and exists (select 1 from public.venues v where v.id = e.venue_id and v.lat is not null and private.in_drive_box(e.region_id, v.lat, v.lng))
        and not (private.confidence_flags(e) && array['all_caps','url_title','long_unseries']) then
    v_status := 'published'; v_reason := null; v_rule := 'rule:publish'; v_close_decision := 'auto_published';
  -- A12 end
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

-- Self-check (true on a fresh reset and on the hosted DB): the enabled set is the four existing sources plus the seven.
do $$ begin
  if (select count(*) from public.sources where enabled) <> 11
     or (select count(*) from public.sources
          where slug like 'ttusd-%' and enabled and trust = 'auto' and cadence = '24h' and family = 'html_finalsite'
            and ingest_disposition = 'permitted' and allowed_methods = array['html']::text[] and terms_recheck_at > now()
            and config ->> 'allowlist' = 'ttusd') <> 7
     or exists (select 1 from public.sources where slug in ('ttusd-kbe', 'ttusd-dte') and enabled)
     or (select count(*) from public.categories) <> 14 then
    raise exception 'ttusd_state';
  end if;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist (unchanged: ttusd_twin is private and ungranted).
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
