-- AC-M0-08: private.area_for named points.
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

select is(pg_temp.q($$private.area_for(39.3280::double precision, -120.1833::double precision)$$), 'truckee', 'area_for(39.3280, -120.1833)');
select is(pg_temp.q($$private.area_for(39.3240::double precision, -120.2650::double precision)$$), 'donner_lake', 'area_for(39.3240, -120.2650)');
select is(pg_temp.q($$private.area_for(39.1677::double precision, -120.1452::double precision)$$), 'tahoe_city_west_shore', 'area_for(39.1677, -120.1452)');
select is(pg_temp.q($$private.area_for(39.1970::double precision, -120.2357::double precision)$$), 'olympic_valley_northstar', 'area_for(39.1970, -120.2357)');
select is(pg_temp.q($$private.area_for(39.2746::double precision, -120.1210::double precision)$$), 'olympic_valley_northstar', 'area_for(39.2746, -120.1210)');
select is(pg_temp.q($$private.area_for(39.2377::double precision, -120.0266::double precision)$$), 'kings_beach_north_shore', 'area_for(39.2377, -120.0266)');
select is(pg_temp.q($$private.area_for(39.2513::double precision, -119.9727::double precision)$$), 'incline_crystal_bay', 'area_for(39.2513, -119.9727)');
select is(pg_temp.q($$private.area_for(39.2266::double precision, -120.0030::double precision)$$), 'incline_crystal_bay', 'area_for(39.2266, -120.0030)');
select is(pg_temp.q($$private.area_for(39.1980::double precision, -119.9310::double precision)$$), 'incline_crystal_bay', 'area_for(39.1980, -119.9310)');
select is(pg_temp.q($$private.area_for(39.5296::double precision, -119.8138::double precision)$$), 'reno_carson', 'area_for(39.5296, -119.8138)');
select is(pg_temp.q($$private.area_for(39.1638::double precision, -119.7674::double precision)$$), 'reno_carson', 'area_for(39.1638, -119.7674)');
select is(pg_temp.q($$private.area_for(39.70::double precision, -120.00::double precision)$$), '<null>', 'area_for(39.70, -120.00)');
select is(pg_temp.q($$private.area_for('NaN'::double precision, -120.18::double precision)$$), '<null>', 'area_for(NaN, -120.18)');

select is(pg_temp.q($$(select count(*) from public.areas)$$), '7', 'seven areas are seeded');
select is(pg_temp.q($$(select count(*) from public.regions where slug = 'truckee')$$), '1', 'truckee region is seeded');
select is(pg_temp.q($$(select count(*) from public.categories)$$), '15', 'fifteen categories are seeded (twelve plus kids R4a, schools A12, members-only A13)');
select is(pg_temp.q($$(select count(*) from private.blocked_terms)$$), '10', 'ten blocked terms are seeded');
select is(pg_temp.q($$(select string_agg(slug, ',' order by slug) from public.sources where enabled)$$), 'alibi-truckee,tdrpd,truckee-chamber,ttusd-acms,ttusd-district,ttusd-nths,ttusd-nts,ttusd-te,ttusd-ths,ttusd-tle,visit-lake-tahoe', 'only the rollout sources are enabled');
-- M1 (S1.13a) records the terms evidence of the nine M1 sources, so the M0 seed state now holds for the other five only.
select is(pg_temp.q($$(select count(*) from public.sources where slug not in ('diamond-peak','ivgid','visit-lake-tahoe','truckee-chamber','tdrpd','alibi-truckee','tahoe-donner','truckee-roundhouse','arts-for-the-schools')
  and slug not like 'ttusd-%' and (ingest_disposition <> 'unknown' or trust <> 'link_only'))$$), '0',
  'the five link-only listings are seeded unknown + link_only');
select is(pg_temp.q($$(select count(*) from public.sources where trust = 'link_only')$$), '8', 'eight link_only sources: the five listings + the three permission-gated M1 sources');
select is(pg_temp.q($$(select count(*) from public.sources where slug in ('diamond-peak','ivgid','visit-lake-tahoe','truckee-chamber','tdrpd','alibi-truckee','tahoe-donner','truckee-roundhouse','arts-for-the-schools'))$$),
  '9', 'the nine M1 sources are seeded');

select * from finish();
rollback;
