-- Sources V2 (Spec_Sources_V2 §3, AC-SV2-02..17). Failing-first: no Sources V2 object exists until 20261101000100_sources_v2.sql lands.
-- Transaction time is constant in this file, so every "age" is a timestamp written relative to now() as postgres, and expiry is
-- simulated by back-dating issued_at / expires_at. Every fixture statement that names a new object runs through pg_temp.x, so a
-- missing object fails assertions, never the whole file.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------------------------------
-- Shared helpers (copied verbatim from 10_ingest_grants.test.sql:12-112; pgTAP files cannot include).
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

-- the item fixture of 10_ingest_grants.test.sql:113-120
create function pg_temp.item(p_key text, p_title text, p_days int, p_hh int default 18, p_over jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('externalKey', p_key, 'title', p_title,
      'startsAt', pg_temp.ts(p_days, p_hh), 'endsAt', pg_temp.ts(p_days, p_hh, 0, 120),
      'allDay', false, 'timeKnown', true, 'venueName', 'Test Hall', 'address', '10 Main St', 'town', 'Truckee',
      'lat', 39.328, 'lng', -120.1833, 'url', 'https://example.test/e/' || p_key,
      'priceKind', 'free', 'age', 'unknown', 'categoriesHint', jsonb_build_array('music')) || p_over
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Sources V2 helpers
-- ---------------------------------------------------------------------------------------------------------------------
-- run an expression as `authenticated` with exactly these claims; error -> 'ERR:<state>|<msg>|<detail>' (03_admin_amr pattern)
create function pg_temp.as_claims(p_claims jsonb, p_expr text) returns text language plpgsql as $$
declare r text; v_msg text; v_detail text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute 'select (' || p_expr || ')::text' into r;
  perform set_config('role', 'postgres', true);
  return coalesce(r, '<null>');
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'postgres', true);
  return 'ERR:' || sqlstate || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
-- the fixture admin's claims with a chosen aal / amr (null amr = no amr key)
create function pg_temp.adm(p_aal text, p_amr jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sub', 'e1500000-0000-4000-a000-000000000001', 'role', 'authenticated', 'is_anonymous', false, 'aal', p_aal)
         || case when p_amr is null then '{}'::jsonb else jsonb_build_object('amr', p_amr) end $$;
-- a synthetic grant row (history only; an INSERT never fires the AFTER UPDATE trigger). Returns run_id, or null on error.
create function pg_temp.grant_row(p_slug text, p_issued interval, p_used boolean, p_fd_gen bigint default null, p_rr_gen bigint default null)
returns uuid language plpgsql as $$
declare v_run uuid := gen_random_uuid();
begin
  insert into private.ingest_grants (token_hash, source_id, run_id, issued_at, expires_at, used_at, force_due_gen, read_request_gen)
    values (extensions.digest(gen_random_uuid()::text, 'sha256'), (select id from public.sources where slug = p_slug), v_run,
            now() - p_issued, now() - p_issued + interval '30 minutes', case when p_used then now() - p_issued + interval '1 minute' end,
            p_fd_gen, p_rr_gen);
  return v_run;
exception when others then
  return null;
end $$;
-- a source_runs row for a synthetic grant (history only)
create function pg_temp.run_row(p_run uuid, p_slug text, p_status text, p_found int, p_ago interval) returns text language sql as $$
  select pg_temp.x('postgres', format($s$insert into public.source_runs (id, source_id, started_at, finished_at, status, items_found)
    values (%L::uuid, (select id from public.sources where slug = %L), now() - %L::interval, now() - %L::interval + interval '1 minute', %L, %s)$s$,
    p_run, p_slug, p_ago, p_ago, p_status, p_found)) $$;
-- submit a batch for a grant as service_role; result text or ERR text (rolled back to the subtransaction)
create function pg_temp.submit(p_grant text, p_status text default 'ok', p_items jsonb default '[]') returns text language sql as $$
  select pg_temp.v('service_role', format('public.svc_ingest_batch(%L, %L::jsonb, %L::jsonb)', p_grant,
    (jsonb_build_object('status', p_status, 'started_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'http_status', case when p_status = 'ok' then 200 else 500 end, 'parser_version', 'test-1')
     || case when p_status = 'http_error' then '{"error_code": "http_500"}'::jsonb else '{}'::jsonb end)::text, p_items::text)) $$;
-- every svc_issue_run_grants() call is recorded per granted slug under a tag
create temp table issued (tag text, slug text, tok text, run uuid, j jsonb);
create function pg_temp.issue(p_tag text) returns integer language plpgsql as $$
declare v jsonb;
begin
  v := pg_temp.jb(pg_temp.v('service_role', 'public.svc_issue_run_grants()'));
  insert into pg_temp.issued
    select p_tag, e #>> '{source,slug}', e ->> 'grant', (e ->> 'run_id')::uuid, e from jsonb_array_elements(coalesce(v -> 'grants', '[]'::jsonb)) e;
  return jsonb_array_length(coalesce(v -> 'grants', '[]'::jsonb));
end $$;
create function pg_temp.tok(p_tag text, p_slug text) returns text language sql as $$
  select tok from pg_temp.issued where tag = p_tag and slug = p_slug limit 1 $$;
create function pg_temp.granted(p_tag text, p_slug text) returns integer language sql as $$
  select count(*)::integer from pg_temp.issued where tag = p_tag and slug = p_slug $$;
-- manual grant results (svc_manual_grant / svc_manual_grant_requested), by tag
create temp table mres (tag text, r text);
create function pg_temp.mtok(p_tag text) returns text language sql as $$
  select pg_temp.jb(r) ->> 'grant' from pg_temp.mres where tag = p_tag $$;
-- a generation log: value of an expression at a step
create temp table gl (step text, v text);
-- the EXECUTE matrix of block B (anon / authenticated / service_role per new function)
create function pg_temp.matrix() returns text language sql as $$
  select string_agg(format('%s:%s:%s', f, r, has_function_privilege(r, f, 'execute')::text), ',' order by f, r)
    from unnest(array['public.admin_jobs(integer)', 'public.admin_set_force_due(text, boolean)', 'public.admin_set_read_request(text, boolean)',
                      'public.svc_manual_grant_requested(text)', 'private.ingest_grant_used()']) f,
         unnest(array['anon', 'authenticated', 'service_role']) r $$;

select pg_temp.mk_admin();

-- fixtures ------------------------------------------------------------------------------------------------------------
select pg_temp.mk_source(s) from unnest(array['sv-ok', 'sv-exp', 'sv-exp2', 'sv-nonok', 'sv-fail', 'sv-late', 'sv-cancel', 'sv-cad',
                                              'sv-off', 'sv-lapsed', 'sv-man', 'sv-man2', 'sv-man3', 'sv-manlap']) s;
select pg_temp.mk_source('sv-link', 'organizer', 'link_only');
update public.sources set enabled = false where slug = 'sv-off';
update public.sources set manual_only = true where slug in ('sv-man', 'sv-man2', 'sv-man3', 'sv-manlap');
update public.sources set enabled = false where slug = 'sv-man3';
-- push every due source out: each svc_issue_run_grants() call grants every eligible due row (the 10:256 pattern)
update public.sources set next_due_at = now() + interval '1 day' where next_due_at <= now();
update public.sources set next_due_at = now() + interval '1 day' where slug like 'sv-%';
-- terms lapsed: the gate refuses this state, so build it with the trigger off (fixture only, as 10:216-222)
alter table public.sources disable trigger sources_gate;
update public.sources set terms_recheck_at = now() - interval '1 second' where slug in ('sv-lapsed', 'sv-manlap');
alter table public.sources enable trigger sources_gate;

-- A (AC-SV2-02) columns, indexes, trigger ------------------------------------------------------------------------------
select pg_temp.eq($$(select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) from information_schema.columns
   where table_schema = 'public' and table_name = 'sources'
     and column_name in ('force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at'))$$,
  'force_due_at:timestamp with time zone:YES,force_due_served_at:timestamp with time zone:YES,read_request_served_at:timestamp with time zone:YES,read_requested_at:timestamp with time zone:YES',
  'AC-SV2-02 sources has the four nullable timestamptz stamp columns');
select pg_temp.eq($$(select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' order by column_name)
   from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('force_due_gen', 'read_request_gen'))$$,
  'force_due_gen:bigint:NO:0,read_request_gen:bigint:NO:0', 'AC-SV2-02 sources.force_due_gen / read_request_gen are bigint not null default 0');
select pg_temp.eq($$(select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name) from information_schema.columns
   where table_schema = 'private' and table_name = 'ingest_grants' and column_name in ('force_due_gen', 'read_request_gen'))$$,
  'force_due_gen:bigint:YES,read_request_gen:bigint:YES', 'AC-SV2-02 ingest_grants.force_due_gen / read_request_gen are nullable bigint');
select pg_temp.eq($$(select count(*) from pg_indexes where schemaname = 'private' and tablename = 'ingest_grants'
   and indexname = 'ingest_grants_source_issued_idx' and indexdef like '%(source_id, issued_at DESC)%')$$, '1',
  'AC-SV2-02 index ingest_grants_source_issued_idx (source_id, issued_at desc)');
