-- AC-M1-89, AC-M1-90 (a), AC-M1-92: Truckee Chamber fixes (A9, A9.1): sentence-like non-place rule, resolve_venue fill, geocode hint, held-run scrub.
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

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-90 (a): the fresh-reset state (reset succeeding proves a9_state passed)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.t($$(select enabled and trust = 'auto' and not strict_auto and page_cap = 200
                           and config ->> 'listUrl' = 'https://chamber.truckee.com/events' and (config ->> 'windowDays')::int = 45
                           and config ->> 'geocodeHint' = 'Truckee, CA' and next_due_at <= now()
                           and 'chamber.truckee.com' = any (allowed_hosts)
                      from public.sources where slug = 'truckee-chamber')$$, 'AC-M1-90a truckee-chamber: A9-5 config, page_cap 200, auto trust (A10), due now');
select pg_temp.eq($$private.scrub_held_non_place()$$, '0', 'AC-M1-92f after reset the scrub function exists and returns 0');
select pg_temp.eq($$(select count(*) from public.venues where private.is_non_place(name))$$, '0', 'AC-M1-90a fresh reset: no non-place venue');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-89 (a): the 19-row parity table
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.eq(format($$private.is_non_place(%L)$$, t.s), t.want, 'AC-M1-89a parity row ' || t.n || ': ' || t.s)
  from (values
    (1, 'Find participating spots on Visit Truckee-Tahoe Taste of Truckee.', 'true'),
    (2, 'Night 1: Oct 16 at Alpenglow Sports (Tahoe City) Night 2: Oct 17 at Tahoe Mountain Sports', 'true'),
    (3, 'See website for locations', 'true'),
    (4, 'Join us at the Truckee Hotel', 'true'),
    (5, 'Doors 7:00 pm, Example Hall', 'true'),
    (6, 'Meet at the trailhead parking lot and carpool up to the lake together', 'true'),
    (7, 'https://x.example.test', 'true'),
    (8, '2026', 'true'),
    (9, 'Truckee Community Recreation Center', 'false'),
    (10, 'Pioneer Park', 'false'),
    (11, 'Gallery 5830''', 'false'),
    (12, 'Cottonwood Restaurant & Bar 10142 Rue Hilltop', 'false'),
    (13, 'Town Corp Yard (located next to the Humane Society)', 'false'),
    (14, 'Truckee Community Recreation Center, 8924 Donner Pass Rd, Truckee, CA 96161', 'false'),
    (15, 'Check Point Cafe', 'false'),
    (16, 'Seeds Bakery & Cafe Downtown Truckee', 'false'),
    (17, 'Alibi Ale Works - Truckee Public House', 'false'),
    (18, 'Café 1', 'false'),
    (19, 'Example Hall, Suite 2: Upstairs', 'false')) t(n, s, want);
select pg_temp.eq($$private.is_non_place(null)$$, 'false', 'AC-M1-89a is_non_place(null) is false');

-- (b) the clean_source_item guard on the Chamber source
create function pg_temp.csi(p_vn text, p_addr text) returns jsonb language plpgsql as $$
begin
  return private.clean_source_item((select s from public.sources s where s.slug = 'truckee-chamber'),
    pg_temp.item('csi1', 'Guard Check Event', 40, 18, jsonb_build_object('url', null, 'venueName', p_vn, 'address', p_addr)));
