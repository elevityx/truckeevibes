-- AC-R4a-01 ... 08: kids category, notice titles, reason codes, tag_reasons through the ingest path, notice hide. Written failing first.
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
select pg_temp.mk_source('r4a-auto', 'organizer', 'auto');
create temp table notice_cases (title text, expect boolean);
insert into notice_cases (title, expect) values
  ('Example Ale Works Closing at 4PM Today', true),
  ('NO Country Fridays Tonight', true),
  ('Kitchen Closed for Maintenance', true),
  ('Holiday Hours at Example Hall', true),
  ('Closed Today for a Private Event', true),
  ('Closing Early Tonight', true),
  ('Special Hours This Week', true),
  ('No Trivia Today', true),
  ('Season Closing Party', false),
  ('Closing Party with Example Band', false),
  ('No Cover Fridays', false),
  ('No Host Bar Mixer', false),
  ('Country Fridays', false),
  ('Closed Captioned Film Night', false),
  ('Notice Board Workshop', false),
  ('Nothing But Bluegrass', false);
create function pg_temp.clean(p_item jsonb) returns jsonb language plpgsql as $$
begin return private.clean_source_item((select s from public.sources s where s.slug = 'r4a-src'), p_item);
exception when others then return jsonb_build_object('error', sqlstate || ':' || sqlerrm); end $$;
create temp table codes (n int, code text);
insert into codes (n, code) select o, c from unnest(array[
    'cat:source_map','cat:title_kw','cat:desc_kids','cat:desc_family','cat:default',
    'price:text_free','price:text_paid','price:text_donation','price:desc_free','price:title_free','price:neg_blocked','price:unknown',
    'age:21_admission','age:18_admission','age:adult_phrase','age:all_ages','age:family','age:ambiguous','age:unknown',
    'conflict:adult','conflict:adult_signal','notice:cancel_sibling']) with ordinality t(c, o);

-- AC-R4a-01 ----------------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select label || '|' || sort || '|' || noun from public.categories where slug = 'kids')$$, 'Kids|5|kids'' event', 'AC-R4a-01 kids: label Kids, sort 5, noun kids'' event');
select pg_temp.eq($$(select sort from public.categories where slug = 'arts')$$, '6', 'AC-R4a-01 arts now sorts 6');
select pg_temp.eq($$(select string_agg(slug, ',' order by sort) from public.categories where sort between 4 and 7)$$, 'family,kids,arts,community', 'AC-R4a-01 sort order family, kids, arts, community');
select pg_temp.eq($$(select max(sort) || '/' || count(*) || '/' || count(distinct sort) from public.categories)$$, '13/13/13', 'AC-R4a-01 13 categories, sorts 1..13 all distinct');
select pg_temp.ing('k1', 'r4a-auto', jsonb_build_array(pg_temp.item('k-a', 'R4a Kids Craft Hour', 10, 11, '{"categoriesHint":["arts","kids","family"]}')));
select pg_temp.eq($$(select categories::text from public.list_events(120) where title = 'R4a Kids Craft Hour')$$, '{family,kids,arts}', 'AC-R4a-01 list_events orders {family, kids, arts} as family, kids, arts');

-- AC-R4a-02 ----------------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from notice_cases)$$, '16', 'AC-R4a-02 the parity table has 16 rows');
select pg_temp.eq($$(select count(*) from notice_cases where private.is_notice_title(title) is distinct from expect)$$, '0', 'AC-R4a-02 is_notice_title returns the table value for all 16 rows');
select pg_temp.eq($$(select count(*) from notice_cases where private.is_notice_title(title) = expect and expect)$$, '8', 'AC-R4a-02 ... 8 notices');
select pg_temp.eq($$private.is_notice_title(null)$$, 'false', 'AC-R4a-02 is_notice_title(null) is false');
select pg_temp.eq($$private.is_notice_title(null) is null$$, 'false', 'AC-R4a-02 ... and not null');