select pg_temp.eq($$(select count(*) from pg_indexes where schemaname = 'private' and tablename = 'ingest_grants'
   and indexname = 'ingest_grants_issued_idx' and indexdef like '%(issued_at DESC)%')$$, '1', 'AC-SV2-02 index ingest_grants_issued_idx (issued_at desc)');
select pg_temp.eq($$(select count(*) from pg_trigger where tgrelid = 'private.ingest_grants'::regclass and tgname = 'ingest_grants_used' and not tgisinternal)$$, '1',
  'AC-SV2-02 exactly one trigger ingest_grants_used on private.ingest_grants');
select pg_temp.eq($$(select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'private.ingest_grants'::regclass and t.tgname = 'ingest_grants_used' and p.proname = 'ingest_grant_used'
     and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 16) = 16)$$, '1',
  'AC-SV2-02 ingest_grants_used is a FOR EACH ROW AFTER UPDATE trigger running private.ingest_grant_used()');
select pg_temp.eq($$(select count(*) from information_schema.tables where table_schema in ('public', 'private') and table_type = 'BASE TABLE')$$, '25',
  'AC-SV2-02 the table set is still 25 (no new table)');

-- B (AC-SV2-03/04) EXECUTE matrix and refusals ------------------------------------------------------------------------
select pg_temp.eq($$pg_temp.matrix()$$,
  'private.ingest_grant_used():anon:false,private.ingest_grant_used():authenticated:false,private.ingest_grant_used():service_role:false,'
  || 'public.admin_jobs(integer):anon:false,public.admin_jobs(integer):authenticated:true,public.admin_jobs(integer):service_role:false,'
  || 'public.admin_set_force_due(text, boolean):anon:false,public.admin_set_force_due(text, boolean):authenticated:true,public.admin_set_force_due(text, boolean):service_role:false,'
  || 'public.admin_set_read_request(text, boolean):anon:false,public.admin_set_read_request(text, boolean):authenticated:true,public.admin_set_read_request(text, boolean):service_role:false,'
  || 'public.svc_manual_grant_requested(text):anon:false,public.svc_manual_grant_requested(text):authenticated:false,public.svc_manual_grant_requested(text):service_role:true',
  'AC-SV2-03 admin RPCs: authenticated only; svc_manual_grant_requested: service_role only; ingest_grant_used: no API role');
create temp table b_calls (call text);
insert into b_calls values ($$public.admin_set_force_due('sv-ok', false)$$), ($$public.admin_set_read_request('sv-man', false)$$), ($$public.admin_jobs(10)$$);
select is((select count(*)::int from b_calls c where pg_temp.v('anon', c.call) like 'ERR:42501|permission denied%'), 3,
  'AC-SV2-04 anon calling any of the three admin RPCs -> 42501 (no EXECUTE)');
select is((select count(*)::int from b_calls c where pg_temp.v('user', c.call) = 'ERR:42501|forbidden|'), 3,
  'AC-SV2-04 a non-admin aal2 password+totp user -> 42501 forbidden');
select is((select count(*)::int from b_calls c
            where pg_temp.as_claims(pg_temp.adm('aal1', '[{"method":"totp","timestamp":1},{"method":"password","timestamp":1}]'), c.call) = 'ERR:42501|forbidden|'), 3,
  'AC-SV2-04 the admin at aal1 -> 42501 forbidden');
select is((select count(*)::int from b_calls c where pg_temp.as_claims(pg_temp.adm('aal2', null), c.call) = 'ERR:42501|forbidden|'), 3,
  'AC-SV2-04 the admin with no amr -> 42501 forbidden');
select is((select count(*)::int from b_calls c
            where pg_temp.as_claims(pg_temp.adm('aal2', '[{"method":"password","timestamp":1}]'), c.call) = 'ERR:42501|forbidden|'), 3,
  'AC-SV2-04 the admin with amr = password only -> 42501 forbidden');
select ok(pg_temp.v('anon', $$public.svc_manual_grant_requested('sv-man')$$) like 'ERR:42501|permission denied%', 'AC-SV2-03 anon -> svc_manual_grant_requested 42501');
select ok(pg_temp.v('user', $$public.svc_manual_grant_requested('sv-man')$$) like 'ERR:42501|permission denied%', 'AC-SV2-03 authenticated -> svc_manual_grant_requested 42501');
select pg_temp.t($$(select read_requested_at is null and force_due_at is null and force_due_gen = 0 and read_request_gen = 0
   from public.sources where slug = 'sv-ok')$$, 'AC-SV2-04 the refused calls changed nothing (sv-ok stamps null, generations 0)');

-- C (AC-SV2-05) admin_set_force_due refusals, in order -----------------------------------------------------------------
select is(pg_temp.v('admin', $$public.admin_set_force_due('nope', true)$$), 'ERR:P0002|not_found|source', 'AC-SV2-05 unknown slug -> P0002 not_found/source');
select is(pg_temp.v('admin', $$public.admin_set_force_due('sv-ok', null)$$), 'ERR:22023|invalid_input|on', 'AC-SV2-05 p_on null -> 22023 invalid_input/on');
select is(pg_temp.v('admin', $$public.admin_set_force_due('sv-man', true)$$), 'ERR:22023|invalid_input|manual_only', 'AC-SV2-05 manual-only -> invalid_input/manual_only');
select is(pg_temp.v('admin', $$public.admin_set_force_due('sv-link', true)$$), 'ERR:22023|invalid_input|link_only', 'AC-SV2-05 link_only -> invalid_input/link_only');
select is(pg_temp.v('admin', $$public.admin_set_force_due('sv-off', true)$$), 'ERR:22023|invalid_input|disabled', 'AC-SV2-05 disabled -> invalid_input/disabled');
select is(pg_temp.v('admin', $$public.admin_set_force_due('sv-lapsed', true)$$), 'ERR:22023|invalid_input|not_permitted', 'AC-SV2-05 terms lapsed -> invalid_input/not_permitted');
create temp table c_g as select pg_temp.grant_row('sv-ok', '10 minutes', true) as run;
select is(pg_temp.v('admin', $$public.admin_set_force_due('sv-ok', true)$$), 'ERR:P0001|rate_limited|too_soon', 'AC-SV2-05 a grant 10 minutes old -> P0001 rate_limited/too_soon');
select pg_temp.eq($$(select force_due_at from public.sources where slug = 'sv-ok')$$, '<null>', 'AC-SV2-05 ... and no stamp was written');
delete from private.ingest_grants where run_id = (select run from c_g);

-- D (AC-SV2-06) stamp, re-stamp, Cancel ---------------------------------------------------------------------------------
insert into gl values ('d0', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
create temp table d1 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_force_due('sv-ok', true)$$)) as j;
insert into gl values ('d1', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
select pg_temp.eq($$(select array(select jsonb_object_keys(j) order by 1) from d1)$$, '{already,force_due_at,last_grant_at,next_due_at,slug}',
  'AC-SV2-06 the result keys are exactly {already, force_due_at, last_grant_at, next_due_at, slug}');
select pg_temp.t($$(select (j ->> 'force_due_at')::timestamptz = now() and (j ->> 'already')::boolean = false and j ->> 'slug' = 'sv-ok' from d1)$$,
  'AC-SV2-06 stamp returns force_due_at = now(), already false');
select pg_temp.t($$(select force_due_at = now() from public.sources where slug = 'sv-ok')$$, 'AC-SV2-06 DB force_due_at = now()');
select pg_temp.x('postgres', $$update public.sources set force_due_at = now() - interval '2 hours' where slug = 'sv-ok'$$);
create temp table d2 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_force_due('sv-ok', true)$$)) as j;
insert into gl values ('d2', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
select pg_temp.t($$(select (j ->> 'already')::boolean = true and (j ->> 'force_due_at')::timestamptz = now() from d2)$$,
  'AC-SV2-06 a repeat while pending returns already true and the new time (grok r3 P1)');
select pg_temp.t($$(select force_due_at = now() from public.sources where slug = 'sv-ok')$$, 'AC-SV2-06 ... and the DB stamp is re-stamped to now()');
create temp table d3 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_force_due('sv-ok', false)$$)) as j;
insert into gl values ('d3', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
select pg_temp.t($$(select j ? 'force_due_at' and j -> 'force_due_at' = 'null'::jsonb and (j ->> 'already')::boolean = false from d3)$$,
  'AC-SV2-06 Cancel returns force_due_at null, already false');
select pg_temp.eq($$(select force_due_at from public.sources where slug = 'sv-ok')$$, '<null>', 'AC-SV2-06 Cancel clears the DB stamp');
create temp table d4 as select pg_temp.v('admin', $$public.admin_set_force_due('sv-ok', false)$$) as r;
insert into gl values ('d4', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
select ok((select r like '{%' from d4), 'AC-SV2-06 a second Cancel is OK (idempotent)');
select pg_temp.eq($$(select string_agg(((select v from gl where step = s)::bigint - (select v from gl where step = p)::bigint)::text, ',' order by s)
   from (values ('d1', 'd0'), ('d2', 'd1'), ('d3', 'd2'), ('d4', 'd3')) x(s, p))$$, '1,1,1,0',
  'AC-SV2-06 force_due_gen moves +1 on the stamp, +1 on the re-stamp, +1 on the first Cancel, 0 on the second Cancel');

-- E (AC-SV2-07) Cancel while terms lapsed; the exemption is narrow ------------------------------------------------------
alter table public.sources disable trigger sources_gate;
select pg_temp.x('postgres', $$update public.sources set force_due_at = now() - interval '1 hour' where slug = 'sv-lapsed'$$);
select pg_temp.x('postgres', $$update public.sources set read_requested_at = now() - interval '1 hour' where slug = 'sv-manlap'$$);
alter table public.sources enable trigger sources_gate;
create temp table e1 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_force_due('sv-lapsed', false)$$)) as j;
select pg_temp.t($$(select j -> 'force_due_at' = 'null'::jsonb from e1)$$, 'AC-SV2-07 Cancel Run now on a lapsed-terms source succeeds');
select pg_temp.eq($$(select force_due_at from public.sources where slug = 'sv-lapsed')$$, '<null>', 'AC-SV2-07 ... and the stamp is null');
create temp table e2 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_read_request('sv-manlap', false)$$)) as j;
select pg_temp.t($$(select j -> 'read_requested_at' = 'null'::jsonb from e2)$$, 'AC-SV2-07 Cancel a Read request on a lapsed-terms source succeeds');
select pg_temp.eq($$(select read_requested_at from public.sources where slug = 'sv-manlap')$$, '<null>', 'AC-SV2-07 ... and the request is null');
select ok(pg_temp.x('postgres', $$update public.sources set force_due_at = now() where slug = 'sv-lapsed'$$) like 'ERR:23514|%',
  'AC-SV2-07 setting a stamp on a lapsed source is still checked (23514)');
