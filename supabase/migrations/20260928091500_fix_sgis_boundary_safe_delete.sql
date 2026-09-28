create or replace function public.import_sgis_admin_dong_boundaries(
  p_features jsonb,
  p_source_year integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imported_count integer;
  total_area numeric;
begin
  if jsonb_typeof(p_features) <> 'array' or jsonb_array_length(p_features) = 0 then
    raise exception 'A non-empty JSON array of SGIS boundary features is required.';
  end if;

  if p_source_year < 2000 or p_source_year > 2100 then
    raise exception 'A valid SGIS source year is required.';
  end if;

  delete from public.admin_dong_boundaries where admin_code is not null;

  insert into public.admin_dong_boundaries (
    admin_code,
    admin_name,
    district_code,
    district_name,
    geometry,
    area_sq_km,
    source,
    source_year
  )
  select
    feature->>'adminCode',
    feature->>'adminName',
    feature->>'districtCode',
    feature->>'districtName',
    normalized.geometry,
    round((extensions.st_area(normalized.geometry::extensions.geography) / 1000000.0)::numeric, 4),
    '통계청 SGIS 행정구역경계 API',
    p_source_year
  from jsonb_array_elements(p_features) feature
  cross join lateral (
    select extensions.st_multi(
      extensions.st_collectionextract(
        extensions.st_makevalid(
          extensions.st_transform(
            extensions.st_setsrid(extensions.st_geomfromgeojson(feature->'geometry'), 5179),
            4326
          )
        ),
        3
      )
    ) as geometry
  ) normalized
  where coalesce(feature->>'adminCode', '') <> ''
    and coalesce(feature->>'adminName', '') <> ''
    and normalized.geometry is not null
    and not extensions.st_isempty(normalized.geometry)
  on conflict (admin_code) do update
  set admin_name = excluded.admin_name,
      district_code = excluded.district_code,
      district_name = excluded.district_name,
      geometry = excluded.geometry,
      area_sq_km = excluded.area_sq_km,
      source = excluded.source,
      source_year = excluded.source_year,
      updated_at = now();

  get diagnostics imported_count = row_count;

  select round(sum(area_sq_km), 2) into total_area
  from public.admin_dong_boundaries;

  return jsonb_build_object(
    'importedCount', imported_count,
    'sourceYear', p_source_year,
    'totalAreaSquareKm', total_area
  );
end;
$$;

revoke all on function public.import_sgis_admin_dong_boundaries(jsonb, integer) from public, anon, authenticated;
grant execute on function public.import_sgis_admin_dong_boundaries(jsonb, integer) to service_role;
