create table if not exists public.flood_scenario_areas (
  id bigint generated always as identity primary key,
  layer_code text not null references public.hazard_layers(code) on delete restrict
    check (layer_code in ('national_river_flood', 'local_river_flood', 'urban_flood')),
  source_feature_id text not null,
  frequency_years integer not null check (frequency_years > 0),
  district_code text not null,
  district_name text not null,
  depth_code text not null,
  depth_label text not null,
  depth_m numeric(6, 2) not null check (depth_m >= 0),
  geometry extensions.geometry(MultiPolygon, 4326) not null,
  area_sq_km numeric(14, 6) not null,
  source text not null default '홍수위험지도 정보제공포털',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (layer_code, source_feature_id)
);

create index if not exists flood_scenario_areas_geometry_idx
  on public.flood_scenario_areas using gist (geometry);
create index if not exists flood_scenario_areas_layer_depth_idx
  on public.flood_scenario_areas (layer_code, depth_m desc);

create table if not exists private.flood_scenario_import_parts (
  id bigint generated always as identity primary key,
  import_key text not null,
  is_hole boolean not null,
  geometry extensions.geometry(MultiPolygon, 5186) not null,
  created_at timestamptz not null default now()
);

create index if not exists flood_scenario_import_parts_key_idx
  on private.flood_scenario_import_parts (import_key, is_hole);

create table if not exists public.facility_flood_exposure (
  facility_id text not null references public.facilities(id) on delete cascade,
  layer_code text not null references public.hazard_layers(code) on delete restrict,
  is_exposed boolean not null,
  max_depth_m numeric(6, 2),
  depth_label text,
  frequency_years integer,
  calculated_at timestamptz not null default now(),
  primary key (facility_id, layer_code)
);

create index if not exists facility_flood_exposure_layer_exposed_idx
  on public.facility_flood_exposure (layer_code, is_exposed);

create table if not exists public.admin_dong_flood_exposure (
  statistic_month text not null check (statistic_month ~ '^[0-9]{6}$'),
  admin_code text not null references public.admin_dong_boundaries(admin_code) on delete cascade,
  layer_code text not null references public.hazard_layers(code) on delete restrict,
  hazard_area_sq_km numeric(14, 6) not null default 0,
  hazard_area_percent numeric(9, 4) not null default 0,
  population integer not null default 0,
  estimated_exposed_population integer not null default 0,
  max_depth_m numeric(6, 2),
  calculated_at timestamptz not null default now(),
  primary key (statistic_month, admin_code, layer_code)
);

create index if not exists admin_dong_flood_exposure_layer_month_idx
  on public.admin_dong_flood_exposure (layer_code, statistic_month, hazard_area_percent desc);

alter table public.flood_scenario_areas enable row level security;
alter table public.facility_flood_exposure enable row level security;
alter table public.admin_dong_flood_exposure enable row level security;

revoke all on public.flood_scenario_areas, public.facility_flood_exposure,
  public.admin_dong_flood_exposure from anon, authenticated;
grant select on public.flood_scenario_areas, public.facility_flood_exposure,
  public.admin_dong_flood_exposure to authenticated;
grant all on public.flood_scenario_areas, public.facility_flood_exposure,
  public.admin_dong_flood_exposure to service_role;
grant usage, select on sequence public.flood_scenario_areas_id_seq to service_role;

drop policy if exists "Administrators can read flood scenario areas" on public.flood_scenario_areas;
create policy "Administrators can read flood scenario areas" on public.flood_scenario_areas
  for select to authenticated using ((select private.is_admin()));
drop policy if exists "Administrators can read facility flood exposure" on public.facility_flood_exposure;
create policy "Administrators can read facility flood exposure" on public.facility_flood_exposure
  for select to authenticated using ((select private.is_admin()));
drop policy if exists "Administrators can read dong flood exposure" on public.admin_dong_flood_exposure;
create policy "Administrators can read dong flood exposure" on public.admin_dong_flood_exposure
  for select to authenticated using ((select private.is_admin()));

