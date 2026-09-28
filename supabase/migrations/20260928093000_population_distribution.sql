create table if not exists public.population_monthly (
  statistic_month text not null check (statistic_month ~ '^[0-9]{6}$'),
  admin_code text not null references public.admin_dong_boundaries(admin_code) on delete restrict,
  mois_admin_code text not null,
  population integer not null check (population >= 0),
  male_population integer not null check (male_population >= 0),
  female_population integer not null check (female_population >= 0),
  households integer not null check (households >= 0),
  people_per_household numeric(8, 2),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (statistic_month, admin_code),
  unique (statistic_month, mois_admin_code)
);

create index if not exists population_monthly_admin_month_idx
  on public.population_monthly (admin_code, statistic_month desc);

alter table public.population_monthly enable row level security;
revoke all on public.population_monthly from anon, authenticated;
grant select on public.population_monthly to authenticated;
grant all on public.population_monthly to service_role;

drop policy if exists "Administrators can read monthly population" on public.population_monthly;
create policy "Administrators can read monthly population" on public.population_monthly
  for select to authenticated using ((select private.is_admin()));

create or replace function public.import_mois_population(
  p_rows jsonb,
  p_statistic_month text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  mapped_admin_code text;
  match_count integer;
  imported_count integer := 0;
  boundary_count integer;
  total_population bigint;
  total_households bigint;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'A non-empty JSON array of population rows is required.';
  end if;
  if p_statistic_month !~ '^[0-9]{6}$' then
    raise exception 'Statistic month must use YYYYMM format.';
  end if;

  select count(*) into boundary_count from public.admin_dong_boundaries;

  for item in select value from jsonb_array_elements(p_rows)
  loop
    select count(*), min(admin_code)
    into match_count, mapped_admin_code
    from public.admin_dong_boundaries
    where district_name = item->>'districtName'
      and admin_name = concat('경기도 ', item->>'districtName', ' ', item->>'dongName');

    if match_count <> 1 then
      raise exception 'Population boundary match failed for % % (matches: %).',
        item->>'districtName', item->>'dongName', match_count;
    end if;

    insert into public.population_monthly (
      statistic_month,
      admin_code,
      mois_admin_code,
      population,
      male_population,
      female_population,
      households,
      people_per_household,
      raw
    ) values (
      p_statistic_month,
      mapped_admin_code,
      item->>'moisAdminCode',
      (item->>'population')::integer,
      (item->>'malePopulation')::integer,
      (item->>'femalePopulation')::integer,
      (item->>'households')::integer,
      nullif(item->>'peoplePerHousehold', '')::numeric,
      coalesce(item->'raw', '{}'::jsonb)
    )
    on conflict (statistic_month, admin_code) do update
    set mois_admin_code = excluded.mois_admin_code,
        population = excluded.population,
        male_population = excluded.male_population,
        female_population = excluded.female_population,
        households = excluded.households,
        people_per_household = excluded.people_per_household,
        raw = excluded.raw,
        updated_at = now();

    imported_count := imported_count + 1;
  end loop;

  if imported_count <> boundary_count then
    raise exception 'Population coverage is incomplete: imported %, boundaries %.', imported_count, boundary_count;
  end if;

  select sum(population), sum(households)
  into total_population, total_households
  from public.population_monthly
  where statistic_month = p_statistic_month;

  return jsonb_build_object(
    'statisticMonth', p_statistic_month,
    'importedCount', imported_count,
    'totalPopulation', total_population,
    'totalHouseholds', total_households
  );
end;
$$;

revoke all on function public.import_mois_population(jsonb, text) from public, anon, authenticated;
grant execute on function public.import_mois_population(jsonb, text) to service_role;

create or replace function public.get_population_distribution(p_month text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_month as (
    select coalesce(p_month, max(statistic_month)) as value
    from public.population_monthly
  ), joined as (
    select
      b.admin_code,
      b.admin_name,
      b.district_code,
      b.district_name,
      b.area_sq_km,
      b.geometry,
      p.statistic_month,
      p.mois_admin_code,
      p.population,
      p.male_population,
      p.female_population,
      p.households,
      p.people_per_household,
      round((p.population / nullif(b.area_sq_km, 0))::numeric, 1) as population_density
    from public.admin_dong_boundaries b
    join selected_month m on true
    join public.population_monthly p
      on p.admin_code = b.admin_code
     and p.statistic_month = m.value
  )
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'statisticMonth', max(statistic_month),
    'featureCount', count(*),
    'totalPopulation', coalesce(sum(population), 0),
    'totalHouseholds', coalesce(sum(households), 0),
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'properties', jsonb_build_object(
        'adminCode', admin_code,
        'adminName', admin_name,
        'districtCode', district_code,
        'districtName', district_name,
        'areaSquareKm', area_sq_km,
        'moisAdminCode', mois_admin_code,
        'population', population,
        'malePopulation', male_population,
        'femalePopulation', female_population,
        'households', households,
        'peoplePerHousehold', people_per_household,
        'populationDensity', population_density
      ),
      'geometry', extensions.st_asgeojson(geometry, 6)::jsonb
    ) order by district_code, admin_code), '[]'::jsonb)
  )
  from joined;
$$;

revoke all on function public.get_population_distribution(text) from public, anon;
grant execute on function public.get_population_distribution(text) to authenticated, service_role;

comment on table public.population_monthly
  is 'Monthly MOIS resident population mapped to SGIS administrative-dong boundary codes.';
