alter table public.flood_scenario_areas
  add column if not exists source_group_id text,
  add column if not exists is_hole boolean not null default false;

update public.flood_scenario_areas
set source_group_id = source_feature_id
where source_group_id is null;

alter table public.flood_scenario_areas
  alter column source_group_id set not null;

create index if not exists flood_scenario_areas_group_hole_idx
  on public.flood_scenario_areas (layer_code, source_group_id, is_hole);

create or replace function public.insert_flood_scenario_part(
  p_layer_code text,
  p_source_group_id text,
  p_source_feature_id text,
  p_is_hole boolean,
  p_frequency_years integer,
  p_district_code text,
  p_district_name text,
  p_depth_code text,
  p_depth_label text,
  p_depth_m numeric,
  p_geometry jsonb,
  p_source_srid integer default 5186,
  p_raw jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '2min'
as $$
declare
  parsed extensions.geometry;
  transformed extensions.geometry;
  final_geometry extensions.geometry(MultiPolygon, 4326);
  final_area numeric;
begin
  if p_layer_code not in ('national_river_flood', 'local_river_flood', 'urban_flood') then
    raise exception 'Unsupported flood scenario layer: %', p_layer_code;
  end if;
  if p_source_srid not in (4326, 5186) then
    raise exception 'Unsupported source SRID: %', p_source_srid;
  end if;

  parsed := extensions.st_setsrid(extensions.st_geomfromgeojson(p_geometry), p_source_srid);
  transformed := extensions.st_makevalid(case
    when p_source_srid = 4326 then parsed
    else extensions.st_transform(parsed, 4326)
  end);

  select extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(
    extensions.st_intersection(transformed, geometry)
  ), 3))
  into final_geometry
  from public.analysis_regions
  where region_code = '41280';

  if final_geometry is null or extensions.st_isempty(final_geometry) then
    return jsonb_build_object('inserted', false, 'reason', 'outside_goyang');
  end if;

  final_area := round((extensions.st_area(final_geometry::extensions.geography) / 1000000.0)::numeric, 6);
  insert into public.flood_scenario_areas (
    layer_code, source_group_id, source_feature_id, is_hole, frequency_years,
    district_code, district_name, depth_code, depth_label, depth_m,
    geometry, area_sq_km, raw
  ) values (
    p_layer_code, p_source_group_id, p_source_feature_id, p_is_hole, p_frequency_years,
    p_district_code, p_district_name, p_depth_code, p_depth_label, p_depth_m,
    final_geometry, final_area, coalesce(p_raw, '{}'::jsonb)
  )
  on conflict (layer_code, source_feature_id) do update
  set source_group_id = excluded.source_group_id,
      is_hole = excluded.is_hole,
      frequency_years = excluded.frequency_years,
      district_code = excluded.district_code,
      district_name = excluded.district_name,
      depth_code = excluded.depth_code,
      depth_label = excluded.depth_label,
      depth_m = excluded.depth_m,
      geometry = excluded.geometry,
      area_sq_km = excluded.area_sq_km,
      raw = excluded.raw,
      updated_at = now();

  return jsonb_build_object(
    'inserted', true,
    'areaSquareKm', final_area,
    'pointCount', extensions.st_npoints(final_geometry)
  );
end;
$$;

