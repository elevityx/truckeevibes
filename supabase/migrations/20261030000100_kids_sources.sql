-- Kids live K1 (Spec_Kids_Live): three public library LibCal feeds and TDRPD off.
-- 1. the `rss_libcal` family (widen-only CHECK); 2. three sources (Truckee, Kings Beach, Tahoe City libraries), trust 'auto' (DR-K4: the
-- offline real-feed replay gate AC-K-12 passed before merge); 3. their terms evidence through the gate; 4. `tdrpd` disabled (DR-K5: its
-- robots.txt now disallows /common/modules/icalendar/ and its calendars are empty).
-- Data only: no function is created or replaced, so this migration intentionally has no revoke/grant block (the allowlist is unchanged
-- and pgTAP 01 still asserts it).

-- Family CHECK, widen only (A14 r3-7 pattern): keep every family the live constraint already allows and add ours.
do $$
declare
  want text[] := array['tribe','ics','ics_chambermaster','ics_civicplus','ics_eventsmanager','rss','squarespace','jsonld','html','llm',
                       'html_finalsite','html_tahoedonner','wprest_crystalbay','curated_dates','rss_libcal'];
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
  ('libcal-truckee', 'Truckee Library (Nevada County Library)', 'https://nevadacountyca.libcal.com/calendar?cid=20247&t=d&cam%5B%5D=8465',
   array['nevadacountyca.libcal.com'], 'rss_libcal', 'municipal'::public.source_class, '24h', 1,
   '{"feedUrl":"https://nevadacountyca.libcal.com/rss.php?cid=20247&m=month&cam=8465","campus":"Truckee Library","tz":"America/Los_Angeles","venueName":"Truckee Library","address":"10031 Levon Ave, Truckee, CA 96161","town":"Truckee","lat":39.325158,"lng":-120.200003}'::jsonb),
  ('libcal-kings-beach', 'Kings Beach Library (Placer County Library)', 'https://placer.libcal.com/calendar?cid=22618',
   array['placer.libcal.com'], 'rss_libcal', 'municipal'::public.source_class, '24h', 1,
   '{"feedUrl":"https://placer.libcal.com/rss.php?cid=22618&m=month","campus":"Kings Beach Library","tz":"America/Los_Angeles","venueName":"Kings Beach Library","address":"301 Secline St, Kings Beach, CA 96143","town":"Kings Beach","lat":39.238603,"lng":-120.029914}'::jsonb),
  ('libcal-tahoe-city', 'Tahoe City Library (Placer County Library)', 'https://placer.libcal.com/calendar?cid=22619',
   array['placer.libcal.com'], 'rss_libcal', 'municipal'::public.source_class, '24h', 1,
   '{"feedUrl":"https://placer.libcal.com/rss.php?cid=22619&m=month","campus":"Tahoe City Library","tz":"America/Los_Angeles","venueName":"Tahoe City Library","address":"740 N Lake Blvd, Tahoe City, CA 96145","town":"Tahoe City","lat":39.17294,"lng":-120.138616}'::jsonb)
  on conflict (slug) do nothing;

-- Terms evidence through the gate (sets ingest_disposition and allowed_methods). LibCal has no terms page; the RSS is the libraries'
-- published subscribe feed, and robots.txt allows rss.php for `*` (crawl-delay 10; GPTBot and others are blocked by name, not us).
select private.record_source_terms('libcal-truckee', 'permitted', array['feed']::text[], 'https://nevadacountyca.libcal.com/robots.txt',
  'e813ed08b8802d4cb88ce37d32d055d8d493f673c1fb60afe7871ec2b12dbfbf', 'conductor', '2026-10-30', '2027-10-30',
  'No terms page on LibCal; public RSS subscribe feed; robots allows rss.php (crawl-delay 10). Facts + link only: no description or images.');
select private.record_source_terms('libcal-kings-beach', 'permitted', array['feed']::text[], 'https://placer.libcal.com/robots.txt',
  '2e4a4e0a108e2c9853ddd55b4b7090b4c30b260ecc899106b2a86541f63771ec', 'conductor', '2026-10-30', '2027-10-30',
  'No terms page on LibCal; public RSS subscribe feed; robots allows rss.php (crawl-delay 10). Facts + link only: no description or images.');
select private.record_source_terms('libcal-tahoe-city', 'permitted', array['feed']::text[], 'https://placer.libcal.com/robots.txt',
  '2e4a4e0a108e2c9853ddd55b4b7090b4c30b260ecc899106b2a86541f63771ec', 'conductor', '2026-10-30', '2027-10-30',
  'No terms page on LibCal; public RSS subscribe feed; robots allows rss.php (crawl-delay 10). Facts + link only: no description or images.');
