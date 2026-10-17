-- AC-M1-61 (A2, A3): durable seed invariants after all M0 + M1 migrations. Nothing here depends on enable/promotion rollout state.
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
create function pg_temp.ev_id_any() returns uuid language plpgsql as $$
declare r uuid;
begin execute 'select id from public.events limit 1' into r; return coalesce(r, '00000000-0000-4000-8000-000000000000'); exception when others then return '00000000-0000-4000-8000-000000000000'; end $$;
select pg_temp.t($$(select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('strict_auto', 'max_cards_7d'))$$,
  'S1.1 sources has strict_auto and max_cards_7d');
create temp table expect (slug text, disp text, methods text[]);
insert into expect values
  ('alibi-truckee', 'permitted', '{feed}'), ('truckee-chamber', 'permitted', '{feed,html}'), ('visit-lake-tahoe', 'permitted', '{api}'),
  ('tdrpd', 'permitted', '{feed}'), ('tahoe-donner', 'permitted', '{feed,html}'), ('arts-for-the-schools', 'permitted', '{html}'),
  ('diamond-peak', 'permission_required', '{}'), ('ivgid', 'permission_required', '{}'), ('truckee-roundhouse', 'permission_required', '{}');
select pg_temp.eq($$(select count(*) from expect e join public.sources s using (slug)
                      where s.ingest_disposition::text = e.disp and s.allowed_methods <@ e.methods and s.allowed_methods @> e.methods)$$, '9',
  'AC-M1-61 the 9 M1 sources have exactly the dispositions and methods of S1.13a');
select pg_temp.eq($$(select count(*) from public.sources where slug in ('diamond-peak', 'ivgid', 'truckee-roundhouse') and not enabled and allowed_methods = '{}' and trust = 'link_only')$$, '3',
  'AC-M1-61 diamond-peak, ivgid, truckee-roundhouse: enabled = false, allowed_methods = {}, trust = link_only');
select pg_temp.eq($$(select count(*) from (values ('diamond-peak'), ('ivgid'), ('truckee-roundhouse')) g(s)
                      where pg_temp.x('admin', format('select public.admin_set_source_enabled(%L, true)', g.s)) like 'ERR:23514|source\_not\_permitted|%')$$, '3',
  'AC-M1-61 admin_set_source_enabled on each gated source -> source_not_permitted');
select pg_temp.eq($$(select class::text || '|' || (trust <> 'auto') || '|' || max_cards_7d from public.sources where slug = 'visit-lake-tahoe')$$, 'aggregator|true|3',
  'AC-M1-61 visit-lake-tahoe: class aggregator, trust <> auto, max_cards_7d = 3');
