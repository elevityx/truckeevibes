-- AC-M1-140 (Amendment 14): the crystal-bay-casino, moodys-bistro and eaa-1073-breakfast source rows, the link-only manifest, area boundaries,
-- publish and cross-source dedupe for Crystal Bay items, and the EAA terms recheck.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------------------------------
-- Shared helpers (this block is repeated verbatim at the top of each M1 pgTAP file; pgTAP files cannot include).
-- Every call into code under test goes through pg_temp.v / pg_temp.x / pg_temp.rb, which turn a database error into a
-- text value, so a missing object fails exactly one assertion instead of aborting the whole file.
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.ctx(p_ctx text) returns void language plpgsql as $$
begin
  if p_ctx in ('admin', 'user') then
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', case p_ctx when 'admin' then 'e1500000-0000-4000-a000-000000000001' else 'e1500000-0000-4000-a000-000000000002' end,
      'role', 'authenticated', 'is_anonymous', false, 'aal', 'aal2',
      'amr', '[{"method":"totp","timestamp":1791564301},{"method":"password","timestamp":1791564300}]'::jsonb)::text, true);
    perform set_config('role', 'authenticated', true);
  elsif p_ctx in ('anon', 'service_role') then
    perform set_config('request.jwt.claims', jsonb_build_object('role', p_ctx)::text, true);
    perform set_config('role', p_ctx, true);
  end if;
end $$;
-- scalar expression -> text as ctx in (postgres, anon, authenticated-user, admin, service_role); error -> 'ERR:<state>|<msg>|<detail>'
create function pg_temp.v(p_ctx text, p_expr text) returns text language plpgsql as $$
declare r text; v_msg text; v_detail text;
begin
  perform pg_temp.ctx(p_ctx);
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
-- statement -> 'OK' or the same ERR text
create function pg_temp.x(p_ctx text, p_sql text) returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform pg_temp.ctx(p_ctx);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
create function pg_temp.q(p_expr text) returns text language sql as $$ select pg_temp.v('postgres', p_expr) $$;
-- an ERR text carries this SQLSTATE / this exact message / this detail
create function pg_temp.err(p_x text, p_state text, p_msg text, p_detail text default null) returns boolean language sql as $$
  select p_x like 'ERR:' || p_state || '|' || p_msg || '|' || coalesce(p_detail, '') || case when p_detail is null then '%' else '' end
$$;
create function pg_temp.errm(p_x text, p_msg text) returns boolean language sql as $$
  select p_x like 'ERR:%|' || p_msg || '|%' $$;
-- md5 over a whole table / query (row text sorted), '-' when empty
create function pg_temp.snap(p_from text) returns text language plpgsql as $$
declare r text;
begin
  execute format('select coalesce(md5(string_agg(t::text, ''|'' order by t::text)), ''-'') from %s t', p_from) into r;
  return r;
exception when others then return 'ERR:' || sqlstate;
end $$;
create function pg_temp.n(p_from text) returns bigint language plpgsql as $$
declare r bigint;
begin
  execute 'select count(*) from ' || p_from into r;
  return r;
exception when others then return -1;
end $$;

-- assertion wrappers: the expression is evaluated through pg_temp.q, so a missing object fails this assertion only
create function pg_temp.eq(p_expr text, p_expected text, p_desc text) returns text language sql as $$
  select is(pg_temp.q(p_expr), p_expected, p_desc) $$;
create function pg_temp.t(p_expr text, p_desc text) returns text language sql as $$
  select is(pg_temp.q(p_expr), 'true', p_desc) $$;
create function pg_temp.jb(p_t text) returns jsonb language plpgsql as $$
begin return p_t::jsonb; exception when others then return null; end $$;

