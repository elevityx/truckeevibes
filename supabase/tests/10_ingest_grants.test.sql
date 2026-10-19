-- AC-M1-02, 03, 04, 05 (+ the nonce contract of S1.2). Failing-first: no ingest object exists until the M1 migrations land.
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

-- fixtures: one source per row of AC-M1-02 -------------------------------------------------------------------------
select pg_temp.mk_source('g-ok');
select pg_temp.mk_source('g-notdue');
select pg_temp.mk_source('g-linkonly', 'organizer', 'link_only');
select pg_temp.mk_source('g-optout');
select pg_temp.mk_source('g-recheck');
select pg_temp.x('postgres', $$select pg_temp.mk_source('g-72h', 'organizer', 'review', array['example.test'], '72h')$$);
insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class) values
  ('g-disabled', 'G disabled', 'https://example.test/d', array['example.test'], 'ics', 'organizer'),
  ('g-prohibited', 'G prohibited', 'https://example.test/p', array['example.test'], 'ics', 'organizer');
update public.sources set ingest_disposition = 'permitted', allowed_methods = '{feed}', terms_url = 'https://example.test/t',
  terms_hash = repeat('b', 64), terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days' where slug = 'g-disabled';
update public.sources set ingest_disposition = 'prohibited' where slug = 'g-prohibited';
-- the gate refuses to enable these states, so build them with the trigger off (fixture only)
alter table public.sources disable trigger sources_gate;
update public.sources set opt_out = true where slug = 'g-optout';
update public.sources set terms_recheck_at = now() - interval '1 second' where slug = 'g-recheck';
update public.sources set next_due_at = now() + interval '1 day' where slug <> 'g-ok';
update public.sources set next_due_at = now() - interval '1 minute' where slug = 'g-ok';
update public.sources set next_due_at = now() + interval '1 hour' where slug = 'g-notdue';
alter table public.sources enable trigger sources_gate;

-- AC-M1-02 ---------------------------------------------------------------------------------------------------------
create temp table g1 as select pg_temp.jb(pg_temp.v('service_role', 'public.svc_issue_run_grants()')) as j;
select pg_temp.eq($$(select jsonb_array_length(j -> 'grants') from g1)$$, '1',
  'AC-M1-02 exactly one grant over {disabled, prohibited, recheck expired, not due, link_only, opt_out, due}');
