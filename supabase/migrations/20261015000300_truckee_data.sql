-- Data the hosted project needs. Every source starts disabled with an unknown disposition.
insert into public.regions (slug, name, tz, local_min_lat, local_max_lat, local_min_lng, local_max_lng,
                            drive_min_lat, drive_max_lat, drive_min_lng, drive_max_lng)
values ('truckee', 'Truckee', 'America/Los_Angeles', 39.10, 39.50, -120.47, -119.88, 39.09, 39.60, -120.47, -119.60);

-- Initial boxes, tunable by migration. priority: lowest number wins.
insert into public.areas (slug, label, sort, priority, min_lat, max_lat, min_lng, max_lng) values
  ('truckee',                  'Truckee',                        1, 7, 39.30,  39.50,  -120.47, -120.10),
  ('donner_lake',              'Donner Lake',                    2, 6, 39.30,  39.35,  -120.33, -120.24),
  ('tahoe_city_west_shore',    'Tahoe City & West Shore',        3, 5, 39.04,  39.185, -120.30, -120.10),
  ('olympic_valley_northstar', 'Olympic Valley & Northstar',     4, 4, 39.185, 39.30,  -120.26, -120.10),
  ('kings_beach_north_shore',  'Kings Beach & North Shore',      5, 3, 39.20,  39.30,  -120.10, -120.005),
  ('incline_crystal_bay',      'Incline Village & Crystal Bay',  6, 2, 39.18,  39.32,  -120.005, -119.88),
  ('reno_carson',              'Reno & Carson City',             7, 1, 39.09,  39.60,  -119.88, -119.60);

insert into public.categories (slug, label, sort, noun) values
  ('music',         'Music',            1, 'live music'),
  ('food-drink',    'Food & drink',     2, 'food and drink event'),
  ('outdoors',      'Outdoors',         3, 'outdoor event'),
  ('family',        'Family',           4, 'family event'),
  ('arts',          'Arts',             5, 'arts event'),
  ('community',     'Community',        6, 'community event'),
  ('markets',       'Markets',          7, 'market'),
  ('sports',        'Sports',           8, 'sports event'),
  ('nightlife',     'Nightlife',        9, 'nightlife event'),
  ('learning',      'Learning',        10, 'class or talk'),
  ('holiday',       'Holiday',         11, 'holiday event'),
  ('halloween-fall','Halloween & fall',12, 'fall festivity');

-- Frozen list, 10 rows (whole-word match). Extend only by migration.
insert into private.blocked_terms (term) values
  ('fuck'), ('shit'), ('cunt'), ('nigger'), ('faggot'), ('retard'), ('nazi'), ('kike'), ('chink'), ('whore');
do $$ begin
  if (select count(*) from private.blocked_terms) <> 10 then raise exception 'blocked_terms count'; end if;
end $$;

-- The M1 sources: disabled, review trust, unknown disposition until a terms review is recorded.
insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values
  ('diamond-peak',         'Diamond Peak',                   'https://www.diamondpeak.com/events/',        array['www.diamondpeak.com', 'diamondpeak.com'], 'tribe',             'venue'),
  ('ivgid',                'Incline Village GID',            'https://www.yourtahoeplace.com/events',      array['www.yourtahoeplace.com', 'yourtahoeplace.com'], 'tribe',      'municipal'),
  ('visit-lake-tahoe',     'Visit Lake Tahoe',               'https://visitlaketahoe.com/events/',         array['visitlaketahoe.com', 'www.visitlaketahoe.com'], 'tribe',      'dmo'),
  ('truckee-chamber',      'Truckee Chamber of Commerce',    'https://business.truckee.com/events',        array['business.truckee.com', 'chamber.truckee.com'], 'ics_chambermaster', 'municipal'),
  ('tdrpd',                'Truckee Donner Recreation & Park District', 'https://www.tdrpd.org/calendar.aspx', array['www.tdrpd.org', 'tdrpd.org'], 'ics_civicplus', 'municipal'),
  ('alibi-truckee',        'Alibi Ale Works (Truckee)',      'https://www.alibialeworks.com/truckee',      array['www.alibialeworks.com', 'alibialeworks.com'], 'ics_eventsmanager', 'venue'),
  ('tahoe-donner',         'Tahoe Donner',                   'https://www.tahoedonner.com/events/',        array['www.tahoedonner.com', 'tahoedonner.com'], 'rss',               'organizer'),
  ('truckee-roundhouse',   'Truckee Roundhouse',             'https://www.truckeeroundhouse.org/events',   array['www.truckeeroundhouse.org', 'truckeeroundhouse.org'], 'squarespace', 'organizer'),
  ('arts-for-the-schools', 'Arts for the Schools',           'https://www.artsfortheschools.org/events',   array['www.artsfortheschools.org', 'artsfortheschools.org'], 'squarespace', 'organizer');

-- Link-only listings: pointed to, never read. Never enabled.
insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust) values
  ('sierra-sun',          'Sierra Sun',                       'https://www.sierrasun.com/events/',          array['www.sierrasun.com'],          'html', 'community', 'link_only'),
  ('moonshine-ink',       'Moonshine Ink',                    'https://www.moonshineink.com/events/',       array['www.moonshineink.com'],       'html', 'community', 'link_only'),
  ('visit-tahoe-city',    'Visit Tahoe City',                 'https://visittahoecity.org/events/',         array['visittahoecity.org'],         'html', 'community', 'link_only'),
  ('north-tahoe-business','North Tahoe Business Association', 'https://northtahoebusiness.org/events/',    array['northtahoebusiness.org'],     'html', 'community', 'link_only'),
  ('tahoe-daily-tribune', 'Tahoe Daily Tribune',              'https://www.tahoedailytribune.com/events/',  array['www.tahoedailytribune.com'],  'html', 'community', 'link_only');
