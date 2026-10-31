-- AC-21-21 (Spec_21Plus_Coverage): Crystal Bay Casino reads its events list page (html) for age labels; default categories music + nightlife.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is((select array_to_string(allowed_methods, ',') || ':' || ingest_disposition::text || ':' || (terms_recheck_at at time zone 'UTC')::date
             from public.sources where slug = 'crystal-bay-casino'), 'api,html:permitted:2027-10-18', 'methods {api,html}, permitted, recheck unchanged');
select is((select config -> 'defaultCategories' from public.sources where slug = 'crystal-bay-casino'), '["music","nightlife"]'::jsonb, 'default categories music + nightlife');
select is((select config ->> 'apiUrl' from public.sources where slug = 'crystal-bay-casino'), 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100', 'apiUrl unchanged');
select is((select page_cap from public.sources where slug = 'crystal-bay-casino'), 3, 'page_cap 3 (API + list page)');
select ok((select char_length(terms_note) <= 200 and terms_note like '%facts-only judgment, not affirmative permission%' from public.sources where slug = 'crystal-bay-casino'),
  'terms note <= 200 chars and still facts-only');
select is((select config ? 'ageRule' from public.sources where slug = 'crystal-bay-casino'), false, 'no venue-wide age rule in config');

-- Re-running the migration's guarded writes changes nothing (R9): updated_at stays put.
create temp table _before as select updated_at, allowed_methods, config, terms_note from public.sources where slug = 'crystal-bay-casino';
select lives_ok($$update public.sources set config = jsonb_set(config, '{defaultCategories}', '["music","nightlife"]'::jsonb)
  where slug = 'crystal-bay-casino' and config -> 'defaultCategories' is distinct from '["music","nightlife"]'::jsonb$$, 'guarded defaults re-apply');
select is((select count(*) from public.sources s, _before b where s.slug = 'crystal-bay-casino' and s.updated_at = b.updated_at
  and s.allowed_methods = b.allowed_methods and s.config = b.config and s.terms_note = b.terms_note), 1::bigint, 'nothing changed on re-run');

select * from finish();
rollback;