-- AC-R4a-03 ----------------------------------------------------------------------------------------------------------
select is(pg_temp.clean(pg_temp.item('n1', 'NO Country Fridays Tonight', 5)) -> 'reject', '"notice"'::jsonb, 'AC-R4a-03 clean_source_item rejects ''NO Country Fridays Tonight'' with reject notice');
select is(pg_temp.clean(pg_temp.item('n2', 'Country Fridays', 5)) ? 'reject', false, 'AC-R4a-03 ''Country Fridays'' is not a reject');
select is(pg_temp.clean(pg_temp.item('n3', 'Country Fridays', 5)) ? 'tag_reasons', true, 'AC-R4a-03 ... and returns a tag_reasons key');

-- AC-R4a-04 ----------------------------------------------------------------------------------------------------------
create function pg_temp.mk_pub(p_title text, p_origin text default 'ingest', p_locked text[] default '{}') returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.events (region_id, title, summary, starts_at, time_known, status, origin, locked_fields, published_at)
    values (private.region_id(), p_title, 'Fixture summary for the notice hide.', now() + interval '10 days', true, 'published', p_origin, p_locked, now())
    returning id into v_id;
  return v_id;
end $$;
select pg_temp.mk_pub('Fx Closing Early Tonight');
select pg_temp.mk_pub('Fx Locked Closed Today for a Private Event', 'ingest', array['title']);
select pg_temp.mk_pub('Fx Admin Kitchen Closed for Maintenance', 'admin');
select pg_temp.mk_pub('Fx Country Fridays');
select pg_temp.eq($$private.hide_notice_events()$$, '1', 'AC-R4a-04 the hide statement reports exactly one event hidden');
select pg_temp.eq($$(select status || '|' || status_by_admin || '|' || reject_reason from public.events where title = 'Fx Closing Early Tonight')$$, 'hidden|true|notice', 'AC-R4a-04 published ingest notice -> hidden, status_by_admin, reject_reason notice');
select pg_temp.eq($$(select count(*) from public.event_changes c join public.events e on e.id = c.event_id where e.title = 'Fx Closing Early Tonight' and c.decided_by = 'rule:notice' and c.field = 'status' and c.old_value = '"published"' and c.new_value = '"hidden"')$$, '1', 'AC-R4a-04 ... with one event_changes row rule:notice');
select pg_temp.eq($$(select status::text from public.events where title = 'Fx Locked Closed Today for a Private Event')$$, 'published', 'AC-R4a-04 locked title -> unchanged');
select pg_temp.eq($$(select status::text from public.events where title = 'Fx Admin Kitchen Closed for Maintenance')$$, 'published', 'AC-R4a-04 admin-origin notice -> unchanged');
select pg_temp.eq($$(select status::text from public.events where title = 'Fx Country Fridays')$$, 'published', 'AC-R4a-04 published Country Fridays -> unchanged');
select pg_temp.eq($$(select count(*) from public.event_changes where decided_by = 'rule:notice')$$, '1', 'AC-R4a-04 exactly one rule:notice journal row overall');
select pg_temp.eq($$private.hide_notice_events()$$, '0', 'AC-R4a-04 running it again hides nothing');

-- AC-R4a-05 ----------------------------------------------------------------------------------------------------------
select pg_temp.eq($$(select count(*) from codes)$$, '22', 'AC-R4a-05 the vocabulary has 22 codes');
select pg_temp.eq($$(select count(*) from codes where private.valid_reason_code(code))$$, '22', 'AC-R4a-05 valid_reason_code is true for all 22');
select pg_temp.eq($$(select string_agg(private.valid_reason_code(c)::text, ',') from unnest(array['age:made_up', 'AGE:21_admission', '', repeat('a', 41), 'age:21_admission ']) c)$$, 'false,false,false,false,false', 'AC-R4a-05 false for age:made_up, AGE:21_admission, empty, 41 chars, trailing space');
select pg_temp.eq($$private.valid_reason_code(null) is null$$, 'true', 'AC-R4a-05 null in, null out (never a pass)');

