-- R4a (Amendment 10): kids category, notice titles, reason-code vocabulary, tag_reasons columns, and the hide of published notices.
-- No public function and no new grant: the allowlist below is the predecessor's (event_pages_read), unchanged.

-- 1. Kids category after family (sort 4); everything from sort 5 moves down one.
update public.categories set sort = sort + 1 where sort >= 5;
insert into public.categories (slug, label, sort, noun) values ('kids', 'Kids', 5, 'kids'' event');

-- 2. Notice parity function (TS twin: ingest/core/notices.ts, R4b).
create function private.is_notice_title(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null
     and lower(p) !~ '(closing party|season closing|no cover|no host)'
     and (lower(p) ~ 'clos(ed|ing) (at|early|today|tonight)'
       or lower(p) ~ '\mclosed\M.*\m(today|tonight|for)\M'
       or lower(p) ~ 'kitchen closed'
       or lower(p) ~ '(holiday|special) hours'
       or lower(p) ~ '^no\s+.+\s+(tonight|today)\M')
$$;

-- 3. Reason-code vocabulary (the closed list; TS twin: ingest/core/reasonCodes.ts, R4b).
create function private.valid_reason_code(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p ~ '^[a-z0-9_:]{1,40}$' and p = any (array[
    'cat:source_map','cat:title_kw','cat:desc_kids','cat:desc_family','cat:default',
    'price:text_free','price:text_paid','price:text_donation','price:desc_free','price:title_free','price:neg_blocked','price:unknown',
    'age:21_admission','age:18_admission','age:adult_phrase','age:all_ages','age:family','age:ambiguous','age:unknown',
    'conflict:adult','conflict:adult_signal','notice:cancel_sibling']::text[])
$$;

-- 4. Columns.
alter table public.source_events add column tag_reasons text[] not null default '{}' check (cardinality(tag_reasons) <= 16);
alter table public.source_event_versions add column tag_reasons text[] not null default '{}' check (cardinality(tag_reasons) <= 16);

-- 5. private.clean_source_item: verbatim copy of 20261021000300_alibi_venue_fixup.sql plus the marked R4a lines.
create or replace function private.clean_source_item(s public.sources, item jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_tz text := private.region_tz();
  v_iso text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  v_key text; v_title text; v_cut text;
  v_start timestamptz; v_end timestamptz; v_all_day boolean := false; v_sd date; v_ed date; v_tk boolean := true;
  v_url text; v_host text; v_turl text; v_vn text; v_addr text; v_town text; v_lat double precision; v_lng double precision;
  v_pk text := 'unknown'; v_pmin numeric; v_pmax numeric; v_age text := 'unknown'; v_cats text[] := '{}';
  v_cancel boolean := false; v_series text;
  -- R4a begin
  v_reasons text[] := '{}';
  -- R4a end
begin
  if jsonb_typeof(item) is distinct from 'object' then return jsonb_build_object('reject', 'item'); end if;

  -- externalKey: 1-400 chars
  if private.jt(item, 'externalKey') <> 'string' then return jsonb_build_object('reject', 'external_key'); end if;
  v_key := item ->> 'externalKey';
  if char_length(v_key) not between 1 and 400 then return jsonb_build_object('reject', 'external_key'); end if;

  -- title: strip control chars, collapse spaces, no markup, no blocked term, >= 3 chars, cut to 80 at a word boundary
  if private.jt(item, 'title') <> 'string' then return jsonb_build_object('reject', 'title'); end if;
  v_title := private.clean_text(item ->> 'title');
  if v_title ~ '[<>]' or private.has_blocked_term(v_title) or char_length(v_title) < 3 then
    return jsonb_build_object('reject', 'title');
  end if;
  if char_length(v_title) > 80 then
    v_cut := left(v_title, 80);
    if substr(v_title, 81, 1) <> ' ' then v_cut := regexp_replace(v_cut, '\s+\S*$', ''); end if;
    v_cut := btrim(v_cut);
    v_title := case when v_cut = '' then left(v_title, 80) else v_cut end;
  end if;
  if char_length(private.normalize_title(v_title)) < 3 then return jsonb_build_object('reject', 'title'); end if;
  -- R4a begin
  if private.is_notice_title(v_title) then return jsonb_build_object('reject', 'notice'); end if;
  -- R4a end

  -- allDay, startsAt, endsAt
  if private.jt(item, 'allDay') = 'boolean' then v_all_day := (item ->> 'allDay')::boolean;
  elsif private.jt(item, 'allDay') <> 'null' then return jsonb_build_object('reject', 'all_day'); end if;

  if v_all_day then
    if private.jt(item, 'startDate') <> 'string' or private.jt(item, 'endDate') <> 'string'
       or (item ->> 'startDate') !~ '^\d{4}-\d{2}-\d{2}$' or (item ->> 'endDate') !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('reject', 'dates');
    end if;
    begin
      v_sd := (item ->> 'startDate')::date; v_ed := (item ->> 'endDate')::date;
    exception when others then return jsonb_build_object('reject', 'dates');
    end;
    if v_ed <= v_sd or v_ed - v_sd > 120 then return jsonb_build_object('reject', 'dates'); end if;
    v_start := v_sd::timestamp at time zone v_tz;       -- local midnight of the first day
    v_end := v_ed::timestamp at time zone v_tz;         -- exclusive end, local midnight
    v_tk := false;
  else
    if private.jt(item, 'startsAt') <> 'string' or (item ->> 'startsAt') !~ v_iso then return jsonb_build_object('reject', 'starts_at'); end if;
    begin
      v_start := (item ->> 'startsAt')::timestamptz;
    exception when others then return jsonb_build_object('reject', 'starts_at');
    end;
    if private.jt(item, 'endsAt') <> 'null' then
      if private.jt(item, 'endsAt') <> 'string' or (item ->> 'endsAt') !~ v_iso then return jsonb_build_object('reject', 'ends_at'); end if;
      begin
        v_end := (item ->> 'endsAt')::timestamptz;
      exception when others then return jsonb_build_object('reject', 'ends_at');
      end;
    end if;
    if private.jt(item, 'timeKnown') = 'boolean' then v_tk := (item ->> 'timeKnown')::boolean;
    elsif private.jt(item, 'timeKnown') <> 'null' then return jsonb_build_object('reject', 'time_known'); end if;
  end if;
  if v_start < now() - interval '1 day' or v_start > now() + interval '120 days' then return jsonb_build_object('reject', 'window'); end if;
  if v_end is not null and (v_end <= v_start or v_end > v_start + interval '120 days') then return jsonb_build_object('reject', 'ends_at'); end if;

  -- url must be https, valid, and on an allowed host (or a subdomain of one); ticketUrl only needs to be valid
  if private.jt(item, 'url') <> 'null' then
    if private.jt(item, 'url') <> 'string' or not private.valid_event_url(item ->> 'url') then return jsonb_build_object('reject', 'url'); end if;
    v_url := item ->> 'url';
    v_host := substring(lower(v_url) from '^https://([^/?#]+)');
    if not exists (select 1 from unnest(s.allowed_hosts) h where v_host = lower(h) or v_host like '%.' || lower(h)) then
      return jsonb_build_object('reject', 'url_host');
    end if;
  end if;
  if private.jt(item, 'ticketUrl') <> 'null' then
    if private.jt(item, 'ticketUrl') <> 'string' or not private.valid_event_url(item ->> 'ticketUrl') then return jsonb_build_object('reject', 'ticket_url'); end if;
    v_turl := item ->> 'ticketUrl';
  end if;

  -- venue
  if private.jt(item, 'venueName') <> 'null' then
    if private.jt(item, 'venueName') <> 'string' then return jsonb_build_object('reject', 'venue'); end if;
    v_vn := nullif(private.clean_text(item ->> 'venueName'), '');
    if v_vn is not null and (char_length(v_vn) > 80 or v_vn ~ '[<>]') then return jsonb_build_object('reject', 'venue'); end if;
  end if;
  if private.jt(item, 'address') <> 'null' then
    if private.jt(item, 'address') <> 'string' then return jsonb_build_object('reject', 'address'); end if;
    v_addr := nullif(private.clean_text(item ->> 'address'), '');
    if v_addr is not null and (char_length(v_addr) > 160 or v_addr ~ '[<>]') then return jsonb_build_object('reject', 'address'); end if;
  end if;
  if private.is_non_place(v_vn) then v_vn := null; v_addr := null; end if;   -- A8.1: a URL or letterless LOCATION is not a venue
  if private.jt(item, 'town') <> 'null' then
    if private.jt(item, 'town') <> 'string' then return jsonb_build_object('reject', 'town'); end if;
    v_town := nullif(private.clean_text(item ->> 'town'), '');
    if v_town is not null and (char_length(v_town) > 60 or v_town ~ '[<>]') then return jsonb_build_object('reject', 'town'); end if;
  end if;
  if private.jt(item, 'lat') = 'number' and private.jt(item, 'lng') = 'number' then
    v_lat := (item ->> 'lat')::double precision; v_lng := (item ->> 'lng')::double precision;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then return jsonb_build_object('reject', 'coords'); end if;
  elsif private.jt(item, 'lat') <> 'null' or private.jt(item, 'lng') <> 'null' then
    return jsonb_build_object('reject', 'coords');      -- both or neither, numbers only
  end if;

  -- price and age: text hints are length-checked (classified in the runner); the enums are re-validated here
  if private.jt(item, 'priceText') <> 'null' and (private.jt(item, 'priceText') <> 'string' or char_length(item ->> 'priceText') > 80) then
    return jsonb_build_object('reject', 'price_text');
  end if;
  if private.jt(item, 'ageText') <> 'null' and (private.jt(item, 'ageText') <> 'string' or char_length(item ->> 'ageText') > 80) then
    return jsonb_build_object('reject', 'age_text');
  end if;
  if private.jt(item, 'priceKind') <> 'null' then
    if private.jt(item, 'priceKind') <> 'string' or (item ->> 'priceKind') not in ('free', 'paid', 'donation', 'unknown') then return jsonb_build_object('reject', 'price_kind'); end if;
    v_pk := item ->> 'priceKind';
  end if;
  if private.jt(item, 'priceMin') <> 'null' then
    if private.jt(item, 'priceMin') <> 'number' or (item ->> 'priceMin')::numeric not between 0 and 99999.99 then return jsonb_build_object('reject', 'price'); end if;
    v_pmin := (item ->> 'priceMin')::numeric;
  end if;
  if private.jt(item, 'priceMax') <> 'null' then
    if private.jt(item, 'priceMax') <> 'number' or (item ->> 'priceMax')::numeric not between 0 and 99999.99 then return jsonb_build_object('reject', 'price'); end if;
    v_pmax := (item ->> 'priceMax')::numeric;
  end if;
  if v_pmin is not null and v_pmax is not null and v_pmin > v_pmax then return jsonb_build_object('reject', 'price'); end if;
  if private.jt(item, 'age') <> 'null' then
    if private.jt(item, 'age') <> 'string' or (item ->> 'age') not in ('all_ages', 'family', '18_plus', '21_plus', 'unknown') then return jsonb_build_object('reject', 'age'); end if;
    v_age := item ->> 'age';
  end if;

  -- categories: only known slugs survive
  if private.jt(item, 'categoriesHint') <> 'null' then
    if private.jt(item, 'categoriesHint') <> 'array' then return jsonb_build_object('reject', 'categories'); end if;
    if exists (select 1 from jsonb_array_elements(item -> 'categoriesHint') c where jsonb_typeof(c) <> 'string') then return jsonb_build_object('reject', 'categories'); end if;
    v_cats := array(select distinct c from jsonb_array_elements_text(item -> 'categoriesHint') c
                     where c in (select k.slug from public.categories k) order by c);
  end if;

  if private.jt(item, 'cancelled') = 'boolean' then v_cancel := (item ->> 'cancelled')::boolean;
  elsif private.jt(item, 'cancelled') <> 'null' then return jsonb_build_object('reject', 'cancelled'); end if;
  if private.jt(item, 'seriesUid') <> 'null' then
    if private.jt(item, 'seriesUid') <> 'string' or char_length(item ->> 'seriesUid') not between 1 and 300 then return jsonb_build_object('reject', 'series'); end if;
    v_series := item ->> 'seriesUid';
  end if;

  -- R4a begin
  -- tagReasons: absent/null -> none; must be an array of strings; unknown codes dropped, duplicates removed, order kept, at most 16
  if private.jt(item, 'tagReasons') <> 'null' then
    if private.jt(item, 'tagReasons') <> 'array' then return jsonb_build_object('reject', 'tag_reasons'); end if;
    if exists (select 1 from jsonb_array_elements(item -> 'tagReasons') c where jsonb_typeof(c) <> 'string') then return jsonb_build_object('reject', 'tag_reasons'); end if;
    v_reasons := array(select c from jsonb_array_elements_text(item -> 'tagReasons') with ordinality t(c, o)
                        where private.valid_reason_code(c) group by c order by min(o) limit 16);
  end if;
  -- R4a end

  -- suppressions (host / url_prefix on the link)
  if v_url is not null and exists (
       select 1 from public.suppressions x
        where (x.kind = 'host' and (v_host = lower(x.value) or right(v_host, char_length(x.value) + 1) = '.' || lower(x.value)))
           or (x.kind = 'url_prefix' and left(v_url, char_length(x.value)) = x.value)) then
    return jsonb_build_object('reject', 'suppressed');
  end if;

  return jsonb_build_object('external_key', v_key, 'series_uid', v_series,
    -- R4a begin
    'tag_reasons', to_jsonb(v_reasons),   -- a sibling of facts, never hashed (DR11)
    -- R4a end
    'facts', jsonb_build_object(
    'title', v_title,
    'starts_at', to_char(v_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ends_at', case when v_end is null then null else to_char(v_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'all_day', v_all_day, 'start_date', v_sd, 'end_date', v_ed, 'time_known', v_tk,
    'venue_name', v_vn, 'address', v_addr, 'town', v_town, 'lat', v_lat, 'lng', v_lng,
    'url', v_url, 'ticket_url', v_turl, 'price_kind', v_pk, 'price_min', v_pmin, 'price_max', v_pmax,
    'age', v_age, 'categories', to_jsonb(v_cats), 'cancelled', v_cancel));
end $$;

-- 6. private.apply_items: verbatim copy of 20261020000200_ingest_rpcs.sql plus the marked R4a lines.
create or replace function private.apply_items(p_source public.sources, p_run_id uuid, p_parser text, p_items jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  rec jsonb; f jsonb; v_key text; v_hash text; se public.source_events; v_venue uuid; v_series uuid; v_status text;
  v_new int := 0; v_changed int := 0; v_gone int := 0; v_keys text[] := '{}'; v_venues uuid[] := '{}';
  v_cats text[]; v_parser text := coalesce(p_parser, 'unknown'); v_exists boolean;
  -- R4a begin
  v_reasons text[];
  -- R4a end
begin
  for rec in select value from jsonb_array_elements(p_items) loop
    f := rec -> 'facts';
    v_key := rec ->> 'external_key';
    v_keys := array_append(v_keys, v_key);
    v_hash := private.facts_hash(f);
    v_status := case when (f ->> 'cancelled')::boolean then 'cancelled_by_source' else 'live' end;
    -- R4a begin
    v_reasons := array(select jsonb_array_elements_text(coalesce(rec -> 'tag_reasons', '[]'::jsonb)));
    -- R4a end
    select * into se from public.source_events x where x.source_id = p_source.id and x.external_key = v_key for update;
    v_exists := found;
    if v_exists and se.content_hash = v_hash then
      -- unchanged: seen again; a row that had gone comes back live
      update public.source_events x set last_seen_at = now(), missing_runs = 0,
             tag_reasons = v_reasons,   -- R4a
             source_status = case when x.source_status = 'gone' then v_status else x.source_status end,
             needs_cluster = x.needs_cluster or x.source_status = 'gone'
       where x.id = se.id;
      if se.venue_id is not null then v_venues := array_append(v_venues, se.venue_id); end if;
      continue;
    end if;

    v_venue := private.resolve_venue(f);
    if v_venue is not null then v_venues := array_append(v_venues, v_venue); end if;
    v_series := null;
    if rec ->> 'series_uid' is not null then
      insert into public.series (source_id, source_uid, title) values (p_source.id, rec ->> 'series_uid', f ->> 'title')
        on conflict (source_id, source_uid) do update set title = excluded.title returning id into v_series;
    end if;
    v_cats := array(select jsonb_array_elements_text(f -> 'categories'));

    if not v_exists then
      insert into public.source_events (source_id, external_key, facts, content_hash, title, normalized_title, starts_at, ends_at,
          all_day, start_date, end_date, time_known, start_day, venue_id, url, ticket_url, price_kind, price_min, price_max,
          age, categories, series_id, source_status, needs_cluster, tag_reasons)   -- R4a
        values (p_source.id, v_key, f, v_hash, f ->> 'title', '', (f ->> 'starts_at')::timestamptz, (f ->> 'ends_at')::timestamptz,
          (f ->> 'all_day')::boolean, (f ->> 'start_date')::date, (f ->> 'end_date')::date, (f ->> 'time_known')::boolean,
          current_date, v_venue, f ->> 'url', f ->> 'ticket_url', f ->> 'price_kind', (f ->> 'price_min')::numeric,
          (f ->> 'price_max')::numeric, f ->> 'age', v_cats, v_series, v_status, true, v_reasons)   -- R4a
        returning * into se;
      v_new := v_new + 1;
    else
      update public.source_events x set facts = f, content_hash = v_hash, title = f ->> 'title',
          starts_at = (f ->> 'starts_at')::timestamptz, ends_at = (f ->> 'ends_at')::timestamptz,
          all_day = (f ->> 'all_day')::boolean, start_date = (f ->> 'start_date')::date, end_date = (f ->> 'end_date')::date,
          time_known = (f ->> 'time_known')::boolean, venue_id = v_venue, url = f ->> 'url', ticket_url = f ->> 'ticket_url',
          price_kind = f ->> 'price_kind', price_min = (f ->> 'price_min')::numeric, price_max = (f ->> 'price_max')::numeric,
          age = f ->> 'age', categories = v_cats, series_id = v_series, last_seen_at = now(), missing_runs = 0,
          source_status = v_status, needs_cluster = true, tag_reasons = v_reasons   -- R4a
        where x.id = se.id;
      v_changed := v_changed + 1;
    end if;
    insert into public.source_event_versions (source_event_id, run_id, normalized, normalized_hash, parser_version, tag_reasons)   -- R4a
      values (se.id, p_run_id, f, v_hash, v_parser, v_reasons);   -- R4a
  end loop;

  -- live, future occurrences missing from this batch: one more missed run; the third marks them gone
  with g as (
    update public.source_events x
       set missing_runs = (x.missing_runs + 1)::smallint,
           source_status = case when x.missing_runs + 1 >= 3 then 'gone' else x.source_status end,
           needs_cluster = x.needs_cluster or x.missing_runs + 1 >= 3
     where x.source_id = p_source.id and x.source_status = 'live' and x.starts_at > now()
       and x.external_key <> all (v_keys)
    returning x.source_status)
  select count(*) filter (where source_status = 'gone') into v_gone from g;

  return jsonb_build_object('new', v_new, 'changed', v_changed, 'gone', v_gone,
                            'venue_ids', to_jsonb((select coalesce(array_agg(distinct vv), '{}') from unnest(v_venues) vv)));
end $$;

-- 7. Hide published notices. A private function (no grant) so pgTAP runs the exact code on fixture rows (A8 pattern); returns the count hidden.
create function private.hide_notice_events() returns integer
language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  with h as (
    update public.events e set status = 'hidden', status_by_admin = true, reject_reason = 'notice'
     where e.origin = 'ingest' and e.status = 'published' and private.is_notice_title(e.title)
       and not ('title' = any (e.locked_fields))
    returning e.id),
  ins as (
    insert into public.event_changes (event_id, field, old_value, new_value, decided_by)
    select h.id, 'status', '"published"'::jsonb, '"hidden"'::jsonb, 'rule:notice' from h
    returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;
select private.hide_notice_events();

-- 8. Grants: deny everything, then the exact cumulative allowlist (the predecessor's 24, unchanged).
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
