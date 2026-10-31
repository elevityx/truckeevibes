-- Manual sources M1 (Spec_Manual_Sources DR-M6): five sources that block bots or need permission, read only when the owner says
-- "read manual" (`scripts/manual-read.sh`), never on the schedule. Data only: no function is created or replaced, so the EXECUTE
-- allowlist is unchanged and there is no grant block (like 20261030000100_kids_sources.sql).
-- 1. family CHECK widened with `elfsight` (widen only, A14 r3-7 pattern); 2. bar-of-america, fiftyfifty-brewing, diamond-peak, ivgid
-- set up as manual_only + automation_restricted, trust review, enabled, with hosts, methods, config and the owner's terms record;
-- 3. tahoe-national-brewing inserted the same way; 4. tdrpd-rec1 page_cap 80 (K3.1 r2-9); 5. self-check.
-- Setup runs only while a row is not yet manual-only (review P2-7): a re-apply never re-enables a kill-switched source, never resets
-- trust after the first-run check, and never overwrites newer terms evidence.
-- Venue coordinates: US Census geocoder (2026-10-31) for the street addresses, Squarespace's own map pin for Tahoe National, and the
-- existing `venues` row for Alibi Incline. The terms hash of the three venue pages is the sha256 of our own config (as for the EAA
-- breakfast): the owner's decision is the evidence, not a reviewed terms text. Diamond Peak and IVGID keep their reviewed terms hash.

do $$
declare
  want text[] := array['tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager','rss','squarespace','jsonld','html','llm',
                       'html_finalsite','html_tahoedonner','wprest_crystalbay','curated_dates','rss_libcal','rec1_catalog','elfsight'];
  def  text;
  cur  text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.sources'::regclass and c.conname = 'sources_family_check';
  cur := coalesce((select array_agg(m[1]) from regexp_matches(coalesce(def, ''), '''([a-z][a-z0-9_]*)''', 'g') m), '{}');
  if def is not null and cardinality(cur) = 0 then raise exception 'family_check_unparsed'; end if;
  if def is not null and want <@ cur then return; end if;
  alter table public.sources drop constraint if exists sources_family_check;
  execute format('alter table public.sources add constraint sources_family_check check (family in (%s))',
                 (select string_agg(quote_literal(f), ',' order by f) from (select unnest(cur) union select unnest(want)) u(f)));
end $$;

-- Bar of America: the music page embeds a public Google Calendar; each show is an all-day row titled "9pm <band>".
do $$ begin
  if exists (select 1 from public.sources where slug = 'bar-of-america' and manual_only) then return; end if;
  update public.sources set family = 'ics', page_cap = 1, cadence = '24h', trust = 'review',
         allowed_hosts = array['www.barofamerica.com', 'calendar.google.com'],
         config = '{"mapper":"manual_gcal","feedUrl":"https://calendar.google.com/calendar/ical/pvq7se1vhdtap3i4bsa990jbas%40group.calendar.google.com/public/basic.ics","link":"https://www.barofamerica.com/music.html","tz":"America/Los_Angeles","town":"Truckee","hints":["music"],"venue":{"name":"Bar of America","address":"10040 Donner Pass Rd, Truckee, CA 96161","lat":39.327989,"lng":-120.184929}}'::jsonb
   where slug = 'bar-of-america';
  if not found then raise exception 'manual_sources_state'; end if;
  perform private.record_source_terms('bar-of-america', 'permitted', array['feed']::text[], 'https://www.barofamerica.com/music.html',
    (select encode(sha256(convert_to(config::text, 'UTF8')), 'hex') from public.sources where slug = 'bar-of-america'), 'owner', '2026-10-31', '2027-10-31',
    'Manual read only (owner 2026-10-30); calendar.google.com robots.txt disallows crawlers; facts + link only; hash is of our config; no venue OK');
  update public.sources set manual_only = true, automation_restricted = true where slug = 'bar-of-america';
  update public.sources set enabled = true where slug = 'bar-of-america';
end $$;

