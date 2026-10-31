-- AC-21-21 (Spec_21Plus_Coverage): Crystal Bay Casino reads its events list page (html) for age labels; default categories music + nightlife.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is((select array_to_string(allowed_methods, ',') || ':' || ingest_disposition::text || ':' || (terms_recheck_at at time zone 'UTC')::date
             from public.sources where slug = 'crystal-bay-casino'), 'api,html:permitted:2027-10-18', 'methods {api,html}, permitted, recheck unchanged');
select is((select config -> 'defaultCategories' from public.sources where slug = 'crystal-bay-casino'), '["music","nightlife"]'::jsonb, 'default categories music + nightlife');
select is((select config ->> 'apiUrl' from public.sources where slug = 'crystal-bay-casino'), 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100', 'apiUrl unchanged');
select is((select page_cap::int from public.sources where slug = 'crystal-bay-casino'), 3, 'page_cap 3 (API + list page)');
select ok((select char_length(terms_note) <= 200 and terms_note like '%facts-only judgment, not affirmative permission%' from public.sources where slug = 'crystal-bay-casino'),
  'terms note <= 200 chars and still facts-only');
select is((select config ? 'ageRule' from public.sources where slug = 'crystal-bay-casino'), false, 'no venue-wide age rule in config');

-- Re-running the whole migration changes nothing (review R9/F4). The migration already ran in an earlier transaction, so a write here would
-- move updated_at to this transaction's now(). The block below is the migration's code verbatim (scripts/m1-migrations.test.mjs checks it).
create temp table _before as select updated_at, allowed_methods, config, terms_note, terms_reviewed_at from public.sources where slug = 'crystal-bay-casino';
-- BEGIN migration copy
do $$ begin
  if exists (select 1 from public.sources where slug = 'crystal-bay-casino'
              and (allowed_methods is distinct from array['api','html']::text[] or ingest_disposition is distinct from 'permitted'
                   or terms_note not like 'Terms 2026-10-30:%')) then
    perform private.record_source_terms('crystal-bay-casino', 'permitted', array['api','html']::text[], 'https://www.crystalbaycasino.com/terms-conditions/',
      '8ed6935355e9abc25e1b4a6876bc89051ca97274c877964c3f1e10c6bbe68b28', 'conductor', '2026-10-30', '2027-10-18',
      'Terms 2026-10-30: facts-only judgment, not affirmative permission. Title, date, time, room, age label from the casino''s pages plus a link; no description or images; no Tixr.');
  end if;
end $$;
update public.sources set config = jsonb_set(config, '{defaultCategories}', '["music","nightlife"]'::jsonb)
 where slug = 'crystal-bay-casino' and config -> 'defaultCategories' is distinct from '["music","nightlife"]'::jsonb;
do $$ begin
  if (select count(*) from public.sources
       where slug = 'crystal-bay-casino' and family = 'wprest_crystalbay' and ingest_disposition = 'permitted'
         and allowed_methods = array['api','html']::text[]
         and (terms_recheck_at at time zone 'UTC')::date = date '2027-10-18'
         and config -> 'defaultCategories' = '["music","nightlife"]'::jsonb
         and config ->> 'apiUrl' = 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100'
         and page_cap = 3 and char_length(terms_note) <= 200
         and terms_note like '%facts-only judgment, not affirmative permission%') <> 1 then
    raise exception '21plus_coverage_state';
  end if;
end $$;
-- END migration copy
select is((select count(*) from public.sources s, _before b where s.slug = 'crystal-bay-casino' and s.updated_at = b.updated_at
  and s.allowed_methods = b.allowed_methods and s.config = b.config and s.terms_note = b.terms_note and s.terms_reviewed_at = b.terms_reviewed_at), 1::bigint,
  'a full re-run of the migration (guarded writes + self-check) changes nothing');

select * from finish();
rollback;
