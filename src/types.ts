export type FacilityStatus = '운영중' | '점검필요' | '비활성'

export interface Facility {
  id: string
  name: string
  type: string
  sourceType: string
  status: FacilityStatus
  address: string
  district: string
  longitude: number | null
  latitude: number | null
  agency: string
  installedAt: string
  detail: string
  pnu: string
  postalCode: string
  sourceSheet: string
  sourceRow: number
  original?: Record<string, unknown>
}

export interface FacilityData {
  sourceFile: string
  generatedAt: string
  total: number
  facilities: Facility[]
}

export interface Filters {
  query: string
  type: string
  status: string
  district: string
  agency: string
}

export interface ChangeRecord {
  id: string
  facilityId: string
  facilityName: string
  action: '등록' | '수정' | '상태변경' | '일괄등록' | '초기화'
  changedAt: string
  summary: string
}

export type ViewName = 'dashboard' | 'map' | 'results' | 'nearby' | 'facilities'

export type DisasterSourceId = 'weather' | 'hydrology' | 'kwater' | 'flood' | 'population'
export type DisasterSourceState = 'live' | 'configured' | 'error'
export type DisasterLayerId = 'facilities' | 'rainfall' | 'snowfall' | 'waterLevel' | 'floodTrace' | 'nationalRiverFlood' | 'localRiverFlood' | 'urbanFlood' | 'population'

export interface DisasterSourceStatus {
  id: DisasterSourceId
  label: string
  state: DisasterSourceState
  updatedAt?: string
  message?: string
}

export interface WeatherSnapshot {
  rainfall1h: number | null
  temperature: number | null
  humidity: number | null
  snowDepth: number | null
  observedAt?: string
}

export interface DisasterMapPoint {
  id: string
  name: string
  kind: 'rainfall' | 'snowfall' | 'waterLevel' | 'population'
  latitude: number
  longitude: number
  value?: number | null
  unit?: string
  trend?: 'up' | 'down' | 'steady' | 'unknown'
  address?: string
  source: string
  observedAt?: string
}

export interface DisasterArea {
  id: string
  name: string
  kind: 'floodTrace' | 'riverFlood' | 'urbanFlood' | 'population'
  coordinates: number[][][]
  value?: number | null
  unit?: string
}

export interface PopulationSnapshot {
  areaName: string
  population: number | null
  households: number | null
  statisticMonth?: string
}

export interface PopulationBoundaryFeature {
  type: 'Feature'
  properties: {
    adminCode: string
    adminName: string
    districtCode: string
    districtName: string
    areaSquareKm: number
    moisAdminCode: string
    population: number
    malePopulation: number
    femalePopulation: number
    households: number
    peoplePerHousehold: number | null
    populationDensity: number
  }
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: number[][][] | number[][][][]
  }
}

export interface PopulationDistribution {
  type: 'FeatureCollection'
  statisticMonth: string
  featureCount: number
  totalPopulation: number
  totalHouseholds: number
  features: PopulationBoundaryFeature[]
}

export type FloodResultLayerCode = 'national_river_flood' | 'local_river_flood' | 'urban_flood'

export interface FloodResultLayerSummary {
  layerCode: FloodResultLayerCode
  layerName: string
  featureCount: number
  analyzedFacilities: number
  exposedFacilities: number
  statisticMonth: string | null
  hazardAreaSquareKm: number
  estimatedExposedPopulation: number
  exposedAdminDongs: number
}

export interface FloodOverlapSummary {
  populationEstimationMethod: string
  layers: FloodResultLayerSummary[]
}

export interface FacilityFloodExposure {
  facilityId: string
  layerCode: FloodResultLayerCode
  maxDepthM: number | null
  depthLabel: string | null
  frequencyYears: number | null
  calculatedAt: string
}

export interface AdminDongFloodExposure {
  adminCode: string
  layerCode: FloodResultLayerCode
  statisticMonth: string
  hazardAreaSquareKm: number
  hazardAreaPercent: number
  population: number
  estimatedExposedPopulation: number
  maxDepthM: number | null
  calculatedAt: string
}

export interface FloodResultMapArea extends AdminDongFloodExposure {
  adminName: string
  districtName: string
  geometry: PopulationBoundaryFeature['geometry']
}

export interface DisasterOverview {
  generatedAt: string
  locationLabel: string
  weather: WeatherSnapshot
  points: DisasterMapPoint[]
  areas: DisasterArea[]
  population: PopulationSnapshot | null
  floodTraceMatched: boolean | null
  sources: DisasterSourceStatus[]
}

export type DisasterLayerVisibility = Record<DisasterLayerId, boolean>

export type HistoricalMetricFilter = 'all' | 'rainfall' | 'snowfall' | 'waterLevel' | 'flood'

export interface HistoricalStationMetric {
  source: string
  stationCode: string
  stationName: string
  facilityId: string | null
  latitude: number
  longitude: number
  metric: string
  minValue: number | null
  avgValue: number | null
  maxValue: number | null
  firstObservedAt?: string
  lastObservedAt?: string
  observationCount: number
}

export interface HistoricalSourceState {
  source: string
  status: 'pending' | 'running' | 'complete' | 'partial' | 'failed'
  acceptedCount: number
  excludedCount: number
  message: string
  finishedAt?: string
}

export interface HistoricalAnalysis {
  schemaReady: boolean
  scope: { regionCode: string; regionName: string }
  period: { start: string; end: string }
  generatedAt: string
  summary: {
    stationCount: number
    observationCount: number
    maxRainfall1h: number | null
    maxRainfallDaily: number | null
    maxSnowDepth: number | null
    maxWaterLevel: number | null
    floodTraceCount: number
    analysedFacilityCount: number
  }
  stations: HistoricalStationMetric[]
  areas: DisasterArea[]
  sources: HistoricalSourceState[]
}
