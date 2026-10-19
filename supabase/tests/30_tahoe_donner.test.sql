-- AC-M1-130, 131, 133 (Amendment 13): the tahoe-donner source row, dedupe and publish for its items, and the members-only category.
-- region rejection, trust re-queue, and the M1 stubs for M3.
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

-- AC-M1-130 migration --------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from public.sources where slug = 'tahoe-donner' and enabled and trust = 'auto' and cadence = '24h' and family = 'html_tahoedonner'
    and ingest_disposition = 'permitted' and allowed_methods = array['html']::text[] and page_cap = 45 and terms_recheck_at = '2027-10-17'::date
    and allowed_hosts = array['www.tahoedonner.com'] and class = 'organizer' and ai_bots_blocked = false and robots_checked_at = '2026-10-19'
    and robots_hash = '0fe5c745546c76471ae5c41caeede4f3e6bf08a51c87aaf8bc6fd22b0ad11eb9'
    and config = '{"listUrl":"https://www.tahoedonner.com/events/","tz":"America/Los_Angeles"}'::jsonb)$$, '1', 'AC-M1-130 tahoe-donner row is enabled/auto/24h/html_tahoedonner/permitted/{html}/page_cap 45/recheck 2027-10-17/hosts/config');
select pg_temp.eq($$(select count(*) from public.sources where enabled)$$, '12', 'AC-M1-130 twelve sources enabled');
select pg_temp.t($$(select pg_temp.x('postgres', $s$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('td-bogus', 'Bogus Family', 'https://example.test/', array['example.test'], 'html_bogus', 'organizer')$s$)) like 'ERR:23514%'$$,
  'AC-M1-130 family html_bogus fails the CHECK');
select pg_temp.t($$(select pg_temp.x('postgres', $s$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values ('td-ok-fam', 'Tahoe Donner Family', 'https://example.test/', array['example.test'], 'html_tahoedonner', 'organizer')$s$)) = 'OK'$$,
  'AC-M1-130 family html_tahoedonner passes the CHECK');
select pg_temp.eq($$(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace, lateral aclexplode(p.proacl) a
   where n.nspname in ('public', 'private') and a.privilege_type = 'EXECUTE' and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')))$$, '24',
  'AC-M1-130 the EXECUTE grants are unchanged (24)');

-- AC-M1-133 (r4) members-only category -----------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from public.categories)$$, '15', 'AC-M1-133 fifteen categories');
select pg_temp.eq($$(select label || '|' || sort || '|' || noun from public.categories where slug = 'members-only')$$, 'Members only|15|members-only event', 'AC-M1-133 members-only: label, sort, noun');