select pg_temp.eq($$(select j -> 'grants' -> 0 #>> '{source,slug}' from g1)$$, 'g-ok', 'AC-M1-02 ... and it is the due, permitted, enabled source');
select pg_temp.t($$(select (j -> 'grants' -> 0 ->> 'grant') ~ '^[0-9a-f]{64}$' from g1)$$, 'AC-M1-02 the grant token is 64 hex chars');
select pg_temp.t($$(select (j -> 'grants' -> 0 ->> 'run_id')::uuid is not null from g1)$$, 'AC-M1-02 the grant carries a run_id');
select pg_temp.eq($$(select array(select jsonb_object_keys(j -> 'grants' -> 0 -> 'source') order by 1) from g1)$$,
  '{allowed_hosts,allowed_methods,config,content_hash,etag,family,ingest_disposition,last_modified,page_cap,slug,terms_recheck_at}',
  'AC-M1-02 the grant payload source object has exactly the S1.2 keys');
select pg_temp.eq($$jsonb_array_length(public.svc_issue_run_grants() -> 'grants')$$, '0', 'AC-M1-02 an immediate second call issues zero grants');
select pg_temp.eq($$(select count(*) from private.ingest_grants g, g1 where encode(g.token_hash, 'hex') = g1.j -> 'grants' -> 0 ->> 'grant')$$, '0',
  'AC-M1-02 the grant row never stores the token itself');
select pg_temp.eq($$(select count(*) from private.ingest_grants g, g1
            where g.token_hash = extensions.digest(g1.j -> 'grants' -> 0 ->> 'grant', 'sha256')
              and g.source_id = (select id from public.sources where slug = 'g-ok')
              and g.run_id = (g1.j -> 'grants' -> 0 ->> 'run_id')::uuid and g.used_at is null
              and g.expires_at > now() + interval '29 minutes' and g.expires_at <= now() + interval '31 minutes')$$, '1',
  'AC-M1-02 the row stores only sha256(token), the source, run_id, a 30 minute expiry and no used_at');
select pg_temp.t($$(select next_due_at = now() + interval '24 hours' from public.sources where slug = 'g-ok')$$,
  'AC-M1-02 issuing advances next_due_at by the cadence (24h)');

-- AC-M1-61 grant half: cadence 72h is accepted and mapped
update public.sources set next_due_at = now() where slug = 'g-72h';
select pg_temp.t($$(select count(*) = 1 from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g where g #>> '{source,slug}' = 'g-72h')$$,
  'cadence 72h source gets a grant');
select pg_temp.t($$(select next_due_at = now() + interval '72 hours' from public.sources where slug = 'g-72h')$$, '72h cadence advances next_due_at by 72 hours');

-- AC-M1-03 ---------------------------------------------------------------------------------------------------------
create function pg_temp.fresh(p_slug text) returns jsonb language plpgsql as $$
declare v_tok text; v_run text;
begin
  update public.sources set next_due_at = now() + interval '1 day' where slug <> p_slug and next_due_at <= now();
  update public.sources set next_due_at = now() where slug = p_slug;
  select g ->> 'grant', g ->> 'run_id' into v_tok, v_run from jsonb_array_elements(public.svc_issue_run_grants() -> 'grants') g
   where g #>> '{source,slug}' = p_slug;
  return jsonb_build_object('grant', v_tok, 'run_id', v_run);
exception when others then
  return jsonb_build_object('grant', 'ERR:' || sqlstate);
end $$;
create function pg_temp.call_batch(p_grant text, p_items jsonb default '[]', p_run jsonb default '{}') returns text language sql as $$
  select pg_temp.v('service_role', format('public.svc_ingest_batch(%L, %L::jsonb, %L::jsonb)', p_grant,
    (jsonb_build_object('status', 'ok', 'started_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'http_status', 200,
                        'parser_version', 'test-1') || p_run)::text, p_items::text)) $$;
create temp table cnt0 as select pg_temp.n('public.source_runs') runs, pg_temp.n('public.source_events') ses, pg_temp.n('public.events') evs;

select ok(pg_temp.call_batch(repeat('0', 64), jsonb_build_array(pg_temp.item('k1', 'Some Show', 5))) like 'ERR:P0001|grant\_invalid|%',
  'AC-M1-03 unknown token -> grant_invalid (P0001)');
create temp table gu as select pg_temp.fresh('g-ok') as g;
select ok(pg_temp.call_batch((select g ->> 'grant' from gu), '[]') like '{%', 'AC-M1-03 fixture: a good grant with an empty ok batch succeeds');
select ok(pg_temp.call_batch((select g ->> 'grant' from gu), '[]') like 'ERR:P0001|grant\_used|%', 'AC-M1-03 a used grant -> grant_used (P0001)');
create temp table ge as select pg_temp.fresh('g-ok') as g;
select pg_temp.x('postgres', format($$update private.ingest_grants set expires_at = now() - interval '1 second' where token_hash = extensions.digest(%L, 'sha256')$$, (select g ->> 'grant' from ge)));
select ok(pg_temp.call_batch((select g ->> 'grant' from ge), '[]') like 'ERR:P0001|grant\_expired|%', 'AC-M1-03 an expired grant -> grant_expired (P0001)');

create temp table gs1 as select pg_temp.fresh('g-ok') as g;
update public.sources set enabled = false where slug = 'g-ok';
select ok(pg_temp.errm(pg_temp.call_batch((select g ->> 'grant' from gs1), '[]'), 'source_not_permitted'), 'AC-M1-03 source disabled after issue -> source_not_permitted');
update public.sources set enabled = true where slug = 'g-ok';
create temp table gs2 as select pg_temp.fresh('g-ok') as g;
update public.sources set enabled = false where slug = 'g-ok';
update public.sources set ingest_disposition = 'prohibited' where slug = 'g-ok';
select ok(pg_temp.errm(pg_temp.call_batch((select g ->> 'grant' from gs2), '[]'), 'source_not_permitted'), 'AC-M1-03 source set prohibited after issue -> source_not_permitted');
update public.sources set ingest_disposition = 'permitted' where slug = 'g-ok';
update public.sources set enabled = true where slug = 'g-ok';
create temp table gs3 as select pg_temp.fresh('g-ok') as g;
alter table public.sources disable trigger sources_gate;
update public.sources set terms_recheck_at = now() - interval '1 second' where slug = 'g-ok';
alter table public.sources enable trigger sources_gate;
select ok(pg_temp.errm(pg_temp.call_batch((select g ->> 'grant' from gs3), '[]'), 'source_not_permitted'), 'AC-M1-03 recheck passed after issue -> source_not_permitted');
alter table public.sources disable trigger sources_gate;
update public.sources set terms_recheck_at = now() + interval '30 days' where slug = 'g-ok';
alter table public.sources enable trigger sources_gate;
select ok((select pg_temp.n('public.source_runs') = runs + 1 and pg_temp.n('public.source_events') = ses and pg_temp.n('public.events') = evs from cnt0),
  'AC-M1-03 after every refused call the only new source_runs row is the one successful empty batch; source_events and events unchanged');

-- AC-M1-04: payload fields naming another source are ignored -------------------------------------------------------
select pg_temp.mk_source('g-victim');
create temp table s_before as select slug, to_jsonb(s) - 'last_success_at' - 'etag' - 'last_modified' - 'content_hash' - 'consecutive_failures'
  - 'robots_checked_at' - 'robots_hash' - 'ai_bots_blocked' - 'next_due_at' - 'updated_at' as j from public.sources s;
select pg_temp.rb('hostile', 'g-ok', jsonb_build_array(pg_temp.item('h1', 'Hostile Payload Night', 6,
    18, jsonb_build_object('source_id', (select id from public.sources where slug = 'g-victim'), 'source', 'g-victim',
                           'trust', 'auto', 'enabled', false))),
  jsonb_build_object('source_id', (select id from public.sources where slug = 'g-victim'), 'source', 'g-victim', 'trust', 'auto',
                     'enabled', false, 'ingest_disposition', 'prohibited', 'allowed_methods', jsonb_build_array('api'),
                     'etag', 'W/"abc"', 'content_hash', 'abc123', 'last_modified', 'Tue, 01 Dec 2026 00:00:00 GMT'));
select is(pg_temp.r('hostile', 'status'), 'ok', 'AC-M1-04 the hostile batch is accepted as an ordinary ok batch');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'g-ok'))$$, '1',
  'AC-M1-04 the row lands under the grant''s source');
