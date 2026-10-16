-- AC-R2a-01 ... 11: list_event_pages() (manifest RPC, DR15), the write-once published_at marker and the suppression helper.
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

-- ---------------------------------------------------------------------------------------------------------------------
-- Fixture helpers for this file
-- ---------------------------------------------------------------------------------------------------------------------
insert into public.venues (id, name, normalized_name, address, town, lat, lng)
  values ('f2a00000-0000-4000-a000-000000000001', 'R2a Fixture Hall', 'r2a fixture hall', '1 Fixture Way', 'Truckee', 39.328, -120.1833);

-- one event row through plain inserts. A once-published event that is no longer 'published' is built published first,
-- because the write-once marker forbids inserting published_at on any other status.
create function pg_temp.mk_ev(p_title text, p_status text, p_pub boolean, p_start interval, p_end interval default null,
                              p_url text default null, p_created interval default interval '0 seconds', p_id uuid default gen_random_uuid()) returns uuid
language plpgsql as $$
begin
  insert into public.events (id, region_id, title, summary, starts_at, ends_at, time_known, status, published_at, organizer_url, created_at, venue_id)
    values (p_id, (select r.id from public.regions r order by r.slug limit 1), p_title, 'Synthetic summary for ' || p_title,
            now() + p_start, case when p_end is null then null else now() + p_end end, true,
            (case when p_pub then 'published' else p_status end)::public.event_status,
            case when p_pub then now() - interval '1 day' end, p_url, now() + p_created, 'f2a00000-0000-4000-a000-000000000001');
  if p_pub and p_status <> 'published' then
    update public.events set status = p_status::public.event_status where id = p_id;
  end if;
  return p_id;
end $$;
create function pg_temp.eid(p_title text) returns uuid language sql as $$ select id from public.events where title = p_title limit 1 $$;
create function pg_temp.slug_of(p_title text) returns text language sql as $$ select slug from public.events where title = p_title limit 1 $$;
-- the manifest, or null when the function does not exist yet
create function pg_temp.mf() returns jsonb language plpgsql as $$
begin return public.list_event_pages(); exception when others then return null; end $$;
-- the pageState of the page for this title, 'absent', or 'NOFN' when the function is missing
create function pg_temp.pstate(p_title text) returns text language plpgsql as $$
declare m jsonb := pg_temp.mf(); r text;
begin
  if m is null then return 'NOFN'; end if;
  select p ->> 'pageState' into r from jsonb_array_elements(m -> 'pages') p where p ->> 'slug' = pg_temp.slug_of(p_title);
  return coalesce(r, 'absent');
end $$;
create function pg_temp.pobj(p_title text) returns jsonb language plpgsql as $$
declare m jsonb := pg_temp.mf(); r jsonb;
begin
  select p into r from jsonb_array_elements(m -> 'pages') p where p ->> 'slug' = pg_temp.slug_of(p_title);
  return r;
end $$;
-- the survivor slug of the redirect for this loser title, 'absent', or 'NOFN'
create function pg_temp.rd_of(p_title text) returns text language plpgsql as $$
declare m jsonb := pg_temp.mf(); r text;
begin
  if m is null then return 'NOFN'; end if;
  select x ->> 'redirectSlug' into r from jsonb_array_elements(m -> 'redirects') x where x ->> 'slug' = pg_temp.slug_of(p_title);
  return coalesce(r, 'absent');
end $$;
create function pg_temp.merge(p_surv text, p_loser text) returns text language sql as $$
  select pg_temp.x('admin', format($e$select public.admin_merge_events(%L, %L)$e$, pg_temp.eid(p_surv), pg_temp.eid(p_loser))) $$;
create function pg_temp.keys_of(p_obj jsonb) returns text language sql as $$
  select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(p_obj) k $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-01 (plan case 10): published_at is write-once
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_ev('R2a Pending One', 'pending', false, interval '10 days');
select pg_temp.mk_ev('R2a Pub Two', 'published', true, interval '10 days');
select pg_temp.mk_ev('R2a Pending Three', 'pending', false, interval '11 days');
select ok(pg_temp.err(pg_temp.x('postgres', $e$update public.events set published_at = now() where title = 'R2a Pending One'$e$),
  '22023', 'published_at_immutable', 'published_at'), 'AC-R2a-01 setting published_at on a pending event -> published_at_immutable');
select ok(pg_temp.err(pg_temp.x('postgres', $e$update public.events set published_at = now() where title = 'R2a Pub Two'$e$),
  '22023', 'published_at_immutable', 'published_at'), 'AC-R2a-01 changing a set published_at -> published_at_immutable');