alter table public.sources disable trigger sources_gate;
select pg_temp.x('postgres', $$update public.sources set force_due_at = now() - interval '1 hour' where slug = 'sv-lapsed'$$);
alter table public.sources enable trigger sources_gate;
select ok(pg_temp.x('postgres', $$update public.sources set force_due_at = null, trust = 'auto' where slug = 'sv-lapsed'$$) like 'ERR:23514|%',
  'AC-SV2-07 clearing a stamp together with another column is still checked (23514)');
select ok(pg_temp.x('postgres', $$update public.sources set enabled = enabled where slug = 'sv-lapsed'$$) like 'ERR:23514|%',
  'AC-SV2-07 a pure no-op update on a lapsed source is still checked (23514)');
select pg_temp.eq($$(select (force_due_at = now() - interval '1 hour')::text || '/' || trust::text from public.sources where slug = 'sv-lapsed')$$, 'true/review',
  'AC-SV2-07 the refused updates changed nothing');
alter table public.sources disable trigger sources_gate;
select pg_temp.x('postgres', $$update public.sources set force_due_at = null where slug = 'sv-lapsed'$$);
alter table public.sources enable trigger sources_gate;

-- F (AC-SV2-08) a pending stamp makes a not-due source due; the grant leaves the stamp -----------------------------------
update public.sources set next_due_at = now() + interval '2 days' where slug = 'sv-ok';
select pg_temp.x('postgres', $$update public.sources set force_due_at = now() - interval '1 hour' where slug = 'sv-ok'$$);
select pg_temp.issue('F');
select is(pg_temp.granted('F', 'sv-ok'), 1, 'AC-SV2-08 a not-cadence-due source with a pending stamp gets exactly one grant');
select pg_temp.eq($$(select array(select jsonb_object_keys(j -> 'source') order by 1) from pg_temp.issued where tag = 'F' and slug = 'sv-ok')$$,
  '{allowed_hosts,allowed_methods,config,content_hash,etag,family,ingest_disposition,last_modified,page_cap,slug,terms_recheck_at}',
  'AC-SV2-08 the grant source object keeps exactly the 10:231-233 keys');
select pg_temp.t($$(select force_due_at = now() - interval '1 hour' from public.sources where slug = 'sv-ok')$$,
  'AC-SV2-08 the grant leaves force_due_at set (unchanged; grok r3 P1)');
select pg_temp.eq($$(select force_due_served_at from public.sources where slug = 'sv-ok')$$, '<null>', 'AC-SV2-08 force_due_served_at stays null at issue');
select pg_temp.t($$(select next_due_at = now() + interval '24 hours' from public.sources where slug = 'sv-ok')$$, 'AC-SV2-08 next_due_at is pushed by the cadence (from now() + 2 days to now() + 24 h)');
select pg_temp.t($$(select g.force_due_gen = s.force_due_gen and g.force_due_gen >= 1 and g.read_request_gen is null
   from private.ingest_grants g join public.sources s on s.id = g.source_id
  where g.token_hash = extensions.digest(pg_temp.tok('F', 'sv-ok'), 'sha256'))$$,
  'AC-SV2-08 the grant row copies the source''s force_due_gen (>= 1); read_request_gen null');

-- G (AC-SV2-09) no second grant while one is live; one more after it expires unused -------------------------------------
select pg_temp.issue('G1');
select is(pg_temp.granted('G1', 'sv-ok'), 0, 'AC-SV2-09 a live unused grant blocks a second grant');
select pg_temp.x('postgres', format($$update private.ingest_grants set issued_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute'
   where token_hash = extensions.digest(%L, 'sha256')$$, pg_temp.tok('F', 'sv-ok')));
select pg_temp.issue('G2');
select is(pg_temp.granted('G2', 'sv-ok'), 1, 'AC-SV2-09 after it expires unused, the next call grants exactly once more');
select pg_temp.eq($$(select count(*)::text || '/' || count(*) filter (where issued_at = now())::text from private.ingest_grants
   where source_id = (select id from public.sources where slug = 'sv-ok'))$$, '2/1', 'AC-SV2-09 two sv-ok grant rows in total, one issued now');