exception when others then return jsonb_build_object('error', sqlstate || ':' || sqlerrm);
end $$;
select pg_temp.eq($$(pg_temp.csi('Find participating spots on Visit Truckee-Tahoe Taste of Truckee.', 'x') ? 'facts')$$, 'true', 'AC-M1-89b a sentence venueName is not a reject');
select pg_temp.eq($$(pg_temp.csi('Find participating spots on Visit Truckee-Tahoe Taste of Truckee.', 'x') -> 'facts' ->> 'venue_name')$$, '<null>', 'AC-M1-89b ... venue_name is null');
select pg_temp.eq($$(pg_temp.csi('Find participating spots on Visit Truckee-Tahoe Taste of Truckee.', 'x') -> 'facts' ->> 'address')$$, '<null>', 'AC-M1-89b ... address is null');
select pg_temp.eq($$(pg_temp.csi('Truckee Community Recreation Center', 'x') -> 'facts' ->> 'venue_name')$$, 'Truckee Community Recreation Center', 'AC-M1-89b row 9 is kept');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-89 (c): resolve_venue fill
-- ---------------------------------------------------------------------------------------------------------------------
create temp table fx (label text primary key, id uuid);
create function pg_temp.mk_venue(p_label text, p_name text, p_attempts int default 0, p_town text default null, p_address text default null,
                                 p_aliases text[] default '{}', p_lat double precision default null, p_outside boolean default false) returns void language plpgsql as $$
begin
  insert into public.venues (name, normalized_name, town, address, geocode_attempts, aliases, lat, lng, outside_region)
    values (p_name, private.normalize_title(p_name), p_town, p_address, p_attempts, p_aliases, p_lat, case when p_lat is null then null else -120.1 end, p_outside);
  insert into fx select p_label, v.id from public.venues v where v.name = p_name and v.town is not distinct from p_town;
end $$;
create function pg_temp.mk_se(p_slug text, p_key text, p_venue text, p_status text default 'live') returns void language plpgsql as $$
begin
  insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, all_day, time_known, start_day,
      venue_id, source_status, needs_cluster)
    values ((select id from public.sources where slug = p_slug), p_key, '{}'::jsonb, md5(p_key), 'Fixture ' || p_key, private.normalize_title('Fixture ' || p_key),
            pg_temp.tstz(30, 18), false, true, (pg_temp.tstz(30, 18) at time zone 'America/Los_Angeles')::date,
            (select id from fx where label = p_venue), p_status, false);
end $$;
create function pg_temp.vrow(p_label text) returns text language sql as $$
  select coalesce((select concat_ws('|', coalesce(address, '-'), coalesce(town, '-'), geocode_attempts) from public.venues where id = (select id from fx where label = p_label)), '<none>') $$;

select pg_temp.mk_venue('V', 'Example Gallery', 1);
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Example Gallery","address":"10 Sample Lane, Truckee, CA 96161","town":"Truckee"}') = (select id from fx where label = 'V')$$, 'true',
  'AC-M1-89c resolve_venue returns the existing venue V');
select pg_temp.eq($$pg_temp.vrow('V')$$, '10 Sample Lane, Truckee, CA 96161|Truckee|0', 'AC-M1-89c V took the address and town, with fresh geocode attempts');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Example Gallery","address":"99 Other Rd","town":"Truckee"}') = (select id from fx where label = 'V')$$, 'true', 'AC-M1-89c a second call finds V');
select pg_temp.eq($$pg_temp.vrow('V')$$, '10 Sample Lane, Truckee, CA 96161|Truckee|0', 'AC-M1-89c ... the address is filled once');
-- coordinates / outside_region are never touched
select pg_temp.mk_venue('VL', 'Located Hall', 2, null, null, '{}', 39.33);
select pg_temp.mk_venue('VO', 'Outside Hall', 2, null, null, '{}', null, true);
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Located Hall","address":"1 Sample St","town":"Truckee"}') = (select id from fx where label = 'VL')$$, 'true', 'AC-M1-89c finds the located venue');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Outside Hall","address":"1 Sample St","town":"Truckee"}') = (select id from fx where label = 'VO')$$, 'true', 'AC-M1-89c finds the outside venue');
select pg_temp.eq($$pg_temp.vrow('VL')$$, '-|-|2', 'AC-M1-89c a venue with coordinates is never changed');
select pg_temp.eq($$pg_temp.vrow('VO')$$, '-|-|2', 'AC-M1-89c an outside_region venue is never changed');
-- the unique guard: V2 (alias dup hall) and O2 (same normalized name, town Truckee)
select pg_temp.mk_venue('V2', 'Old Name', 3, null, null, array['dup hall']);
select pg_temp.mk_venue('O2', 'Old Name', 0, 'Truckee');
select pg_temp.mk_venue('V4', 'Old Name B', 3, null, null, array['dup hall b']);
select pg_temp.mk_venue('O4', 'Old Name B', 0, 'Truckee');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Dup Hall B","town":"Truckee"}') = (select id from fx where label = 'V4')$$, 'true',
  'AC-M1-89c4 no address: V4 is found by alias');
