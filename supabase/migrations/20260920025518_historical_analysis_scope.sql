create schema if not exists extensions;
create extension if not exists postgis with schema extensions;

do $$
declare
  installed_schema text;
begin
  select n.nspname into installed_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'postgis';

  if installed_schema is distinct from 'extensions' then
    execute 'alter extension postgis set schema extensions';
  end if;
end;
$$;

create table if not exists public.analysis_regions (
  region_code text primary key,
  region_name text not null,
  geometry extensions.geometry(MultiPolygon, 4326),
  source text not null default '',
  source_year integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.analysis_regions (region_code, region_name, source, source_year)
values ('41280', '경기도 고양시', '통계청 행정구역 경계', 2018)
on conflict (region_code) do update
set region_name = excluded.region_name,
    source = excluded.source,
    source_year = excluded.source_year,
    updated_at = now();

create table if not exists public.observation_stations (
  id bigint generated always as identity primary key,
  source text not null check (source in ('kma_asos', 'kma_aws', 'kma_snow', 'hrfco', 'kwater')),
  station_code text not null,
  station_name text not null,
  address text not null default '',
  district text not null default '',
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  location extensions.geography(Point, 4326) generated always as (
    extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography
  ) stored,
  metrics text[] not null default '{}',
  is_goyang boolean not null default false,
  is_active boolean not null default true,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, station_code)
);

create or replace function private.enforce_goyang_station_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.is_goyang := exists (
    select 1
    from public.analysis_regions r
    where r.region_code = '41280'
      and r.geometry is not null
      and extensions.st_covers(
        r.geometry,
        extensions.st_setsrid(extensions.st_makepoint(new.longitude, new.latitude), 4326)
      )
  );
  return new;
end;
$$;

drop trigger if exists observation_stations_enforce_goyang_scope on public.observation_stations;
create trigger observation_stations_enforce_goyang_scope
before insert or update of latitude, longitude on public.observation_stations
for each row execute function private.enforce_goyang_station_scope();

create or replace function private.set_goyang_analysis_boundary(
  p_geometry jsonb,
  p_source text,
  p_source_year integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized extensions.geometry(MultiPolygon, 4326);
begin
  normalized := extensions.st_multi(
    extensions.st_collectionextract(
      extensions.st_makevalid(extensions.st_setsrid(extensions.st_geomfromgeojson(p_geometry), 4326)),
      3
    )
  );

  if normalized is null or extensions.st_isempty(normalized) then
    raise exception 'A non-empty Polygon or MultiPolygon GeoJSON geometry is required.';
  end if;

  update public.analysis_regions
  set geometry = normalized,
      source = p_source,
      source_year = p_source_year,
      updated_at = now()
  where region_code = '41280';

  update public.observation_stations s
  set is_goyang = extensions.st_covers(
        normalized,
        extensions.st_setsrid(extensions.st_makepoint(s.longitude, s.latitude), 4326)
      ),
      updated_at = now();
end;
$$;

create index if not exists observation_stations_location_idx on public.observation_stations using gist (location);
create index if not exists observation_stations_goyang_source_idx on public.observation_stations (source, is_active) where is_goyang;

create table if not exists public.historical_observations (
  id bigint generated always as identity primary key,
  station_id bigint not null references public.observation_stations(id) on delete restrict,
  observed_at timestamptz not null,
  metric text not null check (metric in ('rainfall_1h', 'rainfall_3h', 'rainfall_daily', 'snow_depth', 'new_snow', 'water_level', 'flow_rate')),
  value numeric(12, 3) not null,
  unit text not null,
  quality_code text not null default '',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (station_id, observed_at, metric)
);

create index if not exists historical_observations_station_metric_time_idx
  on public.historical_observations (station_id, metric, observed_at desc);
create index if not exists historical_observations_time_brin_idx
  on public.historical_observations using brin (observed_at);

create table if not exists public.flood_areas (
  id bigint generated always as identity primary key,
  source text not null,
  source_feature_id text not null,
  data_year integer,
  flood_type text not null check (flood_type in ('trace', 'river_scenario', 'urban_scenario')),
  scenario text not null default '',
  depth_m numeric(8, 2),
  geometry extensions.geometry(MultiPolygon, 4326) not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source, source_feature_id)
);

create or replace function private.clip_flood_area_to_goyang()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  goyang_boundary extensions.geometry(MultiPolygon, 4326);
begin
  select geometry into goyang_boundary
  from public.analysis_regions
  where region_code = '41280';

  if goyang_boundary is null then
    raise exception 'Load the Goyang boundary before importing flood-area data.';
  end if;

  new.geometry := extensions.st_multi(
    extensions.st_collectionextract(
      extensions.st_intersection(extensions.st_makevalid(new.geometry), goyang_boundary),
      3
    )
  );

  if new.geometry is null or extensions.st_isempty(new.geometry) then
    raise exception 'Flood-area geometry is outside Goyang.';
  end if;
  return new;
