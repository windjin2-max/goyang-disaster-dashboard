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
set statement_timeout = '10min'
as $$
declare
  outer_geometry extensions.geometry;
  hole_geometry extensions.geometry;
  transformed_geometry extensions.geometry;
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

  transformed_geometry := extensions.st_makevalid(
    extensions.st_transform(extensions.st_makevalid(outer_geometry), 4326)
  );

  select extensions.st_multi(extensions.st_collectionextract(extensions.st_makevalid(
    extensions.st_intersection(
      extensions.st_buffer(transformed_geometry, 0),
      extensions.st_buffer(geometry, 0)
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

