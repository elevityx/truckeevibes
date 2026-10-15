-- AC-M0-04..07: the fail-closed source gate (private.sources_gate trigger + table checks).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
create function pg_temp.dml(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text; v_detail text;
begin
  execute p_sql;
  return 'OK';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  v_state := sqlstate;
  return v_state || '|' || coalesce(v_msg, '') || '|' || coalesce(v_detail, '');
end $$;
-- Scalar expression -> text; any error comes back as ERR:<sqlstate>, so one missing object fails one assertion.
create function pg_temp.q(p_expr text) returns text language plpgsql as $$
declare r text;
begin
  execute 'select (' || p_expr || ')::text' into r;
  return coalesce(r, '<null>');
exception when others then
  return 'ERR:' || sqlstate;
end $$;

-- fixtures: disabled sources with the default ('unknown') disposition
select is(pg_temp.dml($$insert into public.sources (slug, name, homepage_url, allowed_hosts, family, class)
  select 'gate-' || n, 'Gate ' || n, 'https://example.test/' || n, array['example.test'], 'ics', 'organizer'
    from generate_series(1, 9) n$$), 'OK', 'fixture: nine disabled unknown sources insert');

-- AC-M0-04
select is(split_part(pg_temp.dml($$update public.sources set enabled = true where slug = 'gate-1'$$), '|', 1), '23514',
  'AC-M0-04 enabling an unknown-disposition source -> 23514');
select is(split_part(pg_temp.dml($$update public.sources set enabled = true where slug = 'gate-1'$$), '|', 2),
  'source_not_permitted', 'AC-M0-04 message is source_not_permitted');

-- AC-M0-05
select is(split_part(pg_temp.dml($$update public.sources set enabled = true, ingest_disposition = 'permitted',
  allowed_methods = '{feed}', terms_url = 'https://example.test/terms', terms_hash = repeat('a', 64),
  terms_reviewed_at = now() - interval '2 days', terms_recheck_at = now() - interval '1 second'
  where slug = 'gate-2'$$), '|', 1), '23514', 'AC-M0-05 permitted but recheck in the past -> 23514');
select is(split_part(pg_temp.dml($$update public.sources set enabled = true, ingest_disposition = 'permitted',
  allowed_methods = '{feed}', terms_url = 'https://example.test/terms', terms_hash = repeat('a', 64),
  terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days'
  where slug = 'gate-3'$$), '|', 1), 'OK', 'AC-M0-05 permitted + recheck +30d + evidence + {feed} -> enabled');
select is(pg_temp.q($$(select enabled from public.sources where slug = 'gate-3')$$), 'true', 'gate-3 is enabled');
select is(split_part(pg_temp.dml($$update public.sources set enabled = true, ingest_disposition = 'permitted',
  allowed_methods = '{}', terms_url = 'https://example.test/terms', terms_hash = repeat('a', 64),
  terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days'
  where slug = 'gate-4'$$), '|', 1), '23514', 'AC-M0-05 empty allowed_methods -> 23514');
select is(split_part(pg_temp.dml($$update public.sources set enabled = true, ingest_disposition = 'permitted',
  allowed_methods = '{feed}', terms_url = 'https://example.test/terms', terms_hash = null,
  terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days'
  where slug = 'gate-5'$$), '|', 1), '23514', 'AC-M0-05 missing terms_hash -> 23514');
select is(split_part(pg_temp.dml($$update public.sources set enabled = true, ingest_disposition = 'permission_required',
  allowed_methods = '{feed}', terms_url = 'https://example.test/terms', terms_hash = repeat('a', 64),
  terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days'
  where slug = 'gate-5'$$), '|', 1), '23514', 'permission_required cannot be enabled');

-- AC-M0-06
select is(split_part(pg_temp.dml($$update public.sources set ingest_disposition = 'official_api_only',
  allowed_methods = '{html}' where slug = 'gate-6'$$), '|', 1), '23514', 'AC-M0-06 official_api_only + {html} -> check violation');
select is(split_part(pg_temp.dml($$update public.sources set ingest_disposition = 'official_api_only',
  allowed_methods = '{api}', enabled = true, terms_url = 'https://example.test/terms', terms_hash = repeat('b', 64),
  terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days'
  where slug = 'gate-6'$$), '|', 1), 'OK', 'official_api_only + {api} can be enabled');
select is(pg_temp.dml($$update public.sources set opt_out = true, enabled = true, ingest_disposition = 'permitted',
  allowed_methods = '{feed}', terms_url = 'https://example.test/terms', terms_hash = repeat('a', 64),
  terms_reviewed_at = now(), terms_recheck_at = now() + interval '30 days'
  where slug = 'gate-7'$$), '22023|invalid_input|opt_out_enabled', 'AC-M0-06 opt_out + enabled -> invalid_input / opt_out_enabled');
-- disabling an enabled source always succeeds, even when its recheck date has lapsed
select is(pg_temp.dml($$update public.sources set enabled = false, terms_recheck_at = now() - interval '1 day'
  where slug = 'gate-3'$$), 'OK', 'AC-M0-06 disabling always succeeds (even with a lapsed recheck)');
select is(pg_temp.q($$(select enabled from public.sources where slug = 'gate-3')$$), 'false', 'gate-3 is now disabled');

-- AC-M0-07
select is(split_part(pg_temp.dml($$update public.sources set ingest_disposition = 'permitted',
  terms_reviewed_at = '2026-01-01 00:00:00+00', terms_recheck_at = '2027-02-01 00:00:00+00'
  where slug = 'gate-8'$$), '|', 1), '23514', 'AC-M0-07 recheck = reviewed + 13 months -> check violation');
select is(split_part(pg_temp.dml($$update public.sources set ingest_disposition = 'permitted',
  terms_reviewed_at = '2026-01-01 00:00:00+00', terms_recheck_at = '2027-01-01 00:00:00+00'
  where slug = 'gate-9'$$), '|', 1), 'OK', 'recheck = reviewed + 12 months is allowed (boundary)');

-- the trigger keeps updated_at fresh
select ok(pg_temp.q($$(select updated_at >= created_at from public.sources where slug = 'gate-3')$$) = 'true',
  'sources_gate stamps updated_at');

select * from finish();
rollback;
