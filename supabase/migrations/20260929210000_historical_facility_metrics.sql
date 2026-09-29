-- Return the linked facility and period statistics for each observed metric.
create or replace function public.get_historical_analysis(p_start date, p_end date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set timezone = 'Asia/Seoul'
as $$
  with scoped_stations as (
    select s.*
    from public.observation_stations s
    where s.is_goyang and s.is_active
  ), scoped_observations as (
    select o.*, s.source, s.station_code, s.station_name, s.facility_id,
      s.latitude, s.longitude
    from public.historical_observations o
    join scoped_stations s on s.id = o.station_id
    where o.observed_at >= p_start::timestamptz
      and o.observed_at < (p_end + 1)::timestamptz
  ), station_metrics as (
    select source, station_code, station_name, facility_id, latitude, longitude, metric,
      min(value) as min_value, round(avg(value)::numeric, 3) as avg_value,
      max(value) as max_value, min(observed_at) as first_observed_at,
      max(observed_at) as last_observed_at, count(*) as observation_count
    from scoped_observations
    group by source, station_code, station_name, facility_id, latitude, longitude, metric
  )
  select jsonb_build_object(
    'scope', jsonb_build_object('regionCode', '41280', 'regionName', '경기도 고양시'),
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'generatedAt', now(),
    'summary', jsonb_build_object(
      'stationCount', (select count(*) from scoped_stations),
      'observationCount', (select count(*) from scoped_observations),
      'maxRainfall1h', (select max(value) from scoped_observations where metric = 'rainfall_1h'),
      'maxRainfallDaily', (select max(value) from scoped_observations where metric = 'rainfall_daily'),
      'maxSnowDepth', (select max(value) from scoped_observations where metric = 'snow_depth'),
      'maxWaterLevel', (select max(value) from scoped_observations where metric = 'water_level'),
      'floodTraceCount', (select count(*) from public.flood_areas where flood_type = 'trace'),
      'analysedFacilityCount', (select count(distinct facility_id) from public.facility_risk_metrics where analysis_start = p_start and analysis_end = p_end)
    ),
    'stations', coalesce((select jsonb_agg(to_jsonb(station_metrics) order by station_name, metric) from station_metrics), '[]'::jsonb),
    'areas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'name', concat(source, case when data_year is null then '' else concat(' ', data_year) end, case when scenario = '' then '' else concat(' · ', scenario) end),
        'kind', case flood_type when 'trace' then 'floodTrace' when 'river_scenario' then 'riverFlood' else 'urbanFlood' end,
        'geojson', extensions.st_asgeojson(geometry)::jsonb,
        'value', depth_m,
        'unit', case when depth_m is null then null else 'm' end
      ) order by flood_type, data_year desc nulls last)
      from public.flood_areas
      where data_year is null or data_year between extract(year from p_start)::integer and extract(year from p_end)::integer
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(to_jsonb(latest) order by source)
      from (
        select distinct on (source) source, status, accepted_count, excluded_count, message, finished_at
        from public.ingestion_runs
        where scope_region_code = '41280'
        order by source, started_at desc
      ) latest
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_historical_analysis(date, date) from public, anon;
grant execute on function public.get_historical_analysis(date, date) to authenticated, service_role;