-- H (AC-SV2-10) a recorded result clears the matching request -----------------------------------------------------------
insert into gl values ('h0', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
select ok(pg_temp.submit(pg_temp.tok('G2', 'sv-ok')) like '{%', 'AC-SV2-10 fixture: the ok batch for the sv-ok grant commits');
insert into gl values ('h1', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-ok')$$));
select pg_temp.eq($$(select force_due_at from public.sources where slug = 'sv-ok')$$, '<null>', 'AC-SV2-10 the batch clears force_due_at');
select pg_temp.t($$(select force_due_served_at = now() from public.sources where slug = 'sv-ok')$$, 'AC-SV2-10 force_due_served_at = the batch''s time');
select pg_temp.eq($$(select (select v from gl where step = 'h1')::bigint - (select v from gl where step = 'h0')::bigint)$$, '0',
  'AC-SV2-10 the clear does not bump force_due_gen');
select pg_temp.t($$(select used_at is not null from private.ingest_grants where token_hash = extensions.digest(pg_temp.tok('G2', 'sv-ok'), 'sha256'))$$,
  'AC-SV2-10 the grant row has used_at set');
select pg_temp.issue('H1');
select is(pg_temp.granted('H1', 'sv-ok'), 0, 'AC-SV2-10 after the clear, the next call issues no sv-ok grant');
-- stamps for the H sub-cases (no grants yet, so no floor)
select pg_temp.v('admin', format('public.admin_set_force_due(%L, true)', s)) from unnest(array['sv-nonok', 'sv-fail', 'sv-late', 'sv-cancel']) s;
insert into gl values ('late0', pg_temp.q($$(select force_due_gen from public.sources where slug = 'sv-late')$$));
select pg_temp.issue('H2');
select is((select count(*)::int from pg_temp.issued where tag = 'H2' and slug in ('sv-nonok', 'sv-fail', 'sv-late', 'sv-cancel')), 4,
  'AC-SV2-10 fixture: the four stamped H sources are granted');
-- sv-late: a newer request after the grant (postgres re-stamp; the admin RPC would refuse too_soon inside the floor)
select pg_temp.x('postgres', $$update public.sources set force_due_at = now(), force_due_gen = force_due_gen + 1 where slug = 'sv-late'$$);
-- sv-cancel: Cancel after the grant
select pg_temp.v('admin', $$public.admin_set_force_due('sv-cancel', false)$$);
select ok(pg_temp.submit(pg_temp.tok('H2', 'sv-nonok'), 'http_error') like '{%', 'AC-SV2-10 fixture: a non-ok (http_error) batch commits');
select pg_temp.t($$(select force_due_at is null and force_due_served_at = now() from public.sources where slug = 'sv-nonok')$$,
  'AC-SV2-10 a committed non-ok batch also clears the stamp and sets served (DS2)');
select is(pg_temp.submit(pg_temp.tok('H2', 'sv-fail'), 'http_error', jsonb_build_array(pg_temp.item('svf1', 'Fail Night', 5))),
  'ERR:22023|invalid_input|items_nonok', 'AC-SV2-10 a batch call that raises (non-ok with items) -> items_nonok');
select pg_temp.t($$(select force_due_at is not null and force_due_served_at is null from public.sources where slug = 'sv-fail')$$,
  'AC-SV2-10 ... clears nothing (stamp kept, served null)');
select pg_temp.t($$(select used_at is null from private.ingest_grants where token_hash = extensions.digest(pg_temp.tok('H2', 'sv-fail'), 'sha256'))$$,
  'AC-SV2-10 ... and the grant used_at stays null');
select ok(pg_temp.submit(pg_temp.tok('H2', 'sv-late')) like '{%', 'AC-SV2-10 fixture: the sv-late batch commits');
select pg_temp.t($$(select force_due_at = now() and force_due_served_at is null from public.sources where slug = 'sv-late')$$,
  'AC-SV2-10 a re-stamp after the grant (generation moved) is not cleared and gets no served time');
select pg_temp.eq($$(select force_due_gen - (select v from gl where step = 'late0')::bigint from public.sources where slug = 'sv-late')$$, '1',
  'AC-SV2-10 ... the source still carries g + 1');
select ok(pg_temp.submit(pg_temp.tok('H2', 'sv-cancel')) like '{%', 'AC-SV2-10 fixture: the sv-cancel batch commits');
select pg_temp.t($$(select force_due_at is null and force_due_served_at is null from public.sources where slug = 'sv-cancel')$$,
  'AC-SV2-10 Cancel after the grant: stamp null, served null');
select pg_temp.eq($$(select count(*) from public.source_runs where id = (select run from pg_temp.issued where tag = 'H2' and slug = 'sv-cancel'))$$, '1',
  'AC-SV2-10 ... and the read is recorded (the run row exists)');

-- I (AC-SV2-11) an expired stamp is never served ------------------------------------------------------------------------
select pg_temp.x('postgres', $$update public.sources set force_due_at = now() - interval '25 hours' where slug in ('sv-exp', 'sv-exp2')$$);
update public.sources set next_due_at = now() - interval '1 minute' where slug = 'sv-exp2';
select pg_temp.issue('I');
select is(pg_temp.granted('I', 'sv-exp'), 0, 'AC-SV2-11 a stamp older than 24 h does not make a not-due source due');
select pg_temp.t($$(select force_due_at = now() - interval '25 hours' from public.sources where slug = 'sv-exp')$$, 'AC-SV2-11 ... and the stamp is unchanged');
select is(pg_temp.granted('I', 'sv-exp2'), 1, 'AC-SV2-11 a cadence-due source with an expired stamp is granted (cadence)');
select pg_temp.t($$(select force_due_gen is null and read_request_gen is null from private.ingest_grants
   where token_hash = extensions.digest(pg_temp.tok('I', 'sv-exp2'), 'sha256'))$$, 'AC-SV2-11 ... the cadence grant carries no generation');
select ok(pg_temp.submit(pg_temp.tok('I', 'sv-exp2')) like '{%', 'AC-SV2-11 fixture: the cadence batch commits');
select pg_temp.t($$(select force_due_at = now() - interval '25 hours' and force_due_served_at is null from public.sources where slug = 'sv-exp2')$$,
  'AC-SV2-11 the cadence batch neither clears the expired stamp nor sets served (astra R3-3)');

-- J (AC-SV2-12) a stamp never bypasses a predicate ----------------------------------------------------------------------
alter table public.sources disable trigger sources_gate;
select pg_temp.x('postgres', $$update public.sources set force_due_at = now() where slug in ('sv-man', 'sv-link', 'sv-off', 'sv-lapsed')$$);
alter table public.sources enable trigger sources_gate;
update public.sources set next_due_at = now() - interval '1 minute' where slug = 'sv-cad';
select pg_temp.issue('J');
select is((select count(*)::int from pg_temp.issued where tag = 'J' and slug in ('sv-man', 'sv-link', 'sv-off', 'sv-lapsed')), 0,
  'AC-SV2-12 stamped manual_only, link_only, disabled and lapsed sources get no grant');
select pg_temp.eq($$(select count(*) from public.sources where slug in ('sv-man', 'sv-link', 'sv-off', 'sv-lapsed') and force_due_at = now())$$, '4',
  'AC-SV2-12 fixture: the four stamps were really set');
select is(pg_temp.granted('J', 'sv-cad'), 1, 'AC-SV2-12 the cadence-due sv-cad is granted');
select pg_temp.t($$(select force_due_gen is null and read_request_gen is null from private.ingest_grants
   where token_hash = extensions.digest(pg_temp.tok('J', 'sv-cad'), 'sha256'))$$, 'AC-SV2-12 a cadence grant without a stamp has both generations null');
select ok(pg_temp.submit(pg_temp.tok('J', 'sv-cad')) like '{%', 'AC-SV2-12 fixture: the sv-cad batch commits');
select pg_temp.t($$(select force_due_served_at is null and read_request_served_at is null and force_due_at is null and read_requested_at is null
   from public.sources where slug = 'sv-cad')$$, 'AC-SV2-12 a grant with no generation never updates the stamp columns (served stays null)');
alter table public.sources disable trigger sources_gate;
select pg_temp.x('postgres', $$update public.sources set force_due_at = null where slug in ('sv-man', 'sv-link', 'sv-off', 'sv-lapsed')$$);
alter table public.sources enable trigger sources_gate;

-- K (AC-SV2-13) admin_set_read_request ---------------------------------------------------------------------------------
select is(pg_temp.v('admin', $$public.admin_set_read_request('nope', true)$$), 'ERR:P0002|not_found|source', 'AC-SV2-13 unknown slug -> not_found/source');
select is(pg_temp.v('admin', $$public.admin_set_read_request('sv-man', null)$$), 'ERR:22023|invalid_input|on', 'AC-SV2-13 p_on null -> invalid_input/on');
select is(pg_temp.v('admin', $$public.admin_set_read_request('sv-ok', true)$$), 'ERR:22023|invalid_input|not_manual', 'AC-SV2-13 a scheduled source -> not_manual');
select is(pg_temp.v('admin', $$public.admin_set_read_request('sv-man3', true)$$), 'ERR:22023|invalid_input|disabled', 'AC-SV2-13 a disabled manual source -> disabled');
select is(pg_temp.v('admin', $$public.admin_set_read_request('sv-manlap', true)$$), 'ERR:22023|invalid_input|not_permitted', 'AC-SV2-13 lapsed terms -> not_permitted');
insert into gl values ('k0', pg_temp.q($$(select read_request_gen from public.sources where slug = 'sv-man')$$));
create temp table k1 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_read_request('sv-man', true)$$)) as j;
insert into gl values ('k1', pg_temp.q($$(select read_request_gen from public.sources where slug = 'sv-man')$$));
select pg_temp.eq($$(select array(select jsonb_object_keys(j) order by 1) from k1)$$, '{already,next_due_at,read_requested_at,slug}',
  'AC-SV2-13 the result keys are exactly {already, next_due_at, read_requested_at, slug}');
select pg_temp.t($$(select (j ->> 'already')::boolean = false and (j ->> 'read_requested_at')::timestamptz = now() from k1)$$, 'AC-SV2-13 stamp: already false, now()');
select pg_temp.t($$(select read_requested_at = now() from public.sources where slug = 'sv-man')$$, 'AC-SV2-13 DB read_requested_at = now()');
select pg_temp.x('postgres', $$update public.sources set read_requested_at = now() - interval '1 hour' where slug = 'sv-man'$$);
create temp table k2 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_read_request('sv-man', true)$$)) as j;
insert into gl values ('k2', pg_temp.q($$(select read_request_gen from public.sources where slug = 'sv-man')$$));
select pg_temp.t($$(select (j ->> 'already')::boolean = true and (j ->> 'read_requested_at')::timestamptz = now() from k2)$$,
  'AC-SV2-13 a repeat while pending re-stamps: already true, now() (DS8)');
select pg_temp.t($$(select read_requested_at = now() from public.sources where slug = 'sv-man')$$, 'AC-SV2-13 ... DB re-stamped');
create temp table k3 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_read_request('sv-man', false)$$)) as j;
insert into gl values ('k3', pg_temp.q($$(select read_request_gen from public.sources where slug = 'sv-man')$$));
select pg_temp.t($$(select j -> 'read_requested_at' = 'null'::jsonb and (j ->> 'already')::boolean = false from k3)$$, 'AC-SV2-13 Cancel returns null');
select pg_temp.eq($$(select read_requested_at from public.sources where slug = 'sv-man')$$, '<null>', 'AC-SV2-13 Cancel clears the DB request');
select pg_temp.eq($$(select string_agg(((select v from gl where step = s)::bigint - (select v from gl where step = p)::bigint)::text, ',' order by s)
   from (values ('k1', 'k0'), ('k2', 'k1'), ('k3', 'k2')) x(s, p))$$, '1,1,1', 'AC-SV2-13 read_request_gen moves +1 on each of the three writes');

-- L (AC-SV2-14) read requests through the manual grant paths ------------------------------------------------------------
update public.sources set next_due_at = now() - interval '1 minute' where slug in ('sv-man', 'sv-man2');
insert into mres values ('l0', pg_temp.v('service_role', $$public.svc_manual_grant_requested('sv-man')$$));
select is((select r from mres where tag = 'l0'), 'ERR:P0001|manual_request_withdrawn|', 'AC-SV2-14 no request -> P0001 manual_request_withdrawn (DS5)');
select pg_temp.v('admin', $$public.admin_set_read_request('sv-man', true)$$);
insert into mres values ('l1', pg_temp.v('service_role', $$public.svc_manual_grant_requested('sv-man')$$));
select ok(pg_temp.mtok('l1') ~ '^[0-9a-f]{64}$', 'AC-SV2-14 with a request, svc_manual_grant_requested issues a grant');
select pg_temp.t($$(select g.read_request_gen = s.read_request_gen and g.force_due_gen is null from private.ingest_grants g join public.sources s on s.id = g.source_id
   where g.token_hash = extensions.digest(pg_temp.mtok('l1'), 'sha256'))$$, 'AC-SV2-14 the grant captures the source''s read_request_gen');
