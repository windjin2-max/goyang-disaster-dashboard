const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type SourceId = 'weather' | 'hydrology' | 'kwater' | 'flood' | 'pump' | 'population'
type SourceState = 'live' | 'configured' | 'error'

interface SourceStatus {
  id: SourceId
  label: string
  state: SourceState
  updatedAt?: string
  message?: string
}

interface MapPoint {
  id: string
  name: string
  kind: 'rainfall' | 'waterLevel' | 'pumpStation'
  latitude: number
  longitude: number
  value?: number | null
  unit?: string
  trend?: 'up' | 'down' | 'steady' | 'unknown'
  address?: string
  source: string
  observedAt?: string
}

const sourceLabels: Record<SourceId, string> = {
  weather: '기상청 강수·적설',
  hydrology: '한강홍수통제소 수문',
  kwater: 'K-water 우량·수위',
  flood: '생활안전지도 침수흔적',
  pump: '전국 배수펌프장',
  population: '행정안전부 주민등록 인구',
}

function envAny(names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim()
    if (value) return value
  }
  return ''
}

const secretNames: Record<SourceId, string[]> = {
  weather: ['KMA_SERVICE_KEY', 'KMA_API_KEY', 'WEATHER_API_KEY'],
  hydrology: ['HRFCO_SERVICE_KEY', 'HRFCO_API_KEY', 'HANRIVER_API_KEY'],
  kwater: ['KWATER_SERVICE_KEY', 'KWATER_API_KEY'],
  flood: ['SAFEMAP_API_KEY', 'SAFETY_MAP_API_KEY', 'LIFE_SAFETY_MAP_API_KEY'],
  pump: ['PUMP_STATION_SERVICE_KEY', 'PUMP_STATION_API_KEY'],
  population: ['MOIS_RESIDENT_POPULATION_SERVICE_KEY', 'MOIS_POPULATION_SERVICE_KEY'],
}

function sourceStatus(id: SourceId, state: SourceState, message?: string): SourceStatus {
  return { id, label: sourceLabels[id], state, message, updatedAt: state === 'live' ? new Date().toISOString() : undefined }
}

async function collectSource<T>(id: SourceId, key: string, work: () => Promise<T>) {
  if (!key) return { status: sourceStatus(id, 'error', 'Secret을 찾을 수 없습니다.') } as { status: SourceStatus; data?: T }
  try {
    const data = await work()
    const count = Array.isArray(data) ? `${data.length}건 수집` : undefined
    return { status: sourceStatus(id, 'live', count), data }
  } catch (error) {
    return { status: sourceStatus(id, 'error', error instanceof Error ? error.message : '호출 실패') } as { status: SourceStatus; data?: T }
  }
}

function koreaDateParts(offsetHours = 0) {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetHours * 60 * 60 * 1000)
  return {
    date: `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`,
    hour: `${String(now.getUTCHours()).padStart(2, '0')}00`,
  }
}

function kmaGrid(latitude: number, longitude: number) {
  const RE = 6371.00877
  const GRID = 5.0
  const SLAT1 = 30.0
  const SLAT2 = 60.0
  const OLON = 126.0
  const OLAT = 38.0
  const XO = 43
  const YO = 136
  const DEGRAD = Math.PI / 180.0
  const re = RE / GRID
  const slat1 = SLAT1 * DEGRAD
  const slat2 = SLAT2 * DEGRAD
  const olon = OLON * DEGRAD
  const olat = OLAT * DEGRAD
  let sn = Math.tan(Math.PI * .25 + slat2 * .5) / Math.tan(Math.PI * .25 + slat1 * .5)
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn)
  let sf = Math.tan(Math.PI * .25 + slat1 * .5)
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn
  let ro = Math.tan(Math.PI * .25 + olat * .5)
  ro = re * sf / Math.pow(ro, sn)
  let ra = Math.tan(Math.PI * .25 + latitude * DEGRAD * .5)
  ra = re * sf / Math.pow(ra, sn)
  let theta = longitude * DEGRAD - olon
  if (theta > Math.PI) theta -= 2.0 * Math.PI
  if (theta < -Math.PI) theta += 2.0 * Math.PI
  theta *= sn
  return { nx: Math.floor(ra * Math.sin(theta) + XO + .5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + .5) }
}