-- FiftyFifty Brewing: the events page is an Elfsight Event Calendar widget, read from its boot JSON.
do $$ begin
  if exists (select 1 from public.sources where slug = 'fiftyfifty-brewing' and manual_only) then return; end if;
  update public.sources set family = 'elfsight', page_cap = 1, cadence = '24h', trust = 'review',
         allowed_hosts = array['www.fiftyfiftybrewing.com', 'core.service.elfsight.com'],
         config = '{"mapper":"manual_elfsight","widget":"e11cc5c3-c71b-4300-b405-829867efe6c3","feedUrl":"https://core.service.elfsight.com/p/boot/?page=https%3A%2F%2Fwww.fiftyfiftybrewing.com%2Fpages%2Fevents&w=e11cc5c3-c71b-4300-b405-829867efe6c3","link":"https://www.fiftyfiftybrewing.com/pages/events","tz":"America/Los_Angeles","town":"Truckee","venue":{"name":"FiftyFifty Brewing Co.","address":"11197 Brockway Rd, Truckee, CA 96161","lat":39.322527,"lng":-120.165175}}'::jsonb
   where slug = 'fiftyfifty-brewing';
  if not found then raise exception 'manual_sources_state'; end if;
  perform private.record_source_terms('fiftyfifty-brewing', 'permitted', array['feed']::text[], 'https://www.fiftyfiftybrewing.com/pages/events',
    (select encode(sha256(convert_to(config::text, 'UTF8')), 'hex') from public.sources where slug = 'fiftyfifty-brewing'), 'owner', '2026-10-31', '2027-10-31',
    'Manual read only (owner 2026-10-30); events come from a third-party widget API, not a published feed; facts + link only; hash is of our config; no venue OK');
  update public.sources set manual_only = true, automation_restricted = true where slug = 'fiftyfifty-brewing';
  update public.sources set enabled = true where slug = 'fiftyfifty-brewing';
end $$;

-- Diamond Peak (IVGID's ski area): Tribe REST; terms review 2026-10-15 found permission required.
do $$ begin
  if exists (select 1 from public.sources where slug = 'diamond-peak' and manual_only) then return; end if;
  update public.sources set page_cap = 2, cadence = '24h', trust = 'review',
         config = '{"base":"https://www.diamondpeak.com","tz":"America/Los_Angeles","town":"Incline Village","venue":{"name":"Diamond Peak Ski Resort","address":"1210 Ski Way, Incline Village, NV 89451","lat":39.251679,"lng":-119.925873},"venues":[{"match":"diamond peak","name":"Diamond Peak Ski Resort","address":"1210 Ski Way, Incline Village, NV 89451","lat":39.251679,"lng":-119.925873},{"match":"alibi","name":"Alibi Ale Works - Incline Public House","address":"931 Tahoe Blvd, Incline Village, NV 89451","lat":39.249088,"lng":-119.9489837}]}'::jsonb
   where slug = 'diamond-peak' and family = 'tribe';
  if not found then raise exception 'manual_sources_state'; end if;
  perform private.record_source_terms('diamond-peak', 'permitted', array['api']::text[], 'https://www.diamondpeak.com/terms-of-use/',
    (select terms_hash from public.sources where slug = 'diamond-peak'), 'owner', '2026-10-31', '2027-10-31',
    'Manual read only (owner 2026-10-30); terms review 2026-10-15 found permission required for automated use; facts + link only; no venue OK');
  update public.sources set manual_only = true, automation_restricted = true where slug = 'diamond-peak';
  update public.sources set enabled = true where slug = 'diamond-peak';
end $$;

-- IVGID (Incline Village recreation): Tribe REST; terms review 2026-10-15 found permission required.
do $$ begin
  if exists (select 1 from public.sources where slug = 'ivgid' and manual_only) then return; end if;
  update public.sources set page_cap = 2, cadence = '24h', trust = 'review',
         config = '{"base":"https://www.yourtahoeplace.com","tz":"America/Los_Angeles","town":"Incline Village","venues":[{"match":"recreation center","name":"Incline Village Recreation Center","address":"980 Incline Way, Incline Village, NV 89451","lat":39.242816,"lng":-119.943141},{"match":"chateau","name":"The Chateau at Incline Village","address":"955 Fairway Blvd, Incline Village, NV 89451","lat":39.253723,"lng":-119.944251},{"match":"championship golf","name":"Incline Village Championship Golf Course","address":"955 Fairway Blvd, Incline Village, NV 89451","lat":39.253723,"lng":-119.944251}]}'::jsonb
   where slug = 'ivgid' and family = 'tribe';
  if not found then raise exception 'manual_sources_state'; end if;
  perform private.record_source_terms('ivgid', 'permitted', array['api']::text[], 'https://www.yourtahoeplace.com/terms-of-use/',
    (select terms_hash from public.sources where slug = 'ivgid'), 'owner', '2026-10-31', '2027-10-31',
    'Manual read only (owner 2026-10-30); terms review 2026-10-15 found permission required for automated use; facts + link only; no venue OK');
  update public.sources set manual_only = true, automation_restricted = true where slug = 'ivgid';
  update public.sources set enabled = true where slug = 'ivgid';
end $$;

-- Tahoe National Brewing (new): Squarespace events collection, read from its `?format=json` answer.
do $$ begin
  if exists (select 1 from public.sources where slug = 'tahoe-national-brewing') then return; end if;
  insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, cadence, page_cap, trust, config) values
    ('tahoe-national-brewing', 'Tahoe National Brewing', 'https://www.tahoenational.beer/events', array['www.tahoenational.beer'],
     'squarespace', 'venue'::public.source_class, '24h', 1, 'review',
     '{"mapper":"manual_squarespace","feedUrl":"https://www.tahoenational.beer/events?format=json","link":"https://www.tahoenational.beer/events","tz":"America/Los_Angeles","town":"Tahoe City","venue":{"name":"Tahoe National Brewing Co.","address":"850 North Lake Blvd, Tahoe City, CA 96145","lat":39.1739451,"lng":-120.1369173}}'::jsonb);
  perform private.record_source_terms('tahoe-national-brewing', 'permitted', array['feed']::text[], 'https://www.tahoenational.beer/events',
    (select encode(sha256(convert_to(config::text, 'UTF8')), 'hex') from public.sources where slug = 'tahoe-national-brewing'), 'owner', '2026-10-31', '2027-10-31',
    'Manual read only (owner 2026-10-30); the events JSON is the site builder''s page API, not a published feed; facts + link only; hash is of our config; no venue OK');
  update public.sources set manual_only = true, automation_restricted = true where slug = 'tahoe-national-brewing';
  update public.sources set enabled = true where slug = 'tahoe-national-brewing';