select pg_temp.t($$(select read_requested_at = now() and read_request_served_at is null from public.sources where slug = 'sv-man')$$,
  'AC-SV2-14 the grant keeps the request (no clear at issue)');
insert into mres values ('l2', pg_temp.v('service_role', $$public.svc_manual_grant_requested('sv-man')$$));
select is((select r from mres where tag = 'l2'), 'ERR:P0001|manual_grant_refused|', 'AC-SV2-14 a second call -> manual_grant_refused (24 h gate)');
select ok(pg_temp.submit(pg_temp.mtok('l1')) like '{%', 'AC-SV2-14 fixture: the requested read batch commits');
select pg_temp.t($$(select read_requested_at is null and read_request_served_at = now() from public.sources where slug = 'sv-man')$$,
  'AC-SV2-14 the batch clears the request and sets read_request_served_at to the batch''s time');
-- a plain svc_manual_grant read also consumes a pending request
select pg_temp.v('admin', $$public.admin_set_read_request('sv-man2', true)$$);
insert into mres values ('l3', pg_temp.v('service_role', $$public.svc_manual_grant('sv-man2')$$));
select pg_temp.t($$(select g.read_request_gen = s.read_request_gen from private.ingest_grants g join public.sources s on s.id = g.source_id
   where g.token_hash = extensions.digest(pg_temp.mtok('l3'), 'sha256'))$$, 'AC-SV2-14 plain svc_manual_grant captures the pending request''s generation');
select ok(pg_temp.submit(pg_temp.mtok('l3')) like '{%', 'AC-SV2-14 fixture: the plain manual batch commits');
select pg_temp.t($$(select read_requested_at is null and read_request_served_at = now() from public.sources where slug = 'sv-man2')$$,
  'AC-SV2-14 every reader consumes the request on submit');
-- a re-request between grant and batch survives
update public.sources set enabled = true, next_due_at = now() - interval '1 minute' where slug = 'sv-man3';
select pg_temp.v('admin', $$public.admin_set_read_request('sv-man3', true)$$);
insert into mres values ('l4', pg_temp.v('service_role', $$public.svc_manual_grant_requested('sv-man3')$$));
insert into gl values ('m3g', pg_temp.q($$(select read_request_gen from private.ingest_grants where token_hash = extensions.digest(pg_temp.mtok('l4'), 'sha256'))$$));
create temp table l5 as select pg_temp.jb(pg_temp.v('admin', $$public.admin_set_read_request('sv-man3', true)$$)) as j;
select pg_temp.t($$(select (j ->> 'already')::boolean from l5)$$, 'AC-SV2-14 fixture: the re-request is accepted (no floor for requests)');
select ok(pg_temp.submit(pg_temp.mtok('l4')) like '{%', 'AC-SV2-14 fixture: the sv-man3 batch commits');
select pg_temp.t($$(select read_requested_at is not null and read_request_served_at is null and read_request_gen = (select v from gl where step = 'm3g')::bigint + 1
   from public.sources where slug = 'sv-man3')$$, 'AC-SV2-14 a re-request between grant and batch survives (newer generation; served null)');
-- after Cancel: withdrawn, and no grant row
select pg_temp.v('admin', $$public.admin_set_read_request('sv-man2', true)$$);
select pg_temp.v('admin', $$public.admin_set_read_request('sv-man2', false)$$);
insert into mres values ('l6', pg_temp.v('service_role', $$public.svc_manual_grant_requested('sv-man2')$$));
select is((select r from mres where tag = 'l6'), 'ERR:P0001|manual_request_withdrawn|', 'AC-SV2-14 after Cancel -> manual_request_withdrawn');
select pg_temp.eq($$(select count(*) from private.ingest_grants where source_id = (select id from public.sources where slug = 'sv-man2'))$$, '1',
  'AC-SV2-14 ... and no new grant row');
select is(pg_temp.v('service_role', $$public.svc_manual_grant('sv-ok')$$), 'ERR:P0001|manual_grant_refused|', 'AC-SV2-14 a scheduled source is still refused');

-- M (AC-SV2-15/16) admin_jobs and admin_source_health -------------------------------------------------------------------
-- Isolation (rolled back with the file): committed rows from other runs on a reused local DB (db-concurrency fixtures) would
-- crowd the 10/20 newest batches and the 40 stamps, so other sources' grants move out of the 14-day window and their stamps clear.
-- Updating issued_at never fires the used_at trigger.
update private.ingest_grants set issued_at = issued_at - interval '30 days', expires_at = expires_at - interval '30 days'
 where source_id not in (select id from public.sources where slug like 'sv-%') and issued_at > now() - interval '15 days';
select pg_temp.x('postgres', $$update public.sources set force_due_at = null, force_due_served_at = null, read_requested_at = null,
  read_request_served_at = null where slug not like 'sv-%'
  and (force_due_at is not null or force_due_served_at is not null or read_requested_at is not null or read_request_served_at is not null)$$);
create temp table m_ids as select
  pg_temp.grant_row('sv-ok', '2 hours', true, 7, null) as b1_ok, pg_temp.grant_row('sv-cad', '2 hours', true) as b1_cad,
  pg_temp.grant_row('sv-exp', '2 hours', false) as b1_exp, pg_temp.grant_row('sv-ok', '5 hours', true, 6, null) as b2_ok,
  pg_temp.grant_row('sv-man', '3 hours', true, null, 3) as man, pg_temp.grant_row('sv-ok', '15 days', true) as old;
select pg_temp.run_row(b1_ok, 'sv-ok', 'ok', 3, '2 hours') from m_ids;
select pg_temp.run_row(b1_cad, 'sv-cad', 'http_error', 0, '2 hours') from m_ids;
select pg_temp.run_row(b2_ok, 'sv-ok', 'ok', 1, '5 hours') from m_ids;
select pg_temp.run_row(man, 'sv-man', 'ok', 2, '3 hours') from m_ids;
select pg_temp.run_row(old, 'sv-ok', 'ok', 1, '15 days') from m_ids;
-- 22 more batches so every clamp is exercised (> 20 batches in the window)
select pg_temp.grant_row('sv-cad', make_interval(hours => 6, mins => n), true) from generate_series(1, 22) n;
create temp table mj as select pg_temp.jb(pg_temp.v('admin', $$public.admin_jobs(10)$$)) as j;
create function pg_temp.batch(p_ago interval) returns jsonb language sql as $$
  select b from mj, jsonb_array_elements(mj.j -> 'batches') b where (b ->> 'issued_at')::timestamptz = now() - p_ago $$;
select pg_temp.eq($$(select array(select jsonb_object_keys(j) order by 1) from mj)$$, '{batches,generated_at,manual,stamps}',
  'AC-SV2-15 admin_jobs top-level keys are exactly {batches, generated_at, manual, stamps}');
select pg_temp.eq($$(select format('%s/%s/%s', b ->> 'grants', b ->> 'unused', b ->> 'pending') from pg_temp.batch('2 hours') b)$$, '3/1/0',
  'AC-SV2-15 B1: grants 3, unused 1, pending 0');
select pg_temp.eq($$(select b -> 'run_now' from pg_temp.batch('2 hours') b)$$, '["sv-ok"]', 'AC-SV2-15 B1 run_now is ["sv-ok"]');
select pg_temp.eq($$(select array(select r ->> 'status' from jsonb_array_elements(b -> 'runs') r order by 1) from pg_temp.batch('2 hours') b)$$, '{http_error,ok}',
  'AC-SV2-15 B1 runs carry the two statuses');
select pg_temp.eq($$(select array(select jsonb_object_keys(r) order by 1) from pg_temp.batch('2 hours') b, jsonb_array_elements(b -> 'runs') r where r ->> 'slug' = 'sv-ok')$$,
  '{changed,error_code,finished_at,found,new,slug,status}', 'AC-SV2-15 a batch run row has exactly {changed, error_code, finished_at, found, new, slug, status}');
select pg_temp.eq($$(select r ->> 'found' from pg_temp.batch('2 hours') b, jsonb_array_elements(b -> 'runs') r where r ->> 'slug' = 'sv-ok')$$, '3',
  'AC-SV2-15 B1 sv-ok run found 3');
select pg_temp.eq($$(select b -> 'run_now' from pg_temp.batch('5 hours') b)$$, '["sv-ok"]',
  'AC-SV2-15 B2 also carries run_now ["sv-ok"] (two serves of one slug both labelled: grok r3 P2)');
select pg_temp.eq($$(select count(*) from mj, jsonb_array_elements(mj.j -> 'batches') b where position('"sv-man"' in b::text) > 0)$$, '0',
  'AC-SV2-15 no batch contains the manual-only sv-man');
