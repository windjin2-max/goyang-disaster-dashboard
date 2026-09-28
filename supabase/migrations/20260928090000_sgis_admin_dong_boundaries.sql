create table if not exists public.admin_dong_boundaries (
  admin_code text primary key,
  admin_name text not null,
  district_code text not null,
  district_name text not null,
  geometry extensions.geometry(MultiPolygon, 4326) not null,
  area_sq_km numeric(12, 4) not null,
  source text not null default 'SGIS',
  source_year integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_dong_boundaries_geometry_idx
  on public.admin_dong_boundaries using gist (geometry);
create index if not exists admin_dong_boundaries_district_idx
  on public.admin_dong_boundaries (district_code, admin_code);

alter table public.admin_dong_boundaries enable row level security;

revoke all on public.admin_dong_boundaries from anon, authenticated;
grant select on public.admin_dong_boundaries to authenticated;
grant all on public.admin_dong_boundaries to service_role;

drop policy if exists "Administrators can read administrative dong boundaries" on public.admin_dong_boundaries;
create policy "Administrators can read administrative dong boundaries" on public.admin_dong_boundaries
  for select to authenticated using ((select private.is_admin()));

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

create or replace function public.get_admin_dong_boundaries()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'properties', jsonb_build_object(
        'adminCode', admin_code,
        'adminName', admin_name,
        'districtCode', district_code,
        'districtName', district_name,
        'areaSquareKm', area_sq_km,
        'source', source,
        'sourceYear', source_year
      ),
      'geometry', extensions.st_asgeojson(geometry, 6)::jsonb
    ) order by district_code, admin_code), '[]'::jsonb)
  )
  from public.admin_dong_boundaries;
$$;

revoke all on function public.get_admin_dong_boundaries() from public, anon;
grant execute on function public.get_admin_dong_boundaries() to authenticated, service_role;

comment on table public.admin_dong_boundaries
  is 'Goyang administrative-dong boundaries transformed from SGIS EPSG:5179 to EPSG:4326.';
