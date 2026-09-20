import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Crosshair, KeyRound, LocateFixed, Minus, Plus, Printer, Ruler } from 'lucide-react'
import type { DisasterArea, DisasterLayerVisibility, DisasterMapPoint, Facility } from './types'
import { fetchFloodOverlay } from './lib/disasterRepository'
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
  layers?: DisasterLayerVisibility
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
  waterLevel: true,
  floodTrace: true,
  pumpStations: true,
  population: false,
}

function pointColor(kind: DisasterMapPoint['kind']) {
  if (kind === 'rainfall') return '#256fd2'
  if (kind === 'waterLevel') return '#0f8f9d'
  if (kind === 'pumpStation') return '#d97706'
  return '#7b61d1'
}

export default function KakaoMap({ facilities, selected, onSelect, allTypes, compact = false, searchRequest, searchRadiusKm = 1, highlightedFacilityIds, onAddressResolved, disasterPoints = [], disasterAreas = [], layers = defaultLayers }: KakaoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const clusterRef = useRef<any>(null)
  const markersRef = useRef<any[]>([])
  const disasterMarkersRef = useRef<any[]>([])
  const disasterAreasRef = useRef<any[]>([])
  const boundaryRef = useRef<any[]>([])
  const searchMarkerRef = useRef<any>(null)
  const searchCircleRef = useRef<any>(null)
  const [mapReady, setMapReady] = useState(false)
  const [boundaryFeatures, setBoundaryFeatures] = useState<BoundaryFeature[]>([])
  const [mapError, setMapError] = useState('')
  const [measureMode, setMeasureMode] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<Facility[]>([])
  const [radiusKm, setRadiusKm] = useState(2)
  const [radiusCenter, setRadiusCenter] = useState<Facility | null>(null)
  const [searchPoint, setSearchPoint] = useState<SearchLocation | null>(null)
  const [floodOverlayImage, setFloodOverlayImage] = useState('')

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/goyang-boundary.json`)
      .then((response) => response.json())
      .then((data: { features: BoundaryFeature[] }) => setBoundaryFeatures(data.features))
      .catch(() => setBoundaryFeatures([]))
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
        || (point.kind === 'waterLevel' && layers.waterLevel)
        || (point.kind === 'pumpStation' && layers.pumpStations)
        || (point.kind === 'population' && layers.population)
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
  }, [disasterPoints, layers.rainfall, layers.waterLevel, layers.pumpStations, layers.population, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map) return

    disasterAreasRef.current.forEach((polygon) => polygon.setMap(null))
    disasterAreasRef.current = disasterAreas
      .filter((area) => (area.kind === 'floodTrace' ? layers.floodTrace : layers.population))
      .map((area) => new kakao.maps.Polygon({
        map,
        path: area.coordinates.map((ring) => ring.map(([longitude, latitude]) => new kakao.maps.LatLng(latitude, longitude))),
        strokeWeight: 2,
        strokeColor: area.kind === 'floodTrace' ? '#d33f49' : '#7b61d1',
        strokeOpacity: .82,
        fillColor: area.kind === 'floodTrace' ? '#ef6a71' : '#8b72df',
        fillOpacity: area.kind === 'floodTrace' ? .24 : .16,
      }))

    return () => {
      disasterAreasRef.current.forEach((polygon) => polygon.setMap(null))
      disasterAreasRef.current = []
    }
  }, [disasterAreas, layers.floodTrace, layers.population, mapReady])

  useEffect(() => {
    const kakao = window.kakao
    const map = mapRef.current
    if (!mapReady || !kakao?.maps || !map || !layers.floodTrace) {
      setFloodOverlayImage('')
      return
    }
    let cancelled = false
    let requestId = 0
    const clear = () => setFloodOverlayImage('')
    const refresh = async () => {
      const currentId = ++requestId
      const bounds = map.getBounds()
      const southWest = bounds.getSouthWest()
      const northEast = bounds.getNorthEast()
      const element = containerRef.current
      if (!element) return
      clear()
      const image = await fetchFloodOverlay({
        bbox: [southWest.getLng(), southWest.getLat(), northEast.getLng(), northEast.getLat()],
        width: element.clientWidth,
        height: element.clientHeight,
      })
      if (!cancelled && currentId === requestId && image) setFloodOverlayImage(image)
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
      setFloodOverlayImage('')
    }
  }, [layers.floodTrace, mapReady])

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
            || (point.kind === 'waterLevel' && layers.waterLevel)
            || (point.kind === 'pumpStation' && layers.pumpStations)
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
      {floodOverlayImage && <img className="flood-wms-overlay" src={floodOverlayImage} alt="" aria-hidden="true" />}

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
