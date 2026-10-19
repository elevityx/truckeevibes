-- A14: 21+ venues and aviation (spec Amendment 14 r2).
-- 1. the `wprest_crystalbay` and `curated_dates` families; 2. three sources (Crystal Bay Casino, Moody's Bistro, the EAA breakfast);
-- 3. their terms evidence through the gate; 4. trust 'review' for Crystal Bay ('auto' only from a separate follow-up migration after the conductor's post-deploy gate, A14 r3-2); 'auto' for Moody's and the EAA breakfast; 5. the link-only venue manifest (listed on /sources, never read).
-- No SQL function changes: Crystal Bay is class 'venue' and wins the primary over a Visit Lake Tahoe copy through the existing cluster rule.

-- Family CHECK, widen only (A14 r3-7): keep every family the live constraint already allows and add ours.
do $$
declare
  want text[] := array['tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager','rss','squarespace','jsonld','html','llm',
                       'html_finalsite','html_tahoedonner','wprest_crystalbay','curated_dates'];
  def  text;
  cur  text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.sources'::regclass and c.conname = 'sources_family_check';
  cur := coalesce((select array_agg(m[1]) from regexp_matches(coalesce(def, ''), '''([a-z][a-z0-9_]*)''', 'g') m), '{}');
  if def is not null and cardinality(cur) = 0 then raise exception 'family_check_unparsed'; end if;
  if def is not null and want <@ cur then return; end if;               -- nothing missing: leave the constraint untouched
  alter table public.sources drop constraint if exists sources_family_check;
  execute format('alter table public.sources add constraint sources_family_check check (family in (%s))',
                 (select string_agg(quote_literal(f), ',' order by f) from (select unnest(cur) union select unnest(want)) u(f)));
end $$;

insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, cadence, page_cap, config) values
  ('crystal-bay-casino', 'Crystal Bay Casino', 'https://www.crystalbaycasino.com/entertainment/events/', array['www.crystalbaycasino.com'], 'wprest_crystalbay',
   'venue'::public.source_class, '24h', 3,
   '{"apiUrl":"https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100","tz":"America/Los_Angeles","defaultCategories":["nightlife"]}'::jsonb),
  ('moodys-bistro', 'Moody''s Bistro Bar & Beats', 'https://www.moodysbistro.com/events/', array['www.moodysbistro.com'], 'tribe',
   'venue'::public.source_class, '24h', 10,
   '{"base":"https://www.moodysbistro.com","tz":"America/Los_Angeles","defaultCategories":["music"]}'::jsonb),
  ('eaa-1073-breakfast', 'EAA Chapter 1073 Pancake Breakfast', 'https://www.tahoe.com/business/eea-truckee/events', array['tahoe.com'], 'curated_dates',
   'community'::public.source_class, '24h', 1,
   '{"tz":"America/Los_Angeles","provenance":"listed on tahoe.com, checked 2026-10-19","title":"EAA Chapter 1073 Pancake Breakfast","venueName":"Truckee Tahoe Airport","address":"10356 Truckee Airport Rd, Truckee, CA 96161","town":"Truckee","lat":39.3180851,"lng":-120.1381025,"url":"https://www.tahoe.com/business/eea-truckee/events","priceText":"$5–$7","categories":["family","kids","outdoors","learning"],"dates":[{"date":"2026-11-14","start":"08:00","end":"10:00"},{"date":"2026-12-12","start":"08:00"},{"date":"2027-01-09","start":"08:00"}]}'::jsonb)
  on conflict (slug) do nothing;

-- Terms evidence through the gate (sets allowed_methods). The notes are public-safe and at most 200 characters (sources.terms_note CHECK); the full reasoning lives in the spec.
select private.record_source_terms('crystal-bay-casino', 'permitted', array['api']::text[], 'https://www.crystalbaycasino.com/terms-conditions/',
  '8ed6935355e9abc25e1b4a6876bc89051ca97274c877964c3f1e10c6bbe68b28', 'conductor', '2026-10-19', '2027-10-18',
  'Terms review 2026-10-19: facts-only judgment, not affirmative permission. Title, date, time, room, age from the event''s own text plus a link; no description or images; Tixr never fetched.');
update public.sources set robots_checked_at = '2026-10-19', robots_hash = '10160cb7c27e8ca5c7093db5b863178da9dd3c46fd400c7b3922f64cb67dc985', ai_bots_blocked = false where slug = 'crystal-bay-casino';
select private.record_source_terms('moodys-bistro', 'permitted', array['api']::text[], 'https://www.moodysbistro.com/robots.txt',
  '457d839d8900bd11d6f58b9267d12251f7e28a60d0332db5617e2e52af6f84ec', 'conductor', '2026-10-19', '2027-10-18',
  'No terms page; robots allows /wp-json/; facts + link.');
-- The EAA grant is dated to its own last listed date: recheck = the day after, so the grants stop by themselves. The hash is of our config, not of reviewed terms text; the runner never fetches this source.
select private.record_source_terms('eaa-1073-breakfast', 'permitted', array['feed']::text[], 'https://www.tahoe.com/business/eea-truckee/events',
  (select encode(sha256(convert_to(config::text, 'UTF8')), 'hex') from public.sources where slug = 'eaa-1073-breakfast'), 'conductor', '2026-10-19', '2027-01-10',
  'Dates listed on tahoe.com, checked 2026-10-19; hash is of our config, not of reviewed terms text; never fetched by the runner.');

update public.sources set enabled = true, trust = 'review' where slug = 'crystal-bay-casino';
update public.sources set enabled = true, trust = 'auto' where slug in ('moodys-bistro', 'eaa-1073-breakfast');

-- Link-only manifest: pointed to on /sources, never read, never enabled (like 20261015000300). Verified 2026-10-19 (Research_A14_Gate_Evidence step 5:
-- one GET each after robots, >= 6 s per host): 8 of 8 pass; FiftyFifty uses its final www host.
insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust) values
  ('bar-of-america',       'Bar of America',         'https://www.barofamerica.com/music.html',               array['www.barofamerica.com'],       'html', 'venue', 'link_only'),
  ('rmu-truckee',          'RMU Truckee',            'https://rmumtnculture.com/pages/rmu-truckee',           array['rmumtnculture.com'],          'html', 'venue', 'link_only'),
  ('tourist-club',         'Tourist Club',           'https://chamber.truckee.com/list/member/tourist-club-3936', array['chamber.truckee.com'],     'html', 'venue', 'link_only'),
  ('cottonwood-truckee',   'Cottonwood Restaurant',  'https://www.cottonwoodrestaurant.com/music',            array['www.cottonwoodrestaurant.com'], 'html', 'venue', 'link_only'),
  ('fiftyfifty-brewing',   'FiftyFifty Brewing',     'https://www.fiftyfiftybrewing.com/pages/events',        array['www.fiftyfiftybrewing.com'], 'html', 'venue', 'link_only'),
  ('glasses-wine-bar',     'Glasses Wine Bar',       'https://www.glasseswinebar.com/events',                 array['www.glasseswinebar.com'],     'html', 'venue', 'link_only'),
  ('the-grid-kings-beach', 'The Grid Bar & Grill',   'https://www.thegridbarandgrill.com/',                   array['www.thegridbarandgrill.com'], 'html', 'venue', 'link_only'),
  ('gar-woods',            'Gar Woods Grill & Pier', 'https://www.garwoods.com/calendar.html',                array['www.garwoods.com'],           'html', 'venue', 'link_only')
  on conflict (slug) do nothing;

