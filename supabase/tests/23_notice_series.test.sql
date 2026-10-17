-- AC-R4c-08: the notice series rule (>= 2 same-source occurrences within 14 days either side) and the same-source source_events.title comparison. Written failing first.
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
create function pg_temp.reasons(p_label text) returns text language sql as $$
  select coalesce((select (res -> 'reasons')::text from tres where label = p_label), '<none>') $$;
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

-- Fixtures -----------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('r4a-src', 'organizer', 'review');
select pg_temp.mk_admin();

-- Fixtures -----------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('r4c-src', 'organizer', 'review');
select pg_temp.mk_source('r4c-other', 'organizer', 'review');

-- D is 20 days out (inside the 120-day ingest window), a Pacific calendar day
create function pg_temp.d0() returns date language sql as $$ select (now() at time zone 'America/Los_Angeles')::date + 20 $$;
-- an event + its source_events row. p_se_title is the title the source emitted; p_title is the cluster title (they differ for a retitled cluster).
create function pg_temp.mk_ev(p_title text, p_slug text, p_key text, p_off int, p_status text default 'published', p_se_title text default null, p_merged uuid default null) returns uuid
language plpgsql as $$
declare v_id uuid; v_src uuid := (select id from public.sources where slug = p_slug); v_day date := pg_temp.d0() + p_off;
begin
  insert into public.events (region_id, title, summary, starts_at, time_known, status, merged_into, published_at)
    values (private.region_id(), p_title, 'Fixture for the notice series rule.', (v_day + time '19:00') at time zone 'America/Los_Angeles', true, p_status::public.event_status, p_merged, case when p_status = 'published' then now() end)
    returning id into v_id;
  insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, all_day, time_known, start_day, cluster_id)
    values (v_src, p_key, '{}', 'x', coalesce(p_se_title, p_title), '', (v_day + time '19:00') at time zone 'America/Los_Angeles', false, true, v_day, v_id);
  return v_id;
end $$;

-- the offsets rows of the parity table (SSOT ingest/core/notices.cases.json); one probe source per row, one sibling event per offset
create temp table series_cases (title text, sibling text, offsets text, expect boolean);
insert into series_cases (title, sibling, offsets, expect) values
  ('NO Country Fridays Tonight', 'Country Fridays', '{-7,7}', true),
  ('NO Country Fridays Tonight', 'Country Fridays', '{-14,14}', true),
  ('NO Country Fridays Tonight', 'Country Fridays', '{7}', false),
  ('NO Country Fridays Tonight', 'Country Fridays', '{-15,15}', false),
  ('No Trivia Today', 'Trivia Night', '{0}', false);
create function pg_temp.probe(p_title text, p_sibling text, p_offsets text) returns boolean language plpgsql as $$
declare v_slug text := 'sp-' || substr(md5(p_title || '|' || p_sibling || '|' || p_offsets), 1, 12); v_off int; v_n int := 0;
begin
  perform pg_temp.mk_source(v_slug, 'organizer', 'review');
  foreach v_off in array p_offsets::int[] loop
    v_n := v_n + 1;
    perform pg_temp.mk_ev(p_sibling, v_slug, 'sib' || v_n, v_off);
  end loop;
  return private.is_notice_title(p_title, private.notice_sibling_exists(p_title, (select id from public.sources where slug = v_slug), pg_temp.d0()));
end $$;
create temp table probed as select title, sibling, offsets, expect, pg_temp.probe(title, sibling, offsets) as got from series_cases;
select pg_temp.eq($$(select count(*) from series_cases)$$, '5', 'AC-R4c-08 the series parity table has the 5 offsets rows');
select pg_temp.eq($$(select count(*) from probed where got is distinct from expect)$$, '0', 'AC-R4c-08 the matcher returns the table value for every offsets row');
select pg_temp.eq($$(select count(*) from probed where got and expect)$$, '2', 'AC-R4c-08 ... two series notices (-7/+7 and -14/+14)');