update public.sources set robots_checked_at = '2026-10-30', robots_hash = 'e813ed08b8802d4cb88ce37d32d055d8d493f673c1fb60afe7871ec2b12dbfbf', ai_bots_blocked = true
 where slug = 'libcal-truckee';
update public.sources set robots_checked_at = '2026-10-30', robots_hash = '2e4a4e0a108e2c9853ddd55b4b7090b4c30b260ecc899106b2a86541f63771ec', ai_bots_blocked = true
 where slug in ('libcal-kings-beach', 'libcal-tahoe-city');

update public.sources set enabled = true, trust = 'auto' where slug in ('libcal-truckee', 'libcal-kings-beach', 'libcal-tahoe-city');

-- TDRPD (DR-K5): robots.txt changed 2026-10-20 to disallow /common/modules/icalendar/ for `*`, and all seven calendars are empty. Disabled;
-- the row and its terms record stay, trust is unchanged.
update public.sources set enabled = false, robots_checked_at = '2026-10-30',
       robots_hash = 'e4a649eaffd96bdf90c5355da98e1cb3aaab71860e2b66c332ef53a8071bc825', ai_bots_blocked = false
 where slug = 'tdrpd';

-- Self-check (scoped to this migration's own rows). A row that existed before and differs in any attribute fails here.
do $$ begin
  if (select count(*) from public.sources s join (values
        ('libcal-truckee', 'Truckee Library (Nevada County Library)', 'https://nevadacountyca.libcal.com/calendar?cid=20247&t=d&cam%5B%5D=8465',
         array['nevadacountyca.libcal.com'], 'e813ed08b8802d4cb88ce37d32d055d8d493f673c1fb60afe7871ec2b12dbfbf',
         '{"feedUrl":"https://nevadacountyca.libcal.com/rss.php?cid=20247&m=month&cam=8465","campus":"Truckee Library","tz":"America/Los_Angeles","venueName":"Truckee Library","address":"10031 Levon Ave, Truckee, CA 96161","town":"Truckee","lat":39.325158,"lng":-120.200003}'::jsonb),
        ('libcal-kings-beach', 'Kings Beach Library (Placer County Library)', 'https://placer.libcal.com/calendar?cid=22618',
         array['placer.libcal.com'], '2e4a4e0a108e2c9853ddd55b4b7090b4c30b260ecc899106b2a86541f63771ec',
         '{"feedUrl":"https://placer.libcal.com/rss.php?cid=22618&m=month","campus":"Kings Beach Library","tz":"America/Los_Angeles","venueName":"Kings Beach Library","address":"301 Secline St, Kings Beach, CA 96143","town":"Kings Beach","lat":39.238603,"lng":-120.029914}'::jsonb),
        ('libcal-tahoe-city', 'Tahoe City Library (Placer County Library)', 'https://placer.libcal.com/calendar?cid=22619',
         array['placer.libcal.com'], '2e4a4e0a108e2c9853ddd55b4b7090b4c30b260ecc899106b2a86541f63771ec',
         '{"feedUrl":"https://placer.libcal.com/rss.php?cid=22619&m=month","campus":"Tahoe City Library","tz":"America/Los_Angeles","venueName":"Tahoe City Library","address":"740 N Lake Blvd, Tahoe City, CA 96145","town":"Tahoe City","lat":39.17294,"lng":-120.138616}'::jsonb)
      ) e(slug, name, url, hosts, robots, config)
      on s.slug = e.slug and s.name = e.name and s.homepage_url = e.url and s.allowed_hosts = e.hosts and s.family = 'rss_libcal'
         and s.class = 'municipal' and s.page_cap = 1 and s.cadence = '24h' and s.trust = 'auto' and s.enabled and not s.strict_auto
         and s.ingest_disposition = 'permitted' and s.allowed_methods = array['feed']::text[]
         and (s.terms_recheck_at at time zone 'UTC')::date = date '2027-10-30' and s.robots_hash = e.robots and s.ai_bots_blocked
         and s.config = e.config) <> 3
     or exists (select 1 from public.sources where slug = 'tdrpd' and enabled) then
    raise exception 'kids_sources_state';
  end if;
  begin
    insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('k1-bogus', 'Bogus', 'https://example.test/', array['example.test'], 'rss_bogus', 'municipal');
    raise exception 'kids_sources_state';
  exception when check_violation then null;
  end;
end $$;