select ok(pg_temp.err(pg_temp.x('postgres', $e$update public.events set published_at = null where title = 'R2a Pub Two'$e$),
  '22023', 'published_at_immutable', 'published_at'), 'AC-R2a-01 clearing published_at -> published_at_immutable');
select ok(pg_temp.err(pg_temp.x('postgres', $e$insert into public.events (region_id, title, summary, starts_at, time_known, status, published_at)
  select r.id, 'R2a Bad Insert', 'Synthetic summary text', now() + interval '9 days', true, 'pending', now() from public.regions r limit 1$e$),
  '22023', 'published_at_immutable', 'published_at'), 'AC-R2a-01 an insert with published_at and status pending -> published_at_immutable');
select is(pg_temp.x('postgres', $e$update public.events set featured = true, title = 'R2a Pub Two' where title = 'R2a Pub Two'$e$), 'OK',
  'AC-R2a-01 an update that leaves published_at alone still works');
select is(pg_temp.x('postgres', $e$select private.admin_set_status(id, 'published', 'ok', 'e1500000-0000-4000-a000-000000000001') from public.events where title = 'R2a Pending One'$e$), 'OK',
  'AC-R2a-01 admin_set_status(published) runs on a pending event');
select pg_temp.t($$(select published_at is not null from public.events where title = 'R2a Pending One')$$, 'AC-R2a-01 ... and sets published_at');
select is(pg_temp.x('postgres', $e$update public.events set status = 'published', published_at = now() where title = 'R2a Pending Three'$e$), 'OK',
  'AC-R2a-01 the publishing transition may set published_at together with the status');
select pg_temp.t($$(select published_at is not null from public.events where title = 'R2a Pending Three')$$, 'AC-R2a-01 ... and it is set');
create temp table pub_before as select published_at as p from public.events where title = 'R2a Pending One';
select pg_temp.x('postgres', $e$select private.admin_set_status(id, 'hidden', 'r', 'e1500000-0000-4000-a000-000000000001') from public.events where title = 'R2a Pending One'$e$);
select pg_temp.t($$(select e.published_at = (select p from pub_before) from public.events e where e.title = 'R2a Pending One')$$, 'AC-R2a-01 a later hide carries published_at forward unchanged');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-02 / 03 (cases 1-3): never-published events are absent; a published one that is then cancelled stays as 'cancelled'
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_source('r2-auto', 'organizer', 'auto');
select pg_temp.mk_source('r2-rev', 'organizer', 'review');
select pg_temp.ing('a1', 'r2-auto', jsonb_build_array(
  pg_temp.item('c1', 'R2a Cancelled First Seen', 40, 18, '{"cancelled":true}'),
  pg_temp.item('pc1', 'R2a Published Then Cancelled', 43)));
select is(pg_temp.ev_status('pc1'), 'published', 'fixture: the auto-source event is published (recompute_event sets published_at)');
select pg_temp.t($$(select e.published_at is not null from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'pc1')$$, 'AC-R2a-01 recompute_event that publishes still sets published_at');
select pg_temp.ing('r1', 'r2-rev', jsonb_build_array(
  pg_temp.item('p1', 'R2a Pending Review Only', 41),
  pg_temp.item('p2', 'R2a Pending Then Cancelled', 42)));
select pg_temp.ing('r2', 'r2-rev', jsonb_build_array(
  pg_temp.item('p1', 'R2a Pending Review Only', 41),
  pg_temp.item('p2', 'R2a Pending Then Cancelled', 42, 18, '{"cancelled":true}')));
select pg_temp.rb('o1', 'r2-auto', jsonb_build_array(pg_temp.item('o1', 'R2a Outside Region', 44, 18, '{"venueName":"R2a Far Hall"}')));
update public.venues set outside_region = true where name = 'R2a Far Hall';
select pg_temp.cluster_all();
select pg_temp.ing('a2', 'r2-auto', jsonb_build_array(pg_temp.item('c1', 'R2a Cancelled First Seen', 40, 18, '{"cancelled":true}'),
  pg_temp.item('pc1', 'R2a Published Then Cancelled', 43, 18, '{"cancelled":true}'),
  pg_temp.item('o1', 'R2a Outside Region', 44, 18, '{"venueName":"R2a Far Hall"}')));
