-- City-operated level sensors, including sensors co-located with voice warning facilities.
alter table public.observation_stations
  drop constraint if exists observation_stations_source_check;

alter table public.observation_stations
  add constraint observation_stations_source_check
  check (source in ('kma_asos', 'kma_aws', 'kma_snow', 'hrfco', 'kwater',
                   'facility_aws', 'facility_rain', 'facility_snow', 'facility_level'));
