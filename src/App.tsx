import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as XLSX from 'xlsx'
import {
  Activity, Building2, CalendarRange, CheckCircle2, ChevronRight, CircleGauge, CloudRain, Database, Download, Droplets,
  Factory, FileDown, History, Layers3, LayoutDashboard, ListChecks, Map as MapIcon,
  LocateFixed, LogOut, MapPin, Menu, Pencil, Plus, RefreshCcw, Search, Siren, SlidersHorizontal, TriangleAlert, Users,
  Snowflake, Upload, Waves, X,
} from 'lucide-react'
import KakaoMap from './KakaoMap'
import FacilityModal from './FacilityModal'
import type { AdminDongFloodExposure, ChangeRecord, DisasterLayerId, DisasterLayerVisibility, DisasterMapPoint, DisasterOverview, Facility, FacilityFloodExposure, Filters, FloodOverlapSummary, FloodResultLayerCode, FloodResultMapArea, HistoricalAnalysis, HistoricalMetricFilter, PopulationDistribution, ViewName } from './types'
import { fetchFacilities, fetchFacilityHistory, importFacilities, persistFacility } from './lib/facilityRepository'
import { emptyDisasterOverview, fetchDisasterOverview, fetchPopulationDistribution, formatMetric } from './lib/disasterRepository'
import { emptyHistoricalAnalysis, fetchHistoricalAnalysis, historicalMapAreas, historicalMapPoints } from './lib/historicalRepository'
import { fetchAdminDongFloodExposure, fetchFacilityFloodExposure, fetchFloodOverlapSummary } from './lib/floodResultsRepository'
import { CCTV_ALL_TYPE, colorForType, downloadText, filterFacilities, formatCoordinate, haversineKm, isCctvType, toCsv } from './utils'

const emptyFilters: Filters = { query: '', type: '', status: '', district: '', agency: '' }
const defaultMapFilters: Filters = { ...emptyFilters, status: '운영중' }
const GOYANG_DISTRICTS = new Set(['덕양구', '일산동구', '일산서구'])
type HazardLayerId = 'floodTrace' | 'nationalRiverFlood' | 'localRiverFlood' | 'urbanFlood'
const hazardLayerIds: HazardLayerId[] = ['floodTrace', 'nationalRiverFlood', 'localRiverFlood', 'urbanFlood']
const defaultDisasterLayers: DisasterLayerVisibility = {
  facilities: true,
  rainfall: true,
  snowfall: true,
  waterLevel: true,
  floodTrace: false,
  nationalRiverFlood: false,
  localRiverFlood: false,
  urbanFlood: false,
  population: false,
}
const floodResultMapLayers: DisasterLayerVisibility = {
  ...defaultDisasterLayers,
  rainfall: false,
  snowfall: false,
  waterLevel: false,
}

const layerLabels: { id: DisasterLayerId; label: string }[] = [
  { id: 'facilities', label: '예·경보시설물' },
  { id: 'rainfall', label: '강우 관측' },
  { id: 'snowfall', label: '적설 관측' },
  { id: 'waterLevel', label: '하천 수위' },
  { id: 'floodTrace', label: '침수흔적도' },
  { id: 'nationalRiverFlood', label: '국가하천 범람(100년)' },
  { id: 'localRiverFlood', label: '지방하천 범람(100년)' },
  { id: 'urbanFlood', label: '도시침수(100년)' },
  { id: 'population', label: '인구 분포' },
]

const historicalSourceLabels: Record<string, string> = {
  kma_asos: '기상청 ASOS',
  kma_aws: '기상청 AWS',
  facility_aws: '고양시 AWS 시설',
  facility_rain: '고양시 강우센서',
  facility_snow: '고양시 적설계',
  facility_level: '고양시 수위센서',
  facility_level_daily_xls: '고양시 수위센서 일자료',
  kma_snow: '기상청 적설',
  hrfco: '한강홍수통제소',
  kwater: 'K-water',
  safemap: '침수흔적도',
  floodmap: '홍수위험지도',
}

const historicalMetricLabels: Record<string, { label: string; unit: string }> = {
  rainfall_1h: { label: '시간 강수량', unit: 'mm' },
  rainfall_3h: { label: '3시간 강수량', unit: 'mm' },
  rainfall_daily: { label: '일 강수량', unit: 'mm' },
  snow_depth: { label: '적설량', unit: 'cm' },
  new_snow: { label: '신적설량', unit: 'cm' },
  water_level: { label: '수위', unit: 'm' },
  flow_rate: { label: '유량', unit: '㎥/s' },
}
const floodResultSourceUrls: Record<FloodResultLayerCode, string> = {
  national_river_flood: 'https://www.floodmap.go.kr/nation',
  local_river_flood: 'https://www.floodmap.go.kr/region',
  urban_flood: 'https://www.floodmap.go.kr/fldara',
}

interface NearbyLocation {
  address: string
  latitude: number
  longitude: number
}

