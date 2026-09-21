create or replace function public.upsert_goyang_observation_stations(
  p_source text,
  p_stations jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with candidates as (
    select station_code, station_name, address, latitude, longitude, raw
    from jsonb_to_recordset(p_stations) as x(
      station_code text,
      station_name text,
      address text,
      latitude double precision,
      longitude double precision,
      raw jsonb
    )
    where station_code <> ''
      and latitude between -90 and 90
      and longitude between -180 and 180
  ), scoped as (
    select c.*
    from candidates c
    join public.analysis_regions r on r.region_code = '41280'
    where r.geometry is not null
      and extensions.st_covers(
        r.geometry,
        extensions.st_setsrid(extensions.st_makepoint(c.longitude, c.latitude), 4326)
      )
  ), upserted as (
    insert into public.observation_stations (
      source, station_code, station_name, address, latitude, longitude,
      metrics, is_active, raw, updated_at
    )
    select
      p_source, station_code, station_name, coalesce(address, ''), latitude, longitude,
      array['rainfall_daily', 'snow_depth', 'new_snow'], true, coalesce(raw, '{}'::jsonb), now()
    from scoped
    on conflict (source, station_code) do update
    set station_name = excluded.station_name,
        address = excluded.address,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        metrics = excluded.metrics,
        is_active = true,
        raw = excluded.raw,
        updated_at = now()
    returning id, station_code, station_name
  )
  select jsonb_build_object(
    'acceptedCount', (select count(*) from upserted),
    'excludedCount', greatest(jsonb_array_length(p_stations) - (select count(*) from scoped), 0),
    'stations', coalesce((select jsonb_agg(to_jsonb(upserted) order by station_name) from upserted), '[]'::jsonb)
  );
$$;

revoke all on function public.upsert_goyang_observation_stations(text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_goyang_observation_stations(text, jsonb) to service_role;

comment on function public.upsert_goyang_observation_stations(text, jsonb)
  is 'Service-role-only batch upsert that retains only stations inside the Goyang boundary.';