-- Self-check (scoped to this migration's own rows; A13 r7-6). A row that existed before and differs in any attribute fails here.
do $$ begin
  if (select count(*) from public.sources s join (values
        ('crystal-bay-casino', 'Crystal Bay Casino', 'https://www.crystalbaycasino.com/entertainment/events/', array['www.crystalbaycasino.com'],
         'wprest_crystalbay', 'venue', 3, 'review', array['api'], date '2027-10-18',
         '{"apiUrl":"https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100","tz":"America/Los_Angeles","defaultCategories":["nightlife"]}'::jsonb),
        ('moodys-bistro', 'Moody''s Bistro Bar & Beats', 'https://www.moodysbistro.com/events/', array['www.moodysbistro.com'],
         'tribe', 'venue', 10, 'auto', array['api'], date '2027-10-18',
         '{"base":"https://www.moodysbistro.com","tz":"America/Los_Angeles","defaultCategories":["music"]}'::jsonb),
        ('eaa-1073-breakfast', 'EAA Chapter 1073 Pancake Breakfast', 'https://www.tahoe.com/business/eea-truckee/events', array['tahoe.com'],
         'curated_dates', 'community', 1, 'auto', array['feed'], date '2027-01-10',
         '{"tz":"America/Los_Angeles","provenance":"listed on tahoe.com, checked 2026-10-19","title":"EAA Chapter 1073 Pancake Breakfast","venueName":"Truckee Tahoe Airport","address":"10356 Truckee Airport Rd, Truckee, CA 96161","town":"Truckee","lat":39.3180851,"lng":-120.1381025,"url":"https://www.tahoe.com/business/eea-truckee/events","priceText":"$5–$7","categories":["family","kids","outdoors","learning"],"dates":[{"date":"2026-11-14","start":"08:00","end":"10:00"},{"date":"2026-12-12","start":"08:00"},{"date":"2027-01-09","start":"08:00"}]}'::jsonb)
      ) e(slug, name, url, hosts, family, class, page_cap, trust, methods, recheck, config)
      on s.slug = e.slug and s.name = e.name and s.homepage_url = e.url and s.allowed_hosts = e.hosts and s.family = e.family
         and s.class::text = e.class and s.page_cap = e.page_cap and s.trust::text = e.trust and s.allowed_methods = e.methods
         and (s.terms_recheck_at at time zone 'UTC')::date = e.recheck and s.config = e.config
         and s.enabled and not s.strict_auto and s.cadence = '24h' and s.ingest_disposition = 'permitted') <> 3
     or (select count(*) from public.sources s join (values
             ('bar-of-america', 'Bar of America', 'https://www.barofamerica.com/music.html', array['www.barofamerica.com']),
             ('rmu-truckee', 'RMU Truckee', 'https://rmumtnculture.com/pages/rmu-truckee', array['rmumtnculture.com']),
             ('tourist-club', 'Tourist Club', 'https://chamber.truckee.com/list/member/tourist-club-3936', array['chamber.truckee.com']),
             ('cottonwood-truckee', 'Cottonwood Restaurant', 'https://www.cottonwoodrestaurant.com/music', array['www.cottonwoodrestaurant.com']),
             ('fiftyfifty-brewing', 'FiftyFifty Brewing', 'https://www.fiftyfiftybrewing.com/pages/events', array['www.fiftyfiftybrewing.com']),
             ('glasses-wine-bar', 'Glasses Wine Bar', 'https://www.glasseswinebar.com/events', array['www.glasseswinebar.com']),
             ('the-grid-kings-beach', 'The Grid Bar & Grill', 'https://www.thegridbarandgrill.com/', array['www.thegridbarandgrill.com']),
             ('gar-woods', 'Gar Woods Grill & Pier', 'https://www.garwoods.com/calendar.html', array['www.garwoods.com'])
           ) m(slug, name, url, hosts)
      on s.slug = m.slug and s.name = m.name and s.homepage_url = m.url and s.allowed_hosts = m.hosts and s.family = 'html' and s.class = 'venue'
         and s.trust = 'link_only' and not s.enabled and s.ingest_disposition = 'unknown' and s.allowed_methods = '{}') <> 8 then
    raise exception 'bars_aviation_state';
  end if;
  begin
    insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('a14-bogus', 'Bogus', 'https://example.test/', array['example.test'], 'html_bogus', 'venue');
    raise exception 'bars_aviation_state';
  exception when check_violation then null;
  end;
end $$;

-- Grants: deny everything, then the exact cumulative allowlist (unchanged: no function is added or redefined).
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
