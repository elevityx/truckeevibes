-- 21+ coverage (Spec_21Plus_Coverage): Crystal Bay Casino also reads its own events list page, only for each show's age label
-- (`html` joins `api` in allowed_methods), and its default categories become music + nightlife (defaults fill only items with no
-- category, so the comedy shows keep `nightlife` from the title). No venue-wide age: the label is per show (A14 r3-6 still holds).
-- Trust, enabled, robots evidence and page_cap (3: API + list page; robots.txt is exempt) are unchanged.
-- Data only: no function is created or replaced, so this migration intentionally has no revoke/grant block (the allowlist is unchanged
-- and pgTAP 01 still asserts it). Re-running it is a no-op (guarded writes) that passes its self-check.

-- Guarded (review R9): each write runs only when its business fields differ, so a re-run changes nothing (not even updated_at).
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

-- Self-check (scoped to this migration's row).
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
