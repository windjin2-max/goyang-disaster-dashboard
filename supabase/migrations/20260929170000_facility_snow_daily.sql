-- Keep municipal snow gauges separate from KMA snow observations.
alter table public.observation_stations
  drop constraint if exists observation_stations_source_check;

alter table public.observation_stations
  add constraint observation_stations_source_check
  check (source in ('kma_asos', 'kma_aws', 'kma_snow', 'hrfco', 'kwater', 'facility_aws', 'facility_rain', 'facility_snow'));