select pg_temp.eq($$pg_temp.vrow('V4')$$, '-|-|3', 'AC-M1-89c4 ... the town fill is blocked by the unique guard, nothing is filled, attempts stay 3');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Dup Hall","address":"5 Sample Rd","town":"Truckee"}') = (select id from fx where label = 'V2')$$, 'true',
  'AC-M1-89c V2 is found by alias and no exception is raised');
select pg_temp.eq($$pg_temp.vrow('V2')$$, '5 Sample Rd|-|0', 'AC-M1-89c/c4 V2 gets the address and attempts 0, but keeps town null');

-- (c2, c3) a town-only fill resets attempts; the hint loses to the town
select pg_temp.mk_venue('W', 'Town Only Hall', 3);
select pg_temp.mk_se('truckee-chamber', 'w1', 'W');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Town Only Hall","town":"Truckee"}') = (select id from fx where label = 'W')$$, 'true', 'AC-M1-89c2 resolve_venue returns W');
select pg_temp.eq($$pg_temp.vrow('W')$$, '-|Truckee|0', 'AC-M1-89c2 W took the town, address stays null, attempts 0');
select pg_temp.eq($$(select string_agg(e ->> 'query', '|') from jsonb_array_elements(private.take_geocode_budget(array[(select id from fx where label = 'W')])) e)$$, 'Town Only Hall, Truckee',
  'AC-M1-89c2 the query uses the town, not the hint');
update public.venues set geocode_attempts = 0 where id = (select id from fx where label = 'W');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Town Only Hall","town":"Truckee"}') = (select id from fx where label = 'W')$$, 'true', 'AC-M1-89c3 a second call finds W');
select pg_temp.eq($$pg_temp.vrow('W')$$, '-|Truckee|0', 'AC-M1-89c3 ... unchanged, no second reset');
update public.venues set geocode_attempts = 2 where id = (select id from fx where label = 'W');
select pg_temp.eq($$private.resolve_venue('{"venue_name":"Town Only Hall","town":"Truckee"}') = (select id from fx where label = 'W')$$, 'true', 'AC-M1-89c3 a repeat call finds W again');
select pg_temp.eq($$pg_temp.vrow('W')$$, '-|Truckee|2', 'AC-M1-89c3 ... a repeat of the same fill does not reset attempts');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-89 (d): geocode hint
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_venue('H', 'Hint Gallery');
select pg_temp.mk_venue('A', 'Addr Hall', 0, null, '1 Sample St, Truckee, CA');
select pg_temp.mk_venue('T', 'Town Hall', 0, 'Kings Beach');
select pg_temp.mk_venue('Z', 'Zed Hall');
select pg_temp.mk_venue('X', 'Done Hall', 3);
select pg_temp.mk_se('truckee-chamber', 'h1', 'H');
select pg_temp.mk_se('truckee-chamber', 'a1', 'A');
select pg_temp.mk_se('truckee-chamber', 't1', 'T');
select pg_temp.mk_se('truckee-chamber', 'x1', 'X');
select pg_temp.mk_se('alibi-truckee', 'z1', 'Z');
create temp table gu as select coalesce((select units from public.geocode_usage where month = date_trunc('month', now())::date), 0) as units;
create temp table gq as select e ->> 'query' as q
  from jsonb_array_elements(private.take_geocode_budget(array(select id from fx where label in ('H', 'A', 'T', 'Z', 'X')))) e;