async function fetchKma(latitude: number, longitude: number, key: string) {
  const basis = koreaDateParts(new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCMinutes() < 35 ? -1 : 0)
  const grid = kmaGrid(latitude, longitude)
  const url = new URL('https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst')
  url.searchParams.set('ServiceKey', key)
  url.searchParams.set('pageNo', '1')
  url.searchParams.set('numOfRows', '100')
  url.searchParams.set('dataType', 'JSON')
  url.searchParams.set('base_date', basis.date)
  url.searchParams.set('base_time', basis.hour)
  url.searchParams.set('nx', String(grid.nx))
  url.searchParams.set('ny', String(grid.ny))

  const response = await fetch(url, { signal: AbortSignal.timeout(9000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json()
  const header = payload?.response?.header
  if (header?.resultCode && header.resultCode !== '00') throw new Error(header.resultMsg || header.resultCode)
  const items = payload?.response?.body?.items?.item ?? []
  const value = (category: string) => {
    const item = items.find((entry: Record<string, unknown>) => entry.category === category)
    const number = Number(item?.obsrValue)
    return Number.isFinite(number) ? number : null
  }
  return {
    rainfall1h: value('RN1'),
    temperature: value('T1H'),
    humidity: value('REH'),
    snowDepth: value('SNO'),
    observedAt: `${basis.date.slice(0, 4)}-${basis.date.slice(4, 6)}-${basis.date.slice(6, 8)} ${basis.hour.slice(0, 2)}:${basis.hour.slice(2)}`,
  }
}

function findItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  if (!payload || typeof payload !== 'object') return []
  const value = payload as Record<string, unknown>
  for (const key of ['item', 'items', 'data', 'records', 'result']) {
    const nested = value[key]
    const found = findItems(nested)
    if (found.length) return found
  }
  for (const nested of Object.values(value)) {
    const found = findItems(nested)
    if (found.length) return found
  }
  return []
}

function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key]
  return undefined
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? '').replaceAll(',', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function previousMonth() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  now.setUTCDate(1)
  now.setUTCMonth(now.getUTCMonth() - 1)
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function dmsToDecimal(value: unknown) {
  const text = String(value ?? '').trim()
  const direct = Number(text)
  if (Number.isFinite(direct)) return direct
  const parts = text.split(/[-°'"\s]+/).filter(Boolean).map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null
  return parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600
}

function distanceKm(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
  const toRad = (value: number) => value * Math.PI / 180
  const dLat = toRad(second.latitude - first.latitude)
  const dLon = toRad(second.longitude - first.longitude)
  const lat1 = toRad(first.latitude)
  const lat2 = toRad(second.latitude)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function fetchHrfco(location: { latitude: number; longitude: number }, key: string) {
  const infoResponse = await fetch(`https://api.hrfco.go.kr/${encodeURIComponent(key)}/waterlevel/info.json`, { signal: AbortSignal.timeout(12000) })
  if (!infoResponse.ok) throw new Error(`관측소 조회 HTTP ${infoResponse.status}`)
  const infoPayload = await infoResponse.json()
  const stations = findItems(infoPayload).map((row) => {
    const latitude = dmsToDecimal(pick(row, ['lat', 'latitude', '위도']))
    const longitude = dmsToDecimal(pick(row, ['lon', 'longitude', '경도']))
    return {
      row,
      code: String(pick(row, ['wlobscd', 'obsCode', '관측소코드']) ?? ''),
      name: String(pick(row, ['obsnm', 'obsName', '관측소명']) ?? '수위관측소'),
      latitude,
      longitude,
    }
  }).filter((station) => station.code && station.latitude != null && station.longitude != null)
    .map((station) => ({ ...station, distance: distanceKm(location, { latitude: station.latitude!, longitude: station.longitude! }) }))
    .filter((station) => station.distance <= 35)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8)

  const points = await Promise.all(stations.map(async (station): Promise<MapPoint> => {
    let latest: Record<string, unknown> | undefined
    try {
      const valueResponse = await fetch(`https://api.hrfco.go.kr/${encodeURIComponent(key)}/waterlevel/list/10M/${encodeURIComponent(station.code)}.json`, { signal: AbortSignal.timeout(9000) })
      if (valueResponse.ok) {
        const items = findItems(await valueResponse.json())
        latest = items.at(-1) ?? items[0]
      }
    } catch {
      // 관측소 위치는 표시하고 값만 비워 둔다.
    }
    return {
      id: station.code,
      name: station.name,
      kind: 'waterLevel',
      latitude: station.latitude!,
      longitude: station.longitude!,
      value: numberValue(pick(latest ?? {}, ['wl', 'waterlevel', '수위'])),
      unit: 'm',
      trend: 'unknown',
      address: String(pick(station.row, ['addr', 'address', '주소']) ?? ''),
      source: sourceLabels.hydrology,
      observedAt: String(pick(latest ?? {}, ['ymdhm', 'obsdt', '관측일시']) ?? ''),
    }
  }))
  return points
}

async function fetchPumpStations(location: { latitude: number; longitude: number }, key: string) {
  const all: Record<string, unknown>[] = []
  for (let page = 1; page <= 8; page += 1) {
    const url = new URL('https://api.data.go.kr/openapi/tn_pubr_public_pump_api')
    url.searchParams.set('serviceKey', key)
    url.searchParams.set('pageNo', String(page))
    url.searchParams.set('numOfRows', '1000')
    url.searchParams.set('type', 'json')
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    const items = findItems(payload)
    all.push(...items)
    const total = numberValue(payload?.response?.body?.totalCount ?? payload?.totalCount)
    if (!items.length || (total != null && all.length >= total)) break
  }
  return all.map((row, index) => pointFromRow(row, 'pumpStation', sourceLabels.pump, index))
    .filter((point): point is MapPoint => point !== null)
    .filter((point) => {
      const area = `${point.address ?? ''} ${String(pick(all.find((row) => String(pick(row, ['시설명', 'fcltyNm', 'name'])) === point.name) ?? {}, ['시군구명', 'signguNm', 'SIGNGU_NM']) ?? '')}`
      return area.includes('고양') || distanceKm(location, point) <= 30
    })
}

async function fetchPopulation(location: { address?: string }, key: string) {
  const month = previousMonth()
  const url = new URL('https://apis.data.go.kr/1741000/admmPpltnHhStus/selectAdmmPpltnHhStus')
  url.searchParams.set('serviceKey', key)
  url.searchParams.set('admmCd', '4128000000')
  url.searchParams.set('srchFrYm', month)
  url.searchParams.set('srchToYm', month)
  url.searchParams.set('lv', '3')
  url.searchParams.set('regSeCd', '1')
  url.searchParams.set('type', 'JSON')
  url.searchParams.set('numOfRows', '100')
  url.searchParams.set('pageNo', '1')
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json()
  const items = findItems(payload)
  const dong = items.find((row) => {
    const name = String(pick(row, ['dongNm', '행정동명']) ?? '')
    return name && location.address?.includes(name)
  })
  const selected = dong ? [dong] : items.filter((row) => String(pick(row, ['sggNm', '시군구명']) ?? '').includes('고양'))
  return {
    areaName: dong ? String(pick(dong, ['dongNm', '행정동명'])) : '고양시',
    population: selected.reduce((sum, row) => sum + (numberValue(pick(row, ['totNmprCnt', '총인구수'])) ?? 0), 0) || null,
    households: selected.reduce((sum, row) => sum + (numberValue(pick(row, ['hhCnt', '세대수'])) ?? 0), 0) || null,
    statisticMonth: String(pick(selected[0] ?? {}, ['statsYm', '통계년월']) ?? month),
  }
}

async function fetchConfiguredJson(endpoint: string, key: string, location: { latitude: number; longitude: number; address?: string }) {
  const url = new URL(endpoint)
  if (!url.searchParams.has('serviceKey') && !url.searchParams.has('ServiceKey')) url.searchParams.set('serviceKey', key)
  if (!url.searchParams.has('pageNo')) url.searchParams.set('pageNo', '1')
  if (!url.searchParams.has('numOfRows')) url.searchParams.set('numOfRows', '1000')
  if (!url.searchParams.has('type') && !url.searchParams.has('_type') && !url.searchParams.has('dataType')) url.searchParams.set('type', 'json')
  url.searchParams.set('latitude', String(location.latitude))
  url.searchParams.set('longitude', String(location.longitude))
  if (location.address) url.searchParams.set('address', location.address)
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function pointFromRow(row: Record<string, unknown>, kind: MapPoint['kind'], source: string, index: number): MapPoint | null {
  const latitude = numberValue(pick(row, ['위도', 'latitude', 'lat', 'y']))
  const longitude = numberValue(pick(row, ['경도', 'longitude', 'lon', 'lng', 'x']))
  if (latitude == null || longitude == null) return null
  const valueKeys = kind === 'rainfall' ? ['우량', '강수량', 'prcptqy', 'rainfall'] : ['수위', 'wal', 'waterLevel']
  return {
    id: String(pick(row, ['관측소코드', '시설코드', 'id', 'code']) ?? `${kind}-${index}`),
    name: String(pick(row, ['시설명', '관측소명', 'fcltyNm', 'obsnm', 'name']) ?? source),
    kind,
    latitude,
    longitude,
    value: kind === 'pumpStation' ? null : numberValue(pick(row, valueKeys)),
    unit: kind === 'rainfall' ? 'mm' : kind === 'waterLevel' ? 'm' : undefined,
    trend: 'unknown',
    address: String(pick(row, ['소재지도로명주소', '소재지지번주소', 'rdnmadr', 'lnmadr', '주소', 'address']) ?? ''),
    source,
    observedAt: String(pick(row, ['관측일시', 'obsrdtmnt', 'observedAt']) ?? ''),
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

async function fetchFloodImage(input: { bbox?: number[]; width?: number; height?: number }, key: string) {
  const bbox = input.bbox?.map(Number)
  if (!bbox || bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) throw new Error('올바른 지도 범위가 필요합니다.')
  const width = Math.max(256, Math.min(1024, Math.round(Number(input.width) || 768)))
  const height = Math.max(256, Math.min(1024, Math.round(Number(input.height) || 640)))
  const url = new URL('https://www.safemap.go.kr/sm/apis.do')
  url.searchParams.set('apikey', key)
  url.searchParams.set('service', 'WMS')
  url.searchParams.set('request', 'GetMap')
  url.searchParams.set('version', '1.1.1')
  url.searchParams.set('layers', 'A2SM_FLUDMARKS')
  url.searchParams.set('styles', '')
  url.searchParams.set('format', 'image/png')
  url.searchParams.set('transparent', 'true')
  url.searchParams.set('srs', 'EPSG:4326')
  url.searchParams.set('bbox', bbox.join(','))
  url.searchParams.set('width', String(width))
  url.searchParams.set('height', String(height))
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`침수흔적도 HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('image')) throw new Error('침수흔적도 이미지 응답이 아닙니다.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  return `data:${contentType.split(';')[0] || 'image/png'};base64,${bytesToBase64(bytes)}`
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'POST 요청만 지원합니다.' }, { status: 405, headers: corsHeaders })

  try {
    const input = await request.json().catch(() => ({})) as { action?: string; latitude?: number; longitude?: number; address?: string; bbox?: number[]; width?: number; height?: number }
    if (input.action === 'flood-wms') {
      const floodKey = envAny(secretNames.flood)
      if (!floodKey) return Response.json({ error: '생활안전지도 Secret을 찾을 수 없습니다.' }, { status: 503, headers: corsHeaders })
      const imageDataUrl = await fetchFloodImage(input, floodKey)
      return Response.json({ imageDataUrl }, { headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=900' } })
    }
    const location = {
      latitude: Number.isFinite(input.latitude) ? Number(input.latitude) : 37.6584,
      longitude: Number.isFinite(input.longitude) ? Number(input.longitude) : 126.832,
      address: input.address || '경기도 고양시',
    }
    const sources: SourceStatus[] = []
    const points: MapPoint[] = []
    let weather = { rainfall1h: null as number | null, temperature: null as number | null, humidity: null as number | null, snowDepth: null as number | null, observedAt: '' }
    let population: { areaName: string; population: number | null; households: number | null; statisticMonth?: string } | null = null

    const weatherKey = envAny(secretNames.weather)
    if (!weatherKey) sources.push(sourceStatus('weather', 'error', '기상청 Secret을 찾을 수 없습니다.'))
    else {
      try {
        weather = await fetchKma(location.latitude, location.longitude, weatherKey)
        sources.push(sourceStatus('weather', 'live'))
      } catch (error) {
        sources.push(sourceStatus('weather', 'error', error instanceof Error ? error.message : '호출 실패'))
      }
    }

    const hydrologyKey = envAny(secretNames.hydrology)
    const pumpKey = envAny(secretNames.pump)
    const populationKey = envAny(secretNames.population)
    const kwaterKey = envAny(secretNames.kwater)
    const kwaterEndpoint = envAny(['KWATER_API_URL'])

    const [hydrologyResult, pumpResult, populationResult, kwaterResult] = await Promise.all([
      collectSource('hydrology', hydrologyKey, () => fetchHrfco(location, hydrologyKey)),
      collectSource('pump', pumpKey, () => fetchPumpStations(location, pumpKey)),
      collectSource('population', populationKey, () => fetchPopulation(location, populationKey)),
      kwaterEndpoint
        ? collectSource('kwater', kwaterKey, async () => {
          const payload = await fetchConfiguredJson(kwaterEndpoint, kwaterKey, location)
          return findItems(payload).map((row, index) => pointFromRow(row, 'rainfall', sourceLabels.kwater, index)).filter((point): point is MapPoint => point !== null)
        })
        : Promise.resolve({ status: kwaterKey
          ? sourceStatus('kwater', 'configured', '인증키 등록 완료 · 관측소 코드 매핑 대기')
          : sourceStatus('kwater', 'error', 'Secret을 찾을 수 없습니다.'), data: undefined as MapPoint[] | undefined }),
    ])

    sources.push(hydrologyResult.status, kwaterResult.status)
    if (hydrologyResult.data) points.push(...hydrologyResult.data)
    if (kwaterResult.data) points.push(...kwaterResult.data)

    const floodKey = envAny(secretNames.flood)
    sources.push(floodKey
      ? sourceStatus('flood', 'configured', '침수흔적도 WMS 보안 프록시 사용 가능')
      : sourceStatus('flood', 'error', '생활안전지도 Secret을 찾을 수 없습니다.'))

    sources.push(pumpResult.status, populationResult.status)
    if (pumpResult.data) points.push(...pumpResult.data)
    if (populationResult.data) population = populationResult.data

    return Response.json({
      generatedAt: new Date().toISOString(),
      locationLabel: location.address,
      weather,
      points,
      areas: [],
      population,
      floodTraceMatched: null,
      sources,
    }, { headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.' }, { status: 500, headers: corsHeaders })
  }
})