-- AC-M1-131 dedupe and publish ---------------------------------------------------------------------------------------------
select pg_temp.mk_source('x-chamber', 'municipal', 'auto');
-- same start day, venue <= 150 m, same title: one event, both arrival orders; primary source is Tahoe Donner
select pg_temp.rb('td1', 'tahoe-donner', jsonb_build_array(pg_temp.td('light-up-the-night', 'Light Up the Night', 40, 17)));
select pg_temp.rb('ch1', 'x-chamber', jsonb_build_array(pg_temp.chamber('ch-lun', 'Light Up the Night', 40, 17, 'Chamber Lodge', 39.35860)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.n_events('Light Up the Night', 40)$$, '1', 'AC-M1-131 TD first, Chamber copy within 150 m -> one event');
select pg_temp.rb('ch2', 'x-chamber', jsonb_build_array(pg_temp.chamber('ch-lun', 'Light Up the Night', 40, 17, 'Chamber Lodge', 39.35860), pg_temp.chamber('ch-lun2', 'Light Up the Night', 41, 17, 'Chamber Lodge', 39.35860)));
select pg_temp.cluster_all();
select pg_temp.rb('td2', 'tahoe-donner', jsonb_build_array(pg_temp.td('light-up-the-night', 'Light Up the Night', 40, 17), pg_temp.td('lun2', 'Light Up the Night', 41, 17)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.n_events('Light Up the Night', 41)$$, '1', 'AC-M1-131 Chamber first, TD second -> one event');
select pg_temp.eq($$(select organizer_url from public.events where title = 'Light Up the Night' and merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 40)$$,
  'https://www.tahoedonner.com/events/light-up-the-night/', 'AC-M1-131 the primary source is tahoe-donner (organizer beats municipal)');
select pg_temp.eq($$(select organizer_url from public.events where title = 'Light Up the Night' and merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 41)$$,
  'https://www.tahoedonner.com/events/lun2/', 'AC-M1-131 ... in the other arrival order too');
-- a Chamber copy at 18:00 is a different event
select pg_temp.rb('ch3', 'x-chamber', jsonb_build_array(pg_temp.chamber('ch-lun', 'Light Up the Night', 40, 17, 'Chamber Lodge', 39.35860), pg_temp.chamber('ch-lun2', 'Light Up the Night', 41, 17, 'Chamber Lodge', 39.35860),
  pg_temp.chamber('ch-lun3', 'Light Up the Night', 42, 18, 'Chamber Lodge', 39.35860)));
select pg_temp.rb('td3', 'tahoe-donner', jsonb_build_array(pg_temp.td('light-up-the-night', 'Light Up the Night', 40, 17), pg_temp.td('lun2', 'Light Up the Night', 41, 17), pg_temp.td('lun3', 'Light Up the Night', 42, 17)));
select pg_temp.cluster_all();
select pg_temp.eq($$pg_temp.n_events('Light Up the Night', 42)$$, '2', 'AC-M1-131 the same Chamber item at 18:00 -> two events');
-- delayed geocode (r2): TD venue lat null at clustering + Chamber copy at a differently named venue -> two events, and still two after the TD venue geocodes
select pg_temp.rb('td4', 'tahoe-donner', jsonb_build_array(pg_temp.td('light-up-the-night', 'Light Up the Night', 40, 17), pg_temp.td('lun2', 'Light Up the Night', 41, 17), pg_temp.td('lun3', 'Light Up the Night', 42, 17),
  pg_temp.td('dg1', 'Winter Gala', 45, 17, false, '{"venueName":"Tahoe Donner Pavilion","address":"12900 Northwoods Blvd, Truckee, CA 96161"}')));
select pg_temp.rb('ch4', 'x-chamber', jsonb_build_array(pg_temp.chamber('ch-lun', 'Light Up the Night', 40, 17, 'Chamber Lodge', 39.35860), pg_temp.chamber('ch-lun2', 'Light Up the Night', 41, 17, 'Chamber Lodge', 39.35860),
  pg_temp.chamber('ch-lun3', 'Light Up the Night', 42, 18, 'Chamber Lodge', 39.35860), pg_temp.chamber('dg2', 'Winter Gala Evening', 45, 17, 'Chamber Gala Hall', 39.35860)));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.events where merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 45 and title in ('Winter Gala', 'Winter Gala Evening'))$$, '2',
  'AC-M1-131 delayed geocode: TD venue lat null at clustering + Chamber copy at a differently named venue -> two events');
select pg_temp.x('service_role', format($$select public.svc_set_venue_geocode(%L, 39.3586, -120.2330, 'nominatim')$$, pg_temp.vid('Tahoe Donner Pavilion')));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.events where merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 45 and title in ('Winter Gala', 'Winter Gala Evening'))$$, '2',
  'AC-M1-131 ... still two after the TD venue geocodes within 150 m (documented limit)');
-- the other arrival order: Chamber first, TD (no coordinates) second
select pg_temp.rb('ch5', 'x-chamber', jsonb_build_array(pg_temp.chamber('ch-lun', 'Light Up the Night', 40, 17, 'Chamber Lodge', 39.35860), pg_temp.chamber('ch-lun2', 'Light Up the Night', 41, 17, 'Chamber Lodge', 39.35860),
  pg_temp.chamber('ch-lun3', 'Light Up the Night', 42, 18, 'Chamber Lodge', 39.35860), pg_temp.chamber('dg2', 'Winter Gala Evening', 45, 17, 'Chamber Gala Hall', 39.35860),
  pg_temp.chamber('dg4', 'Spring Social Night', 46, 17, 'Chamber Gala Hall', 39.35860)));