revoke all on function public.insert_flood_scenario_part(
  text, text, text, boolean, integer, text, text, text, text, numeric, jsonb, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.insert_flood_scenario_part(
  text, text, text, boolean, integer, text, text, text, text, numeric, jsonb, integer, jsonb
) to service_role;

create or replace function public.calculate_flood_overlap_analysis()
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10min'
as $$
declare
  latest_month text;
  facility_rows integer;
  dong_rows integer;
begin
  select max(statistic_month) into latest_month from public.population_monthly;
  if latest_month is null then
    raise exception 'Population data is required before flood overlap analysis.';
  end if;

  delete from public.facility_flood_exposure where facility_id is not null;
  delete from public.admin_dong_flood_exposure where admin_code is not null;

  with layer_codes(layer_code) as (
    values ('national_river_flood'::text), ('local_river_flood'::text), ('urban_flood'::text)
  ), facility_points as (
    select id, extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326) as geometry
    from public.facilities
    where longitude between -180 and 180 and latitude between -90 and 90
  )
  insert into public.facility_flood_exposure (
    facility_id, layer_code, is_exposed, max_depth_m, depth_label, frequency_years
  )
  select f.id, l.layer_code, matched.depth_m is not null,
    matched.depth_m, matched.depth_label, matched.frequency_years
  from facility_points f
  cross join layer_codes l
  left join lateral (
    select a.depth_m, a.depth_label, a.frequency_years
    from public.flood_scenario_areas a
    where a.layer_code = l.layer_code
      and not a.is_hole
      and a.geometry && f.geometry
      and extensions.st_covers(a.geometry, f.geometry)
      and not exists (
        select 1 from public.flood_scenario_areas h
        where h.layer_code = a.layer_code
          and h.source_group_id = a.source_group_id
          and h.is_hole
          and h.geometry && f.geometry
          and extensions.st_covers(h.geometry, f.geometry)
      )
    order by a.depth_m desc
    limit 1
  ) matched on true;
  get diagnostics facility_rows = row_count;

  with layer_codes(layer_code) as (
    values ('national_river_flood'::text), ('local_river_flood'::text), ('urban_flood'::text)
  ), calculated as (
    select
      latest_month as statistic_month,
      b.admin_code,
      l.layer_code,
      b.area_sq_km as dong_area_sq_km,
      p.population,
      greatest(0::numeric, least(b.area_sq_km,
        coalesce(sum(
          (case when a.is_hole then -1 else 1 end) *
          extensions.st_area(extensions.st_intersection(b.geometry, a.geometry)::extensions.geography) / 1000000.0
        ) filter (where a.id is not null), 0)
      )) as hazard_area_sq_km,
      max(a.depth_m) filter (where not a.is_hole) as max_depth_m
    from public.admin_dong_boundaries b
    join public.population_monthly p
      on p.admin_code = b.admin_code and p.statistic_month = latest_month
    cross join layer_codes l
    left join public.flood_scenario_areas a
      on a.layer_code = l.layer_code
     and a.geometry && b.geometry
     and extensions.st_intersects(a.geometry, b.geometry)
    group by b.admin_code, b.area_sq_km, p.population, l.layer_code
  )
  insert into public.admin_dong_flood_exposure (
    statistic_month, admin_code, layer_code, hazard_area_sq_km,
    hazard_area_percent, population, estimated_exposed_population, max_depth_m
  )
  select statistic_month, admin_code, layer_code,
    round(hazard_area_sq_km::numeric, 6),
    round((100.0 * hazard_area_sq_km / nullif(dong_area_sq_km, 0))::numeric, 4),
    population,
    round(population * least(1.0, hazard_area_sq_km / nullif(dong_area_sq_km, 0)))::integer,
    max_depth_m
  from calculated;
  get diagnostics dong_rows = row_count;

  return jsonb_build_object(
    'statisticMonth', latest_month,
    'facilityRows', facility_rows,
    'adminDongRows', dong_rows
  );
end;
$$;

create or replace function public.get_flood_overlap_summary()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with layer_codes(layer_code, layer_name, sort_order) as (
    values
      ('national_river_flood'::text, '국가하천 범람지도'::text, 1),
      ('local_river_flood'::text, '지방하천 범람지도'::text, 2),
      ('urban_flood'::text, '도시침수지도'::text, 3)
  ), area_stats as (
    select layer_code,
      count(distinct source_group_id) as feature_count,
      count(*) as part_count,
      round(sum(case when is_hole then -area_sq_km else area_sq_km end)::numeric, 3) as depth_class_area_sq_km
    from public.flood_scenario_areas group by layer_code
  ), facility_stats as (
    select layer_code, count(*) filter (where is_exposed) as exposed_facilities,
      count(*) as analyzed_facilities
    from public.facility_flood_exposure group by layer_code
  ), population_stats as (
    select layer_code, max(statistic_month) as statistic_month,
      round(sum(hazard_area_sq_km)::numeric, 3) as hazard_area_sq_km,
      sum(estimated_exposed_population) as estimated_exposed_population,
      count(*) filter (where hazard_area_sq_km > 0) as exposed_admin_dongs
    from public.admin_dong_flood_exposure group by layer_code
  )
  select jsonb_build_object(
    'populationEstimationMethod', '행정동 내 인구가 균등 분포한다고 가정한 면적 비례 추정',
    'layers', jsonb_agg(jsonb_build_object(
      'layerCode', l.layer_code,
      'layerName', l.layer_name,
      'featureCount', coalesce(a.feature_count, 0),
      'partCount', coalesce(a.part_count, 0),
      'depthClassAreaSquareKm', coalesce(a.depth_class_area_sq_km, 0),
      'analyzedFacilities', coalesce(f.analyzed_facilities, 0),
      'exposedFacilities', coalesce(f.exposed_facilities, 0),
      'statisticMonth', p.statistic_month,
      'hazardAreaSquareKm', coalesce(p.hazard_area_sq_km, 0),
      'estimatedExposedPopulation', coalesce(p.estimated_exposed_population, 0),
      'exposedAdminDongs', coalesce(p.exposed_admin_dongs, 0)
    ) order by l.sort_order)
  )
  from layer_codes l
  left join area_stats a on a.layer_code = l.layer_code
  left join facility_stats f on f.layer_code = l.layer_code
  left join population_stats p on p.layer_code = l.layer_code;
$$;

revoke all on function public.calculate_flood_overlap_analysis() from public, anon, authenticated;
grant execute on function public.calculate_flood_overlap_analysis() to service_role;
revoke all on function public.get_flood_overlap_summary() from public, anon;
grant execute on function public.get_flood_overlap_summary() to authenticated, service_role;