-- local-time helpers: an ISO UTC timestamp for "<days> from today at hh:mm Pacific (+ plus minutes)"
create function pg_temp.ts(p_days int, p_hh int, p_mm int default 0, p_plus int default 0) returns text language sql as $$
  select to_char(((((now() at time zone 'America/Los_Angeles')::date + p_days) + make_time(p_hh, p_mm, 0)
                   + make_interval(mins => p_plus)) at time zone 'America/Los_Angeles') at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
create function pg_temp.tstz(p_days int, p_hh int, p_mm int default 0, p_plus int default 0) returns timestamptz language sql as $$
  select pg_temp.ts(p_days, p_hh, p_mm, p_plus)::timestamptz $$;

-- fixtures. Item key names are the camelCase of the `facts` columns (S1.2 step 6) plus the plan-3.2 SourceEvent keys.
create function pg_temp.mk_admin() returns void language plpgsql as $$
begin
  insert into auth.users (id, aud, role, email)
    select ('e1500000-0000-4000-a000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'm1fx' || n || '@example.test'
      from generate_series(1, 2) n on conflict do nothing;
  insert into public.admins (user_id, note) values ('e1500000-0000-4000-a000-000000000001', 'm1 test') on conflict do nothing;
end $$;
-- an enabled, permitted, evidenced source (the gate allows it); trust/class as asked
create function pg_temp.mk_source(p_slug text, p_class text default 'organizer', p_trust text default 'review',
                                  p_hosts text[] default array['example.test'], p_cadence text default '24h') returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class, trust, enabled, cadence,
      ingest_disposition, allowed_methods, terms_url, terms_hash, terms_reviewed_by, terms_reviewed_at, terms_recheck_at)
    values (p_slug, 'Src ' || p_slug, 'https://example.test/' || p_slug, p_hosts, 'ics', p_class::public.source_class,
            p_trust::public.source_trust, true, p_cadence, 'permitted', array['feed'], 'https://example.test/terms',
            repeat('a', 64), 'test', now(), now() + interval '30 days')
    returning id into v_id;
  return v_id;
end $$;
create function pg_temp.item(p_key text, p_title text, p_days int, p_hh int default 18, p_over jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('externalKey', p_key, 'title', p_title,
      'startsAt', pg_temp.ts(p_days, p_hh), 'endsAt', pg_temp.ts(p_days, p_hh, 0, 120),
      'allDay', false, 'timeKnown', true, 'venueName', 'Test Hall', 'address', '10 Main St', 'town', 'Truckee',
      'lat', 39.328, 'lng', -120.1833, 'url', 'https://example.test/e/' || p_key,
      'priceKind', 'free', 'age', 'unknown', 'categoriesHint', jsonb_build_array('music')) || p_over
$$;
-- n distinct, non-clustering items (unique md5 titles, 5 time slots a day over ~100 days). The first p_changed items get
-- a " v2" title suffix (a content change); p_urlbase sets the URL prefix.
create function pg_temp.bulk(p_n int, p_prefix text default 'b', p_changed int default 0, p_urlbase text default 'https://example.test/e/') returns jsonb
language sql as $$
  select coalesce(jsonb_agg(pg_temp.item(p_prefix || n, 'Fest ' || substr(md5(p_prefix || n), 1, 12) || case when n <= p_changed then ' v2' else '' end,
                                         1 + (n % 100), 9 + (n % 5) * 2, jsonb_build_object('url', p_urlbase || p_prefix || n))), '[]')
    from generate_series(1, p_n) n
$$;
-- issue a fresh grant for exactly this source and submit; returns the RPC result. Runs as postgres.
create function pg_temp.run_batch(p_slug text, p_items jsonb, p_run jsonb default '{}') returns jsonb language plpgsql as $$
declare v_tok text;
begin
  update public.sources set next_due_at = now() + interval '1 day' where slug <> p_slug and next_due_at <= now();
  update public.sources set next_due_at = now() where slug = p_slug;
  select g ->> 'grant' into v_tok from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g
   where g #>> '{source,slug}' = p_slug;
  if v_tok is null then raise exception 'test fixture: no grant issued for %', p_slug; end if;
  return public.svc_ingest_batch(v_tok,
    jsonb_build_object('status', 'ok', 'started_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                       'http_status', 200, 'parser_version', 'test-1') || p_run, p_items);
end $$;
-- run_batch returning only the error text (or 'OK'): for refusals whose result row is not needed
create function pg_temp.run_batch_err(p_slug text, p_items jsonb, p_run jsonb default '{}') returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform pg_temp.run_batch(p_slug, p_items, p_run);
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
create temp table tres (label text primary key, res jsonb, err text);
-- run_batch with the outcome recorded under a label (never raises)
create function pg_temp.rb(p_label text, p_slug text, p_items jsonb, p_run jsonb default '{}') returns void language plpgsql as $$
declare v_msg text; v_detail text;
begin
  insert into tres (label, res) values (p_label, pg_temp.run_batch(p_slug, p_items, p_run))
    on conflict (label) do update set res = excluded.res, err = null;
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  insert into tres (label, err) values (p_label, 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, ''))
    on conflict (label) do update set err = excluded.err, res = null;
end $$;
create function pg_temp.r(p_label text, p_key text) returns text language sql as $$
  select coalesce((select coalesce(res ->> p_key, err) from tres where label = p_label), '<no result>') $$;
-- drain the cluster outbox; returns the last result
create function pg_temp.cluster_all() returns jsonb language plpgsql as $$
declare r jsonb; i int := 0;
begin
  loop
    r := public.svc_cluster_and_publish(500);
    i := i + 1;
    exit when (r ->> 'remaining')::int = 0 or i > 10;
  end loop;
  return r;
exception when others then
  return jsonb_build_object('error', sqlstate || ':' || sqlerrm);
end $$;
-- ingest + drain in one step (label records the batch result)
create function pg_temp.ing(p_label text, p_slug text, p_items jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.rb(p_label, p_slug, p_items);
  perform pg_temp.cluster_all();
end $$;
create function pg_temp.vid(p_name text) returns uuid language plpgsql as $$
declare r uuid;
begin execute 'select id from public.venues where name = $1 order by created_at limit 1' into r using p_name; return r;
exception when others then return null; end $$;
create function pg_temp.status_of(p_title text) returns text language sql as $$
  select coalesce((select status::text from public.events where title = p_title and merged_into is null), '<none>') $$;
create function pg_temp.seed_runs(p_slug text, p_n int, p_found int, p_new int) returns void language plpgsql as $$
begin
  insert into public.source_runs (id, source_id, started_at, finished_at, status, items_found, items_new)
    select gen_random_uuid(), (select id from public.sources where slug = p_slug),
           now() - make_interval(hours => 24 + n * 6), now() - make_interval(hours => 24 + n * 6), 'ok', p_found, p_new
      from generate_series(1, p_n) n;
exception when others then null;
end $$;
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_admin();

create function pg_temp.ev_status(k text) returns text language plpgsql as $$
declare r text;
begin
  execute 'select e.status::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = $1 limit 1' into r using k;
  return coalesce(r, '<none>');
exception when others then return 'ERR:' || sqlstate; end $$;
create function pg_temp.ev_fails(k text) returns text[] language plpgsql as $$
declare r text[];
begin
  execute 'select private.strict_auto_fails(e) from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = $1 limit 1' into r using k;
  return r;
exception when others then return null; end $$;
create function pg_temp.ev_col(k text, p_col text) returns text language plpgsql as $$
declare r text;
begin
  execute format('select e.%I::text from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = $1 limit 1', p_col) into r using k;
  return coalesce(r, '<null>');
exception when others then return 'ERR:' || sqlstate; end $$;
create function pg_temp.ev_id(k text) returns uuid language plpgsql as $$
declare r uuid;
begin
  execute 'select se.cluster_id from public.source_events se where se.external_key = $1 limit 1' into r using k;
  return r;
exception when others then return null; end $$;
create function pg_temp.open_cards(k text) returns bigint language plpgsql as $$
declare r bigint;
begin
  execute 'select count(*) from public.review_cards c join public.source_events se on se.cluster_id = c.event_id where se.external_key = $1 and c.kind = ''event'' and c.status = ''open''' into r using k;
  return r;
exception when others then return -1; end $$;

create function pg_temp.dt(p_days int) returns text language sql as $$
  select to_char((now() at time zone 'America/Los_Angeles')::date + p_days, 'YYYY-MM-DD') $$;
create function pg_temp.n_events(p_title text, p_day int) returns bigint language sql as $$
  select count(*) from public.events where title = p_title and merged_into is null and start_day = ((now() at time zone 'America/Los_Angeles')::date + p_day) $$;
-- a Tahoe Donner item (venue The Lodge Restaurant & Pub, directory address, geocoded unless p_geo is false)
create function pg_temp.td(p_key text, p_title text, p_day int, p_hh int, p_geo boolean default true, p_over jsonb default '{}') returns jsonb language sql as $$
  select (pg_temp.item(p_key, p_title, p_day, p_hh, jsonb_build_object('venueName', 'The Lodge Restaurant & Pub', 'address', '12850 Northwoods Blvd, Truckee, CA 96161',
           'lat', 39.3585, 'lng', -120.2330, 'url', 'https://www.tahoedonner.com/events/' || p_key || '/', 'categoriesHint', jsonb_build_array('food-drink'), 'priceKind', 'unknown'))
          || p_over) - case when p_geo then '{}'::text[] else array['lat', 'lng'] end $$;
create function pg_temp.chamber(p_key text, p_title text, p_day int, p_hh int, p_venue text, p_lat float8) returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_day, p_hh, jsonb_build_object('venueName', p_venue, 'address', '1 Chamber Way', 'lat', p_lat, 'lng', -120.2330,
           'categoriesHint', jsonb_build_array('community'))) $$;

-- fixtures ------------------------------------------------------------------------------------------------------------
-- a Crystal Bay Casino item (source coordinates, casino event URL and ticket URL, age as asked)
create function pg_temp.cbc(p_key text, p_title text, p_day int, p_hh int, p_age text default '21_plus', p_over jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_day, p_hh, jsonb_build_object('venueName', 'Crystal Bay Casino Crown Room', 'address', '14 Tahoe Blvd, Crystal Bay, NV 89402',
           'town', 'Crystal Bay', 'lat', 39.2275377, 'lng', -120.0046979, 'url', 'https://www.crystalbaycasino.com/event/' || p_key || '/',
           'ticketUrl', 'https://www.crystalbaycasino.com/event/' || p_key || '/', 'categoriesHint', jsonb_build_array('nightlife'), 'priceKind', 'unknown', 'age', p_age) || p_over) $$;
-- a VLT-style copy of the same show at a venue about 100 m from the casino (0.0009 deg of latitude)
create function pg_temp.vlt(p_key text, p_title text, p_day int, p_hh int) returns jsonb language sql as $$
  select pg_temp.item(p_key, p_title, p_day, p_hh, jsonb_build_object('venueName', 'Crystal Bay Club', 'address', '14 Tahoe Blvd', 'town', 'Crystal Bay',
           'lat', 39.2284, 'lng', -120.0047, 'url', 'https://example.test/vlt/' || p_key, 'categoriesHint', jsonb_build_array('music'), 'priceKind', 'unknown')) $$;

-- AC-M1-140 migration ---------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select string_agg(slug || ':' || enabled || ':' || trust || ':' || ingest_disposition || ':' || array_to_string(allowed_methods, ',') || ':' || family || ':' || class || ':'
    || (terms_recheck_at at time zone 'UTC')::date, ';' order by slug) from public.sources where slug in ('crystal-bay-casino', 'moodys-bistro', 'eaa-1073-breakfast'))$$,
  'crystal-bay-casino:true:review:permitted:api:wprest_crystalbay:venue:2027-10-18;eaa-1073-breakfast:true:auto:permitted:feed:curated_dates:community:2027-01-10;moodys-bistro:true:auto:permitted:api:tribe:venue:2027-10-18',
  'AC-M1-151 the three sources: enabled, Crystal Bay at review, Moody''s and EAA auto, permitted, methods, family, class, recheck dates');
select pg_temp.eq($$(select count(*) from public.sources where slug in ('crystal-bay-casino', 'moodys-bistro', 'eaa-1073-breakfast') and strict_auto)$$, '0', 'AC-M1-151 none of the three has strict_auto');
select pg_temp.eq($$(select count(*) from public.sources where slug in ('crystal-bay-casino', 'moodys-bistro', 'eaa-1073-breakfast') and char_length(terms_note) <= 200)$$, '3', 'AC-M1-160 each of the three terms notes is at most 200 characters');
select pg_temp.eq($$(select robots_hash || '|' || robots_checked_at::date || '|' || ai_bots_blocked from public.sources where slug = 'crystal-bay-casino')$$,
  '10160cb7c27e8ca5c7093db5b863178da9dd3c46fd400c7b3922f64cb67dc985|2026-10-19|false', 'AC-M1-140 crystal-bay-casino robots evidence as recorded');
select pg_temp.eq($$(select terms_hash from public.sources where slug = 'crystal-bay-casino')$$, '8ed6935355e9abc25e1b4a6876bc89051ca97274c877964c3f1e10c6bbe68b28', 'AC-M1-140 crystal-bay-casino terms hash');
select pg_temp.t($$(select terms_note like '%facts-only judgment, not affirmative permission%' from public.sources where slug = 'crystal-bay-casino')$$, 'AC-M1-140 the Crystal Bay terms note says facts-only, not permission');
select pg_temp.eq($$(select terms_hash from public.sources where slug = 'eaa-1073-breakfast')$$,
  encode(sha256(convert_to((select config::text from public.sources where slug = 'eaa-1073-breakfast'), 'UTF8')), 'hex'), 'AC-M1-140 the EAA terms hash is the sha256 of its own config text');
select pg_temp.t($$(select terms_note like '%hash is of our config%' from public.sources where slug = 'eaa-1073-breakfast')$$, 'AC-M1-140 the EAA note says the hash is of our config');
select pg_temp.eq($$(select config ->> 'apiUrl' from public.sources where slug = 'crystal-bay-casino')$$, 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100', 'AC-M1-140 crystal-bay-casino apiUrl');
select pg_temp.eq($$(select page_cap::text || '|' || cadence || '|' || homepage_url from public.sources where slug = 'crystal-bay-casino')$$, '3|24h|https://www.crystalbaycasino.com/entertainment/events/', 'AC-M1-140 crystal-bay-casino page_cap, cadence, homepage');
select pg_temp.eq($$(select config = '{"base":"https://www.moodysbistro.com","tz":"America/Los_Angeles","defaultCategories":["music"]}'::jsonb from public.sources where slug = 'moodys-bistro')$$, 'true', 'AC-M1-140 moodys-bistro config');
select pg_temp.eq($$(select jsonb_array_length(config -> 'dates') || '|' || (config -> 'dates' -> 0 ->> 'date') || '|' || (config ->> 'provenance') from public.sources where slug = 'eaa-1073-breakfast')$$,
  '3|2026-11-14|listed on tahoe.com, checked 2026-10-19', 'AC-M1-140 the EAA config lists three dates with provenance');
select pg_temp.eq($$(select count(*) from public.sources where enabled)$$, '18', 'AC-M1-140 fifteen sources enabled; Kids live: +3 libraries, -tdrpd = seventeen; K3 +tdrpd-rec1 = eighteen');

create temp table manifest (slug text, url text);
insert into manifest values
  ('bar-of-america', 'https://www.barofamerica.com/music.html'),
  ('rmu-truckee', 'https://rmumtnculture.com/pages/rmu-truckee'),
  ('tourist-club', 'https://chamber.truckee.com/list/member/tourist-club-3936'),
  ('cottonwood-truckee', 'https://www.cottonwoodrestaurant.com/music'),
  ('fiftyfifty-brewing', 'https://www.fiftyfiftybrewing.com/pages/events'),
  ('glasses-wine-bar', 'https://www.glasseswinebar.com/events'),
  ('the-grid-kings-beach', 'https://www.thegridbarandgrill.com/'),
  ('gar-woods', 'https://www.garwoods.com/calendar.html');
select pg_temp.eq($$(select count(*) from public.sources s join manifest m on m.slug = s.slug and m.url = s.homepage_url
    where not s.enabled and s.trust = 'link_only' and s.ingest_disposition = 'unknown' and s.family = 'html' and s.class = 'venue' and s.allowed_methods = '{}')$$,
  '8', 'AC-M1-158 the manifest rows exist: link_only, unknown, html, venue, never enabled, homepage_url = manifest URL');
select pg_temp.eq($$(select allowed_hosts[1] from public.sources where slug = 'fiftyfifty-brewing')$$, 'www.fiftyfiftybrewing.com', 'AC-M1-158 FiftyFifty allowed host is the www host');
select pg_temp.eq($$(select count(*) from public.sources where trust = 'link_only')$$, '16', 'AC-M1-140 link_only sources: the 8 earlier + the manifest of 8');
select pg_temp.eq($$(select count(*) from public.list_sources_public() p where p.status = 'link_only' and p.homepage_url in (select url from manifest))$$, '8', 'AC-M1-140 the manifest rows show as link_only on the public sources list');
select pg_temp.t($$(select pg_temp.x('postgres', $s$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('bars-bogus', 'Bogus Family', 'https://example.test/', array['example.test'], 'html_bogus', 'venue')$s$) like 'ERR:23514%')$$, 'AC-M1-140 family html_bogus fails the CHECK');
select pg_temp.t($$(select pg_temp.x('postgres', $s$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('bars-ok-1', 'OK Crystal', 'https://example.test/', array['example.test'], 'wprest_crystalbay', 'venue')$s$) = 'OK')$$, 'AC-M1-140 family wprest_crystalbay is accepted');
select pg_temp.t($$(select pg_temp.x('postgres', $s$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('bars-ok-2', 'OK Curated', 'https://example.test/', array['example.test'], 'curated_dates', 'community')$s$) = 'OK')$$, 'AC-M1-140 family curated_dates is accepted');
select pg_temp.eq($$(select count(distinct p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace, lateral aclexplode(p.proacl) a
    where n.nspname in ('public', 'private') and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) and a.privilege_type = 'EXECUTE')$$,
  '26', 'AC-M1-140 the EXECUTE allowlist has 26 functions (A14 keeps A13''s 24; +1 is W1 api_events_v1, +1 is K3 svc_manual_grant)');

-- area boundaries ----------------------------------------------------------------------------------------------------------
select pg_temp.eq($$private.area_for(39.2275377::double precision, -120.0046979::double precision)$$, 'incline_crystal_bay', 'AC-M1-140 the casino coordinates fall in incline_crystal_bay');
select pg_temp.eq($$private.area_for(39.3180851::double precision, -120.1381025::double precision)$$, 'truckee', 'AC-M1-140 the airport coordinates fall in truckee');

-- publish ---------------------------------------------------------------------------------------------------------------
select pg_temp.rb('cb1', 'crystal-bay-casino', jsonb_build_array(pg_temp.cbc('steely-dead-a', 'Steely Dead', 30, 20)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.ev_status('steely-dead-a')$$, 'pending', 'AC-M1-151 at review a Crystal Bay-only item is pending');
select pg_temp.eq($$pg_temp.open_cards('steely-dead-a')$$, '1', 'AC-M1-151 ... with exactly one open event card');
-- simulate the follow-up migration (A14 r3-3): the trust flip re-queues, then the item publishes under auto
update public.sources set trust = 'auto' where slug = 'crystal-bay-casino';
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.ev_status('steely-dead-a')$$, 'published', 'AC-M1-140 after the flip to auto, a Crystal Bay timed 21+ item with coordinates and a URL publishes (DB path with an injected age, not the adapter; A14 r3-6)');
select pg_temp.eq($$pg_temp.ev_col('steely-dead-a', 'area')$$, 'incline_crystal_bay', 'AC-M1-140 ... in area incline_crystal_bay');
select pg_temp.t($$(select pg_temp.ev_col('steely-dead-a', 'summary') like '%21+. Details and tickets on the organizer''s site.')$$, 'AC-M1-140 ... summary ends "21+. Details and tickets on the organizer''s site."');
select pg_temp.eq($$pg_temp.ev_col('steely-dead-a', 'age')$$, '21_plus', 'AC-M1-140 ... age 21_plus');
select pg_temp.eq($$pg_temp.open_cards('steely-dead-a')$$, '0', 'AC-M1-140 ... with no open card');

-- an item with no age statement is not 21_plus
select pg_temp.rb('cb2', 'crystal-bay-casino', jsonb_build_array(pg_temp.cbc('steely-dead-a', 'Steely Dead', 30, 20), pg_temp.cbc('boot-juice', 'Boot Juice', 31, 20, 'unknown')));
select pg_temp.cluster_all();
select pg_temp.t($$(pg_temp.ev_col('boot-juice', 'age') <> '21_plus')$$, 'AC-M1-140 a Crystal Bay item without an age statement is not 21_plus');

-- cross-source: casino first, VLT second; VLT first, casino second; VLT 60 min later is a different event
select pg_temp.mk_source('x-vlt', 'dmo', 'auto');
select pg_temp.rb('cb3', 'crystal-bay-casino', jsonb_build_array(pg_temp.cbc('sd-order1', 'Steely Dead Tribute', 40, 20)));
select pg_temp.rb('vl1', 'x-vlt', jsonb_build_array(pg_temp.vlt('vlt-order1', 'Steely Dead Tribute', 40, 20)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.n_events('Steely Dead Tribute', 40)$$, '1', 'AC-M1-140 casino first, VLT copy within 150 m and 30 min -> one event');
select pg_temp.eq($$(select organizer_url from public.events where title = 'Steely Dead Tribute' and merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 40)$$,
  'https://www.crystalbaycasino.com/event/sd-order1/', 'AC-M1-140 ... and the primary source is crystal-bay-casino');
select pg_temp.rb('vl2', 'x-vlt', jsonb_build_array(pg_temp.vlt('vlt-order2', 'Steely Dead Tribute', 41, 20)));
select pg_temp.rb('cb4', 'crystal-bay-casino', jsonb_build_array(pg_temp.cbc('sd-order1', 'Steely Dead Tribute', 40, 20), pg_temp.cbc('sd-order2', 'Steely Dead Tribute', 41, 20)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.n_events('Steely Dead Tribute', 41)$$, '1', 'AC-M1-140 VLT first, casino second -> one event');
select pg_temp.eq($$(select organizer_url from public.events where title = 'Steely Dead Tribute' and merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 41)$$,
  'https://www.crystalbaycasino.com/event/sd-order2/', 'AC-M1-140 ... the primary source is crystal-bay-casino in this order too');
select pg_temp.rb('vl3', 'x-vlt', jsonb_build_array(pg_temp.vlt('vlt-order1', 'Steely Dead Tribute', 40, 20), pg_temp.vlt('vlt-order2', 'Steely Dead Tribute', 41, 20), pg_temp.vlt('vlt-late', 'Steely Dead Tribute', 42, 21)));
select pg_temp.rb('cb5', 'crystal-bay-casino', jsonb_build_array(pg_temp.cbc('sd-order1', 'Steely Dead Tribute', 40, 20), pg_temp.cbc('sd-order2', 'Steely Dead Tribute', 41, 20), pg_temp.cbc('sd-late', 'Steely Dead Tribute', 42, 20)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.n_events('Steely Dead Tribute', 42)$$, '2', 'AC-M1-140 the VLT copy an hour later (21:00) is a different event');

-- EAA ---------------------------------------------------------------------------------------------------------------------
select pg_temp.rb('ea1', 'eaa-1073-breakfast', jsonb_build_array(pg_temp.item('curated:eaa-1073-breakfast#2026-11-14', 'EAA Chapter 1073 Pancake Breakfast', 25, 8, jsonb_build_object(
  'venueName', 'Truckee Tahoe Airport', 'address', '10356 Truckee Airport Rd, Truckee, CA 96161', 'town', 'Truckee', 'lat', 39.3180851, 'lng', -120.1381025,
  'url', 'https://www.tahoe.com/business/eea-truckee/events', 'priceKind', 'paid', 'priceMin', 5, 'priceMax', 7, 'categoriesHint', jsonb_build_array('family', 'kids', 'outdoors', 'learning')))));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.ev_status('curated:eaa-1073-breakfast#2026-11-14')$$, 'published', 'AC-M1-140 an EAA item publishes');
select pg_temp.eq($$pg_temp.ev_col('curated:eaa-1073-breakfast#2026-11-14', 'area')$$, 'truckee', 'AC-M1-140 ... in area truckee');

-- the recheck stops the grant by itself
alter table public.sources disable trigger sources_gate;
update public.sources set terms_recheck_at = now() - interval '1 day' where slug = 'eaa-1073-breakfast';
update public.sources set next_due_at = now() - interval '1 minute' where slug = 'eaa-1073-breakfast';
alter table public.sources enable trigger sources_gate;
select pg_temp.eq($$(select count(*) from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'eaa-1073-breakfast')$$, '0', 'AC-M1-140 a source whose recheck passed gets no grant');

select * from finish();

rollback;