select is(pg_temp.ev_status('c1'), 'cancelled', 'fixture: first-seen cancelled -> cancelled');
select pg_temp.eq($$(select published_at is null from public.events e join public.source_events se on se.cluster_id = e.id where se.external_key = 'c1')$$, 'true', 'AC-R2a-02 ... with published_at null');
select is(pg_temp.pstate('R2a Cancelled First Seen'), 'absent', 'AC-R2a-02 a first-seen cancelled occurrence is absent from list_event_pages()');
select is(pg_temp.ev_status('p2'), 'cancelled', 'fixture: a pending event whose sources all cancel -> cancelled');
select is(pg_temp.pstate('R2a Pending Then Cancelled'), 'absent', 'AC-R2a-02 a pending event whose sources all cancel is absent');
select is(pg_temp.ev_status('p1'), 'pending', 'fixture: review-only source -> pending');
select is(pg_temp.pstate('R2a Pending Review Only'), 'absent', 'AC-R2a-02 a review-only source event is absent');
select is(pg_temp.ev_status('o1'), 'rejected', 'fixture: outside-region venue -> rejected');
select is(pg_temp.pstate('R2a Outside Region'), 'absent', 'AC-R2a-02 an outside-region event is absent');

select is(pg_temp.ev_status('pc1'), 'cancelled', 'fixture: the published event, after all sources cancel -> cancelled');
select is(pg_temp.pstate('R2a Published Then Cancelled'), 'cancelled', 'AC-R2a-03 published then cancelled -> pageState cancelled');
select pg_temp.eq($$(select (o ->> 'title') || '|' || (o ->> 'venue') || '|' || (o ->> 'town') || '|' || jsonb_array_length(o -> 'categories') || '|' || (o -> 'sources')::text
  from (select pg_temp.pobj('R2a Published Then Cancelled') o) x)$$, 'R2a Published Then Cancelled|Test Hall|Truckee|1|["Src r2-auto"]',
  'AC-R2a-03 ... with title, venue, town, categories and sources filled');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-04 / 05 / 06 (cases 4-7): merged losers
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_ev('R2a Survivor A', 'published', true, interval '20 days', null, null, interval '-2 days');
select pg_temp.mk_ev('R2a Loser Pending', 'pending', false, interval '20 days');
select pg_temp.mk_ev('R2a Loser Rejected', 'rejected', true, interval '20 days');
select pg_temp.mk_ev('R2a Loser Unlisted', 'unlisted', true, interval '20 days');
select pg_temp.mk_ev('R2a Loser Hidden', 'hidden', true, interval '20 days');
select pg_temp.mk_ev('R2a Loser Published Once', 'published', true, interval '20 days');
select pg_temp.x('postgres', $e$select private.admin_set_status(id, 'hidden', 'r', 'e1500000-0000-4000-a000-000000000001') from public.events where title = 'R2a Loser Published Once'$e$);
-- pgTAP runs in one transaction, so every journal row shares one `at`; the hide happened in an earlier transaction in real life
select set_config('tv.retention', 'on', true);      -- the journal is append-only; the sanctioned transaction-local switch lets this fixture edit through
update public.event_changes set at = at - interval '1 hour' where event_id = (select id from public.events where title = 'R2a Loser Published Once');
select set_config('tv.retention', 'off', true);
select pg_temp.mk_ev('R2a Loser Published', 'published', true, interval '20 days');
select pg_temp.mk_ev('R2a Loser Cancelled', 'cancelled', true, interval '20 days');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Pending'), 'OK', 'fixture: merge pending loser');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Rejected'), 'OK', 'fixture: merge rejected loser');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Unlisted'), 'OK', 'fixture: merge unlisted loser');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Hidden'), 'OK', 'fixture: merge hidden loser');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Published Once'), 'OK', 'fixture: merge published-once-then-hidden loser');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Published'), 'OK', 'fixture: merge published loser');
select is(pg_temp.merge('R2a Survivor A', 'R2a Loser Cancelled'), 'OK', 'fixture: merge cancelled loser');
select is(pg_temp.pstate('R2a Survivor A'), 'upcoming', 'fixture: the survivor has an upcoming page');
select is(pg_temp.pstate('R2a Loser Pending') || '/' || pg_temp.rd_of('R2a Loser Pending'), 'absent/absent', 'AC-R2a-04 pending loser: no page, no redirect');
select is(pg_temp.pstate('R2a Loser Rejected') || '/' || pg_temp.rd_of('R2a Loser Rejected'), 'absent/absent', 'AC-R2a-04 rejected loser: no page, no redirect');
select is(pg_temp.pstate('R2a Loser Unlisted') || '/' || pg_temp.rd_of('R2a Loser Unlisted'), 'absent/absent', 'AC-R2a-04 unlisted loser: no page, no redirect');
select is(pg_temp.pstate('R2a Loser Hidden') || '/' || pg_temp.rd_of('R2a Loser Hidden'), 'absent/absent', 'AC-R2a-04 admin-hidden loser: no page, no redirect');
select is(pg_temp.pstate('R2a Loser Published Once') || '/' || pg_temp.rd_of('R2a Loser Published Once'), 'absent/absent', 'AC-R2a-04 published once, admin-hidden, then merged: no page, no redirect');
select is(pg_temp.rd_of('R2a Loser Published'), pg_temp.slug_of('R2a Survivor A'), 'AC-R2a-05 a loser published at merge time -> a redirect to the survivor');
select is(pg_temp.pstate('R2a Loser Published'), 'absent', 'AC-R2a-05 ... and no page of its own');
select is(pg_temp.keys_of((select x from jsonb_array_elements(pg_temp.mf() -> 'redirects') x where x ->> 'slug' = pg_temp.slug_of('R2a Loser Published'))),
  'redirectSlug,slug', 'AC-R2a-05 ... the redirect object has exactly {slug, redirectSlug}');
