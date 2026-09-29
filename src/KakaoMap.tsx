import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Crosshair, KeyRound, LocateFixed, Minus, Plus, Printer, Ruler } from 'lucide-react'
import type { DisasterArea, DisasterLayerVisibility, DisasterMapPoint, Facility, FloodResultMapArea, PopulationDistribution } from './types'
import { fetchHazardOverlay, type HazardOverlayLayer } from './lib/disasterRepository'
import { colorForType, haversineKm } from './utils'

interface KakaoMapProps {
  facilities: Facility[]
  selected: Facility | null
  onSelect: (facility: Facility) => void
  allTypes: string[]
  compact?: boolean
  searchRequest?: { address: string; id: number } | null
  searchRadiusKm?: number
  highlightedFacilityIds?: Set<string>
  onAddressResolved?: (location: SearchLocation | null, error?: string) => void
  disasterPoints?: DisasterMapPoint[]
  disasterAreas?: DisasterArea[]
  populationDistribution?: PopulationDistribution | null
  riskDongAreas?: FloodResultMapArea[]
  layers?: DisasterLayerVisibility
  enableFloodWms?: boolean
}

interface SearchLocation {
  address: string
  latitude: number
  longitude: number
}

interface BoundaryFeature {
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: number[][][] | number[][][][]
  }
}

interface BoundaryImageClip {
  width: number
  height: number
  paths: string[]
}

interface StaticFloodFeature {
  properties: {
    districtCode: string
    districtName: string
    frequencyYears: number
    segmentCode: string
    depthOrder: number
    depthLabel: string
    color: string
  }
  geometry: {
    type: 'Polygon' | 'MultiPolygon'
    coordinates: number[][][] | number[][][][]
  }
}

interface StaticFloodSvg {
  width: number
  height: number
  shapes: Array<{ key: string; path: string; color: string }>
}

interface StaticFloodRasterMetadata {
  image: string
  bounds: { west: number; south: number; east: number; north: number }
}

interface StaticFloodRasterPlacement {
  canvasWidth: number
  canvasHeight: number
  x: number
  y: number
  width: number
  height: number
  imageUrl: string
}

const KAKAO_KEY = import.meta.env.VITE_KAKAO_MAP_APP_KEY as string | undefined