select pg_temp.eq($$(select count(*) from public.source_events where source_id = (select id from public.sources where slug = 'g-victim'))$$, '0',
  'AC-M1-04 ... and none under the source the payload named');
select pg_temp.eq($$(select count(*) from s_before b join public.sources s using (slug)
            where b.j is distinct from (to_jsonb(s) - 'last_success_at' - 'etag' - 'last_modified' - 'content_hash' - 'consecutive_failures'
              - 'robots_checked_at' - 'robots_hash' - 'ai_bots_blocked' - 'next_due_at' - 'updated_at'))$$, '0',
  'AC-M1-04 no sources column outside the run-bookkeeping set changed on any source');
select pg_temp.eq($$(select etag from public.sources where slug = 'g-ok')$$, 'W/"abc"', 'AC-M1-04 bookkeeping from p_run (etag) is stored on the granted source');
select pg_temp.eq($$(select etag from public.sources where slug = 'g-victim')$$, '<null>', 'AC-M1-04 ... and not on the named one');

-- nonce contract (S1.2 svc_ingest_nonce) ---------------------------------------------------------------------------
select pg_temp.eq($$public.svc_ingest_nonce('0123456789abcdef0123456789abcdef')$$, 'true', 'svc_ingest_nonce: a fresh nonce is recorded (true)');
select pg_temp.eq($$public.svc_ingest_nonce('0123456789abcdef0123456789abcdef')$$, 'false', 'svc_ingest_nonce: the same nonce again is a replay (false)');
select pg_temp.x('postgres', $$insert into private.ingest_nonces (nonce, seen_at) values ('ffffffffffffffffffffffffffffffff', now() - interval '2 days')$$);
select pg_temp.eq($$public.svc_ingest_nonce('abcdefabcdefabcdefabcdefabcdefab')$$, 'true', 'svc_ingest_nonce: a third nonce is recorded');
select pg_temp.eq($$(select count(*) from private.ingest_nonces where nonce = 'ffffffffffffffffffffffffffffffff')$$, '0', 'svc_ingest_nonce deletes nonces older than a day');
select ok(pg_temp.x('postgres', $$insert into private.ingest_nonces (nonce) values ('NOT-HEX')$$) like 'ERR:23514%', 'ingest_nonces.nonce must be 32 hex chars (23514)');
select pg_temp.eq($$(select count(*) from pg_indexes where schemaname = 'private' and indexname = 'ingest_nonces_seen_at_idx')$$, '1', 'ingest_nonces_seen_at_idx exists');