select is(pg_temp.rd_of('R2a Loser Cancelled'), pg_temp.slug_of('R2a Survivor A'), 'AC-R2a-05 a previously published loser cancelled at merge time -> a redirect');
select is(pg_temp.pstate('R2a Loser Cancelled'), 'absent', 'AC-R2a-05 ... and no page of its own');

select pg_temp.mk_ev('R2a Survivor Pending', 'pending', false, interval '21 days', null, null, interval '-2 days');
select pg_temp.mk_ev('R2a Survivor Hidden', 'hidden', true, interval '21 days', null, null, interval '-2 days');
select pg_temp.mk_ev('R2a Survivor Old', 'published', true, interval '-33 days', interval '-31 days', null, interval '-2 days');
select pg_temp.mk_ev('R2a Loser To Pending', 'published', true, interval '21 days');
select pg_temp.mk_ev('R2a Loser To Hidden', 'published', true, interval '21 days');
select pg_temp.mk_ev('R2a Loser To Old', 'published', true, interval '21 days');
select is(pg_temp.merge('R2a Survivor Pending', 'R2a Loser To Pending'), 'OK', 'fixture: merge into a pending survivor');
select is(pg_temp.merge('R2a Survivor Hidden', 'R2a Loser To Hidden'), 'OK', 'fixture: merge into a hidden survivor');
select is(pg_temp.merge('R2a Survivor Old', 'R2a Loser To Old'), 'OK', 'fixture: merge into a survivor that ended 31 days ago');
select is(pg_temp.rd_of('R2a Loser To Pending'), 'absent', 'AC-R2a-06 survivor pending -> no redirect');
select is(pg_temp.rd_of('R2a Loser To Hidden'), 'absent', 'AC-R2a-06 survivor hidden -> no redirect');
select is(pg_temp.rd_of('R2a Loser To Old'), 'absent', 'AC-R2a-06 survivor ended 31 days ago -> no redirect');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-07 (case 8): suppressions
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_ev('R2a Loser Sup Event', 'published', true, interval '22 days', null, 'https://r2sup-ev.example.test/a');
select pg_temp.mk_ev('R2a Loser Sup Prefix', 'published', true, interval '22 days', null, 'https://r2sup-pre.example.test/a/b');
select pg_temp.mk_ev('R2a Loser Sup Host', 'published', true, interval '22 days', null, 'https://www.r2sup-host.example.test/a');
select pg_temp.merge('R2a Survivor A', 'R2a Loser Sup Event');
select pg_temp.merge('R2a Survivor A', 'R2a Loser Sup Prefix');
select pg_temp.merge('R2a Survivor A', 'R2a Loser Sup Host');
select is(pg_temp.rd_of('R2a Loser Sup Event') || '|' || pg_temp.rd_of('R2a Loser Sup Prefix') || '|' || pg_temp.rd_of('R2a Loser Sup Host'),
  pg_temp.slug_of('R2a Survivor A') || '|' || pg_temp.slug_of('R2a Survivor A') || '|' || pg_temp.slug_of('R2a Survivor A'),
  'fixture: all three losers have a redirect before any suppression');