select pg_temp.eq($$(select string_agg(q, '|' order by q collate "C") from gq)$$,
  'Addr Hall, 1 Sample St, Truckee, CA|Hint Gallery, Truckee, CA|Town Hall, Kings Beach|Zed Hall',
  'AC-M1-89d queries: hint only for a venue with no address and no town; the exhausted venue is not returned');
select pg_temp.eq($$(select units - (select units from gu) from public.geocode_usage where month = date_trunc('month', now())::date)$$, '4', 'AC-M1-89d geocode_usage.units grows by 4');

-- (e) drop_non_place_venues
select pg_temp.mk_venue('S', 'See website for locations');
select pg_temp.mk_se('truckee-chamber', 's1', 'S');
select pg_temp.eq($$private.drop_non_place_venues()$$, '1', 'AC-M1-89e drop_non_place_venues removes the sentence venue');
select pg_temp.eq($$(select concat_ws('|', venue_id is null, needs_cluster) from public.source_events where external_key = 's1')$$, 't|t', 'AC-M1-89e ... its row has no venue and is queued');

-- (f) privileges
select pg_temp.eq(format($$has_function_privilege(%L, to_regprocedure(%L), 'execute')$$, r.role, f.fn), 'false', 'AC-M1-89f / AC-M1-92e ' || r.role || ' cannot execute ' || f.fn)
  from (values ('private.is_non_place(text)'), ('private.resolve_venue(jsonb)'), ('private.take_geocode_budget(uuid[])'), ('private.scrub_held_non_place()')) f(fn)
  cross join (values ('anon'), ('authenticated'), ('service_role')) r(role);

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-M1-92: pending held runs are scrubbed
-- ---------------------------------------------------------------------------------------------------------------------
create function pg_temp.hitem(p_key text, p_vn text, p_addr text default null) returns jsonb language plpgsql as $$
declare c jsonb;
begin
  c := private.clean_source_item((select s from public.sources s where s.slug = 'truckee-chamber'),
         pg_temp.item(p_key, 'Held Item ' || p_key, 40, 18, jsonb_build_object('url', null, 'venueName', 'Seed Hall', 'address', '1 Seed St')));
  c := jsonb_set(c, '{facts,venue_name}', coalesce(to_jsonb(p_vn), 'null'::jsonb));
  c := jsonb_set(c, '{facts,address}', coalesce(to_jsonb(p_addr), 'null'::jsonb));
  return c;
end $$;
create function pg_temp.mk_held(p_label text, p_status text, p_age_h int, p_items jsonb) returns void language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.source_runs (id, source_id, started_at, finished_at, status, parser_version)
    values (v_id, (select id from public.sources where slug = 'truckee-chamber'), now() - make_interval(hours => p_age_h), now() - make_interval(hours => p_age_h), 'anomaly', 'test-1');
  insert into public.held_runs (run_id, source_id, items, summary, status)
    values (v_id, (select id from public.sources where slug = 'truckee-chamber'), p_items, '{"found":3}'::jsonb, p_status);
  insert into fx values (p_label, v_id);
  if p_status = 'pending' then
    insert into public.review_cards (kind, held_run_id, source_id) values ('held_run', v_id, (select id from public.sources where slug = 'truckee-chamber'));
  end if;
end $$;
select pg_temp.mk_held('P1', 'pending', 0, jsonb_build_array(
  pg_temp.hitem('p1a', 'Find participating spots on Visit Truckee-Tahoe Taste of Truckee.', 'x'),
  pg_temp.hitem('p1b', 'Truckee Community Recreation Center', '8924 Donner Pass Rd'),
  pg_temp.hitem('p1c', null)));
