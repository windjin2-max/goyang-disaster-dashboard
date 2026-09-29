-- Keep city-operated facility AWS observations distinct from KMA AWS stations.
alter table public.observation_stations
  drop constraint if exists observation_stations_source_check;

alter table public.observation_stations
  add constraint observation_stations_source_check
  check (source in ('kma_asos', 'kma_aws', 'kma_snow', 'hrfco', 'kwater', 'facility_aws'));

alter table public.observation_stations
  add column if not exists facility_id text references public.facilities(id) on delete restrict;

create unique index if not exists observation_stations_facility_id_unique
  on public.observation_stations (facility_id) where facility_id is not null;