select is(pg_temp.x('admin', format($e$select public.admin_add_suppression('event', %L, 'r')$e$, pg_temp.eid('R2a Loser Sup Event'))), 'OK', 'fixture: event suppression');
select is(pg_temp.x('admin', $e$select public.admin_add_suppression('url_prefix', 'https://r2sup-pre.example.test/a', 'r')$e$), 'OK', 'fixture: url_prefix suppression');
select is(pg_temp.x('admin', $e$select public.admin_add_suppression('host', 'r2sup-host.example.test', 'r')$e$), 'OK', 'fixture: host suppression');
select is(pg_temp.rd_of('R2a Loser Sup Event'), 'absent', 'AC-R2a-07 event suppression -> the loser redirect is gone');
select is(pg_temp.rd_of('R2a Loser Sup Prefix'), 'absent', 'AC-R2a-07 url_prefix suppression -> the loser redirect is gone');
select is(pg_temp.rd_of('R2a Loser Sup Host'), 'absent', 'AC-R2a-07 host suppression -> the loser redirect is gone');

create temp table suppression_cases (n int primary key, kind text, value text, url text, expected boolean);
insert into suppression_cases values
  (1, 'host', 'r2s1.example.test', 'https://r2s1.example.test/x', true),
  (2, 'host', 'r2s2.example.test', 'https://www.r2s2.example.test/x', true),
  (3, 'host', 'r2s3.example.test', 'https://notr2s3.example.test/x', false),
  (4, 'host', 'r2s4.example.test', 'https://R2S4.Example.Test/x', true),
  (5, 'url_prefix', 'https://r2s5.example.test/a/', 'https://r2s5.example.test/a/b', true),
  (6, 'url_prefix', 'https://r2s6.example.test/a/', 'https://r2s6.example.test/b', false),
  (7, 'host', 'r2s7.example.test', null, false),
  (8, 'event', 'f3000000-0000-4000-a000-000000000008', 'https://r2s8.example.test/x', true),
  (9, 'event', 'f3000000-0000-4000-a000-0000000000ff', 'https://r2s9.example.test/x', false);