end $$;

-- K3.1 r2-9: the TDRPD read plan needs up to 80 requests.
update public.sources set page_cap = 80 where slug = 'tdrpd-rec1' and page_cap <> 80;

-- Self-check: identity, the manual-only flags and the owner's terms note (never enabled or trust, which operations may change).
do $$ begin
  if (select count(*) from public.sources s join (values
        ('bar-of-america', 'ics', array['www.barofamerica.com', 'calendar.google.com'], array['feed'], 1, 'manual_gcal'),
        ('fiftyfifty-brewing', 'elfsight', array['www.fiftyfiftybrewing.com', 'core.service.elfsight.com'], array['feed'], 1, 'manual_elfsight'),
        ('tahoe-national-brewing', 'squarespace', array['www.tahoenational.beer'], array['feed'], 1, 'manual_squarespace'),
        ('diamond-peak', 'tribe', array['www.diamondpeak.com', 'diamondpeak.com'], array['api'], 2, null),
        ('ivgid', 'tribe', array['www.yourtahoeplace.com', 'yourtahoeplace.com'], array['api'], 2, null)
      ) e(slug, family, hosts, methods, page_cap, mapper)
      on s.slug = e.slug and s.family = e.family and s.allowed_hosts = e.hosts and s.allowed_methods = e.methods and s.page_cap = e.page_cap
         and s.config ->> 'mapper' is not distinct from e.mapper and s.manual_only and s.automation_restricted and not s.strict_auto
         and s.ingest_disposition = 'permitted' and s.terms_reviewed_by = 'owner' and s.terms_note like 'Manual read only (owner 2026-10-30); %'
         and length(s.terms_note) <= 200) <> 5
     or exists (select 1 from public.sources where slug = 'glasses-wine-bar' and (manual_only or enabled or trust <> 'link_only'))
     or exists (select 1 from public.sources where slug = 'tdrpd-rec1' and page_cap <> 80)
     or exists (select 1 from public.sources where automation_restricted and not manual_only) then
    raise exception 'manual_sources_state';
  end if;
end $$;