select pg_temp.eq($$(select cadence from public.sources where slug = 'truckee-chamber')$$, '24h', 'AC-M1-61 (A10) truckee-chamber cadence is 24h');
-- a grant for the chamber sets next_due_at = now + 24 h (A10: was 72 h) (enabled here with a fresh, fixture-only recheck so the test cannot expire)
select pg_temp.x('postgres', $$update public.sources set terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days', enabled = true, next_due_at = now() where slug = 'truckee-chamber'$$);
select pg_temp.x('postgres', $$update public.sources set next_due_at = now() + interval '1 day' where slug <> 'truckee-chamber' and next_due_at <= now()$$);
select pg_temp.t($$(select count(*) = 1 from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'truckee-chamber')$$, 'AC-M1-61 the chamber is issued a grant');
select pg_temp.t($$(select next_due_at = now() + interval '24 hours' from public.sources where slug = 'truckee-chamber')$$, 'AC-M1-61 (A10) ... and its next_due_at is now + 24 h');
select pg_temp.eq($$(select count(*) from public.sources where family = 'squarespace')$$, '0', 'AC-M1-61 no source has family squarespace');
select pg_temp.eq($$(select count(*) from expect e join public.sources s using (slug) where s.terms_hash ~ '^[0-9a-f]{64}$' and s.robots_hash ~ '^[0-9a-f]{64}$' and s.robots_checked_at is not null)$$, '9',
  'AC-M1-61 every terms_hash and robots_hash of the 9 matches ^[0-9a-f]{64}$ and robots was checked');
select pg_temp.eq($$(select count(*) from public.sources where (terms_hash is not null and terms_hash !~ '^[0-9a-f]{64}$') or (robots_hash is not null and robots_hash !~ '^[0-9a-f]{64}$'))$$, '0', 'AC-M1-61 no source has a malformed hash');
select is(pg_temp.v('anon', $$(select count(*) from public.list_sources_public() p where p.status = 'link_only' and p.name = any (array['Diamond Peak', 'Incline Village GID', 'Truckee Roundhouse']))$$), '3', 'AC-M1-61 list_sources_public() shows the three gated sources as link_only');
-- no RPC granted to authenticated or service_role can change strict_auto / max_cards_7d
select pg_temp.mk_source('seed-h', 'organizer', 'review');
create temp table cfg0 as select pg_temp.snap($$(select slug, strict_auto, max_cards_7d from public.sources)$$) s;
select pg_temp.rb('hostile', 'seed-h',
  jsonb_build_array(pg_temp.item('sh1', 'Seed Hostile Night', 9, 18, '{"strict_auto":true,"max_cards_7d":50}')),
  '{"strict_auto":true,"max_cards_7d":50,"trust":"auto"}');
select pg_temp.x('admin', $$select public.admin_set_source_trust('seed-h', 'auto')$$);
select pg_temp.x('admin', $$select public.admin_set_source_enabled('seed-h', true)$$);
select pg_temp.x('admin', format($$select public.admin_update_event(%L, '{"strict_auto":true,"max_cards_7d":50}'::jsonb)$$, pg_temp.ev_id_any()));
select pg_temp.x('admin', $$select public.admin_add_suppression('host', 'seed-h.example.test', '{"strict_auto":true}')$$);
select pg_temp.x('service_role', $$select public.svc_cluster_and_publish(500)$$);
select pg_temp.x('service_role', $$select public.svc_weekly_report()$$);
select pg_temp.t($$(select pg_temp.snap($e$(select slug, strict_auto, max_cards_7d from public.sources)$e$) = s from cfg0)$$, 'AC-M1-61 hostile payloads through the batch, admin and service RPCs leave strict_auto and max_cards_7d unchanged on every source');
select pg_temp.eq($$(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
   and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))
   and p.prosrc ~* '(set|update)[^;]*(strict_auto|max_cards_7d)')$$, '0', 'AC-M1-61 no granted RPC body updates strict_auto or max_cards_7d');

-- AC-M1-61 (A5-1, A5-10) ---------------------------------------------------------------------------------------------------------
select is(pg_temp.q($$(select config -> 'filter' -> 'excludeCategorySlugs' from public.sources where slug = 'visit-lake-tahoe')$$),
  '["attractions-events", "wellness", "tahoe-blue-event-center"]', 'AC-M1-61 (A5-1) visit-lake-tahoe excludeCategorySlugs is exactly the re-probe array, in order');
select pg_temp.t($$(select config -> 'filter' -> 'excludeCategorySlugs' = '["attractions-events","wellness","tahoe-blue-event-center"]'::jsonb from public.sources where slug = 'visit-lake-tahoe')$$,
  'AC-M1-61 (A5-1) ... jsonb equality with the exact array');
select pg_temp.eq($$(select string_agg(k, ',' order by k) from public.sources s, jsonb_object_keys(s.config -> 'filter') k where s.slug = 'visit-lake-tahoe')$$,
  'excludeCategorySlugs,maxDurationDays,maxItems,towns,windowDays', 'AC-M1-61 (A5-1) the filter key set is exactly {windowDays, towns, maxDurationDays, excludeCategorySlugs, maxItems}');
select pg_temp.eq($$(select count(*) from public.sources where slug in (select slug from expect) and terms_note !~ '^Terms review \d{4}-\d{2}-\d{2}: [a-z_]+\.$')$$, '0',
  'AC-M1-61 (A5-10) every M1 source terms_note matches the neutral pattern');
select pg_temp.eq($$(select count(*) from public.sources where slug in (select slug from expect) and terms_note is not null)$$, '9', 'AC-M1-61 (A5-10) ... and all 9 M1 sources have a terms_note');

select * from finish();
rollback;
