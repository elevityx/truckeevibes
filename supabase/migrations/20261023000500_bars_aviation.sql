-- A14: 21+ venues and aviation (spec Amendment 14 r2).
-- 1. the `wprest_crystalbay` and `curated_dates` families; 2. three sources (Crystal Bay Casino, Moody's Bistro, the EAA breakfast);
-- 3. their terms evidence through the gate; 4. trust 'auto'; 5. the link-only venue manifest (listed on /sources, never read).
-- No SQL function changes: Crystal Bay is class 'venue' and wins the primary over a Visit Lake Tahoe copy through the existing cluster rule.

alter table public.sources drop constraint sources_family_check;
alter table public.sources add constraint sources_family_check check (family in ('tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager',
                                         'rss','squarespace','jsonld','html','llm','html_finalsite','html_tahoedonner','wprest_crystalbay','curated_dates'));

insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, cadence, page_cap, config) values
  ('crystal-bay-casino', 'Crystal Bay Casino', 'https://www.crystalbaycasino.com/entertainment/events/', array['www.crystalbaycasino.com'], 'wprest_crystalbay',
   'venue'::public.source_class, '24h', 3,
   '{"apiUrl":"https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100","tz":"America/Los_Angeles","defaultCategories":["nightlife"]}'::jsonb),
  ('moodys-bistro', 'Moody''s Bistro Bar & Beats', 'https://www.moodysbistro.com/events/', array['www.moodysbistro.com'], 'tribe',
   'venue'::public.source_class, '24h', 10,
   '{"base":"https://www.moodysbistro.com","tz":"America/Los_Angeles","defaultCategories":["music"]}'::jsonb),
  ('eaa-1073-breakfast', 'EAA Chapter 1073 Pancake Breakfast', 'https://www.tahoe.com/business/eea-truckee/events', array['tahoe.com'], 'curated_dates',
   'community'::public.source_class, '24h', 1,
   '{"tz":"America/Los_Angeles","provenance":"listed on tahoe.com, checked 2026-10-19","title":"EAA Chapter 1073 Pancake Breakfast","venueName":"Truckee Tahoe Airport","address":"10356 Truckee Airport Rd, Truckee, CA 96161","town":"Truckee","lat":39.3180851,"lng":-120.1381025,"url":"https://www.tahoe.com/business/eea-truckee/events","priceText":"$5–$7","categories":["family","kids","outdoors","learning"],"dates":[{"date":"2026-11-14","start":"08:00","end":"10:00"},{"date":"2026-12-12","start":"08:00"},{"date":"2027-01-09","start":"08:00"}]}'::jsonb);

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

update public.sources set enabled = true, trust = 'auto' where slug in ('crystal-bay-casino', 'moodys-bistro', 'eaa-1073-breakfast');

-- Link-only manifest: pointed to on /sources, never read, never enabled (like 20261015000300). UNVERIFIED at write time: each URL still needs the
-- one-GET-with-robots check (spec step 5) before merge; a failing row is removed from this list and from pgTAP 31 and 04.
insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust) values
  ('bar-of-america',       'Bar of America',         'https://www.barofamerica.com/music.html',               array['www.barofamerica.com'],       'html', 'venue', 'link_only'),
  ('rmu-truckee',          'RMU Truckee',            'https://rmumtnculture.com/pages/rmu-truckee',           array['rmumtnculture.com'],          'html', 'venue', 'link_only'),
  ('tourist-club',         'Tourist Club',           'https://chamber.truckee.com/list/member/tourist-club-3936', array['chamber.truckee.com'],     'html', 'venue', 'link_only'),
  ('cottonwood-truckee',   'Cottonwood Restaurant',  'https://www.cottonwoodrestaurant.com/music',            array['www.cottonwoodrestaurant.com'], 'html', 'venue', 'link_only'),
  ('fiftyfifty-brewing',   'FiftyFifty Brewing',     'https://fiftyfiftybrewing.com/pages/events',            array['fiftyfiftybrewing.com'],      'html', 'venue', 'link_only'),
  ('glasses-wine-bar',     'Glasses Wine Bar',       'https://www.glasseswinebar.com/events',                 array['www.glasseswinebar.com'],     'html', 'venue', 'link_only'),
  ('the-grid-kings-beach', 'The Grid Bar & Grill',   'https://www.thegridbarandgrill.com/',                   array['www.thegridbarandgrill.com'], 'html', 'venue', 'link_only'),
  ('gar-woods',            'Gar Woods Grill & Pier', 'https://www.garwoods.com/calendar.html',                array['www.garwoods.com'],           'html', 'venue', 'link_only');

-- Self-check (scoped to this migration's own rows; no global totals, which are asserted only in fresh-DB tests, A13 r7-6 / AC-M1-148).
do $$ begin
  if (select count(*) from public.sources
          where slug in ('crystal-bay-casino', 'moodys-bistro', 'eaa-1073-breakfast') and enabled and trust = 'auto' and cadence = '24h'
            and ingest_disposition = 'permitted' and terms_recheck_at > now()) <> 3
     or (select count(*) from public.sources where trust = 'link_only' and not enabled and ingest_disposition = 'unknown' and family = 'html' and class = 'venue'
          and slug in ('bar-of-america','rmu-truckee','tourist-club','cottonwood-truckee','fiftyfifty-brewing','glasses-wine-bar','the-grid-kings-beach','gar-woods')) <> 8 then
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