end;
$$;

drop trigger if exists flood_areas_clip_to_goyang on public.flood_areas;
create trigger flood_areas_clip_to_goyang
before insert or update of geometry on public.flood_areas
for each row execute function private.clip_flood_area_to_goyang();

create index if not exists flood_areas_geometry_idx on public.flood_areas using gist (geometry);
create index if not exists flood_areas_type_year_idx on public.flood_areas (flood_type, data_year);

create table if not exists public.facility_risk_metrics (
  id bigint generated always as identity primary key,
  facility_id text not null references public.facilities(id) on delete cascade,
  analysis_start date not null,
  analysis_end date not null,
  max_rainfall_1h numeric(10, 2),
  max_rainfall_daily numeric(10, 2),
  max_snow_depth numeric(10, 2),
  max_water_level numeric(10, 3),
  heavy_rain_days integer not null default 0 check (heavy_rain_days >= 0),
  water_level_exceedances integer not null default 0 check (water_level_exceedances >= 0),
  flood_trace_overlap boolean,
  river_scenario_overlap boolean,
  urban_scenario_overlap boolean,
  analysis_version text not null default 'v1',
  calculated_at timestamptz not null default now(),
  unique (facility_id, analysis_start, analysis_end, analysis_version)
);

create index if not exists facility_risk_metrics_period_idx
  on public.facility_risk_metrics (analysis_start, analysis_end, facility_id);

create table if not exists public.ingestion_runs (
  id bigint generated always as identity primary key,
  source text not null,
  scope_region_code text not null default '41280',
  period_start date,
  period_end date,
  status text not null check (status in ('pending', 'running', 'complete', 'partial', 'failed')),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  excluded_count integer not null default 0 check (excluded_count >= 0),
  message text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ingestion_runs_source_started_idx on public.ingestion_runs (source, started_at desc);

alter table public.analysis_regions enable row level security;
alter table public.observation_stations enable row level security;
alter table public.historical_observations enable row level security;
alter table public.flood_areas enable row level security;
alter table public.facility_risk_metrics enable row level security;
alter table public.ingestion_runs enable row level security;

revoke all on public.analysis_regions, public.observation_stations, public.historical_observations,
  public.flood_areas, public.facility_risk_metrics, public.ingestion_runs from anon, authenticated;
grant select on public.analysis_regions, public.observation_stations, public.historical_observations,
  public.flood_areas, public.facility_risk_metrics, public.ingestion_runs to authenticated;
grant all on public.analysis_regions, public.observation_stations, public.historical_observations,
  public.flood_areas, public.facility_risk_metrics, public.ingestion_runs to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function private.set_goyang_analysis_boundary(jsonb, text, integer) from public, anon, authenticated;
grant execute on function private.set_goyang_analysis_boundary(jsonb, text, integer) to service_role;

create policy "Administrators can read analysis regions" on public.analysis_regions
  for select to authenticated using ((select private.is_admin()));
create policy "Administrators can read observation stations" on public.observation_stations
  for select to authenticated using ((select private.is_admin()));
create policy "Administrators can read historical observations" on public.historical_observations
  for select to authenticated using ((select private.is_admin()));
create policy "Administrators can read flood areas" on public.flood_areas
  for select to authenticated using ((select private.is_admin()));
create policy "Administrators can read facility risk metrics" on public.facility_risk_metrics
  for select to authenticated using ((select private.is_admin()));
create policy "Administrators can read ingestion runs" on public.ingestion_runs
  for select to authenticated using ((select private.is_admin()));

create or replace function public.get_historical_analysis(p_start date, p_end date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with scoped_stations as (
    select s.*
    from public.observation_stations s
    where s.is_goyang and s.is_active
  ), scoped_observations as (
    select o.*, s.source, s.station_code, s.station_name, s.latitude, s.longitude
    from public.historical_observations o
    join scoped_stations s on s.id = o.station_id
    where o.observed_at >= p_start::timestamptz
      and o.observed_at < (p_end + 1)::timestamptz
  ), station_metrics as (
    select source, station_code, station_name, latitude, longitude, metric,
      max(value) as max_value, min(observed_at) as first_observed_at,
      max(observed_at) as last_observed_at, count(*) as observation_count
    from scoped_observations
    group by source, station_code, station_name, latitude, longitude, metric
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