create or replace function public.clear_flood_scenario_import(p_layer_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_layer_code not in ('national_river_flood', 'local_river_flood', 'urban_flood') then
    raise exception 'Unsupported flood scenario layer: %', p_layer_code;
  end if;
  delete from private.flood_scenario_import_parts
  where import_key like p_layer_code || ':%';
  delete from public.flood_scenario_areas where layer_code = p_layer_code;
end;
$$;

revoke all on function public.clear_flood_scenario_import(text) from public, anon, authenticated;
grant execute on function public.clear_flood_scenario_import(text) to service_role;

create or replace function public.stage_flood_scenario_part(
  p_import_key text,
  p_is_hole boolean,
  p_geometry jsonb,
  p_source_srid integer default 5186
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  parsed extensions.geometry;
  normalized extensions.geometry(MultiPolygon, 5186);
  inserted_id bigint;
begin
  if p_import_key !~ '^(national_river_flood|local_river_flood|urban_flood):' then
    raise exception 'Invalid flood scenario import key.';
  end if;
  if p_source_srid not in (4326, 5186) then
    raise exception 'Unsupported source SRID: %', p_source_srid;
  end if;

  parsed := extensions.st_setsrid(extensions.st_geomfromgeojson(p_geometry), p_source_srid);
  if p_source_srid <> 5186 then
    parsed := extensions.st_transform(parsed, 5186);
  end if;
  normalized := extensions.st_multi(
    extensions.st_collectionextract(extensions.st_makevalid(parsed), 3)
  );
  if normalized is null or extensions.st_isempty(normalized) then
    raise exception 'The staged geometry is empty.';
  end if;

  insert into private.flood_scenario_import_parts (import_key, is_hole, geometry)
  values (p_import_key, p_is_hole, normalized)
  returning id into inserted_id;

  return jsonb_build_object(
    'id', inserted_id,
    'pointCount', extensions.st_npoints(normalized),
    'isHole', p_is_hole
  );
end;
$$;

revoke all on function public.stage_flood_scenario_part(text, boolean, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.stage_flood_scenario_part(text, boolean, jsonb, integer)
  to service_role;

create or replace function public.finalize_flood_scenario_feature(
  p_import_key text,
  p_layer_code text,
  p_source_feature_id text,
  p_frequency_years integer,
  p_district_code text,
  p_district_name text,
  p_depth_code text,
  p_depth_label text,
  p_depth_m numeric,
  p_raw jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  outer_geometry extensions.geometry;
  hole_geometry extensions.geometry;
  final_geometry extensions.geometry(MultiPolygon, 4326);
  final_area numeric;
  final_points integer;
begin
  if p_import_key <> p_layer_code || ':' || p_source_feature_id then
    raise exception 'Import key and feature identity do not match.';
  end if;

  select extensions.st_unaryunion(extensions.st_collect(geometry))
  into outer_geometry
  from private.flood_scenario_import_parts
  where import_key = p_import_key and not is_hole;

  select extensions.st_unaryunion(extensions.st_collect(geometry))
  into hole_geometry
  from private.flood_scenario_import_parts
  where import_key = p_import_key and is_hole;

  if outer_geometry is null or extensions.st_isempty(outer_geometry) then
    raise exception 'No outer geometry was staged for %.', p_import_key;
  end if;
  if hole_geometry is not null and not extensions.st_isempty(hole_geometry) then
    outer_geometry := extensions.st_difference(outer_geometry, hole_geometry);
  end if;

  select extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(
    extensions.st_intersection(
      extensions.st_transform(outer_geometry, 4326),
      geometry
    )
  ), 3))
  into final_geometry
  from public.analysis_regions
  where region_code = '41280';

  if final_geometry is null or extensions.st_isempty(final_geometry) then
    raise exception 'Feature % does not overlap the Goyang boundary.', p_import_key;
  end if;

  final_area := round((extensions.st_area(final_geometry::extensions.geography) / 1000000.0)::numeric, 6);
  final_points := extensions.st_npoints(final_geometry);

  insert into public.flood_scenario_areas (
    layer_code, source_feature_id, frequency_years, district_code, district_name,
    depth_code, depth_label, depth_m, geometry, area_sq_km, raw
  ) values (
    p_layer_code, p_source_feature_id, p_frequency_years, p_district_code, p_district_name,
    p_depth_code, p_depth_label, p_depth_m, final_geometry, final_area, coalesce(p_raw, '{}'::jsonb)
  )
  on conflict (layer_code, source_feature_id) do update
  set frequency_years = excluded.frequency_years,
      district_code = excluded.district_code,
      district_name = excluded.district_name,
      depth_code = excluded.depth_code,
      depth_label = excluded.depth_label,
      depth_m = excluded.depth_m,
      geometry = excluded.geometry,
      area_sq_km = excluded.area_sq_km,
      raw = excluded.raw,
      updated_at = now();

  delete from private.flood_scenario_import_parts where import_key = p_import_key;

  return jsonb_build_object(
    'featureId', p_source_feature_id,
    'areaSquareKm', final_area,
    'pointCount', final_points
  );
end;
$$;

revoke all on function public.finalize_flood_scenario_feature(
  text, text, text, integer, text, text, text, text, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_flood_scenario_feature(
  text, text, text, integer, text, text, text, text, numeric, jsonb
) to service_role;

create or replace function public.calculate_flood_overlap_analysis()
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  select
    f.id,
    l.layer_code,
    matched.depth_m is not null,
    matched.depth_m,
    matched.depth_label,
    matched.frequency_years
  from facility_points f
  cross join layer_codes l
  left join lateral (
    select a.depth_m, a.depth_label, a.frequency_years
    from public.flood_scenario_areas a
    where a.layer_code = l.layer_code
      and a.geometry && f.geometry
      and extensions.st_covers(a.geometry, f.geometry)
    order by a.depth_m desc
    limit 1
  ) matched on true;
  get diagnostics facility_rows = row_count;

  with layer_codes(layer_code) as (
    values ('national_river_flood'::text), ('local_river_flood'::text), ('urban_flood'::text)
  ), layer_unions as (
    select layer_code, extensions.st_unaryunion(extensions.st_collect(geometry)) as geometry
    from public.flood_scenario_areas
    group by layer_code
  ), calculated as (
    select
      latest_month as statistic_month,
      b.admin_code,
      l.layer_code,
      b.area_sq_km as dong_area_sq_km,
      p.population,
      case when u.geometry is null or not extensions.st_intersects(b.geometry, u.geometry)
        then 0::numeric
        else extensions.st_area(extensions.st_intersection(b.geometry, u.geometry)::extensions.geography) / 1000000.0
      end as hazard_area_sq_km,
      (
        select max(a.depth_m)
        from public.flood_scenario_areas a
        where a.layer_code = l.layer_code
          and a.geometry && b.geometry
          and extensions.st_intersects(a.geometry, b.geometry)
      ) as max_depth_m
    from public.admin_dong_boundaries b
    join public.population_monthly p
      on p.admin_code = b.admin_code and p.statistic_month = latest_month
    cross join layer_codes l
    left join layer_unions u on u.layer_code = l.layer_code
  )
  insert into public.admin_dong_flood_exposure (
    statistic_month, admin_code, layer_code, hazard_area_sq_km,
    hazard_area_percent, population, estimated_exposed_population, max_depth_m
  )
  select
    statistic_month,
    admin_code,
    layer_code,
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

revoke all on function public.calculate_flood_overlap_analysis() from public, anon, authenticated;
grant execute on function public.calculate_flood_overlap_analysis() to service_role;

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
    select layer_code, count(*) as feature_count,
      round(sum(area_sq_km)::numeric, 3) as depth_class_area_sq_km
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

revoke all on function public.get_flood_overlap_summary() from public, anon;
grant execute on function public.get_flood_overlap_summary() to authenticated, service_role;

comment on table public.flood_scenario_areas
  is '고양시 국가·지방하천 범람 및 도시침수 100년 빈도 SHP 분석 도형. 지도 표출용 정적 파일과 분리한다.';
comment on table public.facility_flood_exposure
  is '시설물 지점과 홍수 시나리오 도형의 공간 중첩 분석 결과.';
comment on table public.admin_dong_flood_exposure
  is '행정동별 홍수 위험면적과 면적 비례 추정 노출인구 분석 결과.';
comment on function public.get_flood_overlap_summary()
  is '관리자용 홍수 시나리오 시설물·인구 중첩 분석 요약.';