-- AC-R4a-06 ----------------------------------------------------------------------------------------------------------
create temp table reasons_in as
  select jsonb_build_array('age:ambiguous', 'bogus', 'age:ambiguous') || (select jsonb_agg(code order by n) from (select code, n from codes where code <> 'age:ambiguous' order by n limit 20) x) as j;
create temp table reasons_out as select pg_temp.clean(pg_temp.item('t6', 'R4a Reasons Show', 8, 18, jsonb_build_object('tagReasons', (select j from reasons_in)))) as r;
select pg_temp.eq($$(select jsonb_array_length(r -> 'tag_reasons') from reasons_out)$$, '16', 'AC-R4a-06 tag_reasons is capped at 16');
select pg_temp.eq($$(select (r -> 'tag_reasons' ->> 0) || '|' || (r -> 'tag_reasons' ->> 1) from reasons_out)$$, 'age:ambiguous|cat:source_map', 'AC-R4a-06 ... deduped, bogus dropped, first-seen order kept');
select pg_temp.eq($$(select (select jsonb_agg(code order by n) from (select code, n from codes where code <> 'age:ambiguous' order by n limit 15) x) = (r -> 'tag_reasons') - 0 from reasons_out)$$, 'true', 'AC-R4a-06 ... the other 15 are the first 15 valid codes in order');
select pg_temp.eq($$(select r -> 'facts' ? 'tag_reasons' from reasons_out)$$, 'false', 'AC-R4a-06 facts has no tag_reasons key');
select pg_temp.eq($$(select private.facts_hash(r -> 'facts') = private.facts_hash(pg_temp.clean(pg_temp.item('t6', 'R4a Reasons Show', 8, 18)) -> 'facts') from reasons_out)$$, 'true', 'AC-R4a-06 facts_hash equals that of the same item without tagReasons');
select is(pg_temp.clean(pg_temp.item('t6', 'R4a Reasons Show', 8, 18, '{"tagReasons":"x"}')) -> 'reject', '"tag_reasons"'::jsonb, 'AC-R4a-06 tagReasons ''x'' -> reject tag_reasons');
select is(pg_temp.clean(pg_temp.item('t6', 'R4a Reasons Show', 8, 18, '{"tagReasons":["age:family", 7]}')) -> 'reject', '"tag_reasons"'::jsonb, 'AC-R4a-06 a non-string element -> reject tag_reasons');
select is(pg_temp.clean(pg_temp.item('t6', 'R4a Reasons Show', 8, 18, '{"tagReasons":null}')) -> 'tag_reasons', '[]'::jsonb, 'AC-R4a-06 tagReasons null -> []');
select is(pg_temp.clean(pg_temp.item('t6', 'R4a Reasons Show', 8, 18)) -> 'tag_reasons', '[]'::jsonb, 'AC-R4a-06 tagReasons absent -> []');

-- AC-R4a-07 + AC-R4a-08 ----------------------------------------------------------------------------------------------
select pg_temp.mk_source('r4a-held', 'organizer', 'review');
create function pg_temp.ten(p_cat text, p_age text, p_changed int, p_reasons jsonb) returns jsonb language sql as $$
  select jsonb_agg(pg_temp.item('h' || n, 'Held Show ' || substr(md5('h' || n), 1, 10), 3 + n, 10,
           case when n <= p_changed then jsonb_build_object('categoriesHint', jsonb_build_array(p_cat), 'age', p_age, 'tagReasons', p_reasons) else '{}'::jsonb end))
    from generate_series(1, 10) n $$;