select pg_temp.eq($$(select pg_temp.batch('3 hours'))$$, '<null>', 'AC-SV2-15 the manual grant forms no batch');
select pg_temp.eq($$(select format('%s/%s/%s/%s', m ->> 'slug', m ->> 'requested', m ->> 'state', m #>> '{run,status}')
   from mj, jsonb_array_elements(mj.j -> 'manual') m where (m ->> 'issued_at')::timestamptz = now() - interval '3 hours')$$, 'sv-man/true/done/ok',
  'AC-SV2-15 manual lists the sv-man read with requested true, state done and its run');
select pg_temp.eq($$(select pg_temp.batch('15 days'))$$, '<null>', 'AC-SV2-15 a 15-day-old batch is outside the 14-day window');
select pg_temp.eq($$jsonb_array_length(pg_temp.jb(pg_temp.v('admin', 'public.admin_jobs(0)')) -> 'batches')$$, '1', 'AC-SV2-15 admin_jobs(0) clamps to 1 batch');
select pg_temp.eq($$jsonb_array_length(pg_temp.jb(pg_temp.v('admin', 'public.admin_jobs(500)')) -> 'batches')$$, '20', 'AC-SV2-15 admin_jobs(500) clamps to 20 batches');
select pg_temp.eq($$jsonb_array_length(pg_temp.jb(pg_temp.v('admin', 'public.admin_jobs(null)')) -> 'batches')$$, '10', 'AC-SV2-15 admin_jobs(null) defaults to 10 batches');
select pg_temp.eq($$(select string_agg(b ->> 'issued_at', ',') = string_agg(b ->> 'issued_at', ',' order by (b ->> 'issued_at')::timestamptz desc)
   from jsonb_array_elements(pg_temp.jb(pg_temp.v('admin', 'public.admin_jobs(20)')) -> 'batches') b)$$, 'true', 'AC-SV2-15 batches are newest first');
create temp table mj20 as select pg_temp.v('admin', 'public.admin_jobs(20)') as t;
select ok((select t like '{%' and position('token_hash' in t) = 0 and position('"user_id"' in t) = 0 and position('"requested_by"' in t) = 0 from mj20),
  'AC-SV2-15 admin_jobs never carries token_hash, user_id or requested_by');
select pg_temp.eq($$(select s ->> 'served_at' is not null from mj, jsonb_array_elements(mj.j -> 'stamps') s where s ->> 'slug' = 'sv-ok' and s ->> 'kind' = 'run_now')$$,
  'true', 'AC-SV2-15 stamps lists sv-ok run_now with served_at set');
select pg_temp.eq($$(select count(*) from mj, jsonb_array_elements(mj.j -> 'stamps') s where s ->> 'slug' = 'sv-man' and s ->> 'kind' = 'read_request')$$,
  '1', 'AC-SV2-15 stamps lists sv-man read_request');
select pg_temp.eq($$(select format('%s/%s', s ->> 'pending', s ->> 'expired') from mj, jsonb_array_elements(mj.j -> 'stamps') s where s ->> 'slug' = 'sv-exp')$$,
  'false/true', 'AC-SV2-15 an expired stamp shows pending false, expired true');
select pg_temp.eq($$(select array(select jsonb_object_keys(s) order by 1) from mj, jsonb_array_elements(mj.j -> 'stamps') s where s ->> 'slug' = 'sv-ok')$$,
  '{expired,kind,name,pending,requested_at,served_at,slug}', 'AC-SV2-15 a stamps row has exactly its seven keys');
select pg_temp.eq($$(select string_agg(p.proname || ':' || p.provolatile::text, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('admin_jobs', 'admin_source_health'))$$, 'admin_jobs:s,admin_source_health:s',
  'AC-SV2-15/16 admin_jobs and admin_source_health are stable');
create temp table mh as select pg_temp.jb(pg_temp.v('admin', $$(select jsonb_agg(x) from public.admin_source_health() x)$$)) as j;
select pg_temp.eq($$(select bool_and(r ?& array['last_grant_at', 'force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at',
                                              'manual_only', 'next_due_at', 'request_grant']) from mh, jsonb_array_elements(mh.j) r)$$, 'true',
  'AC-SV2-16 every admin_source_health row carries last_grant_at, request_grant and the stamp columns');
select pg_temp.t($$(select (r ->> 'last_grant_at')::timestamptz = (select max(issued_at) from private.ingest_grants where source_id = (select id from public.sources where slug = 'sv-ok'))
   from mh, jsonb_array_elements(mh.j) r where r ->> 'slug' = 'sv-ok')$$, 'AC-SV2-16 sv-ok last_grant_at equals its max issued_at');
select pg_temp.eq($$(select format('%s/%s', r -> 'request_grant' ->> 'live', ((r #>> '{request_grant,issued_at}')::timestamptz = now())::text)
   from mh, jsonb_array_elements(mh.j) r where r ->> 'slug' = 'sv-fail')$$, 'true/true',
  'AC-SV2-16 request_grant: the pending stamp''s live unused grant (generation match)');
select pg_temp.eq($$(select r -> 'request_grant' from mh, jsonb_array_elements(mh.j) r where r ->> 'slug' = 'sv-ok')$$, 'null',
  'AC-SV2-16 request_grant is null when no request is pending');
select is(pg_temp.v('user', $$(select count(*) from public.admin_source_health())$$), 'ERR:42501|forbidden|', 'AC-SV2-16 admin_source_health still forbidden for non-admins');

-- N (AC-SV2-17) re-running the whole migration changes nothing ----------------------------------------------------------
create temp table n0 as select
  pg_temp.snap($$(select slug, force_due_at, force_due_served_at, read_requested_at, read_request_served_at, next_due_at, enabled, trust from public.sources)$$) as s1,
  pg_temp.snap($$(select run_id, force_due_gen, read_request_gen, used_at, issued_at from private.ingest_grants)$$) as s2,
  pg_temp.snap($$(select slug, force_due_gen, read_request_gen from public.sources)$$) as s3,
  pg_temp.q($$(select count(*)::text || ':' || md5(string_agg(pg_get_functiondef(p.oid), '|' order by n.nspname, p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname::text, p.proname::text) in (('public', 'admin_jobs'), ('public', 'admin_source_health'), ('public', 'admin_set_force_due'),
       ('public', 'admin_set_read_request'), ('public', 'svc_manual_grant_requested'), ('public', 'svc_issue_run_grants'), ('public', 'svc_manual_grant'),
       ('private', 'ingest_grant_used'), ('private', 'sources_gate')))$$) as fns,
  pg_temp.q($$(select count(*) from pg_trigger where tgrelid = 'private.ingest_grants'::regclass and not tgisinternal)$$) as trg,
  pg_temp.q($$pg_temp.matrix()$$) as mx;
select ok((select s1 not like 'ERR%' and s2 not like 'ERR%' and fns like '9:%' from n0), 'AC-SV2-17 fixture: the snapshots read the new columns and all nine functions');

-- BEGIN migration copy
alter table public.sources add column if not exists force_due_at timestamptz;
alter table public.sources add column if not exists force_due_served_at timestamptz;
alter table public.sources add column if not exists read_requested_at timestamptz;
alter table public.sources add column if not exists read_request_served_at timestamptz;
alter table public.sources add column if not exists force_due_gen bigint not null default 0;
alter table public.sources add column if not exists read_request_gen bigint not null default 0;
alter table private.ingest_grants add column if not exists force_due_gen bigint;
alter table private.ingest_grants add column if not exists read_request_gen bigint;
create index if not exists ingest_grants_source_issued_idx on private.ingest_grants (source_id, issued_at desc);
create index if not exists ingest_grants_issued_idx on private.ingest_grants (issued_at desc);
create or replace function private.sources_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (new.force_due_at, new.force_due_served_at, new.read_requested_at, new.read_request_served_at, new.force_due_gen, new.read_request_gen)
         is distinct from (old.force_due_at, old.force_due_served_at, old.read_requested_at, old.read_request_served_at, old.force_due_gen, old.read_request_gen)
     and (to_jsonb(new) - array['force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at', 'force_due_gen',
                                'read_request_gen', 'updated_at', 'priority'])
         = (to_jsonb(old) - array['force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at', 'force_due_gen',
                                  'read_request_gen', 'updated_at', 'priority'])
     and (new.force_due_at is null or new.force_due_at is not distinct from old.force_due_at)
     and (new.read_requested_at is null or new.read_requested_at is not distinct from old.read_requested_at) then
    new.updated_at := now();
    return new;
  end if;
  if new.opt_out and new.enabled then
    raise exception 'invalid_input' using errcode = '22023', detail = 'opt_out_enabled';
  end if;
  if new.enabled and not coalesce(
       new.ingest_disposition in ('permitted', 'official_api_only')
       and new.terms_recheck_at > now()
       and cardinality(new.allowed_methods) > 0
       and new.terms_hash is not null
       and new.terms_url is not null
       and new.terms_reviewed_at is not null, false) then
    raise exception 'source_not_permitted' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create or replace function private.ingest_grant_used() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.force_due_gen is null and new.read_request_gen is null then return null; end if;
  update public.sources s
     set force_due_at = case when s.force_due_at is not null and s.force_due_gen = new.force_due_gen then null else s.force_due_at end,
         force_due_served_at = case when s.force_due_at is not null and s.force_due_gen = new.force_due_gen
                                    then now() else s.force_due_served_at end,
         read_requested_at = case when s.read_requested_at is not null and s.read_request_gen = new.read_request_gen
                                  then null else s.read_requested_at end,
         read_request_served_at = case when s.read_requested_at is not null and s.read_request_gen = new.read_request_gen
                                       then now() else s.read_request_served_at end
   where s.id = new.source_id
     and ((s.force_due_at is not null and s.force_due_gen = new.force_due_gen)
       or (s.read_requested_at is not null and s.read_request_gen = new.read_request_gen));
  return null;
end $$;
create or replace trigger ingest_grants_used after update of used_at on private.ingest_grants
  for each row when (old.used_at is null and new.used_at is not null) execute function private.ingest_grant_used();
create or replace function public.svc_issue_run_grants() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid; v_out jsonb := '[]'::jsonb;
begin
  for s in
    select * from public.sources x
     where x.enabled and not x.opt_out and x.trust <> 'link_only' and not x.manual_only
       and x.ingest_disposition in ('permitted', 'official_api_only') and x.terms_recheck_at > now()
       and cardinality(x.allowed_methods) > 0
       and (x.next_due_at <= now()
            or (x.force_due_at > now() - interval '24 hours'
                and not exists (select 1 from private.ingest_grants g
                                 where g.source_id = x.id and g.used_at is null and g.expires_at > now())))
     order by x.next_due_at for update skip locked
  loop
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_run := gen_random_uuid();
    insert into private.ingest_grants (token_hash, source_id, run_id, expires_at, force_due_gen)
      values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes',
              case when s.force_due_at > now() - interval '24 hours' then s.force_due_gen end);
    update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
      'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
      'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'etag', s.etag, 'last_modified', s.last_modified,
      'content_hash', s.content_hash, 'ingest_disposition', s.ingest_disposition, 'terms_recheck_at', s.terms_recheck_at)));
  end loop;
  return jsonb_build_object('grants', v_out);
end $$;
create or replace function public.svc_manual_grant(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_token text; v_run uuid;
begin
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found or not s.manual_only or not private.source_ingest_permitted(s) or s.next_due_at > now() then
    raise exception 'manual_grant_refused' using errcode = 'P0001';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_run := gen_random_uuid();
  insert into private.ingest_grants (token_hash, source_id, run_id, expires_at, read_request_gen)
    values (extensions.digest(v_token, 'sha256'), s.id, v_run, now() + interval '30 minutes',
            case when s.read_requested_at > now() - interval '7 days' then s.read_request_gen end);
  update public.sources set next_due_at = now() + private.cadence_interval(s.cadence) where id = s.id;
  return jsonb_build_object('grant', v_token, 'run_id', v_run, 'source', jsonb_build_object(
    'slug', s.slug, 'family', s.family, 'config', s.config, 'allowed_hosts', to_jsonb(s.allowed_hosts),
    'allowed_methods', to_jsonb(s.allowed_methods), 'page_cap', s.page_cap, 'ingest_disposition', s.ingest_disposition,
    'terms_recheck_at', s.terms_recheck_at));
end $$;
create or replace function public.svc_manual_grant_requested(p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources;
begin
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found or not coalesce(s.read_requested_at > now() - interval '7 days', false) then
    raise exception 'manual_request_withdrawn' using errcode = 'P0001';
  end if;
  return public.svc_manual_grant(p_slug);
end $$;
create or replace function public.admin_set_force_due(p_slug text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_last timestamptz; v_pending boolean;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_on is null then raise exception 'invalid_input' using errcode = '22023', detail = 'on'; end if;
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'source'; end if;
  select max(g.issued_at) into v_last from private.ingest_grants g where g.source_id = s.id;
  if not p_on then
    update public.sources set force_due_at = null, force_due_gen = force_due_gen + 1 where id = s.id and force_due_at is not null;
    return jsonb_build_object('slug', s.slug, 'force_due_at', null::timestamptz, 'already', false, 'next_due_at', s.next_due_at,
                              'last_grant_at', v_last);
  end if;
  if s.manual_only then raise exception 'invalid_input' using errcode = '22023', detail = 'manual_only'; end if;
  if s.trust = 'link_only' then raise exception 'invalid_input' using errcode = '22023', detail = 'link_only'; end if;
  if not s.enabled then raise exception 'invalid_input' using errcode = '22023', detail = 'disabled'; end if;
  if not private.source_ingest_permitted(s) then raise exception 'invalid_input' using errcode = '22023', detail = 'not_permitted'; end if;
  if v_last > now() - interval '30 minutes' then raise exception 'rate_limited' using errcode = 'P0001', detail = 'too_soon'; end if;
  v_pending := coalesce(s.force_due_at > now() - interval '24 hours', false);
  update public.sources set force_due_at = now(), force_due_gen = force_due_gen + 1 where id = s.id;
  return jsonb_build_object('slug', s.slug, 'force_due_at', now(), 'already', v_pending, 'next_due_at', s.next_due_at,
                            'last_grant_at', v_last);
end $$;
create or replace function public.admin_set_read_request(p_slug text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.sources; v_pending boolean;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_on is null then raise exception 'invalid_input' using errcode = '22023', detail = 'on'; end if;
  select * into s from public.sources x where x.slug = p_slug for update;
  if not found then raise exception 'not_found' using errcode = 'P0002', detail = 'source'; end if;
  if not p_on then
    update public.sources set read_requested_at = null, read_request_gen = read_request_gen + 1 where id = s.id and read_requested_at is not null;
    return jsonb_build_object('slug', s.slug, 'read_requested_at', null::timestamptz, 'already', false, 'next_due_at', s.next_due_at);
  end if;
  if not s.manual_only then raise exception 'invalid_input' using errcode = '22023', detail = 'not_manual'; end if;
  if not s.enabled then raise exception 'invalid_input' using errcode = '22023', detail = 'disabled'; end if;
  if not private.source_ingest_permitted(s) then raise exception 'invalid_input' using errcode = '22023', detail = 'not_permitted'; end if;
  v_pending := coalesce(s.read_requested_at > now() - interval '7 days', false);
  update public.sources set read_requested_at = now(), read_request_gen = read_request_gen + 1 where id = s.id;
  return jsonb_build_object('slug', s.slug, 'read_requested_at', now(), 'already', v_pending, 'next_due_at', s.next_due_at);
end $$;
create or replace function public.admin_jobs(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_lim integer := least(20, greatest(1, coalesce(p_limit, 10)));
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'generated_at', now(),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object('issued_at', b.issued_at, 'grants', x.grants, 'pending', x.pending, 'unused', x.unused,
                                          'run_now', x.run_now, 'runs', x.runs) order by b.issued_at desc)
        from (select g.issued_at from private.ingest_grants g join public.sources s on s.id = g.source_id
               where not s.manual_only and g.issued_at > now() - interval '14 days'
               group by g.issued_at order by g.issued_at desc limit v_lim) b
        cross join lateral (
          select count(*)::integer as grants,
                 (count(*) filter (where g.used_at is null and g.expires_at > now()))::integer as pending,
                 (count(*) filter (where g.used_at is null and g.expires_at <= now()))::integer as unused,
                 coalesce(jsonb_agg(s.slug order by s.slug) filter (where g.force_due_gen is not null), '[]'::jsonb) as run_now,
                 coalesce((select jsonb_agg(jsonb_build_object('slug', q.slug, 'status', q.status, 'found', q.items_found, 'new', q.items_new,
                                    'changed', q.items_changed, 'error_code', q.error_code, 'finished_at', q.finished_at) order by q.slug)
                             from (select s2.slug, r.status, r.items_found, r.items_new, r.items_changed, r.error_code, r.finished_at
                                     from private.ingest_grants g2 join public.sources s2 on s2.id = g2.source_id
                                     join public.source_runs r on r.id = g2.run_id
                                    where g2.issued_at = b.issued_at and not s2.manual_only order by s2.slug limit 30) q),
                          '[]'::jsonb) as runs
            from private.ingest_grants g join public.sources s on s.id = g.source_id
           where g.issued_at = b.issued_at and not s.manual_only) x), '[]'::jsonb),
    'manual', coalesce((
      select jsonb_agg(jsonb_build_object('issued_at', m.issued_at, 'slug', m.slug, 'requested', m.read_request_gen is not null,
               'state', case when m.used_at is not null then 'done' when m.expires_at > now() then 'reading' else 'no_result' end,
               'run', case when m.rid is null then null else jsonb_build_object('slug', m.slug, 'status', m.status, 'found', m.items_found,
                        'new', m.items_new, 'changed', m.items_changed, 'error_code', m.error_code, 'finished_at', m.finished_at) end)
             order by m.issued_at desc)
        from (select g.issued_at, g.used_at, g.expires_at, g.read_request_gen, s.slug, r.id as rid, r.status, r.items_found, r.items_new,
                     r.items_changed, r.error_code, r.finished_at
                from private.ingest_grants g join public.sources s on s.id = g.source_id
                left join public.source_runs r on r.id = g.run_id
               where s.manual_only and g.issued_at > now() - interval '14 days'
               order by g.issued_at desc limit 20) m), '[]'::jsonb),
    'stamps', coalesce((
      select jsonb_agg(t.j order by t.at desc) from (
        select u.at, u.j from (
          select greatest(s.force_due_at, s.force_due_served_at) as at,
                 jsonb_build_object('slug', s.slug, 'name', s.name, 'kind', 'run_now', 'requested_at', s.force_due_at,
                   'served_at', s.force_due_served_at, 'pending', coalesce(s.force_due_at > now() - interval '24 hours', false),
                   'expired', coalesce(s.force_due_at <= now() - interval '24 hours', false)) as j
            from public.sources s
           where s.force_due_at > now() - interval '14 days' or s.force_due_served_at > now() - interval '14 days'
          union all
          select greatest(s.read_requested_at, s.read_request_served_at),
                 jsonb_build_object('slug', s.slug, 'name', s.name, 'kind', 'read_request', 'requested_at', s.read_requested_at,
                   'served_at', s.read_request_served_at, 'pending', coalesce(s.read_requested_at > now() - interval '7 days', false),
                   'expired', coalesce(s.read_requested_at <= now() - interval '7 days', false))
            from public.sources s
           where s.read_requested_at > now() - interval '14 days' or s.read_request_served_at > now() - interval '14 days') u
        order by u.at desc limit 40) t), '[]'::jsonb));
end $$;
create or replace function public.admin_source_health() returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select (to_jsonb(s) - 'config') || jsonb_build_object(
      'last_runs', (select coalesce(jsonb_agg(jsonb_build_object('status', q.status, 'finished_at', q.finished_at, 'found', q.items_found,
                                'new', q.items_new, 'changed', q.items_changed, 'error_code', q.error_code) order by q.finished_at desc), '[]')
                      from (select r.* from public.source_runs r where r.source_id = s.id order by r.finished_at desc limit 7) q),
      'open_cards_7d', (select count(*) from public.review_cards c where c.source_id = s.id and c.status = 'open' and c.created_at > now() - interval '7 days'),
      'open_cards_14d', (select count(*) from public.review_cards c where c.source_id = s.id and c.status = 'open' and c.created_at > now() - interval '14 days'),
      'held_runs_pending', (select count(*) from public.held_runs h where h.source_id = s.id and h.status = 'pending'),
      'last_grant_at', (select max(g.issued_at) from private.ingest_grants g where g.source_id = s.id),
      'request_grant', (select jsonb_build_object('issued_at', g.issued_at, 'live', g.expires_at > now())
                          from private.ingest_grants g
                         where g.source_id = s.id and g.used_at is null
                           and ((s.force_due_at is not null and g.force_due_gen = s.force_due_gen)
                             or (s.read_requested_at is not null and g.read_request_gen = s.read_request_gen))
                         order by g.issued_at desc limit 1))
    from public.sources s order by s.name;
end $$;
do $$ begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sources'
        and column_name in ('force_due_at', 'force_due_served_at', 'read_requested_at', 'read_request_served_at')
        and data_type = 'timestamp with time zone' and is_nullable = 'YES') <> 4
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sources'
           and column_name in ('force_due_gen', 'read_request_gen') and data_type = 'bigint' and is_nullable = 'NO') <> 2
     or (select count(*) from information_schema.columns where table_schema = 'private' and table_name = 'ingest_grants'
           and column_name in ('force_due_gen', 'read_request_gen') and data_type = 'bigint' and is_nullable = 'YES') <> 2
     or (select count(*) from pg_trigger where tgrelid = 'private.ingest_grants'::regclass and tgname = 'ingest_grants_used' and not tgisinternal) <> 1
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname::text, p.proname::text, p.provolatile::text) in (
                ('public', 'admin_jobs', 's'), ('public', 'admin_source_health', 's'), ('public', 'admin_set_force_due', 'v'),
                ('public', 'admin_set_read_request', 'v'), ('public', 'svc_manual_grant_requested', 'v'), ('public', 'svc_issue_run_grants', 'v'),
                ('public', 'svc_manual_grant', 'v'), ('private', 'ingest_grant_used', 'v'), ('private', 'sources_gate', 'v'))) <> 9
     or exists (select 1 from public.sources where manual_only and force_due_at is not null)
     or exists (select 1 from public.sources where not manual_only and read_requested_at is not null) then
    raise exception 'sources_v2_state';
  end if;