-- hide_notice_events on fixtures, one source, notice at D --------------------------------------------------------------
-- S1: a real series of "Fx Fridays" at D-7 and D+7 -> hidden; both occurrences stay published
select pg_temp.mk_ev('NO Fx Fridays Tonight', 'r4c-src', 's1n', 0);
select pg_temp.mk_ev('Fx Fridays', 'r4c-src', 's1a', -7);
select pg_temp.mk_ev('Fx Fridays', 'r4c-src', 's1b', 7);
-- S2: only D+7 -> stays published
select pg_temp.mk_ev('NO Fx Single Tonight', 'r4c-src', 's2n', 0);
select pg_temp.mk_ev('Fx Single', 'r4c-src', 's2a', 7);
-- S3: D-7 and D+7 from another source -> stays published
select pg_temp.mk_ev('NO Fx Elsewhere Tonight', 'r4c-src', 's3n', 0);
select pg_temp.mk_ev('Fx Elsewhere', 'r4c-other', 's3a', -7);
select pg_temp.mk_ev('Fx Elsewhere', 'r4c-other', 's3b', 7);
-- S4: a hidden occurrence does not count; a merged_into occurrence does not count
select pg_temp.mk_ev('NO Fx Hid Tonight', 'r4c-src', 's4n', 0);
select pg_temp.mk_ev('Fx Hid', 'r4c-src', 's4a', -7);
select pg_temp.mk_ev('Fx Hid', 'r4c-src', 's4b', 7, 'hidden');
select pg_temp.mk_ev('NO Fx Merged Tonight', 'r4c-src', 's5n', 0);
select pg_temp.mk_ev('Fx Merged', 'r4c-src', 's5a', -7);
select pg_temp.mk_ev('Fx Merged', 'r4c-src', 's5b', 7, 'published', null, (select id from public.events where title = 'Fx Merged' limit 1));
-- S5: cluster retitled by a higher-priority source (events.title differs, same-source source_events.title is the series) -> still counts -> hidden.
-- The rows are inserted directly: recompute_event would overwrite events.title from the contributor.
select pg_temp.mk_ev('NO Fx Retitled Tonight', 'r4c-src', 's6n', 0);
select pg_temp.mk_ev('Country Fridays at Alibi', 'r4c-src', 's6a', -7, 'published', 'Fx Retitled');
select pg_temp.mk_ev('Country Fridays at Alibi', 'r4c-src', 's6b', 7, 'published', 'Fx Retitled');
-- S6: a same-day sibling matched only through events.title (its source_events.title differs) does not count
select pg_temp.mk_ev('NO Fx Cluster Tonight', 'r4c-src', 's7n', 0);
select pg_temp.mk_ev('Fx Cluster', 'r4c-src', 's7a', 0, 'published', 'Something Else Entirely');

select pg_temp.eq($$private.hide_notice_events()$$, '2', 'AC-R4c-08 the hide statement reports two events hidden (the Fx Fridays series and the retitled-cluster series)');
select pg_temp.eq($$(select string_agg(title || '=' || status::text, ',' order by title) from public.events where title like 'NO Fx%')$$,
  'NO Fx Cluster Tonight=published,NO Fx Elsewhere Tonight=published,NO Fx Fridays Tonight=hidden,NO Fx Hid Tonight=published,NO Fx Merged Tonight=published,NO Fx Retitled Tonight=hidden,NO Fx Single Tonight=published',
  'AC-R4c-08 a notice is hidden only with a 2-occurrence same-source series within 14 days; a single, other-source, hidden, merged or events.title-only match leaves it published');
select pg_temp.eq($$(select count(*) from public.events where title = 'Fx Fridays' and status = 'published')$$, '2', 'AC-R4c-08 both Fx Fridays occurrences stay published');
select pg_temp.eq($$(select count(*) from public.event_changes where decided_by = 'rule:notice')$$, '2', 'AC-R4c-08 exactly two rule:notice journal rows');
select pg_temp.eq($$(select count(*) from public.event_changes c join public.events e on e.id = c.event_id where c.decided_by = 'rule:notice' and e.title = 'NO Fx Fridays Tonight')$$, '1', 'AC-R4c-08 ... one for the notice');
select pg_temp.eq($$(select count(*) from public.event_changes c join public.events e on e.id = c.event_id where c.decided_by = 'rule:notice' and e.title in ('Fx Fridays', 'Country Fridays at Alibi'))$$, '0', 'AC-R4c-08 ... and none for a series occurrence');
select pg_temp.eq($$private.hide_notice_events()$$, '0', 'AC-R4c-08 running it again hides nothing');

-- clean_source_item: an item "NO Fx Fridays Tonight" at D with the 2-occurrence series is rejected as a notice ---------------
create function pg_temp.clean(p_item jsonb) returns jsonb language plpgsql as $$
begin return private.clean_source_item((select s from public.sources s where s.slug = 'r4c-src'), p_item);
exception when others then return jsonb_build_object('error', sqlstate || ':' || sqlerrm); end $$;
select is(pg_temp.clean(pg_temp.item('c1', 'NO Fx Fridays Tonight', 20, 19)) -> 'reject', '"notice"'::jsonb, 'AC-R4c-08 clean_source_item rejects the notice when the 2-occurrence series exists');
select is(pg_temp.clean(pg_temp.item('c2', 'NO Fx Single Tonight', 20, 19)) ? 'reject', false, 'AC-R4c-08 ... and does not with only one occurrence');
select is(pg_temp.clean(pg_temp.item('c3', 'NO Fx Cluster Tonight', 20, 19)) ? 'reject', false, 'AC-R4c-08 ... nor with a same-day sibling matched only through events.title');
select is(pg_temp.clean(pg_temp.item('c4', 'NO Fx Retitled Tonight', 20, 19)) -> 'reject', '"notice"'::jsonb, 'AC-R4c-08 ... but does when the series is retitled at the cluster and matches on source_events.title');

select * from finish();
rollback;