-- AC-M1-05: ACL and hostile payloads -------------------------------------------------------------------------------
create temp table svc_calls (sig text, call text);
insert into svc_calls values
  ('svc_ingest_nonce(text)', $$public.svc_ingest_nonce('00000000000000000000000000000000')$$),
  ('svc_issue_run_grants()', $$public.svc_issue_run_grants()$$),
  ('svc_ingest_batch(text, jsonb, jsonb)', $$public.svc_ingest_batch('x', '{}'::jsonb, '[]'::jsonb)$$),
  ('svc_set_venue_geocode(uuid, double precision, double precision, text)', $$public.svc_set_venue_geocode(gen_random_uuid(), 39.3, -120.1, 'nominatim')$$),
  ('svc_cluster_and_publish(integer)', $$public.svc_cluster_and_publish(1)$$),
  ('svc_weekly_report()', $$public.svc_weekly_report()$$);
select is((select count(*)::int from svc_calls c where pg_temp.v('anon', c.call) like 'ERR:42501%'), 6, 'AC-M1-05 anon calling any of the six svc_* -> 42501');
select is((select count(*)::int from svc_calls c where pg_temp.v('user', c.call) like 'ERR:42501%'), 6, 'AC-M1-05 authenticated calling any of the six svc_* -> 42501');
select is(
  array(select format('%s(%s)', p.proname, oidvectortypes(p.proargtypes))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('service_role', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1),
  array['svc_cluster_and_publish(integer)', 'svc_ingest_batch(text, jsonb, jsonb)', 'svc_ingest_nonce(text)',
        'svc_issue_mirror_grant()', 'svc_issue_run_grants()', 'svc_lights_mirror_apply(text, jsonb, jsonb)',   -- + the two W3 mirror routines
        'svc_set_venue_geocode(uuid, double precision, double precision, text)', 'svc_weekly_report()'],
  'AC-M1-05 the service_role EXECUTE list in public is exactly the six svc_* routines + the two W3 mirror routines');
select is(
  array(select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'svc\_%' and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  '{}'::text[], 'AC-M1-05 no svc_* is executable by anon or authenticated');

-- hostile payloads: the protected columns/tables are bit-for-bit unchanged
select pg_temp.mk_source('g-hostile');
create temp table prot0 as select
  pg_temp.snap($$(select slug, trust, ingest_disposition, enabled, allowed_methods, opt_out from public.sources where slug <> 'g-hostile')$$) srcs,
  pg_temp.snap('public.suppressions') sup, pg_temp.snap('public.admins') adm;
select pg_temp.rb('h2', 'g-hostile',
  jsonb_build_array(pg_temp.item('z1', 'Hostile Two', 7, 18, jsonb_build_object('trust', 'auto', 'enabled', true, 'suppressions', jsonb_build_array('x'))),
                    jsonb_build_object('externalKey', 'z2', 'title', 'No Dates At All')),
  jsonb_build_object('trust', 'auto', 'enabled', false, 'ingest_disposition', 'prohibited', 'allowed_methods', jsonb_build_array('html'),
                     'admins', jsonb_build_array('e1500000-0000-4000-a000-000000000002')));
select pg_temp.x('service_role', $$select public.svc_set_venue_geocode((select id from public.venues limit 1), 39.3, -120.1, 'nominatim')$$);
select pg_temp.x('service_role', $$select public.svc_cluster_and_publish(500)$$);
select pg_temp.x('service_role', $$select public.svc_weekly_report()$$);
select ok((select pg_temp.snap('public.suppressions') = sup and pg_temp.snap('public.admins') = adm from prot0),
  'AC-M1-05 hostile payloads leave suppressions and admins unchanged');
select pg_temp.eq($$(select trust::text || '|' || enabled::text || '|' || ingest_disposition::text || '|' || allowed_methods::text from public.sources where slug = 'g-hostile')$$,
  'review|true|permitted|{feed}', 'AC-M1-05 hostile payloads leave trust, enabled, disposition and allowed_methods of the source unchanged');
select ok((select srcs = pg_temp.snap($$(select slug, trust, ingest_disposition, enabled, allowed_methods, opt_out from public.sources where slug <> 'g-hostile')$$) from prot0),
  'AC-M1-05 ... and of every other source');

select * from finish();
rollback;