end $$;
revoke all on all tables    in schema public, private from service_role;
revoke all on all sequences in schema public, private from service_role;
revoke execute on all functions in schema public  from public, anon, authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function public.list_sources_public() to anon, authenticated;
grant execute on function public.list_events(integer) to anon, authenticated;
grant execute on function public.admin_whoami() to authenticated;
grant execute on function public.admin_list_sources() to authenticated;
grant execute on function public.admin_set_source_enabled(text, boolean) to authenticated;
grant execute on function public.admin_set_source_trust(text, text) to authenticated;
grant execute on function public.admin_merge_events(uuid, uuid) to authenticated;
grant execute on function public.admin_queue(text, integer) to authenticated;
grant execute on function public.admin_card_open(uuid) to authenticated;
grant execute on function public.admin_decide_card(uuid, text, text, integer) to authenticated;
grant execute on function public.admin_update_event(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_event_status(uuid, text, text) to authenticated;
grant execute on function public.admin_unlock_field(uuid, text) to authenticated;
grant execute on function public.admin_source_health() to authenticated;
grant execute on function public.admin_add_suppression(text, text, text) to authenticated;
grant execute on function public.admin_log_activity(text, integer) to authenticated;
grant execute on function public.svc_ingest_nonce(text) to service_role;
grant execute on function public.svc_issue_run_grants() to service_role;
grant execute on function public.svc_ingest_batch(text, jsonb, jsonb) to service_role;
grant execute on function public.svc_set_venue_geocode(uuid, double precision, double precision, text) to service_role;
grant execute on function public.svc_cluster_and_publish(integer) to service_role;
grant execute on function public.svc_weekly_report() to service_role;
grant execute on function public.admin_owner_minutes_7d() to authenticated;
grant execute on function public.list_event_pages() to anon, authenticated;
grant execute on function public.api_events_v1(text, text, integer, date, date, text[], text[], integer, text) to anon, authenticated;
grant execute on function public.svc_manual_grant(text) to service_role;
grant execute on function public.admin_set_force_due(text, boolean) to authenticated;
grant execute on function public.admin_set_read_request(text, boolean) to authenticated;
grant execute on function public.admin_jobs(integer) to authenticated;
grant execute on function public.svc_manual_grant_requested(text) to service_role;
-- END migration copy

select is(pg_temp.snap($$(select slug, force_due_at, force_due_served_at, read_requested_at, read_request_served_at, next_due_at, enabled, trust from public.sources)$$),
  (select s1 from n0), 'AC-SV2-17 re-running the migration changes no stamp, next_due_at, enabled or trust');
select is(pg_temp.snap($$(select run_id, force_due_gen, read_request_gen, used_at, issued_at from private.ingest_grants)$$), (select s2 from n0),
  'AC-SV2-17 ... no grant row');
select is(pg_temp.snap($$(select slug, force_due_gen, read_request_gen from public.sources)$$), (select s3 from n0), 'AC-SV2-17 ... no generation');
select is(pg_temp.q($$(select count(*)::text || ':' || md5(string_agg(pg_get_functiondef(p.oid), '|' order by n.nspname, p.proname)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname::text, p.proname::text) in (('public', 'admin_jobs'), ('public', 'admin_source_health'), ('public', 'admin_set_force_due'),
       ('public', 'admin_set_read_request'), ('public', 'svc_manual_grant_requested'), ('public', 'svc_issue_run_grants'), ('public', 'svc_manual_grant'),
       ('private', 'ingest_grant_used'), ('private', 'sources_gate')))$$), (select fns from n0), 'AC-SV2-17 ... no function definition');
select is(pg_temp.q($$(select count(*) from pg_trigger where tgrelid = 'private.ingest_grants'::regclass and not tgisinternal)$$), (select trg from n0),
  'AC-SV2-17 ... no trigger');
select is(pg_temp.q($$pg_temp.matrix()$$), (select mx from n0), 'AC-SV2-17 ... no privilege');
select pg_temp.eq($$pg_temp.matrix()$$,
  'private.ingest_grant_used():anon:false,private.ingest_grant_used():authenticated:false,private.ingest_grant_used():service_role:false,'
  || 'public.admin_jobs(integer):anon:false,public.admin_jobs(integer):authenticated:true,public.admin_jobs(integer):service_role:false,'
  || 'public.admin_set_force_due(text, boolean):anon:false,public.admin_set_force_due(text, boolean):authenticated:true,public.admin_set_force_due(text, boolean):service_role:false,'
  || 'public.admin_set_read_request(text, boolean):anon:false,public.admin_set_read_request(text, boolean):authenticated:true,public.admin_set_read_request(text, boolean):service_role:false,'
  || 'public.svc_manual_grant_requested(text):anon:false,public.svc_manual_grant_requested(text):authenticated:false,public.svc_manual_grant_requested(text):service_role:true',
  'AC-SV2-17 block B''s EXECUTE matrix still holds after the re-run');

select * from finish();
rollback;
