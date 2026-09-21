create table if not exists public.hazard_layers (
  code text primary key check (code in ('flood_trace', 'urban_flood', 'national_river_flood', 'local_river_flood')),
  name text not null,
  hazard_kind text not null check (hazard_kind in ('trace', 'urban_scenario', 'river_scenario')),
  source text not null,
  source_url text not null,
  service_format text not null default 'WMS',
  default_frequency integer,
  update_cycle text not null default '',
  license_note text not null default '',
  is_active boolean not null default true,
  last_checked_at timestamptz,
  last_status text not null default 'pending' check (last_status in ('pending', 'complete', 'failed')),
  last_message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.hazard_layers (
  code, name, hazard_kind, source, source_url, default_frequency, update_cycle, license_note
)
values
  ('flood_trace', '침수흔적도', 'trace', '생활안전지도', 'https://www.safemap.go.kr/openapi2/IF_0092_WMS', null, '연 1회', '공공누리 제4유형'),
  ('urban_flood', '도시침수지도', 'urban_scenario', '홍수위험지도 정보시스템', 'https://data.floodmap.go.kr/api/wms-service/adm-cty-wms', 100, '제공기관 갱신 시', '출처 표시'),
  ('national_river_flood', '국가하천 범람지도', 'river_scenario', '홍수위험지도 정보시스템', 'https://data.floodmap.go.kr/api/wms-service/adm-ntn-wms', 100, '제공기관 갱신 시', '출처 표시'),
  ('local_river_flood', '지방하천 범람지도', 'river_scenario', '홍수위험지도 정보시스템', 'https://data.floodmap.go.kr/api/wms-service/adm-rgn-wms', 100, '제공기관 갱신 시', '출처 표시')
on conflict (code) do update
set name = excluded.name,
    hazard_kind = excluded.hazard_kind,
    source = excluded.source,
    source_url = excluded.source_url,
    default_frequency = excluded.default_frequency,
    update_cycle = excluded.update_cycle,
    license_note = excluded.license_note,
    is_active = true,
    updated_at = now();

create table if not exists public.hazard_layer_snapshots (
  id bigint generated always as identity primary key,
  layer_code text not null references public.hazard_layers(code) on delete restrict,
  scope_region_code text not null default '41280',
  frequency integer,
  bbox double precision[] not null check (array_length(bbox, 1) = 4),
  srs text not null default 'EPSG:4326',
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  storage_path text not null unique,
  content_type text not null default 'image/png',
  byte_size integer not null check (byte_size >= 0),
  checksum text not null default '',
  captured_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create index if not exists hazard_layer_snapshots_layer_captured_idx
  on public.hazard_layer_snapshots (layer_code, captured_at desc);

create or replace function public.upsert_scoped_observation_stations(
  p_source text,
  p_metrics text[],
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
      coalesce(p_metrics, '{}'::text[]), true, coalesce(raw, '{}'::jsonb), now()
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

revoke all on function public.upsert_scoped_observation_stations(text, text[], jsonb) from public, anon, authenticated;
grant execute on function public.upsert_scoped_observation_stations(text, text[], jsonb) to service_role;

alter table public.hazard_layers enable row level security;
alter table public.hazard_layer_snapshots enable row level security;

revoke all on public.hazard_layers, public.hazard_layer_snapshots from anon, authenticated;
grant select on public.hazard_layers, public.hazard_layer_snapshots to authenticated;
grant all on public.hazard_layers, public.hazard_layer_snapshots to service_role;
grant usage, select on sequence public.hazard_layer_snapshots_id_seq to service_role;

create policy "Administrators can read hazard layers" on public.hazard_layers
  for select to authenticated using ((select private.is_admin()));
create policy "Administrators can read hazard layer snapshots" on public.hazard_layer_snapshots
  for select to authenticated using ((select private.is_admin()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hazard-snapshots', 'hazard-snapshots', false, 5242880, array['image/png'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Administrators can read hazard snapshot objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'hazard-snapshots' and (select private.is_admin()));

comment on table public.hazard_layers is '고양시 재난 분석지도에서 사용하는 공식 WMS 위험지도 카탈로그.';
comment on table public.hazard_layer_snapshots is '고양시 범위로 잘라 보관한 WMS PNG 스냅샷 메타데이터.';
comment on function public.upsert_scoped_observation_stations(text, text[], jsonb)
  is 'Service-role-only station upsert that retains only points covered by the Goyang boundary.';