select pg_temp.mk_held('P2', 'pending', 1, jsonb_build_array(pg_temp.hitem('p2a', 'Night 1: Oct 16 at Alpenglow Sports (Tahoe City) Night 2: Oct 17 at Tahoe Mountain Sports', 'y')));
select pg_temp.mk_held('A1', 'accepted', 2, jsonb_build_array(pg_temp.hitem('a1a', 'Find participating spots on Visit Truckee-Tahoe Taste of Truckee.', 'z')));
create temp table hsnap as select run_id, label, items, summary, status from public.held_runs h join fx on fx.id = h.run_id;
select pg_temp.eq($$private.scrub_held_non_place()$$, '2', 'AC-M1-92a the scrub reports 2 items (P1 item 1, P2 item 1)');
select pg_temp.eq($$(select concat_ws('|', e #>> '{facts,venue_name}' is null, e #>> '{facts,address}' is null, jsonb_typeof(e #> '{facts,venue_name}'),
                       (e - 'facts') = ((select items -> 0 from hsnap where label = 'P1') - 'facts'),
                       (e #> '{facts}') - 'venue_name' - 'address' = ((select items -> 0 from hsnap where label = 'P1') #> '{facts}') - 'venue_name' - 'address')
                      from public.held_runs h, jsonb_array_elements(h.items) with ordinality t(e, o)
                     where h.run_id = (select id from fx where label = 'P1') and o = 1)$$, 't|t|null|t|t',
  'AC-M1-92b P1 item 1: venue_name and address are JSON null; external_key and every other fact unchanged');
select pg_temp.t($$(select (h.items -> 1) = (s.items -> 1) and (h.items -> 2) = (s.items -> 2) and (h.items -> 1)::text = (s.items -> 1)::text and jsonb_array_length(h.items) = 3
                      from public.held_runs h join hsnap s on s.run_id = h.run_id where s.label = 'P1')$$, 'AC-M1-92b P1 items 2 and 3 are byte-equal and the order is kept');
select pg_temp.eq($$(select concat_ws('|', e #>> '{facts,venue_name}' is null, e #>> '{facts,address}' is null)
                      from public.held_runs h, jsonb_array_elements(h.items) e where h.run_id = (select id from fx where label = 'P2'))$$, 't|t', 'AC-M1-92b P2 item 1 is scrubbed');
select pg_temp.t($$(select h.items = s.items from public.held_runs h join hsnap s on s.run_id = h.run_id where s.label = 'A1')$$, 'AC-M1-92b the accepted run A1 is unchanged');
select pg_temp.t($$(select bool_and(h.summary = s.summary and h.status = s.status) from public.held_runs h join hsnap s on s.run_id = h.run_id)$$, 'AC-M1-92b summary and status of all three are unchanged');
create temp table hsnap2 as select run_id, items from public.held_runs;
select pg_temp.eq($$private.scrub_held_non_place()$$, '0', 'AC-M1-92c a second call returns 0');
select pg_temp.t($$(select bool_and(h.items = s.items) from public.held_runs h join hsnap2 s on s.run_id = h.run_id)$$, 'AC-M1-92c ... and changes nothing');
-- (d) accept P1
create temp table vcount as select count(*) as n from public.venues;
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'accept', null, 40)$$, (select c.id from public.review_cards c where c.held_run_id = (select id from fx where label = 'P1')))),
  'OK', 'AC-M1-92d accepting P1 succeeds');
select pg_temp.eq($$(select count(*) from public.venues where private.is_non_place(name))$$, '0', 'AC-M1-92d ... no non-place venue exists');
select pg_temp.eq($$(select count(*) - (select n from vcount) from public.venues)$$, '1', 'AC-M1-92d ... the venue count rises by exactly 1 (row 9)');
select pg_temp.eq($$(select count(*) from public.venues where name = 'Truckee Community Recreation Center')$$, '1', 'AC-M1-92d ... that venue is Truckee Community Recreation Center');

select * from finish();
rollback;