select pg_temp.rb('h0', 'r4a-held', pg_temp.ten('music', 'unknown', 0, '[]'));
select is(pg_temp.r('h0', 'status') || '/' || pg_temp.r('h0', 'new'), 'ok/10', 'fixture: 10 live occurrences stored');
select pg_temp.seed_runs('r4a-held', 3, 10, 0);
-- plain ingest first: reasons stored on the row and on the version
select pg_temp.mk_source('r4a-ing', 'organizer', 'review');
select pg_temp.rb('i1', 'r4a-ing', jsonb_build_array(pg_temp.item('i-a', 'Ingest Reason Show', 12, 19, '{"tagReasons":["age:21_admission","cat:title_kw"]}')));
select is(pg_temp.r('i1', 'new'), '1', 'fixture: one new occurrence');
select pg_temp.eq($$(select tag_reasons::text from public.source_events where external_key = 'i-a')$$, '{age:21_admission,cat:title_kw}', 'AC-R4a-07 source_events.tag_reasons stored');
select pg_temp.eq($$(select count(*) || '|' || min(v.tag_reasons::text) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.external_key = 'i-a')$$, '1|{age:21_admission,cat:title_kw}', 'AC-R4a-07 the version row carries the reasons');
select pg_temp.rb('i2', 'r4a-ing', jsonb_build_array(pg_temp.item('i-a', 'Ingest Reason Show', 12, 19, '{"tagReasons":["age:all_ages"]}')));
select pg_temp.eq($$(select tag_reasons::text from public.source_events where external_key = 'i-a')$$, '{age:all_ages}', 'AC-R4a-07 same facts, different reasons -> source_events.tag_reasons updated');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.external_key = 'i-a')$$, '1', 'AC-R4a-07 ... without a new version row');
-- the surge: 6 of 10 change categories/age (and carry reasons)
create temp table s08 as select pg_temp.snap('public.source_events') se, pg_temp.snap('public.source_event_versions') v,
                                (select count(*) from public.held_runs where source_id = (select id from public.sources where slug = 'r4a-held')) h;
select pg_temp.rb('h1', 'r4a-held', pg_temp.ten('kids', 'family', 6, '["cat:title_kw","age:family"]'));
select is(pg_temp.r('h1', 'status'), 'anomaly', 'AC-R4a-08 10 live, 3 prior ok runs, 6 categories/age edits -> anomaly');
select is(pg_temp.reasons('h1'), '["edit_surge"]', 'AC-R4a-08 ... reason edit_surge');
select pg_temp.eq($$(select count(*) - (select h from s08) from public.held_runs where source_id = (select id from public.sources where slug = 'r4a-held'))$$, '1', 'AC-R4a-08 one new held_runs row');
select pg_temp.t($$(select pg_temp.snap('public.source_events') = se and pg_temp.snap('public.source_event_versions') = v from s08)$$, 'AC-R4a-08 no source_events or version change');
select pg_temp.eq($$(select count(*) from public.held_runs h, jsonb_array_elements(h.items) i where h.run_id = (select (res ->> 'run_id')::uuid from tres where label = 'h1') and jsonb_array_length(i -> 'tag_reasons') = 2)$$, '6', 'AC-R4a-07 the held run items carry tag_reasons (6 of 10 with 2 codes)');
select pg_temp.mk_admin();
select pg_temp.eq($$(select string_agg(status::text, ',') from public.review_cards where kind = 'held_run' and held_run_id = (select (res ->> 'run_id')::uuid from tres where label = 'h1'))$$, 'open', 'fixture: one open held_run card');
select is(pg_temp.x('admin', format($$select public.admin_decide_card(%L, 'accept', null, 30)$$,
  (select id from public.review_cards where kind = 'held_run' and held_run_id = (select (res ->> 'run_id')::uuid from tres where label = 'h1')))), 'OK', 'AC-R4a-07 admin_decide_card(accept) succeeds');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'r4a-held') and tag_reasons = '{cat:title_kw,age:family}')$$, '6', 'AC-R4a-07 ... and stores the reasons on the 6 source_events');
select pg_temp.eq($$(select count(*) from public.source_event_versions v join public.source_events se on se.id = v.source_event_id where se.source_id = (select id from public.sources where slug = 'r4a-held') and v.tag_reasons = '{cat:title_kw,age:family}')$$, '6', 'AC-R4a-07 ... and on 6 new version rows');

select * from finish();
rollback;