select pg_temp.rb('td5', 'tahoe-donner', jsonb_build_array(pg_temp.td('light-up-the-night', 'Light Up the Night', 40, 17), pg_temp.td('lun2', 'Light Up the Night', 41, 17), pg_temp.td('lun3', 'Light Up the Night', 42, 17),
  pg_temp.td('dg1', 'Winter Gala', 45, 17, false, '{"venueName":"Tahoe Donner Pavilion","address":"12900 Northwoods Blvd, Truckee, CA 96161"}'),
  pg_temp.td('dg3', 'Spring Social', 46, 17, false, '{"venueName":"Tahoe Donner Terrace","address":"12950 Northwoods Blvd, Truckee, CA 96161"}')));
select pg_temp.cluster_all();
select pg_temp.eq($$(select count(*) from public.events where merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 46 and title in ('Spring Social', 'Spring Social Night'))$$, '2',
  'AC-M1-131 delayed geocode, Chamber first -> two events');
-- publish: a TD timed item with a geocoded venue and URL is published with no open card; with venue lat null it waits as pending
select pg_temp.eq($$(select status::text from public.events where title = 'Light Up the Night' and merged_into is null and start_day = (now() at time zone 'America/Los_Angeles')::date + 42 order by starts_at limit 1)$$, 'published',
  'AC-M1-131 a TD timed item with a geocoded venue and URL -> published');
select pg_temp.eq($$(select count(*) from public.review_cards c join public.events e on e.id = c.event_id where c.kind = 'event' and c.status = 'open' and e.title = 'Light Up the Night')$$, '0',
  'AC-M1-131 ... and no open event card');
select pg_temp.eq($$(select status::text from public.events where title = 'Winter Gala' and merged_into is null)$$, 'published', 'AC-M1-131 the delayed item publishes once its venue is geocoded');
select pg_temp.eq($$(select status::text from public.events where title = 'Spring Social' and merged_into is null)$$, 'pending', 'AC-M1-131 a TD timed item whose venue lat is null -> pending');

-- AC-M1-133 (r4) a TD item with categoriesHint [members-only, food-drink] ---------------------------------------------------
select pg_temp.rb('td6', 'tahoe-donner', jsonb_build_array(pg_temp.td('light-up-the-night', 'Light Up the Night', 40, 17), pg_temp.td('lun2', 'Light Up the Night', 41, 17), pg_temp.td('lun3', 'Light Up the Night', 42, 17),
  pg_temp.td('dg1', 'Winter Gala', 45, 17, false, '{"venueName":"Tahoe Donner Pavilion","address":"12900 Northwoods Blvd, Truckee, CA 96161"}'),
  pg_temp.td('dg3', 'Spring Social', 46, 17, false, '{"venueName":"Tahoe Donner Terrace","address":"12950 Northwoods Blvd, Truckee, CA 96161"}'),
  pg_temp.td('mo1', 'Members Only Supper', 47, 18, true, '{"categoriesHint":["members-only","food-drink"]}')));
select pg_temp.cluster_all();
select pg_temp.eq($$(select string_agg(category, ',' order by category) from public.event_categories where event_id = pg_temp.ev_id('mo1'))$$, 'food-drink,members-only', 'AC-M1-133 event_categories holds both slugs');
select pg_temp.eq($$(select status::text from public.events where id = pg_temp.ev_id('mo1'))$$, 'published', 'AC-M1-133 a members-only event publishes (label only)');
select pg_temp.eq($$(select count(*) from public.list_events() l where l.id = pg_temp.ev_id('mo1') and 'members-only' = any (l.categories) and 'food-drink' = any (l.categories))$$, '1', 'AC-M1-133 list_events.categories includes members-only');
select pg_temp.eq($$(select categories::text from public.list_events() l where l.id = pg_temp.ev_id('mo1'))$$, '{food-drink,members-only}', 'AC-M1-133 ... ordered by category sort');
-- a Tribe-style source cannot add the slug through anything but a hint the database already accepts (the runner strips it first)
select pg_temp.eq($$(select count(*) from public.events e join public.event_categories c on c.event_id = e.id where c.category = 'members-only')$$, '1', 'AC-M1-133 exactly one members-only event');

select * from finish();
rollback;