function loadKakao(key: string) {
  return new Promise<void>((resolve, reject) => {
    if (window.kakao?.maps) {
      window.kakao.maps.load(resolve)
      return
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-kakao-map]')
    if (existing) {
      existing.addEventListener('load', () => window.kakao.maps.load(resolve), { once: true })
      existing.addEventListener('error', () => reject(new Error('카카오 지도 스크립트를 불러오지 못했습니다.')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.dataset.kakaoMap = 'true'
    script.async = true
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false&libraries=clusterer,services,drawing`
    script.onload = () => window.kakao.maps.load(resolve)
    script.onerror = () => reject(new Error('카카오 지도 스크립트를 불러오지 못했습니다.'))
    document.head.appendChild(script)
  })
}

function markerSvg(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42"><path fill="${color}" stroke="white" stroke-width="2" d="M17 1C8.2 1 1 8.2 1 17c0 11.9 16 24 16 24s16-12.1 16-24C33 8.2 25.8 1 17 1Z"/><circle cx="17" cy="17" r="6" fill="white"/></svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

const defaultLayers: DisasterLayerVisibility = {
  facilities: true,
  rainfall: true,
  snowfall: true,
  waterLevel: true,
  floodTrace: true,
  nationalRiverFlood: false,
  localRiverFlood: false,
  urbanFlood: false,
  population: false,
}

const hazardLayerMeta: Record<HazardOverlayLayer, { title: string; category: string; description: string; source: string; dataDate: string }> = {
  flood_trace: {
    title: '침수흔적도',
    category: '실제 침수 이력',
    description: '재해 발생 후 조사·측량한 과거 침수 구역입니다.',
    source: '생활안전지도',
    dataDate: '제공기관 최신 WMS · 원자료 기준일 미표기',
  },
  national_river_flood: {
    title: '국가하천 범람',
    category: '예상 위험 범위',
    description: '국가하천의 제방 월류·붕괴 등을 가정한 예상 범람도입니다.',
    source: '홍수위험지도 정보제공포털 SHP · 100년 빈도',
    dataDate: '원자료 기준일 미표기 · 적용일 2026.09.28',
  },
  local_river_flood: {
    title: '지방하천 범람',
    category: '예상 위험 범위',
    description: '지방하천의 제방 월류·붕괴 등을 가정한 예상 범람도입니다.',
    source: '홍수위험지도 정보제공포털 SHP · 100년 빈도',
    dataDate: '원자료 기준일 미표기 · 적용일 2026.09.28',
  },
  urban_flood: {
    title: '도시침수',
    category: '예상 위험 범위',
    description: '배수시설 용량 초과·고장 등을 가정한 내수침수 예상도입니다.',
    source: '홍수위험지도 정보제공포털 SHP · 100년 빈도',
    dataDate: '원자료 기준일 미표기 · 적용일 2026.09.28',
  },
}

const floodDepthLegend = [
  { label: '0.5m 이하', color: '#FDFBC7' },
  { label: '0.5~1.0m', color: '#E6FF99' },
  { label: '1.0~2.0m', color: '#38FEFD' },
  { label: '2.0~5.0m', color: '#CE9AFE' },
  { label: '5.0m 이상', color: '#CE3F87' },
]

const populationColors = ['#fff4cc', '#cfe8b4', '#82c9b8', '#4292c6', '#6a51a3']
const emptyRiskDongAreas: FloodResultMapArea[] = []
const riskAreaLegend = [
  { label: '중첩 없음', color: '#e8eef4' },
  { label: '0~5%', color: '#ffe3a3' },
  { label: '5~15%', color: '#ffc078' },
  { label: '15~30%', color: '#f18466' },
  { label: '30% 초과', color: '#d84b52' },
]

function riskAreaColor(percent: number) {
  if (percent <= 0) return riskAreaLegend[0].color
  if (percent <= 5) return riskAreaLegend[1].color
  if (percent <= 15) return riskAreaLegend[2].color
  if (percent <= 30) return riskAreaLegend[3].color
  return riskAreaLegend[4].color
}

function populationColor(value: number, breaks: number[]) {
  const index = breaks.findIndex((threshold) => value <= threshold)
  return populationColors[index < 0 ? populationColors.length - 1 : index]
}

function shortAdministrativeName(value: string) {
  const parts = value.trim().split(/\s+/)
  return parts[parts.length - 1] || value
}

function pointColor(kind: DisasterMapPoint['kind']) {
  if (kind === 'rainfall') return '#256fd2'
  if (kind === 'snowfall') return '#38a3c7'
  if (kind === 'waterLevel') return '#0f8f9d'
  return '#7b61d1'
}

export default function KakaoMap({ facilities, selected, onSelect, allTypes, compact = false, searchRequest, searchRadiusKm = 1, highlightedFacilityIds, onAddressResolved, disasterPoints = [], disasterAreas = [], populationDistribution = null, riskDongAreas = emptyRiskDongAreas, layers = defaultLayers, enableFloodWms = true }: KakaoMapProps) {
  const boundaryClipId = `goyang-boundary-${useId().replace(/:/g, '')}`
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const clusterRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const disasterMarkersRef = useRef<any[]>([])
  const disasterAreasRef = useRef<any[]>([])
  const populationAreasRef = useRef<any[]>([])
  const populationInfoWindowRef = useRef<any>(null)
  const riskDongAreasRef = useRef<any[]>([])
  const riskDongInfoWindowRef = useRef<any>(null)
  const boundaryRef = useRef<any[]>([])
  const searchMarkerRef = useRef<any>(null)
  const searchCircleRef = useRef<any>(null)
  const [mapReady, setMapReady] = useState(false)
  const [boundaryFeatures, setBoundaryFeatures] = useState<BoundaryFeature[]>([])
  const [nationalFloodFeatures, setNationalFloodFeatures] = useState<StaticFloodFeature[]>([])
  const [urbanFloodFeatures, setUrbanFloodFeatures] = useState<StaticFloodFeature[]>([])
  const [localRiverFloodRaster, setLocalRiverFloodRaster] = useState<StaticFloodRasterMetadata | null>(null)
  const [mapError, setMapError] = useState('')
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<Facility[]>([])
  const [radiusKm, setRadiusKm] = useState(2)
  const [radiusCenter, setRadiusCenter] = useState<Facility | null>(null)
  const [searchPoint, setSearchPoint] = useState<SearchLocation | null>(null)
  const [hazardOverlayImages, setHazardOverlayImages] = useState<Partial<Record<HazardOverlayLayer, string[]>>>({})
  const [boundaryImageClip, setBoundaryImageClip] = useState<BoundaryImageClip | null>(null)
  const [staticFloodSvg, setStaticFloodSvg] = useState<StaticFloodSvg | null>(null)
  const [staticFloodRaster, setStaticFloodRaster] = useState<StaticFloodRasterPlacement | null>(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/goyang-boundary.json`)
      .then((response) => response.json())
      .then((data: { features: BoundaryFeature[] }) => setBoundaryFeatures(data.features))
      .catch(() => setBoundaryFeatures([]))
  }, [])

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/goyang-national-river-flood-100.geojson`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((data: { features: StaticFloodFeature[] }) => setNationalFloodFeatures(data.features))
      .catch(() => setNationalFloodFeatures([]))
    fetch(`${import.meta.env.BASE_URL}data/goyang-urban-flood-100.geojson`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((data: { features: StaticFloodFeature[] }) => setUrbanFloodFeatures(data.features))
      .catch(() => setUrbanFloodFeatures([]))
    fetch(`${import.meta.env.BASE_URL}data/goyang-local-river-flood-100.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((data: StaticFloodRasterMetadata) => setLocalRiverFloodRaster(data))
      .catch(() => setLocalRiverFloodRaster(null))
  }, [])

  const facilitiesWithCoords = useMemo(
    () => facilities.filter((item) => item.latitude != null && item.longitude != null),
    [facilities],
  )
  const measuredDistance = measurePoints.length === 2 ? haversineKm(measurePoints[0], measurePoints[1]) : null
  const radiusFacilities = useMemo(() => {
    if (!radiusCenter) return facilitiesWithCoords
    return facilitiesWithCoords.filter((facility) => (haversineKm(radiusCenter, facility) ?? Infinity) <= radiusKm)
  }, [facilitiesWithCoords, radiusCenter, radiusKm])
  const activeHazardLayer: HazardOverlayLayer | null = layers.floodTrace
    ? 'flood_trace'
    : layers.nationalRiverFlood
      ? 'national_river_flood'
      : layers.localRiverFlood
        ? 'local_river_flood'
        : layers.urbanFlood
          ? 'urban_flood'
          : null
  const activeHazardMeta = activeHazardLayer ? hazardLayerMeta[activeHazardLayer] : null
  const populationBreaks = useMemo(() => {
    const values = (populationDistribution?.features ?? [])
      .map((feature) => Number(feature.properties.populationDensity))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    if (!values.length) return []
    return [0.2, 0.4, 0.6, 0.8].map((ratio) => values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)])
  }, [populationDistribution])

  const handleSelection = (facility: Facility) => {
    onSelect(facility)
    if (measureMode) {
      setMeasurePoints((current) => current.length >= 2 ? [facility] : [...current, facility])
    }
  }

  useEffect(() => {
    if (!KAKAO_KEY || !containerRef.current) return
    let cancelled = false
    loadKakao(KAKAO_KEY)
      .then(() => {
        if (cancelled || !containerRef.current) return
        const kakao = window.kakao
        const map = new kakao.maps.Map(containerRef.current, {
          center: new kakao.maps.LatLng(37.6584, 126.8320),
          level: 8,
        })
        mapRef.current = map
        clusterRef.current = new kakao.maps.MarkerClusterer({ map, averageCenter: true, minLevel: 6 })
        setMapReady(true)
      })
      .catch((error) => setMapError(error instanceof Error ? error.message : '지도를 불러오지 못했습니다.'))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map || !boundaryFeatures.length) return

    boundaryRef.current.forEach((polygon) => polygon.setMap(null))
    const bounds = new kakao.maps.LatLngBounds()
    boundaryRef.current = boundaryFeatures.flatMap((feature) => {
      const polygons = feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates as number[][][][]
        : [feature.geometry.coordinates as number[][][]]

      return polygons.map((rings) => {
        const path = rings.map((ring) => ring.map(([longitude, latitude]) => {
          const point = new kakao.maps.LatLng(latitude, longitude)
          bounds.extend(point)
          return point
        }))
        return new kakao.maps.Polygon({
          map,
          path,
          strokeWeight: 3,
          strokeColor: '#1565c0',
          strokeOpacity: 0.9,
          fillColor: '#42a5f5',
          fillOpacity: 0.08,
        })
      })
    })
    if (!searchPoint) map.setBounds(bounds, 36, 36, 36, 36)

    return () => {
      boundaryRef.current.forEach((polygon) => polygon.setMap(null))
      boundaryRef.current = []
    }
  }, [boundaryFeatures, mapReady, searchPoint])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map) return
    if (!searchRequest) {
      setSearchPoint(null)
      onAddressResolved?.(null)
      return
    }
    if (!kakao.maps.services?.Geocoder) {
      onAddressResolved?.(null, '카카오 주소 검색 서비스를 사용할 수 없습니다.')
      return
    }
    let cancelled = false
    const geocoder = new kakao.maps.services.Geocoder()
    geocoder.addressSearch(searchRequest.address, (results: Array<{ address_name: string; x: string; y: string }>, status: string) => {
      if (cancelled) return
      if (status === kakao.maps.services.Status.OK && results[0]) {
        const point = { address: results[0].address_name || searchRequest.address, longitude: Number(results[0].x), latitude: Number(results[0].y) }
        setSearchPoint(point)
        onAddressResolved?.(point)
      } else {
        setSearchPoint(null)
        onAddressResolved?.(null, '주소를 찾을 수 없습니다. 도로명이나 지번 주소를 확인해 주세요.')
      }
    })
    return () => { cancelled = true }
  }, [searchRequest, mapReady, onAddressResolved])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map) return
    searchMarkerRef.current?.setMap(null)
    searchCircleRef.current?.setMap(null)
    searchMarkerRef.current = null
    searchCircleRef.current = null
    if (!searchPoint) return
    const center = new kakao.maps.LatLng(searchPoint.latitude, searchPoint.longitude)
    const image = new kakao.maps.MarkerImage(markerSvg('#e53935'), new kakao.maps.Size(34, 42), { offset: new kakao.maps.Point(17, 41) })
    searchMarkerRef.current = new kakao.maps.Marker({ map, position: center, title: '검색 위치', image, zIndex: 10 })
    searchCircleRef.current = new kakao.maps.Circle({ map, center, radius: searchRadiusKm * 1000, strokeWeight: 2, strokeColor: '#e53935', strokeOpacity: 0.9, strokeStyle: 'dash', fillColor: '#e53935', fillOpacity: 0.08 })
    map.setCenter(center)
    map.setLevel(searchRadiusKm <= 0.5 ? 4 : searchRadiusKm <= 1 ? 5 : searchRadiusKm <= 2 ? 6 : 7)
    return () => {
      searchMarkerRef.current?.setMap(null)
      searchCircleRef.current?.setMap(null)
    }
  }, [searchPoint, searchRadiusKm, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    const clusterer = clusterRef.current
    if (!mapReady || !kakao?.maps || !map || !clusterer) return

    clusterer.clear()
    markersRef.current.forEach((marker) => marker.setMap(null))
    markersRef.current = layers.facilities ? radiusFacilities.map((facility) => {
      const color = colorForType(facility.type, allTypes)
      const image = new kakao.maps.MarkerImage(markerSvg(color), new kakao.maps.Size(34, 42), { offset: new kakao.maps.Point(17, 41) })
      const marker = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(facility.latitude, facility.longitude),
        title: facility.name,
        image,
        opacity: highlightedFacilityIds ? (highlightedFacilityIds.has(facility.id) ? 1 : 0.24) : 1,
      })
      kakao.maps.event.addListener(marker, 'click', () => handleSelection(facility))
      return marker
    }) : []
    clusterer.addMarkers(markersRef.current)
  }, [radiusFacilities, allTypes, measureMode, mapReady, highlightedFacilityIds, layers.facilities])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map) return

    disasterMarkersRef.current.forEach((marker) => marker.setMap(null))
    disasterMarkersRef.current = disasterPoints
      .filter((point) => (
        (point.kind === 'rainfall' && layers.rainfall)
        || (point.kind === 'snowfall' && layers.snowfall)
        || (point.kind === 'waterLevel' && layers.waterLevel)
      ))
      .map((point) => {
        const value = point.value == null ? '' : ` · ${point.value}${point.unit ?? ''}`
        const image = new kakao.maps.MarkerImage(markerSvg(pointColor(point.kind)), new kakao.maps.Size(34, 42), { offset: new kakao.maps.Point(17, 41) })
        return new kakao.maps.Marker({
          map,
          position: new kakao.maps.LatLng(point.latitude, point.longitude),
          title: `${point.name}${value}`,
          image,
          zIndex: 7,
        })
      })

    return () => {
      disasterMarkersRef.current.forEach((marker) => marker.setMap(null))
      disasterMarkersRef.current = []
    }
  }, [disasterPoints, layers.rainfall, layers.snowfall, layers.waterLevel, layers.population, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    populationAreasRef.current.forEach((polygon) => polygon.setMap(null))
    populationAreasRef.current = []
    populationInfoWindowRef.current?.close()
    populationInfoWindowRef.current = null
    if (!mapReady || !kakao?.maps || !map || !layers.population || !populationDistribution?.features.length || !populationBreaks.length) return

    populationAreasRef.current = populationDistribution.features.flatMap((feature) => {
      const polygons = feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates as number[][][][]
        : [feature.geometry.coordinates as number[][][]]
      return polygons.map((rings) => {
        const density = Number(feature.properties.populationDensity)
        const polygon = new kakao.maps.Polygon({
          map,
          path: rings.map((ring) => ring.map(([longitude, latitude]) => new kakao.maps.LatLng(latitude, longitude))),
          strokeWeight: 1.3,
          strokeColor: '#344b62',
          strokeOpacity: .72,
          fillColor: populationColor(density, populationBreaks),
          fillOpacity: .58,
        })
        kakao.maps.event.addListener(polygon, 'mouseover', () => polygon.setOptions({ fillOpacity: .78, strokeWeight: 2 }))
        kakao.maps.event.addListener(polygon, 'mouseout', () => polygon.setOptions({ fillOpacity: .58, strokeWeight: 1.3 }))
        kakao.maps.event.addListener(polygon, 'click', (event: any) => {
          populationInfoWindowRef.current?.close()
          const content = document.createElement('div')
          content.className = 'population-info-window'
          const title = document.createElement('strong')
          title.textContent = shortAdministrativeName(feature.properties.adminName)
          const district = document.createElement('span')
          district.textContent = feature.properties.districtName
          const metrics = document.createElement('dl')
          ;[
            ['총인구', `${feature.properties.population.toLocaleString('ko-KR')}명`],
            ['인구밀도', `${Math.round(density).toLocaleString('ko-KR')}명/㎢`],
            ['세대수', `${feature.properties.households.toLocaleString('ko-KR')}세대`],
          ].forEach(([label, value]) => {
            const row = document.createElement('div')
            const term = document.createElement('dt')
            const detail = document.createElement('dd')
            term.textContent = label
            detail.textContent = value
            row.append(term, detail)
            metrics.append(row)
          })
          content.append(title, district, metrics)
          const infoWindow = new kakao.maps.InfoWindow({ content, removable: true, position: event.latLng })
          infoWindow.open(map)
          populationInfoWindowRef.current = infoWindow
        })
        return polygon
      })
    })

    return () => {
      populationAreasRef.current.forEach((polygon) => polygon.setMap(null))
      populationAreasRef.current = []
      populationInfoWindowRef.current?.close()
      populationInfoWindowRef.current = null
    }
  }, [layers.population, populationDistribution, populationBreaks, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    riskDongAreasRef.current.forEach((polygon) => polygon.setMap(null))
    riskDongAreasRef.current = []
    riskDongInfoWindowRef.current?.close()
    riskDongInfoWindowRef.current = null
    if (!mapReady || !kakao?.maps || !map || !riskDongAreas.length) return

    riskDongAreasRef.current = riskDongAreas.flatMap((area) => {
      const polygons = area.geometry.type === 'MultiPolygon'
        ? area.geometry.coordinates as number[][][][]
        : [area.geometry.coordinates as number[][][]]
      return polygons.map((rings) => {
        const polygon = new kakao.maps.Polygon({
          map,
          path: rings.map((ring) => ring.map(([longitude, latitude]) => new kakao.maps.LatLng(latitude, longitude))),
          strokeWeight: 1.3,
          strokeColor: '#52677c',
          strokeOpacity: .78,
          fillColor: riskAreaColor(area.hazardAreaPercent),
          fillOpacity: .57,
        })
        kakao.maps.event.addListener(polygon, 'mouseover', () => polygon.setOptions({ fillOpacity: .78, strokeWeight: 2 }))
        kakao.maps.event.addListener(polygon, 'mouseout', () => polygon.setOptions({ fillOpacity: .57, strokeWeight: 1.3 }))
        kakao.maps.event.addListener(polygon, 'click', (event: any) => {
          riskDongInfoWindowRef.current?.close()
          const content = document.createElement('div')
          content.className = 'population-info-window'
          const title = document.createElement('strong')
          title.textContent = shortAdministrativeName(area.adminName)
          const district = document.createElement('span')
          district.textContent = area.districtName
          const metrics = document.createElement('dl')
          ;[
            ['중첩 면적', `${area.hazardAreaSquareKm.toLocaleString('ko-KR')}㎢`],
            ['행정동 면적 비율', `${area.hazardAreaPercent.toLocaleString('ko-KR')}%`],
            ['추정 노출인구', `${area.estimatedExposedPopulation.toLocaleString('ko-KR')}명`],
          ].forEach(([label, value]) => {
            const row = document.createElement('div')
            const term = document.createElement('dt')
            const detail = document.createElement('dd')
            term.textContent = label
            detail.textContent = value
            row.append(term, detail)
            metrics.append(row)
          })
          content.append(title, district, metrics)
          const infoWindow = new kakao.maps.InfoWindow({ content, removable: true, position: event.latLng })
          infoWindow.open(map)
          riskDongInfoWindowRef.current = infoWindow
        })
        return polygon
      })
    })

    return () => {
      riskDongAreasRef.current.forEach((polygon) => polygon.setMap(null))
      riskDongAreasRef.current = []
      riskDongInfoWindowRef.current?.close()
      riskDongInfoWindowRef.current = null
    }
  }, [riskDongAreas, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map) return

    disasterAreasRef.current.forEach((polygon) => polygon.setMap(null))
    disasterAreasRef.current = disasterAreas
      .filter((area) => (
        (area.kind === 'floodTrace' && layers.floodTrace)
        || (area.kind === 'riverFlood' && (layers.nationalRiverFlood || layers.localRiverFlood))
        || (area.kind === 'urbanFlood' && layers.urbanFlood)
        || (area.kind === 'population' && layers.population)
      ))
      .map((area) => new kakao.maps.Polygon({
        map,
        path: area.coordinates.map((ring) => ring.map(([longitude, latitude]) => new kakao.maps.LatLng(latitude, longitude))),
        strokeWeight: 2,
        strokeColor: area.kind === 'floodTrace' ? '#d33f49' : area.kind === 'riverFlood' ? '#1565c0' : area.kind === 'urbanFlood' ? '#e38b2c' : '#7b61d1',
        strokeOpacity: .82,
        fillColor: area.kind === 'floodTrace' ? '#ef6a71' : area.kind === 'riverFlood' ? '#3f8fe8' : area.kind === 'urbanFlood' ? '#f1a84c' : '#8b72df',
        fillOpacity: area.kind === 'population' ? .16 : .24,
      }))

    return () => {
      disasterAreasRef.current.forEach((polygon) => polygon.setMap(null))
      disasterAreasRef.current = []
    }
  }, [disasterAreas, layers.floodTrace, layers.nationalRiverFlood, layers.localRiverFlood, layers.urbanFlood, layers.population, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    const features = layers.nationalRiverFlood
      ? nationalFloodFeatures
      : layers.urbanFlood
        ? urbanFloodFeatures
        : []
    if (!mapReady || !kakao?.maps || !map || !features.length) {
      setStaticFloodSvg(null)
      return
    }
    const clear = () => setStaticFloodSvg(null)
    const refresh = () => {
      const element = containerRef.current
      if (!element) return
      const projection = map.getProjection()
      const shapes = features.map((feature) => {
        const polygons = feature.geometry.type === 'MultiPolygon'
          ? feature.geometry.coordinates as number[][][][]
          : [feature.geometry.coordinates as number[][][]]
        const path = polygons.map((rings) => rings.map((ring) => ring.map(([longitude, latitude], index) => {
          const point = projection.containerPointFromCoords(new kakao.maps.LatLng(latitude, longitude))
          return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
        }).join(' ') + ' Z').join(' ')).join(' ')
        return {
          key: `${feature.properties.districtCode}-${feature.properties.segmentCode}`,
          path,
          color: feature.properties.color,
        }
      })
      setStaticFloodSvg({ width: element.clientWidth, height: element.clientHeight, shapes })
    }
    kakao.maps.event.addListener(map, 'idle', refresh)
    kakao.maps.event.addListener(map, 'dragstart', clear)
    kakao.maps.event.addListener(map, 'zoom_start', clear)
    refresh()
    return () => {
      kakao.maps.event.removeListener(map, 'idle', refresh)
      kakao.maps.event.removeListener(map, 'dragstart', clear)
      kakao.maps.event.removeListener(map, 'zoom_start', clear)
      setStaticFloodSvg(null)
    }
  }, [layers.nationalRiverFlood, layers.urbanFlood, nationalFloodFeatures, urbanFloodFeatures, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map || !layers.localRiverFlood || !localRiverFloodRaster) {
      setStaticFloodRaster(null)
      return
    }
    const clear = () => setStaticFloodRaster(null)
    const refresh = () => {
      const element = containerRef.current
      if (!element) return
      const projection = map.getProjection()
      const { west, south, east, north } = localRiverFloodRaster.bounds
      const northWest = projection.containerPointFromCoords(new kakao.maps.LatLng(north, west))
      const southEast = projection.containerPointFromCoords(new kakao.maps.LatLng(south, east))
      setStaticFloodRaster({
        canvasWidth: element.clientWidth,
        canvasHeight: element.clientHeight,
        x: northWest.x,
        y: northWest.y,
        width: southEast.x - northWest.x,
        height: southEast.y - northWest.y,
        imageUrl: `${import.meta.env.BASE_URL}data/${localRiverFloodRaster.image}`,
      })
    }
    kakao.maps.event.addListener(map, 'idle', refresh)
    kakao.maps.event.addListener(map, 'dragstart', clear)
    kakao.maps.event.addListener(map, 'zoom_start', clear)
    refresh()
    return () => {
      kakao.maps.event.removeListener(map, 'idle', refresh)
      kakao.maps.event.removeListener(map, 'dragstart', clear)
      kakao.maps.event.removeListener(map, 'zoom_start', clear)
      setStaticFloodRaster(null)
    }
  }, [layers.localRiverFlood, localRiverFloodRaster, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map || !enableFloodWms) {
      setHazardOverlayImages({})
      setBoundaryImageClip(null)
      return
    }
    const enabledLayers: HazardOverlayLayer[] = [
      ...(layers.floodTrace ? ['flood_trace' as const] : []),
    ]
    if (!enabledLayers.length) {
      setHazardOverlayImages({})
      return
    }
    let cancelled = false
    let requestId = 0
    const clear = () => setHazardOverlayImages({})
    const refresh = async () => {
      const currentId = ++requestId
      const bounds = map.getBounds()
      const southWest = bounds.getSouthWest()
      const northEast = bounds.getNorthEast()
      const element = containerRef.current
      if (!element) return
      clear()
      const projection = map.getProjection()
      const clipPaths = boundaryFeatures.flatMap((feature) => {
        const polygons = feature.geometry.type === 'MultiPolygon'
          ? feature.geometry.coordinates as number[][][][]
          : [feature.geometry.coordinates as number[][][]]
        return polygons.map((rings) => rings.map((ring) => ring.map(([longitude, latitude], index) => {
          const point = projection.containerPointFromCoords(new kakao.maps.LatLng(latitude, longitude))
          return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`
        }).join(' ') + ' Z').join(' '))
      })
      setBoundaryImageClip(clipPaths.length ? { width: element.clientWidth, height: element.clientHeight, paths: clipPaths } : null)
      const bbox: [number, number, number, number] = [southWest.getLng(), southWest.getLat(), northEast.getLng(), northEast.getLat()]
      const results = await Promise.all(enabledLayers.map(async (layer) => [layer, await fetchHazardOverlay({
        layer,
        bbox,
        width: element.clientWidth,
        height: element.clientHeight,
        frequency: 100,
      })] as const))
      if (!cancelled && currentId === requestId) {
        setHazardOverlayImages(Object.fromEntries(results.filter(([, images]) => Boolean(images?.length))) as Partial<Record<HazardOverlayLayer, string[]>>)
      }
    }
    kakao.maps.event.addListener(map, 'idle', refresh)
    kakao.maps.event.addListener(map, 'dragstart', clear)
    kakao.maps.event.addListener(map, 'zoom_start', clear)
    void refresh()
    return () => {
      cancelled = true
      kakao.maps.event.removeListener(map, 'idle', refresh)
      kakao.maps.event.removeListener(map, 'dragstart', clear)
      kakao.maps.event.removeListener(map, 'zoom_start', clear)
      setHazardOverlayImages({})
      setBoundaryImageClip(null)
    }
  }, [layers.floodTrace, layers.urbanFlood, layers.nationalRiverFlood, layers.localRiverFlood, boundaryFeatures, mapReady, enableFloodWms])

  useEffect(() => {
    if (!selected || !mapRef.current || !window.kakao?.maps || selected.latitude == null || selected.longitude == null) return
    mapRef.current.panTo(new window.kakao.maps.LatLng(selected.latitude, selected.longitude))
  }, [selected])

  const zoom = (delta: number) => {
    if (mapRef.current) mapRef.current.setLevel(Math.max(1, mapRef.current.getLevel() + delta))
  }

  const positionPercent = (location: { longitude: number | null; latitude: number | null }) => {
    const lng = location.longitude ?? 126.832
    const lat = location.latitude ?? 37.658
    const left = Math.max(4, Math.min(96, ((lng - 126.68) / 0.32) * 100))
    const top = Math.max(5, Math.min(95, 100 - ((lat - 37.54) / 0.23) * 100))
    return { left: `${left}%`, top: `${top}%` }
  }

  return (
    <div className={`map-stage ${compact ? 'map-stage-compact' : ''}`}>
      {KAKAO_KEY && !mapError ? <div ref={containerRef} className="kakao-map" aria-label="카카오 지도" /> : (
        <div className="fallback-map" role="img" aria-label="시설물 위치 미리보기 지도">
          <div className="fallback-map-grid" />
          <div className="map-place-label place-one">덕양구</div>
          <div className="map-place-label place-two">일산동구</div>
          <div className="map-place-label place-three">일산서구</div>
          {layers.facilities && radiusFacilities.map((facility) => (
            <button
              className={`fallback-marker ${selected?.id === facility.id ? 'is-selected' : ''}`}
              key={facility.id}
              style={{ ...positionPercent(facility), '--marker-color': colorForType(facility.type, allTypes), opacity: highlightedFacilityIds ? (highlightedFacilityIds.has(facility.id) ? 1 : 0.2) : 1 } as CSSProperties}
              onClick={() => handleSelection(facility)}
              aria-label={`${facility.name}, ${facility.type}`}
              title={facility.name}
            />
          ))}
          {disasterPoints.filter((point) => (
            (point.kind === 'rainfall' && layers.rainfall)
            || (point.kind === 'snowfall' && layers.snowfall)
            || (point.kind === 'waterLevel' && layers.waterLevel)
            || (point.kind === 'population' && layers.population)
          )).map((point) => (
            <span
              className={`fallback-marker disaster-marker ${point.kind}`}
              key={`${point.kind}-${point.id}`}
              style={{ ...positionPercent(point), '--marker-color': pointColor(point.kind) } as CSSProperties}
              title={`${point.name}${point.value == null ? '' : ` · ${point.value}${point.unit ?? ''}`}`}
            />
          ))}
          <div className="map-key-message">
            <KeyRound size={17} aria-hidden="true" />
            <span>{mapError || '카카오 JavaScript 키를 설정하면 실제 지도가 표시됩니다.'}</span>
          </div>
        </div>
      )}
      {boundaryImageClip && Object.keys(hazardOverlayImages).length > 0 && (
        <svg
          className="flood-wms-overlay-frame"
          viewBox={`0 0 ${boundaryImageClip.width} ${boundaryImageClip.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <clipPath id={boundaryClipId} clipPathUnits="userSpaceOnUse">
              {boundaryImageClip.paths.map((path, index) => <path key={index} d={path} clipRule="evenodd" fillRule="evenodd" />)}
            </clipPath>
          </defs>
          {(['flood_trace', 'urban_flood', 'national_river_flood', 'local_river_flood'] as HazardOverlayLayer[]).flatMap((layer) => (hazardOverlayImages[layer] ?? []).map((image, index) => (
            <image
              key={`${layer}-${index}`}
              className={`flood-wms-overlay-layer ${layer}`}
              href={image}
              x="0"
              y="0"
              width={boundaryImageClip.width}
              height={boundaryImageClip.height}
              preserveAspectRatio="none"
              clipPath={`url(#${boundaryClipId})`}
            />
          )))}
        </svg>
      )}

      {staticFloodSvg && (
        <svg
          className="static-flood-overlay-frame"
          viewBox={`0 0 ${staticFloodSvg.width} ${staticFloodSvg.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {staticFloodSvg.shapes.map((shape) => (
            <path key={shape.key} d={shape.path} fill={shape.color} fillOpacity="0.68" fillRule="evenodd" stroke="#3c4c63" strokeOpacity="0.3" strokeWidth="0.6" />
          ))}
        </svg>
      )}

      {staticFloodRaster && (
        <svg
          className="static-flood-overlay-frame"
          viewBox={`0 0 ${staticFloodRaster.canvasWidth} ${staticFloodRaster.canvasHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <image
            href={staticFloodRaster.imageUrl}
            x={staticFloodRaster.x}
            y={staticFloodRaster.y}
            width={staticFloodRaster.width}
            height={staticFloodRaster.height}
            opacity="0.68"
            preserveAspectRatio="none"
          />
        </svg>
      )}

      {!compact && enableFloodWms && activeHazardLayer && activeHazardMeta && (
        <aside className="hazard-map-legend" aria-label={`${activeHazardMeta.title} 범례`}>
          <div className="hazard-legend-heading">
            <div><span>현재 지도 레이어</span><strong>{activeHazardMeta.title}</strong></div>
            <b className={activeHazardLayer === 'flood_trace' ? 'history' : 'forecast'}>{activeHazardMeta.category}</b>
          </div>
          <p>{activeHazardMeta.description}</p>
          {activeHazardLayer === 'flood_trace' ? (
            <div className="trace-legend-row"><i aria-hidden="true" /><span>과거 침수 조사 구역<br /><small>원본 지도 색상 기준</small></span></div>
          ) : (
            <div className="depth-legend">
              <span className="depth-legend-title">예상 침수심</span>
              {floodDepthLegend.map((item) => <span key={item.label}><i style={{ backgroundColor: item.color }} aria-hidden="true" />{item.label}</span>)}
            </div>
          )}
          <footer><span>출처: {activeHazardMeta.source}</span><span>데이터 날짜: {activeHazardMeta.dataDate}</span><span>표시 범위: 고양시 경계 내부</span></footer>
        </aside>
      )}

      {!compact && layers.population && populationDistribution?.features.length && populationBreaks.length > 0 && (
        <aside className={`hazard-map-legend population-map-legend ${activeHazardLayer ? 'with-hazard' : ''}`} aria-label="행정동별 인구밀도 범례">
          <div className="hazard-legend-heading">
            <div><span>행정동 단계구분도</span><strong>인구 분포</strong></div>
            <b className="forecast">{populationDistribution.statisticMonth.slice(0, 4)}.{populationDistribution.statisticMonth.slice(4, 6)}</b>
          </div>
          <p>행정동 면적 대비 주민등록 인구밀도입니다.</p>
          <div className="depth-legend population-depth-legend">
            {populationColors.map((color, index) => {
              const previous = index === 0 ? 0 : Math.round(populationBreaks[index - 1])
              const current = populationBreaks[index] == null ? null : Math.round(populationBreaks[index])
              const label = current == null
                ? `${previous.toLocaleString('ko-KR')}명/㎢ 초과`
                : `${previous ? `${previous.toLocaleString('ko-KR')} 초과~` : ''}${current.toLocaleString('ko-KR')}명/㎢`
              return <span key={color}><i style={{ backgroundColor: color }} aria-hidden="true" />{label}</span>
            })}
          </div>
          <footer><span>출처: 행정안전부 주민등록 인구</span><span>데이터 날짜: {populationDistribution.statisticMonth.slice(0, 4)}년 {populationDistribution.statisticMonth.slice(4, 6)}월 말 기준</span><span>총 {populationDistribution.totalPopulation.toLocaleString('ko-KR')}명</span></footer>
        </aside>
      )}

      {!compact && riskDongAreas.length > 0 && (
        <aside className="hazard-map-legend" aria-label="행정동별 위험면적 비율 범례">
          <div className="hazard-legend-heading"><div><span>행정동 단계구분도</span><strong>시나리오 중첩 면적 비율</strong></div><b className="forecast">100년 빈도</b></div>
          <p>행정동 전체 면적 중 선택한 예상 침수 구역과 겹치는 비율입니다.</p>
          <div className="depth-legend population-depth-legend">{riskAreaLegend.map((item) => <span key={item.label}><i style={{ backgroundColor: item.color }} aria-hidden="true" />{item.label}</span>)}</div>
          <footer><span>출처: 홍수위험지도 정보제공포털 SHP</span><span>인구 기준월: {riskDongAreas[0].statisticMonth.slice(0, 4)}.{riskDongAreas[0].statisticMonth.slice(4, 6)}</span></footer>
        </aside>
      )}

      {!compact && <div className="map-toolbar map-toolbar-right" aria-label="지도 도구">
        <button className="icon-button" onClick={() => zoom(-1)} aria-label="지도 확대"><Plus size={18} /></button>
        <button className="icon-button" onClick={() => zoom(1)} aria-label="지도 축소"><Minus size={18} /></button>
        <button className={`icon-button ${measureMode ? 'is-active' : ''}`} onClick={() => { setMeasureMode((value) => !value); setMeasurePoints([]) }} aria-label="거리 측정"><Ruler size={18} /></button>
        <button className={`icon-button ${radiusCenter ? 'is-active' : ''}`} onClick={() => setRadiusCenter(selected)} disabled={!selected} aria-label="선택 시설 기준 반경 검색"><Crosshair size={18} /></button>
        <button className="icon-button" onClick={() => window.print()} aria-label="지도 인쇄"><Printer size={18} /></button>
      </div>}

      {!compact && <div className="map-result-strip" aria-live="polite">
        <span><LocateFixed size={15} /> 표시 시설 <b>{layers.facilities ? radiusFacilities.length.toLocaleString('ko-KR') : '0'}</b>개</span>
        {measureMode && <span>거리측정: {measurePoints.length === 0 ? '첫 시설 선택' : measurePoints.length === 1 ? '두 번째 시설 선택' : `${measurePoints[0].name} ↔ ${measurePoints[1].name} ${measuredDistance?.toFixed(2)}km`}</span>}
        {radiusCenter && (
          <label className="radius-control">{radiusCenter.name} 기준
            <input type="range" min="0.5" max="10" step="0.5" value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))} />
            <b>{radiusKm}km</b>
            <button type="button" onClick={() => setRadiusCenter(null)}>해제</button>
          </label>
        )}
      </div>}
    </div>
  )
}
