-- One physical facility may host multiple sensor sources/metrics.
-- The (source, station_code) constraint continues to prevent duplicate stations.
drop index if exists public.observation_stations_facility_id_unique;

create index if not exists observation_stations_facility_id_idx
  on public.observation_stations (facility_id) where facility_id is not null;