function countBy(items: Facility[], key: keyof Facility) {
  const counts = new globalThis.Map<string, number>()
  items.forEach((item) => {
    const value = String(item[key] || '미분류')
    counts.set(value, (counts.get(value) ?? 0) + 1)
  })
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function calculateReferenceRisk(overview: DisasterOverview) {
  const rainfall = overview.weather.rainfall1h
  const risingWater = overview.points.some((point) => point.kind === 'waterLevel' && point.trend === 'up')
  if (overview.floodTraceMatched || (rainfall != null && rainfall >= 30)) return { label: '경계 참고', tone: 'danger' }
  if (risingWater || (rainfall != null && rainfall >= 10)) return { label: '주의 참고', tone: 'warning' }
  if (rainfall != null || overview.points.length || overview.population) return { label: '관심 없음', tone: 'safe' }
  return { label: '판단 대기', tone: 'neutral' }
}

function overviewLocationPoints(overview: DisasterOverview, location?: NearbyLocation): DisasterMapPoint[] {
  const latitude = location?.latitude ?? 37.6584
  const longitude = location?.longitude ?? 126.832
  const result: DisasterMapPoint[] = []
  if (overview.weather.observedAt || overview.weather.rainfall1h != null || overview.weather.snowDepth != null) {
    result.push({
      id: `weather-${latitude}-${longitude}`,
      name: location?.address || '고양시 기상 조회지점',
      kind: 'rainfall',
      latitude,
      longitude,
      value: overview.weather.rainfall1h,
      unit: 'mm',
      source: '기상청',
      observedAt: overview.weather.observedAt,
    })
  }
  if (overview.population?.population != null) {
    result.push({
      id: `population-${latitude}-${longitude}`,
      name: overview.population.areaName || location?.address || '고양시 인구',
      kind: 'population',
      latitude,
      longitude,
      value: overview.population.population,
      unit: '명',
      source: '행정안전부',
      observedAt: overview.population.statisticMonth,
    })
  }
  return result
}

function normalizeImportedRow(row: Record<string, unknown>, index: number, source = '일괄등록'): Facility | null {
  const name = String(row['시설명'] ?? row['지점명'] ?? row['지정명'] ?? '').trim()
  const upper = String(row['지번주소 상위부분'] ?? '')
  const lower = String(row['지번주소 하위부분'] ?? '')
  const address = String(row['주소'] ?? `${upper} ${lower}`).trim()
  const longitude = Number(row['X좌표'] ?? row['경도'])
  const latitude = Number(row['Y좌표'] ?? row['위도'])
  if (!name || !address || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  const district = ['덕양구', '일산동구', '일산서구'].find((value) => address.includes(value)) ?? '미분류'
  return {
    id: `import-${crypto.randomUUID()}`,
    name,
    type: String(row['시설유형'] ?? row['유형'] ?? source),
    sourceType: source,
    status: String(row['운영상태'] ?? '운영중') as Facility['status'],
    address,
    district,
    longitude,
    latitude,
    agency: String(row['관리부서'] ?? row['관련과'] ?? '미등록'),
    installedAt: String(row['설치연도'] ?? row['설치년도'] ?? ''),
    detail: String(row['상세정보'] ?? row['설치목적'] ?? row['시설명'] ?? ''),
    pnu: String(row['PNU코드'] ?? ''),
    postalCode: String(row['새우편번호'] ?? row['우편번호'] ?? ''),
    sourceSheet: source,
    sourceRow: index + 2,
  }
}

export default function App({ onSignOut }: { onSignOut?: () => void | Promise<void> }) {
  const [view, setView] = useState<ViewName>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [dataInfo, setDataInfo] = useState({ sourceFile: '', generatedAt: '' })
  const [filters, setFilters] = useState<Filters>(defaultMapFilters)
  const [selected, setSelected] = useState<Facility | null>(null)
  const [editing, setEditing] = useState<Facility | null | undefined>(undefined)
  const [history, setHistory] = useState<ChangeRecord[]>([])
  const [toast, setToast] = useState('')
  const [page, setPage] = useState(1)
  const [facilityQuery, setFacilityQuery] = useState('')
  const [facilityType, setFacilityType] = useState('')
  const [nearbyAddress, setNearbyAddress] = useState('')
  const [nearbyRequest, setNearbyRequest] = useState<{ address: string; id: number } | null>(null)
  const [nearbyLocation, setNearbyLocation] = useState<NearbyLocation | null>(null)
  const [nearbyError, setNearbyError] = useState('')
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState(1)
  const [disasterOverview, setDisasterOverview] = useState<DisasterOverview>(() => emptyDisasterOverview())
  const [nearbyDisasterOverview, setNearbyDisasterOverview] = useState<DisasterOverview | null>(null)
  const [disasterLoading, setDisasterLoading] = useState(false)
  const [disasterError, setDisasterError] = useState('')
  const [disasterLayers, setDisasterLayers] = useState<DisasterLayerVisibility>(defaultDisasterLayers)
  const [populationDistribution, setPopulationDistribution] = useState<PopulationDistribution | null>(null)
  const [analysisStart, setAnalysisStart] = useState('2020-01-01')
  const [analysisEnd, setAnalysisEnd] = useState('2025-12-31')
  const [analysisMetric, setAnalysisMetric] = useState<HistoricalMetricFilter>('all')
  const [analysisFloodLayer, setAnalysisFloodLayer] = useState<HazardLayerId>('floodTrace')
  const [analysisShowFacilities, setAnalysisShowFacilities] = useState(false)
  const [analysisShowFloodLayer, setAnalysisShowFloodLayer] = useState(false)
  const [historicalFacilityQuery, setHistoricalFacilityQuery] = useState('')
  const [historicalFacilityId, setHistoricalFacilityId] = useState('')
  const [historicalAnalysis, setHistoricalAnalysis] = useState<HistoricalAnalysis>(() => emptyHistoricalAnalysis())
  const [historicalLoading, setHistoricalLoading] = useState(false)
  const [historicalError, setHistoricalError] = useState('')
  const [resultLayer, setResultLayer] = useState<FloodResultLayerCode>('national_river_flood')
  const [resultSummary, setResultSummary] = useState<FloodOverlapSummary | null>(null)
  const [resultFacilities, setResultFacilities] = useState<FacilityFloodExposure[]>([])
  const [resultDongs, setResultDongs] = useState<AdminDongFloodExposure[]>([])
  const [resultLoading, setResultLoading] = useState(false)
  const [resultError, setResultError] = useState('')
  const [resultReloadKey, setResultReloadKey] = useState(0)
  const [resultDistrict, setResultDistrict] = useState('')
  const [resultFacilityType, setResultFacilityType] = useState('')
  const [resultFacilityQuery, setResultFacilityQuery] = useState('')
  const [selectedResultFacilityId, setSelectedResultFacilityId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pageSize = 12

  const loadDatabase = useCallback(async () => {
    try {
      const [facilityResult, historyResult] = await Promise.all([fetchFacilities(), fetchFacilityHistory()])
      setFacilities(facilityResult.facilities)
      setHistory(historyResult)
      setDataInfo({ sourceFile: 'Supabase 시설물 DB', generatedAt: facilityResult.latestUpdatedAt ? facilityResult.latestUpdatedAt.slice(0, 10) : '-' })
      setSelected((current) => current ? facilityResult.facilities.find((item) => item.id === current.id) ?? null : facilityResult.facilities[0] ?? null)
      return true
    } catch (error) {
      setToast(error instanceof Error ? error.message : '시설물 데이터를 불러오지 못했습니다.')
      return false
    }
  }, [])

  useEffect(() => { void loadDatabase() }, [loadDatabase])

  useEffect(() => {
    void fetchPopulationDistribution()
      .then(setPopulationDistribution)
      .catch(() => setPopulationDistribution(null))
  }, [])

  const loadDisasterData = useCallback(async (location?: NearbyLocation) => {
    setDisasterLoading(true)
    setDisasterError('')
    try {
      const result = await fetchDisasterOverview(location)
      if (location) setNearbyDisasterOverview(result)
      else setDisasterOverview(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : '재난 API 데이터를 불러오지 못했습니다.'
      setDisasterError(message)
      if (location) setNearbyDisasterOverview(emptyDisasterOverview(message))
      else setDisasterOverview(emptyDisasterOverview(message))
    } finally {
      setDisasterLoading(false)
    }
  }, [])

  const loadHistorical = useCallback(async () => {
    if (analysisStart > analysisEnd) {
      setHistoricalError('분석 시작일은 종료일보다 늦을 수 없습니다.')
      return
    }
    setHistoricalLoading(true)
    setHistoricalError('')
    try {
      setHistoricalAnalysis(await fetchHistoricalAnalysis(analysisStart, analysisEnd))
    } catch (error) {
      setHistoricalAnalysis(emptyHistoricalAnalysis(analysisStart, analysisEnd))
      setHistoricalError(error instanceof Error ? error.message : '과거 재난 분석자료를 불러오지 못했습니다.')
    } finally {
      setHistoricalLoading(false)
    }
  }, [analysisStart, analysisEnd])

  useEffect(() => { void loadHistorical() }, [loadHistorical])
  useEffect(() => {
    if (view !== 'results') return
    let cancelled = false
    setResultLoading(true)
    setResultError('')
    setResultSummary(null)
    setResultFacilities([])
    setResultDongs([])
    void (async () => {
      try {
        const summary = await fetchFloodOverlapSummary()
        const month = summary.layers.find((layer) => layer.layerCode === resultLayer)?.statisticMonth
        const [exposures, dongs] = await Promise.all([
          fetchFacilityFloodExposure(resultLayer),
          month ? fetchAdminDongFloodExposure(resultLayer, month) : Promise.resolve([]),
        ])
        if (cancelled) return
        setResultSummary(summary)
        setResultFacilities(exposures)
        setResultDongs(dongs)
      } catch (error) {
        if (!cancelled) setResultError(error instanceof Error ? error.message : '분석 결과를 불러오지 못했습니다.')
      } finally {
        if (!cancelled) setResultLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [view, resultLayer, resultReloadKey])
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 2800); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => setPage(1), [facilityQuery, facilityType])

  const types = useMemo(() => [...new Set(facilities.map((item) => item.type))].sort(), [facilities])
  const districts = useMemo(() => [...new Set(facilities.map((item) => item.district))].sort((a, b) => {
    if (a === '미분류') return 1
    if (b === '미분류') return -1
    return a.localeCompare(b, 'ko')
  }), [facilities])
  const agencies = useMemo(() => [...new Set(facilities.map((item) => item.agency))].sort(), [facilities])
  const filtered = useMemo(() => filterFacilities(facilities, filters), [facilities, filters])
  const managedFacilities = useMemo(() => filterFacilities(facilities, {
    ...emptyFilters,
    query: facilityQuery,
    type: facilityType,
  }), [facilities, facilityQuery, facilityType])
  const typeCounts = useMemo(() => countBy(facilities, 'type'), [facilities])
  const cctvCount = useMemo(() => facilities.filter((item) => isCctvType(item.type)).length, [facilities])
  const nonCctvTypeCounts = useMemo(() => typeCounts.filter(([type]) => !isCctvType(type)), [typeCounts])
  const nonCctvTypes = useMemo(() => nonCctvTypeCounts.map(([type]) => type), [nonCctvTypeCounts])
  const groupedTypeCount = nonCctvTypeCounts.length + (cctvCount ? 1 : 0)
  const districtCounts = useMemo(() => countBy(facilities, 'district'), [facilities])
  const statusCounts = useMemo(() => countBy(facilities, 'status'), [facilities])
  const pageCount = Math.max(1, Math.ceil(managedFacilities.length / pageSize))
  const pageRows = managedFacilities.slice((page - 1) * pageSize, page * pageSize)
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount])
  const activeCount = facilities.filter((item) => item.status === '운영중').length
  const coordCount = facilities.filter((item) => item.longitude != null && item.latitude != null).length
  const inspectionCount = facilities.filter((item) => item.status === '점검필요').length
  const missingCoordCount = facilities.length - coordCount
  const disasterPoints = useMemo(() => (
    [...disasterOverview.points, ...overviewLocationPoints(disasterOverview)]
  ), [disasterOverview])
  const nearbyDisasterPoints = useMemo(() => {
    if (!nearbyDisasterOverview) return disasterPoints
    return [...nearbyDisasterOverview.points, ...overviewLocationPoints(nearbyDisasterOverview, nearbyLocation ?? undefined)]
  }, [nearbyDisasterOverview, nearbyLocation, disasterPoints])
  const waterLevelPoints = disasterPoints.filter((point) => point.kind === 'waterLevel')
  const risingWaterCount = waterLevelPoints.filter((point) => point.trend === 'up').length
  const liveSourceCount = disasterOverview.sources.filter((source) => source.state === 'live').length
  const goyangFacilities = useMemo(() => facilities.filter((facility) => GOYANG_DISTRICTS.has(facility.district)), [facilities])
  const historicalPoints = useMemo(() => historicalMapPoints(historicalAnalysis, analysisMetric), [historicalAnalysis, analysisMetric])
  const historicalAreas = useMemo(() => historicalMapAreas(historicalAnalysis, analysisMetric), [historicalAnalysis, analysisMetric])
  const observedFacilityIds = useMemo(() => new Set(historicalAnalysis.stations.map((station) => station.facilityId).filter((id): id is string => Boolean(id))), [historicalAnalysis.stations])
  const observedFacilities = useMemo(() => facilities.filter((facility) => observedFacilityIds.has(facility.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko')), [facilities, observedFacilityIds])
  const matchingObservedFacilities = useMemo(() => observedFacilities.filter((facility) => {
    const query = historicalFacilityQuery.trim().toLocaleLowerCase('ko-KR')
    return !query || facility.id === historicalFacilityId || `${facility.name} ${facility.type} ${facility.address}`.toLocaleLowerCase('ko-KR').includes(query)
  }), [observedFacilities, historicalFacilityQuery, historicalFacilityId])
  const historicalFacility = useMemo(() => facilities.find((facility) => facility.id === historicalFacilityId) ?? null, [facilities, historicalFacilityId])
  const historicalFacilityMetrics = useMemo(() => historicalAnalysis.stations.filter((station) => {
    if (station.facilityId !== historicalFacilityId) return false
    if (analysisMetric === 'all') return true
    if (analysisMetric === 'rainfall') return station.metric.startsWith('rainfall')
    if (analysisMetric === 'snowfall') return station.metric.includes('snow')
    return analysisMetric === 'waterLevel' && (station.metric === 'water_level' || station.metric === 'flow_rate')
  }), [historicalAnalysis.stations, historicalFacilityId, analysisMetric])
  const historicalSourceNames = useMemo(() => (
    historicalAnalysis.sources.map((source) => historicalSourceLabels[source.source] ?? source.source).join(' · ')
  ), [historicalAnalysis.sources])
  const historicalSourceRanges = useMemo(() => {
    const ranges = new globalThis.Map<string, { start: string; end: string }>()
    historicalAnalysis.stations.forEach((station) => {
      if (!station.firstObservedAt && !station.lastObservedAt) return
      const current = ranges.get(station.source)
      const start = station.firstObservedAt || station.lastObservedAt || ''
      const end = station.lastObservedAt || station.firstObservedAt || ''
      ranges.set(station.source, {
        start: !current?.start || (start && start < current.start) ? start : current.start,
        end: !current?.end || (end && end > current.end) ? end : current.end,
      })
    })
    return ranges
  }, [historicalAnalysis.stations])
  const historicalDataRange = useMemo(() => {
    const ranges = [...historicalSourceRanges.values()]
    if (!ranges.length) return '관측자료 없음'
    const start = ranges.map((range) => range.start).filter(Boolean).sort()[0]
    const sortedEnds = ranges.map((range) => range.end).filter(Boolean).sort()
    const end = sortedEnds[sortedEnds.length - 1]
    return start && end ? `${start.slice(0, 10)} ~ ${end.slice(0, 10)}` : '관측기간 미확인'
  }, [historicalSourceRanges])
  const availableHazardLayerCount = useMemo(() => {
    const floodmap = historicalAnalysis.sources.find((source) => source.source === 'floodmap')
    const safemap = historicalAnalysis.sources.find((source) => source.source === 'safemap')
    return (floodmap?.status === 'complete' ? 3 : 0) + (safemap?.status === 'complete' ? 1 : 0)
  }, [historicalAnalysis.sources])
  const historicalLayers = useMemo<DisasterLayerVisibility>(() => ({
    ...defaultDisasterLayers,
    facilities: analysisShowFacilities,
    population: false,
    rainfall: analysisMetric === 'all' || analysisMetric === 'rainfall',
    snowfall: analysisMetric === 'all' || analysisMetric === 'snowfall',
    waterLevel: analysisMetric === 'all' || analysisMetric === 'waterLevel',
    floodTrace: analysisShowFloodLayer && (analysisMetric === 'all' || analysisMetric === 'flood') && analysisFloodLayer === 'floodTrace',
    nationalRiverFlood: analysisShowFloodLayer && (analysisMetric === 'all' || analysisMetric === 'flood') && analysisFloodLayer === 'nationalRiverFlood',
    localRiverFlood: analysisShowFloodLayer && (analysisMetric === 'all' || analysisMetric === 'flood') && analysisFloodLayer === 'localRiverFlood',
    urbanFlood: analysisShowFloodLayer && (analysisMetric === 'all' || analysisMetric === 'flood') && analysisFloodLayer === 'urbanFlood',
  }), [analysisMetric, analysisFloodLayer, analysisShowFacilities, analysisShowFloodLayer])
  const districtGradient = useMemo(() => {
    if (!facilities.length || !districtCounts.length) return '#dce4ee'
    const colors = ['#256fd2', '#16a1b3', '#7b61d1', '#e38b2c', '#66768c']
    let cursor = 0
    const segments = districtCounts.map(([, count], index) => {
      const start = cursor
      cursor += count / facilities.length * 100
      return `${colors[index % colors.length]} ${start}% ${cursor}%`
    })
    return `conic-gradient(${segments.join(', ')})`
  }, [districtCounts, facilities.length])
  const nearbyResults = useMemo(() => {
    if (!nearbyLocation) return []
    return facilities
      .map((facility) => ({ facility, distance: haversineKm(nearbyLocation, facility) }))
      .filter((item): item is { facility: Facility; distance: number } => item.distance != null && item.distance <= nearbyRadiusKm)
      .sort((a, b) => a.distance - b.distance)
  }, [facilities, nearbyLocation, nearbyRadiusKm])
  const nearbyIds = useMemo(() => new Set(nearbyResults.map((item) => item.facility.id)), [nearbyResults])
  const nearbyRisk = calculateReferenceRisk(nearbyDisasterOverview ?? disasterOverview)
  const resultLayerSummary = resultSummary?.layers.find((layer) => layer.layerCode === resultLayer)
  const resultFacilityItems = useMemo(() => {
    const byId = new globalThis.Map(facilities.map((facility) => [facility.id, facility]))
    return resultFacilities.flatMap((exposure) => {
      const facility = byId.get(exposure.facilityId)
      return facility ? [{ facility, exposure }] : []
    })
  }, [facilities, resultFacilities])
  const resultFacilityTypes = useMemo(() => [...new Set(resultFacilityItems.map(({ facility }) => facility.type))].sort((a, b) => a.localeCompare(b, 'ko')), [resultFacilityItems])
  const filteredResultFacilities = useMemo(() => resultFacilityItems.filter(({ facility }) => {
    const query = resultFacilityQuery.trim().toLocaleLowerCase('ko-KR')
    return (!resultDistrict || facility.district === resultDistrict)
      && (!resultFacilityType || facility.type === resultFacilityType)
      && (!query || `${facility.name} ${facility.address} ${facility.type}`.toLocaleLowerCase('ko-KR').includes(query))
  }), [resultFacilityItems, resultDistrict, resultFacilityType, resultFacilityQuery])
  const resultBoundaryByCode = useMemo(() => new globalThis.Map((populationDistribution?.features ?? []).map((feature) => [feature.properties.adminCode, feature])), [populationDistribution])
  const resultDongItems = useMemo(() => resultDongs.map((row) => {
    const boundary = resultBoundaryByCode.get(row.adminCode)
    return { ...row, adminName: boundary?.properties.adminName ?? row.adminCode,
      districtName: boundary?.properties.districtName ?? '' }
  }).filter((row) => !resultDistrict || row.districtName.includes(resultDistrict)), [resultDongs, resultBoundaryByCode, resultDistrict])
  const resultMapAreas = useMemo<FloodResultMapArea[]>(() => resultDongItems.flatMap((row) => {
    const boundary = resultBoundaryByCode.get(row.adminCode)
    return boundary ? [{ ...row, geometry: boundary.geometry }] : []
  }), [resultDongItems, resultBoundaryByCode])
  const resultAreaSquareKm = resultDongItems.reduce((sum, row) => sum + row.hazardAreaSquareKm, 0)
  const resultEstimatedPopulation = resultDongItems.reduce((sum, row) => sum + row.estimatedExposedPopulation, 0)
  const resultCalculationDates = [...resultFacilities.map((row) => row.calculatedAt), ...resultDongs.map((row) => row.calculatedAt)].filter(Boolean).sort()
  const resultCalculatedAt = resultCalculationDates[resultCalculationDates.length - 1]
  const resultSelectedFacility = filteredResultFacilities.find(({ facility }) => facility.id === selectedResultFacilityId) ?? null

  const notify = (message: string) => setToast(message)
  const toggleDisasterLayer = (layerId: DisasterLayerId) => {
    setDisasterLayers((current) => {
      if (!hazardLayerIds.includes(layerId as HazardLayerId)) return { ...current, [layerId]: !current[layerId] }
      const next = { ...current }
      hazardLayerIds.forEach((id) => { next[id] = id === layerId ? !current[layerId] : false })
      return next
    })
  }
  const goToMap = (nextFilters: Partial<Filters> = {}) => {
    setFilters({ ...emptyFilters, ...nextFilters })
    setView('map')
  }
  const goToNearby = () => {
    setFilters(emptyFilters)
    setSelected(null)
    setView('nearby')
  }
  const goToAnalysis = () => {
    setAnalysisMetric('all')
    setAnalysisShowFacilities(false)
    setAnalysisShowFloodLayer(false)
    setView('analysis')
  }
  const searchNearby = (event: FormEvent) => {
    event.preventDefault()
    const address = nearbyAddress.trim()
    if (!address) {
      setNearbyError('검색할 주소를 입력해 주세요.')
      return
    }
    setNearbyError('')
    setNearbyLocation(null)
    setNearbyRequest({ address, id: Date.now() })
  }
  const resetNearby = () => {
    setNearbyAddress('')
    setNearbyRequest(null)
    setNearbyLocation(null)
    setNearbyError('')
    setNearbyRadiusKm(1)
    setSelected(null)
    setNearbyDisasterOverview(null)
  }
  const handleAddressResolved = useCallback((location: NearbyLocation | null, error?: string) => {
    setNearbyLocation(location)
    setNearbyError(error ?? '')
    setNearbyDisasterOverview(null)
  }, [])
  const saveFacility = async (facility: Facility) => {
    const exists = facilities.some((item) => item.id === facility.id)
    try {
      const result = await persistFacility(facility, exists, exists ? '수정' : '등록', exists ? '시설 기본정보를 수정했습니다.' : '신규 시설을 등록했습니다.')
      setFacilities((current) => exists ? current.map((item) => item.id === result.facility.id ? result.facility : item) : [result.facility, ...current])
      setHistory((current) => [result.history, ...current].slice(0, 100))
      setEditing(undefined)
      setSelected(result.facility)
      notify(exists ? '시설 정보가 DB에 저장되었습니다.' : '시설이 DB에 등록되었습니다.')
    } catch (error) {
      notify(error instanceof Error ? error.message : '시설물 저장에 실패했습니다.')
    }
  }
  const changeStatus = async (facility: Facility, status: Facility['status']) => {
    const updated = { ...facility, status }
    try {
      const result = await persistFacility(updated, true, '상태변경', `운영 상태를 ${status}(으)로 변경했습니다.`)
      setFacilities((current) => current.map((item) => item.id === result.facility.id ? result.facility : item))
      setSelected(result.facility)
      setHistory((current) => [result.history, ...current].slice(0, 100))
      notify(`운영 상태를 ${status}(으)로 변경했습니다.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '운영 상태 변경에 실패했습니다.')
    }
  }
  const exportCsv = () => downloadText(`재난시설_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(facilities), 'text/csv;charset=utf-8')
  const exportJson = () => downloadText(`재난시설_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(facilities, null, 2), 'application/json')
  const reloadData = async () => {
    const loaded = await loadDatabase()
    if (loaded) notify('Supabase에서 최신 데이터를 다시 불러왔습니다.')
  }
  const importWorkbook = async (file: File) => {
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const imported: Facility[] = []
      workbook.SheetNames.forEach((sheetName) => {
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' })
        rows.forEach((row, index) => {
          const facility = normalizeImportedRow(row, index, sheetName)
          if (facility) imported.push(facility)
        })
      })
      if (!imported.length) throw new Error('필수값이 있는 시설을 찾지 못했습니다.')
      const keys = new Set(facilities.map((item) => `${item.name}|${item.address}|${item.longitude}|${item.latitude}`))
      const newRows = imported.filter((item) => !keys.has(`${item.name}|${item.address}|${item.longitude}|${item.latitude}`))
      const savedRows = await importFacilities(newRows)
      setFacilities((current) => [...savedRows, ...current])
      setHistory(await fetchFacilityHistory())
      notify(`${newRows.length}개 시설을 추가했습니다. 중복 ${imported.length - newRows.length}개는 제외했습니다.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '파일을 불러오지 못했습니다.')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    const context = document.modelContext
    if (!context?.registerTool || !facilities.length) return
    const lifecycle = new AbortController()
    const register = (tool: Parameters<typeof context.registerTool>[0]) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined) } catch { /* unsupported host */ }
    }

    register({
      name: 'read_facility_summary',
      title: '시설 현황 조회',
      description: '현재 시설 데이터의 전체 수, 운영 상태, 유형 수, 행정구역별 수를 조회합니다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ total: facilities.length, active: activeCount, types: types.length, districts: Object.fromEntries(districtCounts) }),
    })
    register({
      name: 'read_historical_analysis',
      title: '재난 이력 분석 조회',
      description: '현재 선택한 기간의 고양시 강수·적설·하천수위·침수 공간자료 분석 결과와 원천별 적재 상태를 조회합니다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({
        scope: historicalAnalysis.scope,
        period: historicalAnalysis.period,
        generatedAt: historicalAnalysis.generatedAt,
        summary: historicalAnalysis.summary,
        sources: historicalAnalysis.sources,
      }),
    })
    register({
      name: 'filter_facility_map',
      title: '지도 시설 필터',
      description: '지도 상황판으로 이동하고 시설 유형, 운영 상태, 행정구역, 담당 기관, 검색어 조건을 적용합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' },
          district: { type: 'string' }, agency: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input) => {
        const value = typeof input === 'object' && input ? input as Partial<Filters> : {}
        const next = { ...emptyFilters, ...value }
        setFilters(next); setView('map')
        return { view: 'map', resultCount: filterFacilities(facilities, next).length, filters: next }
      },
    })
    register({
      name: 'update_facility_status',
      title: '시설 운영 상태 변경',
      description: '시설 ID에 해당하는 시설의 운영 상태를 운영중, 점검필요 또는 비활성으로 변경하고 DB 변경 이력에 기록합니다.',
      inputSchema: {
        type: 'object',
        properties: { facilityId: { type: 'string' }, status: { type: 'string', enum: ['운영중', '점검필요', '비활성'] } },
        required: ['facilityId', 'status'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        if (typeof input !== 'object' || !input) throw new Error('시설 ID와 운영 상태가 필요합니다.')
        const { facilityId, status } = input as { facilityId?: string; status?: Facility['status'] }
        const facility = facilities.find((item) => item.id === facilityId)
        if (!facility) throw new Error('해당 시설을 찾을 수 없습니다.')
        if (!status || !['운영중', '점검필요', '비활성'].includes(status)) throw new Error('올바른 운영 상태가 아닙니다.')
        await changeStatus(facility, status)
        return { facilityId, facilityName: facility.name, status }
      },
    })
    return () => lifecycle.abort()
  }, [facilities, activeCount, types.length, districtCounts, historicalAnalysis])

  const navigation = [
    { id: 'dashboard' as const, label: '통합 대시보드', icon: LayoutDashboard },
    { id: 'map' as const, label: '지도 상황판', icon: MapIcon },
    { id: 'analysis' as const, label: '재난 이력 분석', icon: CalendarRange },
    { id: 'results' as const, label: '분석 결과', icon: Layers3 },
    { id: 'nearby' as const, label: '주변 시설물 검색', icon: LocateFixed },
    { id: 'facilities' as const, label: '시설물 관리', icon: ListChecks },
  ]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <button className="brand" onClick={() => { setView('dashboard'); setSidebarOpen(false) }} aria-label="통합 대시보드로 이동"><div className="brand-mark"><Siren size={21} /></div><div><strong>재난 예·경보시설물 통합관리</strong><span>고양시 상황판</span></div></button>
        <nav className="main-nav" aria-label="주요 화면">
          {navigation.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'is-active' : ''} onClick={() => { if (id === 'map') goToMap(); else if (id === 'nearby') goToNearby(); else if (id === 'analysis') goToAnalysis(); else setView(id); setSidebarOpen(false) }}><Icon size={19} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-status"><Database size={17} /><div><strong>Supabase 연결</strong><span>시설물과 변경 이력을 중앙 DB에 저장합니다.</span></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSidebarOpen((value) => !value)} aria-label="메뉴 열기">{sidebarOpen ? <X /> : <Menu />}</button>
          <div className="page-heading"><h1>{navigation.find((item) => item.id === view)?.label}</h1><p>{view === 'analysis' ? `분석지역 경기도 고양시 · ${analysisStart}~${analysisEnd}` : view === 'results' ? '고양시 100년 빈도 예상 침수 시나리오 중첩 결과' : `${dataInfo.sourceFile || '시설물 데이터를 불러오는 중입니다'} · 기준일 ${dataInfo.generatedAt || '-'}`}</p></div>
          <div className="top-actions">{view !== 'results' && <button className="button secondary" onClick={exportCsv}><Download size={17} />CSV 내보내기</button>}<button className="button primary" onClick={() => goToMap()}><MapPin size={17} />지도 열기</button>{onSignOut && <button className="button secondary signout-button" onClick={() => void onSignOut()}><LogOut size={17} />로그아웃</button>}</div>
        </header>

        <div className="content">
          {view === 'dashboard' && (
            <section className="view-stack" aria-label="통합 대시보드">
              <article className="disaster-command-panel">
                <div className="command-heading">
                  <div><span className="eyebrow">과거 재난·기상 분석</span><h2>고양시 이력 분석 요약</h2></div>
                  <div className="command-sync"><span className={`source-pulse ${historicalAnalysis.summary.observationCount ? 'is-live' : ''}`} />{historicalLoading ? '분석자료 조회 중' : `${analysisStart.slice(0, 4)}~${analysisEnd.slice(0, 4)}년 · 고양시 한정`}</div>
                </div>
                <div className="command-metrics">
                  <div><span><CloudRain />최대 일강수</span><strong>{formatMetric(historicalAnalysis.summary.maxRainfallDaily, 'mm')}</strong><small>선택기간 일 누적 최댓값</small></div>
                  <div><span><Snowflake />최대 적설</span><strong>{formatMetric(historicalAnalysis.summary.maxSnowDepth, 'cm')}</strong><small>고양시 내부 관측소</small></div>
                  <div><span><Waves />최고 하천수위</span><strong>{formatMetric(historicalAnalysis.summary.maxWaterLevel, 'm')}</strong><small>고양시 내부 관측소</small></div>
                  <div><span><Layers3 />위험지도 레이어</span><strong>{availableHazardLayerCount ? `${availableHazardLayerCount}종` : '적재 대기'}</strong><small>고양시 범위 WMS 스냅샷</small></div>
                </div>
                <div className="source-status-row" aria-label="외부 API 연계 상태">
                  {historicalAnalysis.sources.length ? historicalAnalysis.sources.map((source) => <span key={source.source} className={`source-chip ${source.status === 'complete' ? 'live' : source.status === 'failed' ? 'error' : 'configured'}`} title={source.message}><i />{historicalSourceLabels[source.source] ?? source.source}</span>) : <span className="source-chip configured"><i />과거자료 초기 적재 대기</span>}
                  <button className="text-button command-refresh" onClick={goToAnalysis}><CalendarRange size={14} />분석 화면 열기</button>
                </div>
                {historicalError && <p className="command-error">{historicalError}</p>}
              </article>

              <div className="situation-kpi-grid">
                <button className="situation-kpi tone-blue" onClick={() => goToMap()}><span className="kpi-icon"><Building2 /></span><span className="kpi-copy"><small>전체 시설</small><strong>{facilities.length.toLocaleString('ko-KR')}</strong><em>전체 위치 보기 <ChevronRight size={14} /></em></span></button>
                <button className="situation-kpi tone-green" onClick={() => goToMap({ status: '운영중' })}><span className="kpi-icon"><CheckCircle2 /></span><span className="kpi-copy"><small>운영 중</small><strong>{activeCount.toLocaleString('ko-KR')}</strong><em>전체의 {facilities.length ? Math.round(activeCount / facilities.length * 100) : 0}%</em></span></button>
                <button className="situation-kpi tone-orange" onClick={() => goToMap({ status: '점검필요' })}><span className="kpi-icon"><TriangleAlert /></span><span className="kpi-copy"><small>점검 필요</small><strong>{inspectionCount.toLocaleString('ko-KR')}</strong><em>{inspectionCount ? '확인 대상 시설 보기' : '확인 대상 없음'}</em></span></button>
                <button className="situation-kpi tone-slate" onClick={() => setView('facilities')}><span className="kpi-icon"><MapPin /></span><span className="kpi-copy"><small>좌표 누락</small><strong>{missingCoordCount.toLocaleString('ko-KR')}</strong><em>{missingCoordCount ? '시설 정보 확인 필요' : `전체 ${coordCount.toLocaleString('ko-KR')}개 등록 완료`}</em></span></button>
              </div>

              <div className="situation-main-grid">
                <article className="panel dashboard-map-panel">
                  <header className="panel-header"><div><span className="eyebrow">고양시 전역</span><h2>시설 분포 지도</h2></div><div className="map-panel-actions"><span>지도 표시 {coordCount.toLocaleString('ko-KR')}개</span><button className="text-button" onClick={() => goToMap()}>상황판 열기 <ChevronRight size={15} /></button></div></header>
                  <KakaoMap facilities={facilities} selected={null} onSelect={(facility) => { setSelected(facility); goToMap() }} allTypes={types} disasterPoints={disasterPoints} disasterAreas={disasterOverview.areas} populationDistribution={populationDistribution} layers={{ ...disasterLayers, floodTrace: false }} compact />
                </article>

                <div className="dashboard-side-column">
                  <article className="panel type-panel">
                  <header className="panel-header"><div><span className="eyebrow">유형별 분포</span><h2>시설 유형 현황</h2></div><span className="panel-count">{groupedTypeCount}개 유형</span></header>
                  <div className="bar-chart cctv-bar-group">
                    <span className="bar-group-label">CCTV 시설 통합</span>
                    <button className="bar-row bar-row-featured" onClick={() => goToMap({ type: CCTV_ALL_TYPE })}>
                      <span className="bar-label"><i />{CCTV_ALL_TYPE}</span>
                      <span className="bar-track"><i style={{ width: '100%' }} /></span>
                      <strong>{cctvCount}</strong>
                    </button>
                    <small>CCTV 세부 유형 합계 · 전체의 {facilities.length ? (cctvCount / facilities.length * 100).toFixed(1) : 0}%</small>
                  </div>
                  <div className="bar-chart other-type-bars">
                    <span className="bar-group-label">기타 예·경보 시설</span>
                    {nonCctvTypeCounts.map(([type, count]) => (
                      <button className="bar-row" key={type} onClick={() => goToMap({ type })}>
                        <span className="bar-label"><i style={{ background: colorForType(type, nonCctvTypes) }} />{type}</span>
                        <span className="bar-track"><i style={{ width: `${count / Math.max(1, nonCctvTypeCounts[0]?.[1] ?? 1) * 100}%`, background: colorForType(type, nonCctvTypes) }} /></span>
                        <strong>{count}</strong>
                      </button>
                    ))}
                  </div>
                </article>

                <article className="panel district-panel">
                  <header className="panel-header"><div><span className="eyebrow">행정구역</span><h2>구별 시설 현황</h2></div><CircleGauge size={21} /></header>
                  <div className="district-visual">
                    <div className="donut" style={{ background: districtGradient }}><div><strong>{facilities.length}</strong><span>전체 시설</span></div></div>
                    <div className="district-list">{districtCounts.map(([district, count], index) => <button key={district} onClick={() => goToMap({ district })}><i style={{ background: ['#256fd2', '#16a1b3', '#7b61d1', '#e38b2c', '#66768c'][index % 5] }} /><span>{district === '미분류' ? '관외' : district}</span><strong>{count}개</strong><ChevronRight size={15} /></button>)}</div>
                  </div>
                </article>
                </div>
              </div>

              <div className="situation-bottom-grid">
                <article className="panel status-panel">
                  <header className="panel-header"><div><span className="eyebrow">운영 상태</span><h2>상태별 시설</h2></div><Activity size={21} /></header>
                  <div className="status-list">{statusCounts.map(([status, count]) => <button key={status} onClick={() => goToMap({ status })}><i className={`status-dot ${status}`} /><span>{status}</span><strong>{count}</strong></button>)}</div>
                </article>

                <article className="panel recent-panel">
                  <header className="panel-header"><div><span className="eyebrow">최근 활동</span><h2>시설 변경 이력</h2></div><History size={21} /></header>
                  {history.length ? <div className="history-list">{history.slice(0, 5).map((item) => <div key={item.id}><span>{item.action}</span><div><strong>{item.facilityName}</strong><small>{new Date(item.changedAt).toLocaleString('ko-KR')}</small></div></div>)}</div> : <div className="empty-compact">아직 변경 이력이 없습니다.</div>}
                </article>
              </div>
            </section>
          )}

          {view === 'analysis' && (
            <section className="historical-view" aria-label="재난 이력 분석">
              <div className="analysis-scope-bar">
                <div><span className="eyebrow">분석지역 고정</span><h2>경기도 고양시</h2><p>덕양구·일산동구·일산서구 경계 내부 자료만 사용합니다.</p></div>
                <span className="scope-badge"><MapPin size={15} />행정구역 코드 41280</span>
              </div>

              <div className="analysis-kpi-grid">
                <article><CloudRain /><span>최대 일강수</span><strong>{formatMetric(historicalAnalysis.summary.maxRainfallDaily, 'mm')}</strong></article>
                <article><Snowflake /><span>최대 적설</span><strong>{formatMetric(historicalAnalysis.summary.maxSnowDepth, 'cm')}</strong></article>
                <article><Waves /><span>최고 하천수위</span><strong>{formatMetric(historicalAnalysis.summary.maxWaterLevel, 'm')}</strong></article>
                <article><Layers3 /><span>위험지도 레이어</span><strong>{availableHazardLayerCount ? `${availableHazardLayerCount}종` : '적재 대기'}</strong></article>
              </div>

              <div className="analysis-workspace">
                <aside className="analysis-filter-panel">
                  <div className="filter-title"><SlidersHorizontal size={18} /><h2>분석 조건</h2></div>
                  <label className="field"><span>시작일</span><input type="date" min="2000-01-01" max={analysisEnd} value={analysisStart} onChange={(event) => setAnalysisStart(event.target.value)} /></label>
                  <label className="field"><span>종료일</span><input type="date" min={analysisStart} max="2099-12-31" value={analysisEnd} onChange={(event) => setAnalysisEnd(event.target.value)} /></label>
                  <div className="period-presets" aria-label="분석기간 빠른 선택">
                    <button type="button" onClick={() => { setAnalysisStart('2025-01-01'); setAnalysisEnd('2025-12-31') }}>1년</button>
                    <button type="button" onClick={() => { setAnalysisStart('2023-01-01'); setAnalysisEnd('2025-12-31') }}>3년</button>
                    <button type="button" onClick={() => { setAnalysisStart('2020-01-01'); setAnalysisEnd('2025-12-31') }}>기본 6년</button>
                  </div>
                  <label className="field"><span>자료 유형</span><select value={analysisMetric} onChange={(event) => setAnalysisMetric(event.target.value as HistoricalMetricFilter)}><option value="all">전체 자료</option><option value="rainfall">강수량</option><option value="snowfall">적설량</option><option value="waterLevel">하천수위</option><option value="flood">침수·홍수</option></select></label>
                  <label className="field"><span>침수·홍수 지도</span><select value={analysisFloodLayer} onChange={(event) => setAnalysisFloodLayer(event.target.value as HazardLayerId)} disabled={analysisMetric !== 'all' && analysisMetric !== 'flood'}><option value="floodTrace">침수흔적도 · 실제 이력</option><option value="nationalRiverFlood">국가하천 범람 · 예상</option><option value="localRiverFlood">지방하천 범람 · 예상</option><option value="urbanFlood">도시침수 · 예상</option></select></label>
                  <fieldset className="layer-fieldset analysis-layer-fieldset">
                    <legend><Layers3 size={15} />지도 표시 항목</legend>
                    <label><input type="checkbox" checked={analysisShowFacilities} onChange={(event) => setAnalysisShowFacilities(event.target.checked)} /><span>시설물 현황</span></label>
                    <label><input type="checkbox" checked={analysisShowFloodLayer} onChange={(event) => setAnalysisShowFloodLayer(event.target.checked)} disabled={analysisMetric !== 'all' && analysisMetric !== 'flood'} /><span>침수·홍수 지도</span></label>
                    <small className="layer-fieldset-note">처음에는 관측자료만 표시합니다. 시설물과 침수·홍수 지도는 선택 시 추가됩니다.</small>
                  </fieldset>
                  <div className="analysis-rule"><strong>지역·시나리오 기준</strong><span>고양시 경계 내부 자료만 사용하며 홍수위험지도는 100년 빈도를 표시합니다.</span></div>
                  <button className="button primary full" onClick={() => void loadHistorical()} disabled={historicalLoading}><RefreshCcw size={16} className={historicalLoading ? 'is-spinning' : ''} />{historicalLoading ? '조회 중' : '분석자료 조회'}</button>
                </aside>

                <KakaoMap facilities={goyangFacilities} selected={analysisShowFacilities ? selected : null} onSelect={setSelected} allTypes={types} disasterPoints={historicalPoints} disasterAreas={historicalAreas} layers={historicalLayers} />

                <aside className="analysis-result-panel">
                  <header><span className="eyebrow">분석 범위</span><h2>{analysisStart}~{analysisEnd}</h2><p>고양시 내부 관측·공간자료</p></header>
                  <dl className="analysis-summary-list">
                    <div><dt>관측소</dt><dd>{historicalAnalysis.summary.stationCount.toLocaleString('ko-KR')}개소</dd></div>
                    <div><dt>관측자료</dt><dd>{historicalAnalysis.summary.observationCount.toLocaleString('ko-KR')}건</dd></div>
                    {analysisShowFacilities && <div><dt>분석 완료 시설</dt><dd>{historicalAnalysis.summary.analysedFacilityCount.toLocaleString('ko-KR')}개</dd></div>}
                    <div><dt>데이터 출처</dt><dd>{historicalSourceNames || '적재 대기'}</dd></div>
                    <div><dt>데이터 기간</dt><dd>{historicalDataRange}</dd></div>
                    <div><dt>조회 생성일</dt><dd>{historicalAnalysis.generatedAt ? new Date(historicalAnalysis.generatedAt).toLocaleDateString('ko-KR') : '적재 대기'}</dd></div>
                  </dl>
                  {!historicalAnalysis.schemaReady && <div className="analysis-empty-note"><Database size={20} /><strong>분석 DB 준비 중</strong><span>구조 적용 후 과거 관측자료를 순차적으로 적재합니다.</span></div>}
                  {historicalError && <div className="nearby-error" role="alert">{historicalError}</div>}
                  <div className="source-coverage-list">
                    <strong>자료 적재 현황</strong>
                    {historicalAnalysis.sources.length ? historicalAnalysis.sources.map((source) => {
                      const range = historicalSourceRanges.get(source.source)
                      return <div key={source.source}><span>{historicalSourceLabels[source.source] ?? source.source}</span><b className={source.status}>{source.status === 'complete' ? '완료' : source.status === 'running' ? '수집 중' : source.status === 'failed' ? '실패' : '대기'}</b><small>{source.acceptedCount.toLocaleString('ko-KR')}건 · 관외 제외 {source.excludedCount.toLocaleString('ko-KR')}건</small><small className="source-data-date">{range ? `데이터 ${range.start.slice(0, 10)} ~ ${range.end.slice(0, 10)}` : source.finishedAt ? `자료 적재일 ${source.finishedAt.slice(0, 10)}` : '데이터 날짜 미확인'}</small></div>
                    }) : <p>아직 적재 이력이 없습니다.</p>}
                  </div>
                </aside>
              </div>

              <article className="panel analysis-table-panel">
                <header className="panel-header"><div><span className="eyebrow">시설물별 기간 통계</span><h2>시설물 관측자료 조회</h2></div><span className="panel-count">관측자료 연결 시설 {observedFacilities.length.toLocaleString('ko-KR')}개</span></header>
                <div className="analysis-facility-search">
                  <label className="field"><span>시설명·유형·주소 검색</span><input type="search" value={historicalFacilityQuery} onChange={(event) => setHistoricalFacilityQuery(event.target.value)} placeholder="조회할 시설물을 검색하세요" /></label>
                  <label className="field"><span>시설물 선택</span><select value={historicalFacilityId} onChange={(event) => setHistoricalFacilityId(event.target.value)}><option value="">시설물을 선택하세요</option>{matchingObservedFacilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name} · {facility.type} · {facility.district}</option>)}</select></label>
                </div>
                {historicalFacility && <div className="analysis-facility-context"><strong>{historicalFacility.name}</strong><span>{historicalFacility.type} · {historicalFacility.address}</span><small>{analysisStart} ~ {analysisEnd} · {historicalFacilityMetrics.reduce((sum, station) => sum + station.observationCount, 0).toLocaleString('ko-KR')}건</small></div>}
                {historicalFacilityMetrics.length ? <div className="table-wrap"><table><thead><tr><th>관측 항목</th><th>관측소·자료원</th><th>최솟값</th><th>평균값</th><th>최댓값</th><th>자료 수</th><th>관측 기간</th></tr></thead><tbody>{historicalFacilityMetrics.map((station) => {
                  const metric = historicalMetricLabels[station.metric] ?? { label: station.metric, unit: '' }
                  return <tr key={`${station.source}-${station.stationCode}-${station.metric}`}><td><strong>{metric.label}</strong><small>{metric.unit}</small></td><td>{station.stationName}<small>{historicalSourceLabels[station.source] ?? station.source}</small></td><td>{formatMetric(station.minValue, metric.unit, '-')}</td><td>{formatMetric(station.avgValue, metric.unit, '-')}</td><td>{formatMetric(station.maxValue, metric.unit, '-')}</td><td>{station.observationCount.toLocaleString('ko-KR')}건</td><td>{station.firstObservedAt ? new Date(station.firstObservedAt).toLocaleDateString('ko-KR') : '-'}<small>~ {station.lastObservedAt ? new Date(station.lastObservedAt).toLocaleDateString('ko-KR') : '-'}</small></td></tr>
                })}</tbody></table></div> : <div className="empty-state"><CalendarRange size={28} /><h3>{!historicalAnalysis.stations.length ? '과거 관측자료 적재를 기다리고 있습니다.' : historicalFacilityId ? '선택한 조건의 관측자료가 없습니다.' : '시설물을 선택해 주세요.'}</h3><p>{!historicalAnalysis.stations.length ? '고양시 관측자료가 적재되면 시설물별로 조회할 수 있습니다.' : historicalFacilityId ? '분석 기간 또는 자료 유형을 변경해 확인해 주세요.' : '검색 후 시설물을 선택하면 해당 기간의 관측 통계를 보여줍니다.'}</p></div>}
              </article>
            </section>
          )}

          {view === 'results' && (
            <section className="results-view" aria-label="홍수 시나리오 분석 결과">
              <div className="analysis-scope-bar">
                <div><span className="eyebrow">고양시 공간 중첩 분석</span><h2>예상 침수범위 중첩 결과</h2><p>시설물 위치와 행정동 경계를 예상 침수지도에 겹쳐 확인한 결과입니다.</p></div>
                <span className="scope-badge"><MapPin size={15} />100년 빈도 · 고양시 경계</span>
              </div>

              <article className="panel results-guide" aria-labelledby="results-guide-title">
                <div className="results-guide-heading"><div><span className="eyebrow">결과 읽는 법</span><h2 id="results-guide-title">현재 침수 상황이나 피해 현황이 아닙니다</h2><p>선택한 100년 빈도 예상 침수지도와 고양시 시설·행정동 자료를 겹쳐 본 참고 결과입니다. ‘100년 빈도’는 100년 뒤에 침수된다는 뜻이 아닙니다.</p></div><TriangleAlert size={25} aria-hidden="true" /></div>
                <div className="results-guide-grid">
                  <div><strong>예상 구역 안 시설</strong><span>시설물의 등록 좌표가 예상 침수범위 안에 있는 수입니다. 실제 침수·피해 시설 수가 아닙니다.</span></div>
                  <div><strong>행정동·면적 비율</strong><span>예상 침수범위와 겹치는 행정동·면적입니다. 면적 비율은 겹친 면적을 행정동 전체 면적으로 나눈 값입니다.</span></div>
                  <div><strong>면적 비례 추정 인구</strong><span>행정동 인구가 고르게 분포한다고 가정해 계산한 값입니다. 실제 거주 위치나 피해 인원을 뜻하지 않습니다.</span></div>
                  <div><strong>최대 침수심</strong><span>선택한 시나리오 지도의 예상 수심 중 가장 큰 값입니다. 관측 수위나 실제 침수 깊이가 아닙니다.</span></div>
                </div>
                <p>국가하천·지방하천·도시침수는 서로 다른 시나리오이며 범위가 겹칠 수 있으므로 수치들을 단순 합산하지 마세요. 새 시설 등록·좌표 수정 후에는 분석 결과를 재계산해야 반영됩니다.</p>
              </article>

              <div className="panel results-filter-bar">
                <label className="field"><span>분석 지도</span><select value={resultLayer} onChange={(event) => { setResultLayer(event.target.value as FloodResultLayerCode); setResultFacilityType(''); setSelectedResultFacilityId('') }}><option value="national_river_flood">국가하천 범람</option><option value="local_river_flood">지방하천 범람</option><option value="urban_flood">도시침수</option></select></label>
                <label className="field"><span>행정구역</span><select value={resultDistrict} onChange={(event) => setResultDistrict(event.target.value)}><option value="">고양시 전체</option><option value="덕양구">덕양구</option><option value="일산동구">일산동구</option><option value="일산서구">일산서구</option></select></label>
                <label className="field"><span>시설 유형</span><select value={resultFacilityType} onChange={(event) => setResultFacilityType(event.target.value)}><option value="">전체 유형</option>{resultFacilityTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
                <button className="button secondary" onClick={() => setResultReloadKey((value) => value + 1)} disabled={resultLoading}><RefreshCcw size={16} className={resultLoading ? 'is-spinning' : ''} />새로고침</button>
              </div>

              {resultError && <div className="nearby-error" role="alert">{resultError}</div>}
              {!populationDistribution && !resultLoading && <div className="nearby-error" role="status">행정동 경계를 불러오지 못해 지도 색상과 행정동 명칭을 표시할 수 없습니다. 인구 분포 데이터 연결을 확인해 주세요.</div>}
              {resultLoading && <p className="results-loading" role="status">분석 결과를 불러오는 중입니다.</p>}
              <div className="results-kpi-grid">
                <article><Building2 /><span>예상 구역 안 시설</span><strong>{filteredResultFacilities.length.toLocaleString('ko-KR')}개</strong></article>
                <article><MapPin /><span>예상 구역 닿은 행정동</span><strong>{resultDongItems.filter((row) => row.hazardAreaSquareKm > 0).length.toLocaleString('ko-KR')}개</strong></article>
                <article><Layers3 /><span>예상 구역 겹친 면적</span><strong>{resultAreaSquareKm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}㎢</strong></article>
                <article><Users /><span>면적 비례 추정 인구</span><strong>{resultEstimatedPopulation.toLocaleString('ko-KR')}명</strong></article>
              </div>
              <p className="results-method-note">{resultLayerSummary?.layerName ?? '분석 지도'} · 시설물 {resultLayerSummary?.analyzedFacilities.toLocaleString('ko-KR') ?? '-'}개 분석 · 인구 기준 {resultLayerSummary?.statisticMonth ? `${resultLayerSummary.statisticMonth.slice(0, 4)}.${resultLayerSummary.statisticMonth.slice(4, 6)}` : '확인 중'} · 마지막 중첩 계산 {resultCalculatedAt ? new Date(resultCalculatedAt).toLocaleDateString('ko-KR') : '확인 중'} · 시설 유형 필터는 시설 목록에만 적용됩니다.</p>

              <div className="results-main-grid">
                <div className="results-map-wrap">
                  <KakaoMap facilities={filteredResultFacilities.map(({ facility }) => facility)} selected={resultSelectedFacility?.facility ?? null} onSelect={(facility) => setSelectedResultFacilityId(facility.id)} allTypes={types} riskDongAreas={resultMapAreas} layers={floodResultMapLayers} enableFloodWms={false} />
                </div>
                <article className="panel results-facility-panel">
                  <header className="panel-header"><div><span className="eyebrow">시설물 지점 중첩</span><h2>예상 구역 안 시설</h2></div><span className="panel-count">{filteredResultFacilities.length.toLocaleString('ko-KR')}개</span></header>
                  <label className="field"><span>시설명·주소 검색</span><input type="search" value={resultFacilityQuery} onChange={(event) => setResultFacilityQuery(event.target.value)} placeholder="시설명 또는 주소" /></label>
                  {resultSelectedFacility && <div className="results-selected-facility"><strong>{resultSelectedFacility.facility.name}</strong><span>{resultSelectedFacility.facility.type} · {resultSelectedFacility.facility.address}</span><small>시나리오 최대 침수심 {resultSelectedFacility.exposure.maxDepthM == null ? '미제공' : `${resultSelectedFacility.exposure.maxDepthM}m`}</small></div>}
                  <div className="results-facility-list">{filteredResultFacilities.length ? filteredResultFacilities.map(({ facility, exposure }) => <button key={facility.id} className={selectedResultFacilityId === facility.id ? 'is-selected' : ''} onClick={() => setSelectedResultFacilityId(facility.id)}><strong>{facility.name}</strong><span>{facility.type} · {facility.district}</span><small>{exposure.depthLabel || (exposure.maxDepthM == null ? '침수심 미제공' : `최대 ${exposure.maxDepthM}m`)}</small></button>) : <p className="results-empty">{resultLoading ? '조회 중입니다.' : '조건에 맞는 중첩 시설이 없습니다.'}</p>}</div>
                </article>
              </div>

              <article className="panel results-dong-panel">
                <header className="panel-header"><div><span className="eyebrow">행정동·인구 중첩 분석</span><h2>행정동별 예상 구역 중첩 면적</h2></div><span className="panel-count">{resultDongItems.length.toLocaleString('ko-KR')}개 행정동</span></header>
                <div className="table-wrap"><table><thead><tr><th>구</th><th>행정동</th><th>중첩 면적</th><th>행정동 면적 비율</th><th>주민등록 인구</th><th>추정 노출인구</th><th>최대 침수심</th></tr></thead><tbody>{resultDongItems.map((row) => <tr key={row.adminCode}><td>{row.districtName || '-'}</td><td><strong>{row.adminName}</strong><small>{row.adminCode}</small></td><td>{row.hazardAreaSquareKm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}㎢</td><td>{row.hazardAreaPercent.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%</td><td>{row.population.toLocaleString('ko-KR')}명</td><td>{row.estimatedExposedPopulation.toLocaleString('ko-KR')}명</td><td>{row.maxDepthM == null ? '-' : `${row.maxDepthM}m`}</td></tr>)}</tbody></table></div>
                {!resultDongItems.length && <p className="results-empty">{resultLoading ? '행정동 결과를 불러오는 중입니다.' : '선택한 조건의 행정동 결과가 없습니다.'}</p>}
                <p className="results-caveat">중첩 시설은 피해 확정 시설이 아닙니다. 추정 노출인구는 행정동 내 인구가 고르게 분포한다고 가정한 면적 비례 추정치이며 실제 침수·피해 인구를 뜻하지 않습니다. 지도 3종의 결과는 서로 겹칠 수 있어 합산하지 않습니다.</p>
                <p className="results-source">출처: <a href={floodResultSourceUrls[resultLayer]} target="_blank" rel="noopener noreferrer">홍수위험지도 정보제공포털</a> 100년 빈도 SHP · 행정안전부 주민등록 인구({resultLayerSummary?.statisticMonth ?? '기준월 미확인'})</p>
              </article>
            </section>
          )}

          {view === 'map' && (
            <section className="map-layout" aria-label="지도 상황판">
              <aside className="filter-panel">
                <div className="filter-title"><SlidersHorizontal size={18} /><h2>시설 검색·필터</h2></div>
                <label className="search-field"><Search size={17} /><input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="시설명·주소·좌표 검색" /></label>
                <label className="field"><span>시설 유형</span><select value={filters.type} onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))}><option value="">전체 유형</option><optgroup label="통합 유형"><option value={CCTV_ALL_TYPE}>{CCTV_ALL_TYPE}</option></optgroup><optgroup label="세부 유형">{types.map((value) => <option key={value}>{value}</option>)}</optgroup></select></label>
                <label className="field"><span>운영 상태</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="">전체 상태</option><option>운영중</option><option>점검필요</option><option>비활성</option></select></label>
                <label className="field"><span>행정구역</span><select value={filters.district} onChange={(event) => setFilters((current) => ({ ...current, district: event.target.value }))}><option value="">고양시 전체</option>{districts.map((value) => <option key={value} value={value}>{value === '미분류' ? '관외' : value}</option>)}</select></label>
                <label className="field"><span>담당 기관</span><select value={filters.agency} onChange={(event) => setFilters((current) => ({ ...current, agency: event.target.value }))}><option value="">전체 기관</option>{agencies.map((value) => <option key={value}>{value}</option>)}</select></label>
                <fieldset className="layer-fieldset">
                  <legend><Layers3 size={15} />재난 지도 레이어</legend>
                  {layerLabels.map((layer) => <label key={layer.id}><input type="checkbox" checked={disasterLayers[layer.id]} onChange={() => toggleDisasterLayer(layer.id)} /><span>{layer.label}</span></label>)}
                  <small className="layer-fieldset-note">침수·범람 지도는 색상 혼합을 막기 위해 한 번에 하나만 표시됩니다.</small>
                </fieldset>
                <button className="button secondary full" onClick={() => setFilters(defaultMapFilters)}><RefreshCcw size={16} />필터 초기화</button>
                <div className="filter-summary"><strong>{filtered.length.toLocaleString('ko-KR')}</strong><span>개 시설 표시 중</span></div>
              </aside>

              <KakaoMap facilities={filtered} selected={selected} onSelect={setSelected} allTypes={types} disasterPoints={disasterPoints} disasterAreas={disasterOverview.areas} populationDistribution={populationDistribution} layers={disasterLayers} />

              <aside className={`detail-panel ${selected ? 'has-selection' : ''}`}>
                {selected ? <>
                  <header><div><span className={`status-badge ${selected.status}`}>{selected.status}</span><h2>{selected.name}</h2><p>{selected.type}</p></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="선택 해제"><X size={17} /></button></header>
                  <dl className="detail-list"><div><dt>주소</dt><dd>{selected.address || '미등록'}</dd></div><div><dt>좌표</dt><dd>{formatCoordinate(selected.longitude)}, {formatCoordinate(selected.latitude)}</dd></div><div><dt>행정구역</dt><dd>{selected.district}</dd></div><div><dt>관리부서</dt><dd>{selected.agency}</dd></div><div><dt>설치연도</dt><dd>{selected.installedAt || '미등록'}</dd></div><div><dt>상세정보</dt><dd>{selected.detail || '미등록'}</dd></div><div><dt>원본 위치</dt><dd>{selected.sourceSheet} {selected.sourceRow}행</dd></div></dl>
                  <div className="detail-actions"><button className="button primary full" onClick={() => setEditing(selected)}><Pencil size={16} />시설 정보 수정</button><select value={selected.status} onChange={(event) => changeStatus(selected, event.target.value as Facility['status'])} aria-label="운영 상태 변경"><option>운영중</option><option>점검필요</option><option>비활성</option></select></div>
                </> : <div className="detail-empty"><MapPin size={28} /><h2>시설을 선택해 주세요</h2><p>마커를 선택하면 전체 정보를 확인할 수 있습니다.</p></div>}
              </aside>
            </section>
          )}

          {view === 'nearby' && (
            <section className="map-layout nearby-layout" aria-label="주변 시설물 검색">
              <aside className="filter-panel nearby-search-panel">
                <div className="filter-title"><LocateFixed size={18} /><h2>주소 기준 검색</h2></div>
                <p className="nearby-help">주소를 검색하면 해당 위치와 반경 안의 시설물을 거리순으로 확인할 수 있습니다.</p>
                <form className="nearby-search-form" onSubmit={searchNearby}>
                  <label className="search-field"><Search size={17} /><input value={nearbyAddress} onChange={(event) => setNearbyAddress(event.target.value)} placeholder="도로명 또는 지번 주소" /></label>
                  <button className="button primary full" type="submit"><Search size={16} />주소 검색</button>
                </form>
                <label className="field"><span>검색 반경</span><select value={nearbyRadiusKm} onChange={(event) => setNearbyRadiusKm(Number(event.target.value))}><option value={0.5}>500m</option><option value={1}>1km</option><option value={2}>2km</option><option value={5}>5km</option></select></label>
                <button className="button secondary full" onClick={resetNearby}><RefreshCcw size={16} />검색 초기화</button>
                {nearbyError && <div className="nearby-error" role="alert">{nearbyError}</div>}
                <div className="filter-summary"><strong>{nearbyLocation ? nearbyResults.length.toLocaleString('ko-KR') : facilities.length.toLocaleString('ko-KR')}</strong><span>{nearbyLocation ? `개 시설 · ${nearbyRadiusKm}km 이내` : '개 전체 시설 표시 중'}</span></div>
              </aside>

              <KakaoMap
                facilities={facilities}
                selected={selected}
                onSelect={setSelected}
                allTypes={types}
                searchRequest={nearbyRequest}
                searchRadiusKm={nearbyRadiusKm}
                highlightedFacilityIds={nearbyLocation ? nearbyIds : undefined}
                onAddressResolved={handleAddressResolved}
                disasterPoints={nearbyDisasterPoints}
                disasterAreas={(nearbyDisasterOverview ?? disasterOverview).areas}
                populationDistribution={populationDistribution}
                layers={disasterLayers}
              />

              <aside className="detail-panel nearby-results-panel">
                <header><div><span className="eyebrow">거리순 결과</span><h2>{nearbyLocation ? `${nearbyResults.length.toLocaleString('ko-KR')}개 시설` : '주변 시설물'}</h2><p>{nearbyLocation?.address ?? '주소를 검색하면 결과가 표시됩니다.'}</p></div></header>
                {!nearbyLocation ? <div className="detail-empty nearby-empty"><LocateFixed size={28} /><h2>검색 위치를 지정해 주세요</h2><p>지도에는 전체 시설물이 먼저 표시됩니다.</p></div> : nearbyResults.length ? (
                  <div className="nearby-result-list">
                    {nearbyResults.map(({ facility, distance }) => <button key={facility.id} className={selected?.id === facility.id ? 'is-selected' : ''} onClick={() => setSelected(facility)}><span className="nearby-result-top"><strong>{facility.name}</strong><b>{distance < 1 ? `${Math.round(distance * 1000)}m` : `${distance.toFixed(2)}km`}</b></span><span>{facility.type} · {facility.status}</span><small>{facility.address}</small></button>)}
                  </div>
                ) : <div className="detail-empty nearby-empty"><Search size={28} /><h2>반경 안에 시설이 없습니다</h2><p>검색 반경을 넓혀 다시 확인해 주세요.</p></div>}
              </aside>
            </section>
          )}

          {view === 'facilities' && (
            <section className="view-stack" aria-label="시설물 관리">
              <div className="local-notice"><Database size={18} /><div><strong>Supabase 중앙 저장</strong><span>등록·수정·운영 상태 변경 내용이 관리자 전용 데이터베이스에 즉시 반영됩니다.</span></div></div>
              <article className="panel facility-panel">
                <div className="facility-toolbar">
                  <div className="facility-search-controls">
                    <label className="search-field table-search"><Search size={17} /><input value={facilityQuery} onChange={(event) => setFacilityQuery(event.target.value)} placeholder="시설명·주소 검색" aria-label="시설명 또는 주소 검색" /></label>
                    <label className="field table-type-filter"><span>시설 유형</span><select value={facilityType} onChange={(event) => setFacilityType(event.target.value)}><option value="">전체 유형</option><option value={CCTV_ALL_TYPE}>{CCTV_ALL_TYPE}</option>{types.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                  </div>
                  <div className="toolbar-actions">
                    <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(event) => event.target.files?.[0] && importWorkbook(event.target.files[0])} />
                    <button className="button secondary" onClick={() => fileInputRef.current?.click()}><Upload size={16} />엑셀·CSV 등록</button>
                    <button className="button secondary" onClick={exportJson}><FileDown size={16} />JSON</button>
                    <button className="button primary" onClick={() => setEditing(null)}><Plus size={17} />시설 등록</button>
                  </div>
                </div>
                <div className="table-meta"><span>검색 결과 {managedFacilities.length.toLocaleString('ko-KR')}개 / 전체 {facilities.length.toLocaleString('ko-KR')}개</span><button className="text-button" onClick={() => void reloadData()}><RefreshCcw size={14} />DB 새로고침</button></div>
                <div className="table-wrap"><table><thead><tr><th>시설명</th><th>시설 유형</th><th>행정구역</th><th>관리부서</th><th>운영 상태</th><th>좌표</th><th>관리</th></tr></thead><tbody>{pageRows.map((facility) => <tr key={facility.id}><td><button className="facility-name" onClick={() => { goToMap(); setSelected(facility) }}><strong>{facility.name}</strong><span>{facility.address}</span></button></td><td>{facility.type}</td><td>{facility.district}</td><td>{facility.agency}</td><td><span className={`status-badge ${facility.status}`}>{facility.status}</span></td><td>{facility.longitude != null && facility.latitude != null ? '등록 완료' : '좌표 없음'}</td><td><button className="icon-button" onClick={() => setEditing(facility)} aria-label={`${facility.name} 수정`}><Pencil size={16} /></button></td></tr>)}</tbody></table></div>
                {!pageRows.length && <div className="empty-state"><Search size={28} /><h3>검색 결과가 없습니다.</h3><p>검색어 또는 필터를 변경해 주세요.</p></div>}
                <div className="pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>이전</button><span>{page} / {pageCount}</span><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>다음</button></div>
              </article>
            </section>
          )}
        </div>
      </main>

      {sidebarOpen && <button className="mobile-overlay" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기" />}
      {editing !== undefined && <FacilityModal facility={editing} types={types} onClose={() => setEditing(undefined)} onSave={saveFacility} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}</div>}
    </div>
  )
}
