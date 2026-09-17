create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create table private.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.admin_users enable row level security;

create policy "No direct access to administrator allowlist"
on private.admin_users
as restrictive
for all
to authenticated
using (false)
with check (false);

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from private.admin_users
      where user_id = (select auth.uid())
    );
$$;

revoke all on function private.is_admin() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

create table public.facilities (
  id text primary key,
  name text not null,
  type text not null,
  source_type text not null default '',
  status text not null default '운영중' check (status in ('운영중', '점검필요', '비활성')),
  address text not null default '',
  district text not null default '미분류',
  longitude double precision,
  latitude double precision,
  agency text not null default '미등록',
  installed_at text not null default '',
  detail text not null default '',
  pnu text not null default '',
  postal_code text not null default '',
  source_sheet text not null default '',
  source_row integer not null default 0 check (source_row >= 0),
  original jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  constraint facilities_longitude_range check (longitude is null or longitude between -180 and 180),
  constraint facilities_latitude_range check (latitude is null or latitude between -90 and 90)
);

create index facilities_type_idx on public.facilities (type);
create index facilities_status_idx on public.facilities (status);
create index facilities_district_idx on public.facilities (district);
create index facilities_agency_idx on public.facilities (agency);
create index facilities_name_idx on public.facilities (name);
create index facilities_created_by_idx on public.facilities (created_by);
create index facilities_updated_by_idx on public.facilities (updated_by);

create table public.facility_change_history (
  id uuid primary key default gen_random_uuid(),
  facility_id text not null references public.facilities(id) on delete restrict,
  facility_name text not null,
  action text not null check (action in ('등록', '수정', '상태변경', '일괄등록', '초기화')),
  summary text not null default '',
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null default auth.uid()
);

create index facility_change_history_facility_id_idx on public.facility_change_history (facility_id);
create index facility_change_history_changed_at_idx on public.facility_change_history (changed_at desc);
create index facility_change_history_changed_by_idx on public.facility_change_history (changed_by);

alter table public.facilities enable row level security;
alter table public.facility_change_history enable row level security;

revoke all on public.facilities from anon, authenticated;
revoke all on public.facility_change_history from anon, authenticated;
grant select, insert, update on public.facilities to authenticated;
grant select, insert on public.facility_change_history to authenticated;
grant all on public.facilities, public.facility_change_history to service_role;

create policy "Administrators can read facilities"
on public.facilities for select to authenticated
using ((select private.is_admin()));

create policy "Administrators can insert facilities"
on public.facilities for insert to authenticated
with check ((select private.is_admin()));

create policy "Administrators can update facilities"
on public.facilities for update to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy "Administrators can read facility history"
on public.facility_change_history for select to authenticated
using ((select private.is_admin()));

create policy "Administrators can insert facility history"
on public.facility_change_history for insert to authenticated
with check ((select private.is_admin()) and changed_by = (select auth.uid()));