select pg_temp.mk_ev('R2a Twin ' || n, 'published', true, interval '23 days', null, url, interval '0 seconds',
  ('f3000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid) from suppression_cases order by n;
select is((select count(*) filter (where pg_temp.x('admin', format($e$select public.admin_add_suppression(%L, %L, 'r')$e$, kind, value)) <> 'OK') from suppression_cases),
  0::bigint, 'fixture: every suppression of the shared case table is added');
select is(pg_temp.q(format($e$private.event_matches_suppression((select e from public.events e where e.id = %L))$e$, ('f3000000-0000-4000-a000-' || lpad(n::text, 12, '0')))), expected::text,
  'AC-R2a-07 event_matches_suppression case ' || n || ' (' || kind || ') = ' || expected) from suppression_cases order by n;
select is((select (e.status = 'hidden')::text from public.events e where e.id = ('f3000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid), expected::text,
  'AC-R2a-07 admin_add_suppression hides the non-merged twin of case ' || n || ' exactly when the helper matches') from suppression_cases order by n;

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-08 (case 9): non-merged events and the time window
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_ev('R2a NM Hidden', 'hidden', false, interval '24 days');
select pg_temp.mk_ev('R2a NM Rejected', 'rejected', false, interval '24 days');
select pg_temp.mk_ev('R2a NM Pending', 'pending', false, interval '24 days');
select pg_temp.mk_ev('R2a NM Unlisted', 'unlisted', true, interval '24 days');
select pg_temp.mk_ev('R2a NM Admin Hidden', 'published', true, interval '24 days');
select pg_temp.x('postgres', $e$select private.admin_set_status(id, 'hidden', 'r', 'e1500000-0000-4000-a000-000000000001') from public.events where title = 'R2a NM Admin Hidden'$e$);
select pg_temp.mk_ev('R2a NM Suppressed', 'published', true, interval '24 days', null, 'https://r2s-gone.example.test/x');
select pg_temp.x('admin', $e$select public.admin_add_suppression('host', 'r2s-gone.example.test', 'r')$e$);
select pg_temp.mk_ev('R2a NM No Published At', 'published', false, interval '24 days');
select pg_temp.mk_ev('R2a NM Far Future', 'published', true, interval '121 days');
select pg_temp.mk_ev('R2a NM Ended 31d', 'published', true, interval '-31 days' - interval '2 hours', interval '-31 days');
select pg_temp.mk_ev('R2a NM Ended 29d', 'published', true, interval '-29 days' - interval '2 hours', interval '-29 days');
select pg_temp.mk_ev('R2a NM Ended 30m', 'published', true, interval '-150 minutes', interval '-30 minutes');
select pg_temp.mk_ev('R2a NM Ended 90m', 'published', true, interval '-210 minutes', interval '-90 minutes');
select pg_temp.mk_ev('R2a NM Open Cancelled', 'cancelled', true, interval '25 days');
select is(pg_temp.pstate(t), 'absent', 'AC-R2a-08 absent: ' || t) from unnest(array[
  'R2a NM Hidden', 'R2a NM Rejected', 'R2a NM Pending', 'R2a NM Unlisted', 'R2a NM Admin Hidden', 'R2a NM Suppressed',
  'R2a NM No Published At', 'R2a NM Far Future', 'R2a NM Ended 31d']) t;
select is(pg_temp.pstate('R2a NM Ended 29d'), 'ended', 'AC-R2a-08 a published event that ended 29 days ago -> ended');
select pg_temp.eq($$(select (o ->> 'title') || '|' || (o ->> 'venue') || '|' || (o ->> 'town') || '|' || (o ->> 'priceKind') || '|' || (o ->> 'age') from (select pg_temp.pobj('R2a NM Ended 29d') o) x)$$,
  'R2a NM Ended 29d|R2a Fixture Hall|Truckee|unknown|unknown', 'AC-R2a-08 ... with its facts');
select is(pg_temp.pstate('R2a NM Ended 30m'), 'upcoming', 'AC-R2a-08 one that ended 30 minutes ago -> upcoming (the list_events grace hour)');
select is(pg_temp.pstate('R2a NM Ended 90m'), 'ended', 'AC-R2a-08 one that ended 90 minutes ago -> ended');
select is(pg_temp.pstate('R2a NM Open Cancelled'), 'cancelled', 'AC-R2a-08 a published-once cancelled event -> cancelled');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-22 (Amendment R2a-db-1): a redirect resolves the whole merged_into chain to the final winner
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_ev('R2a Chain C', 'published', true, interval '26 days', null, null, interval '-3 days');
select pg_temp.mk_ev('R2a Chain A', 'published', true, interval '26 days', null, null, interval '-2 days');
select pg_temp.mk_ev('R2a Chain B', 'published', true, interval '26 days');
select is(pg_temp.merge('R2a Chain A', 'R2a Chain B'), 'OK', 'fixture: B merged into A');
select is(pg_temp.merge('R2a Chain C', 'R2a Chain A'), 'OK', 'fixture: A merged into C');
select is(pg_temp.rd_of('R2a Chain B'), pg_temp.slug_of('R2a Chain C'), 'AC-R2a-22 B -> A -> C: B redirects to the final winner C');
select is(pg_temp.rd_of('R2a Chain A'), pg_temp.slug_of('R2a Chain C'), 'AC-R2a-22 A redirects to C');
select is(pg_temp.pstate('R2a Chain B') || '/' || pg_temp.pstate('R2a Chain A'), 'absent/absent', 'AC-R2a-22 neither loser has a page');
select pg_temp.mk_ev('R2a Chain2 C', 'published', true, interval '26 days', null, null, interval '-3 days');
select pg_temp.mk_ev('R2a Chain2 A', 'published', true, interval '26 days', null, null, interval '-2 days');
select pg_temp.mk_ev('R2a Chain2 B', 'published', true, interval '26 days');
select pg_temp.merge('R2a Chain2 A', 'R2a Chain2 B');
select pg_temp.merge('R2a Chain2 C', 'R2a Chain2 A');
select pg_temp.x('postgres', $e$select private.admin_set_status(id, 'hidden', 'r', 'e1500000-0000-4000-a000-000000000001') from public.events where title = 'R2a Chain2 C'$e$);
select is(pg_temp.rd_of('R2a Chain2 B') || '/' || pg_temp.rd_of('R2a Chain2 A'), 'absent/absent', 'AC-R2a-22 with the final winner C hidden, neither B nor A redirects');
-- a 2-cycle (impossible through the RPCs, forced here): no redirect and no error
select pg_temp.mk_ev('R2a Cycle X', 'published', true, interval '26 days');
select pg_temp.mk_ev('R2a Cycle Y', 'published', true, interval '26 days');
update public.events set merged_into = case title when 'R2a Cycle X' then pg_temp.eid('R2a Cycle Y') else pg_temp.eid('R2a Cycle X') end, status = 'hidden'
 where title in ('R2a Cycle X', 'R2a Cycle Y');
insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
  select e.id, 'status', '"published"'::jsonb, '"hidden"'::jsonb, 'admin:e1500000-0000-4000-a000-000000000001' from public.events e where e.title in ('R2a Cycle X', 'R2a Cycle Y');
insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
  select e.id, 'merged_into', null, to_jsonb(e.merged_into), 'admin:e1500000-0000-4000-a000-000000000001' from public.events e where e.title in ('R2a Cycle X', 'R2a Cycle Y');
select ok(pg_temp.mf() is not null, 'AC-R2a-22 a 2-cycle does not raise');
select is(pg_temp.rd_of('R2a Cycle X') || '/' || pg_temp.rd_of('R2a Cycle Y'), 'absent/absent', 'AC-R2a-22 a 2-cycle yields no redirect');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-09 (case 11): the envelope
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.eq($$pg_get_function_result('public.list_event_pages()'::regprocedure)$$, 'jsonb', 'AC-R2a-09 list_event_pages() returns jsonb');
select pg_temp.eq($$(select pronargs from pg_proc where oid = 'public.list_event_pages()'::regprocedure)$$, '0', 'AC-R2a-09 ... with no arguments');
select pg_temp.eq($$(select prosecdef::text || '|' || (proconfig = array['search_path=""'])::text || '|' || provolatile::text from pg_proc where oid = 'public.list_event_pages()'::regprocedure)$$, 'true|true|s',
  'AC-R2a-09 ... security definer, search_path pinned, stable');
select is(pg_temp.keys_of(pg_temp.mf()), 'pageCapHit,pageTotal,pages,redirectCapHit,redirectTotal,redirects,v', 'AC-R2a-09 the envelope has exactly the seven DR15 keys');
select is(pg_temp.mf() ->> 'v', '1', 'AC-R2a-09 v = 1');
select is(jsonb_typeof(pg_temp.mf()), 'object', 'AC-R2a-09 the result is one JSON object');
select is((select count(*) from jsonb_array_elements(pg_temp.mf() -> 'pages') p where p ->> 'pageState' = 'upcoming'
             and pg_temp.keys_of(p) <> 'pageState,slug'), 0::bigint, 'AC-R2a-09 every upcoming page object has exactly {slug, pageState}');
select ok((select count(*) from jsonb_array_elements(pg_temp.mf() -> 'pages') p where p ->> 'pageState' = 'upcoming') > 0, 'AC-R2a-09 (self-check) there are upcoming pages');
select is((select count(*) from jsonb_array_elements(pg_temp.mf() -> 'pages') p where p ->> 'pageState' in ('ended', 'cancelled')
             and pg_temp.keys_of(p) <> 'address,age,allDay,categories,endDate,endsAt,lat,lng,pageState,priceKind,priceMax,priceMin,slug,sources,startDate,startsAt,summary,timeKnown,title,town,url,venue'),
  0::bigint, 'AC-R2a-09 every ended/cancelled page object has exactly slug, pageState and the 20 fact keys');
select ok((select count(*) from jsonb_array_elements(pg_temp.mf() -> 'pages') p where p ->> 'pageState' in ('ended', 'cancelled')) >= 3, 'AC-R2a-09 (self-check) there are ended and cancelled pages');
select is((select count(*) from jsonb_array_elements(pg_temp.mf() -> 'redirects') x where pg_temp.keys_of(x) <> 'redirectSlug,slug'), 0::bigint,
  'AC-R2a-09 every redirect object has exactly {slug, redirectSlug}');
select ok((select count(*) from jsonb_array_elements(pg_temp.mf() -> 'redirects')) >= 2, 'AC-R2a-09 (self-check) there are redirects');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-11 (case 13): privileges
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.eq($$has_function_privilege('anon', 'public.list_event_pages()', 'EXECUTE')$$, 'true', 'AC-R2a-11 anon can execute list_event_pages()');
select pg_temp.eq($$has_function_privilege('authenticated', 'public.list_event_pages()', 'EXECUTE')$$, 'true', 'AC-R2a-11 authenticated can execute list_event_pages()');
select pg_temp.eq($$has_function_privilege('public', 'public.list_event_pages()', 'EXECUTE')$$, 'false', 'AC-R2a-11 PUBLIC cannot execute list_event_pages()');
select pg_temp.eq($$has_function_privilege('service_role', 'public.list_event_pages()', 'EXECUTE')$$, 'false', 'AC-R2a-11 service_role cannot execute list_event_pages()');
select pg_temp.eq($$has_function_privilege('anon', 'private.event_matches_suppression(public.events)', 'EXECUTE')$$, 'false', 'AC-R2a-11 anon cannot execute the suppression helper');
select pg_temp.eq($$has_function_privilege('authenticated', 'private.event_matches_suppression(public.events)', 'EXECUTE')$$, 'false', 'AC-R2a-11 authenticated cannot execute the suppression helper');
select pg_temp.eq($$has_function_privilege('public', 'private.event_matches_suppression(public.events)', 'EXECUTE')$$, 'false', 'AC-R2a-11 PUBLIC cannot execute the suppression helper');
select pg_temp.eq($$has_function_privilege('service_role', 'private.event_matches_suppression(public.events)', 'EXECUTE')$$, 'false', 'AC-R2a-11 service_role cannot execute the suppression helper');
select is(pg_temp.v('anon', $$(public.list_event_pages() ->> 'v')$$), '1', 'AC-R2a-11 anon can call list_event_pages()');
select is(pg_temp.v('anon', $$(select count(*) from public.events)$$) like 'ERR:42501%', true, 'AC-R2a-11 anon still has no table privilege');
select pg_temp.eq($$(select count(*) from information_schema.table_privileges where grantee in ('anon', 'authenticated', 'service_role') and table_schema in ('public', 'private'))$$, '0',
  'AC-R2a-11 no table privilege for anon, authenticated or service_role');

-- ---------------------------------------------------------------------------------------------------------------------
-- AC-R2a-10 (case 12): the caps (last: it adds ~3,000 rows)
-- ---------------------------------------------------------------------------------------------------------------------
select pg_temp.mk_ev('R2a Cap Survivor', 'published', true, interval '1 day', null, null, interval '-2 days');
select pg_temp.mk_ev('R2a Cap Loser', 'published', true, interval '1 day');
select is(pg_temp.merge('R2a Cap Survivor', 'R2a Cap Loser'), 'OK', 'fixture: cap loser merged into a survivor inside the first 3,000');
create temp table cap_base as select (pg_temp.mf() ->> 'pageTotal')::int as pt;
insert into public.events (region_id, title, summary, starts_at, time_known, status, published_at, venue_id)
  select (select r.id from public.regions r order by r.slug limit 1), 'R2a Cap Bulk ' || n, 'Synthetic summary for the cap fixture',
         now() + interval '118 days' + n * interval '1 second', true, 'published', now() - interval '1 day', 'f2a00000-0000-4000-a000-000000000001'
    from generate_series(1, (select 3001 - pt from cap_base)) n;
create temp table cap_3001 as select pg_temp.mf() as m;
select pg_temp.eq($$(select jsonb_array_length(m -> 'pages') from cap_3001)$$, '3000', 'AC-R2a-10 3,001 qualifying pages -> pages has 3,000 objects');
select pg_temp.eq($$(select m ->> 'pageTotal' from cap_3001)$$, '3001', 'AC-R2a-10 ... pageTotal 3001');
select pg_temp.eq($$(select m ->> 'pageCapHit' from cap_3001)$$, 'true', 'AC-R2a-10 ... pageCapHit true');
select pg_temp.eq($$(select m ->> 'redirectCapHit' from cap_3001)$$, 'false', 'AC-R2a-10 ... redirectCapHit false');
select pg_temp.eq($$(select count(*) from cap_3001, jsonb_array_elements(m -> 'redirects') x where x ->> 'slug' = pg_temp.slug_of('R2a Cap Loser') and x ->> 'redirectSlug' = pg_temp.slug_of('R2a Cap Survivor'))$$, '1',
  'AC-R2a-10 ... and the redirect (survivor inside the first 3,000) is present');
delete from public.events where title in ('R2a Cap Bulk 1', 'R2a Cap Bulk 2');
create temp table cap_2999 as select pg_temp.mf() as m;
select pg_temp.eq($$(select m ->> 'pageCapHit' from cap_2999)$$, 'false', 'AC-R2a-10 2,999 rows -> pageCapHit false');
select pg_temp.eq($$(select (m ->> 'pageTotal')::int = jsonb_array_length(m -> 'pages') and jsonb_array_length(m -> 'pages') = 2999 from cap_2999)$$, 'true',
  'AC-R2a-10 ... pageTotal = jsonb_array_length(pages) = 2999');

select * from finish();
rollback;
