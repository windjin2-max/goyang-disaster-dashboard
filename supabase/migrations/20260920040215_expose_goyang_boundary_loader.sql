create or replace function public.load_goyang_analysis_boundary(
  p_geojson jsonb,
  p_source text default '통계청 행정구역 경계',
  p_source_year integer default 2018
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  boundary extensions.geometry(MultiPolygon, 4326);
  district_count integer;
  scoped_station_count integer;
begin
  if jsonb_typeof(p_geojson) <> 'object' then
    raise exception 'GeoJSON must be an object.';
  end if;

  with features as (
    select value as feature
    from jsonb_array_elements(
      case p_geojson->>'type'
        when 'FeatureCollection' then p_geojson->'features'
        when 'Feature' then jsonb_build_array(p_geojson)
        else jsonb_build_array(jsonb_build_object('type', 'Feature', 'geometry', p_geojson))
      end
    )
  ), parsed as (
    select extensions.st_makevalid(
      extensions.st_setsrid(
        extensions.st_geomfromgeojson((feature->'geometry')::text),
        4326
      )
    ) as geometry
    from features
    where feature->'geometry' is not null
  )
  select
    extensions.st_multi(
      extensions.st_collectionextract(
        extensions.st_unaryunion(extensions.st_collect(geometry)),
        3
      )
    ),
    count(*)
  into boundary, district_count
  from parsed;

  if boundary is null or extensions.st_isempty(boundary) then
    raise exception 'A non-empty Polygon or MultiPolygon is required.';
  end if;

  insert into public.analysis_regions (
    region_code, region_name, geometry, source, source_year, updated_at
  )
  values (
    '41280', '경기도 고양시', boundary, p_source, p_source_year, now()
  )
  on conflict (region_code) do update
  set region_name = excluded.region_name,
      geometry = excluded.geometry,
      source = excluded.source,
      source_year = excluded.source_year,
      updated_at = now();

  update public.observation_stations s
  set is_goyang = extensions.st_covers(
        boundary,
        extensions.st_setsrid(extensions.st_makepoint(s.longitude, s.latitude), 4326)
      ),
      updated_at = now();

  select count(*) into scoped_station_count
  from public.observation_stations
  where is_goyang;

  return jsonb_build_object(
    'regionCode', '41280',
    'regionName', '경기도 고양시',
    'districtCount', district_count,
    'areaSquareKm', round((extensions.st_area(boundary::extensions.geography) / 1000000.0)::numeric, 2),
    'stationCount', scoped_station_count,
    'source', p_source,
    'sourceYear', p_source_year
  );
end;
$$;

revoke all on function public.load_goyang_analysis_boundary(jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.load_goyang_analysis_boundary(jsonb, text, integer) to service_role;

comment on function public.load_goyang_analysis_boundary(jsonb, text, integer)
  is 'Service-role-only loader for the Goyang analysis boundary.';
