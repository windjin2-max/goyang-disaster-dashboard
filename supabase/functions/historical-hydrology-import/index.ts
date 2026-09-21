import { PNG } from 'npm:pngjs@7.0.0'

type JsonObject = Record<string, unknown>
type LayerCode = 'flood_trace' | 'urban_flood' | 'national_river_flood' | 'local_river_flood'

const GOYANG_BBOX: [number, number, number, number] = [126.65, 37.53, 127.01, 37.77]
const layerEndpoints: Record<Exclude<LayerCode, 'flood_trace'>, string> = {
  urban_flood: 'adm-cty-wms',
  national_river_flood: 'adm-ntn-wms',
  local_river_flood: 'adm-rgn-wms',
}
function floodMapBbox([west, south, east, north]: [number, number, number, number]) {
  return [south, west, north, east]
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function decodedKey(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function hasVisiblePixels(bytes: Uint8Array) {
  try {
    const image = PNG.sync.read(bytes)
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if (image.data[offset + 3] > 8 && (image.data[offset] < 250 || image.data[offset + 1] < 250 || image.data[offset + 2] < 250)) return true
    }
    return false
  } catch {
    return false
  }
}

function findItems(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) return payload.filter((item): item is JsonObject => Boolean(item && typeof item === 'object'))
  if (!payload || typeof payload !== 'object') return []
  const value = payload as JsonObject
  for (const key of ['item', 'items', 'data', 'records', 'result', 'content']) {
    const found = findItems(value[key])
    if (found.length) return found
  }
  for (const nested of Object.values(value)) {
    const found = findItems(nested)
    if (found.length) return found
  }
  return []
}

function pick(row: JsonObject, keys: string[]) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key]
  return undefined
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function dmsToDecimal(value: unknown) {
  const text = String(value ?? '').trim()
  const direct = Number(text)
  if (Number.isFinite(direct)) return direct
  const parts = text.split(/[-°'"\s]+/).filter(Boolean).map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null
  return parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600
}

function monthRange(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    compactStart: `${year}${mm}010000`,
    compactEnd: `${year}${mm}${String(lastDay).padStart(2, '0')}2350`,
  }
}

function observedAt(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  const minute = digits.length >= 12 ? digits.slice(10, 12) : '00'
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${minute}:00+09:00`
}

async function supabaseRequest(url: string, serviceRoleKey: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function fetchHrfcoJson(path: string, key: string) {
  const response = await fetch(`https://api.hrfco.go.kr/${encodeURIComponent(key)}/${path}`, { signal: AbortSignal.timeout(60000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`HRFCO HTTP ${response.status}: ${text.slice(0, 180)}`)
  try { return JSON.parse(text) } catch { throw new Error(`HRFCO returned non-JSON data: ${text.slice(0, 180)}`) }
}

async function importWaterLevel(input: { year: number; month: number; refreshStations?: boolean }, context: {
  hrfcoKey: string
  supabaseUrl: string
  serviceRoleKey: string
}) {
  const range = monthRange(input.year, input.month)
  let excludedCount = 0
  let storedStations = await supabaseRequest(
    `${context.supabaseUrl}/rest/v1/observation_stations?select=id,station_code&source=eq.hrfco&is_goyang=eq.true&is_active=eq.true`,
    context.serviceRoleKey,
  ) as Array<{ id: number; station_code: string }>

  if (!storedStations.length || input.refreshStations) {
    const infoPayload = await fetchHrfcoJson('waterlevel/info.json', context.hrfcoKey)
    const stations = findItems(infoPayload).flatMap((row) => {
      const stationCode = String(pick(row, ['wlobscd', 'obsCode', 'stationCode']) ?? '').trim()
      const latitude = dmsToDecimal(pick(row, ['lat', 'latitude']))
      const longitude = dmsToDecimal(pick(row, ['lon', 'longitude']))
      if (!stationCode || latitude == null || longitude == null) return []
      return [{
        station_code: stationCode,
        station_name: String(pick(row, ['obsnm', 'obsName', 'stationName']) ?? stationCode),
        address: String(pick(row, ['addr', 'address']) ?? ''),
        latitude,
        longitude,
        raw: row,
      }]
    })
    if (!stations.length) throw new Error('HRFCO station list returned no usable coordinates.')
    const scoped = await supabaseRequest(`${context.supabaseUrl}/rest/v1/rpc/upsert_scoped_observation_stations`, context.serviceRoleKey, {
      method: 'POST',
      body: JSON.stringify({ p_source: 'hrfco', p_metrics: ['water_level'], p_stations: stations }),
    }) as { excludedCount?: number }
    excludedCount = Number(scoped.excludedCount ?? 0)
    storedStations = await supabaseRequest(
      `${context.supabaseUrl}/rest/v1/observation_stations?select=id,station_code&source=eq.hrfco&is_goyang=eq.true&is_active=eq.true`,
      context.serviceRoleKey,
    ) as Array<{ id: number; station_code: string }>
  }

  if (!storedStations.length) throw new Error('고양시 경계 내부에 한강홍수통제소 수위관측소가 없습니다.')
  const observations: JsonObject[] = []
  const errors: string[] = []
  for (const station of storedStations) {
    try {
      const payload = await fetchHrfcoJson(
        `waterlevel/list/10M/${encodeURIComponent(station.station_code)}/${range.compactStart}/${range.compactEnd}.json`,
        context.hrfcoKey,
      )
      for (const row of findItems(payload)) {
        const timestamp = observedAt(pick(row, ['ymdhm', 'obsdt', 'tm', 'time']))
        const value = numberValue(pick(row, ['wl', 'waterlevel', 'value']))
        if (!timestamp || value == null || value <= -900) continue
        observations.push({
          station_id: station.id,
          observed_at: timestamp,
          metric: 'water_level',
          value,
          unit: 'm',
          quality_code: String(pick(row, ['fw', 'qc', 'quality']) ?? ''),
          raw: row,
        })
      }
    } catch (error) {
      errors.push(`${station.station_code}: ${error instanceof Error ? error.message : 'request failed'}`)
    }
  }

  for (let offset = 0; offset < observations.length; offset += 500) {
    await supabaseRequest(
      `${context.supabaseUrl}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric`,
      context.serviceRoleKey,
      {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(observations.slice(offset, offset + 500)),
      },
    )
  }
  const status = errors.length ? (observations.length ? 'partial' : 'failed') : 'complete'
  await supabaseRequest(`${context.supabaseUrl}/rest/v1/ingestion_runs`, context.serviceRoleKey, {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      source: 'hrfco', scope_region_code: '41280', period_start: range.start, period_end: range.end,
      status, accepted_count: observations.length, excluded_count: excludedCount,
      message: errors.join(' | '), finished_at: new Date().toISOString(),
    }),
  })
  return { ok: status !== 'failed', status, stationCount: storedStations.length, acceptedCount: observations.length, excludedCount, errors }
}

async function fetchHazardImage(layer: LayerCode) {
  const isTrace = layer === 'flood_trace'
  const secret = Deno.env.get(isTrace ? 'SAFEMAP_SERVICE_KEY' : 'FLOODMAP_SERVICE_KEY')?.trim()
  if (!secret) throw new Error(`${isTrace ? 'SAFEMAP_SERVICE_KEY' : 'FLOODMAP_SERVICE_KEY'} is unavailable.`)
  const urls = isTrace
    ? [new URL('https://www.safemap.go.kr/openapi2/IF_0092_WMS'), new URL('https://www.safemap.go.kr/sm/apis.do')]
    : [new URL(`https://data.floodmap.go.kr/api/wms-service/${layerEndpoints[layer as Exclude<LayerCode, 'flood_trace'>]}`)]
  let lastError = 'PNG image was not returned.'
  for (const [index, url] of urls.entries()) {
    url.searchParams.set(isTrace ? (index === 0 ? 'serviceKey' : 'apikey') : 'ServiceKey', decodedKey(secret))
    url.searchParams.set('srs', 'EPSG:4326')
    url.searchParams.set('Bbox', (isTrace ? GOYANG_BBOX : floodMapBbox(GOYANG_BBOX)).join(','))
    url.searchParams.set('Format', 'image/png')
    url.searchParams.set('width', '1024')
    url.searchParams.set('height', '768')
    url.searchParams.set('transparent', 'TRUE')
    if (isTrace && index === 1) {
      url.searchParams.set('service', 'WMS')
      url.searchParams.set('request', 'GetMap')
      url.searchParams.set('version', '1.1.1')
      url.searchParams.set('layers', 'A2SM_FLUDMARKS')
      url.searchParams.set('styles', 'A2SM_FludMarks')
    } else if (!isTrace) {
      url.searchParams.set('Freq', '100')
      url.searchParams.set('STDG_SGG_CD', '41280')
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    const contentType = response.headers.get('content-type') ?? ''
    const bytes = new Uint8Array(await response.arrayBuffer())
    const isPng = contentType.includes('image/png') && bytes.length > 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    if (response.ok && isPng && hasVisiblePixels(bytes)) return bytes
    if (response.ok && isPng) {
      lastError = 'WMS returned an empty transparent image. Check API utilization approval and layer availability.'
      continue
    }
    lastError = `WMS ${response.status}: ${new TextDecoder().decode(bytes.slice(0, 200)).replace(secret, '[REDACTED]')}`
  }
  throw new Error(lastError)
}

async function captureHazardLayers(context: { supabaseUrl: string; serviceRoleKey: string }) {
  const layers: LayerCode[] = ['flood_trace', 'urban_flood', 'national_river_flood', 'local_river_flood']
  const capturedAt = new Date()
  const results: Array<{ layer: LayerCode; ok: boolean; bytes?: number; error?: string }> = []
  for (const layer of layers) {
    try {
      const bytes = await fetchHazardImage(layer)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const checksum = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
      const timestamp = capturedAt.toISOString().replaceAll(':', '').replaceAll('-', '').replace('.000Z', 'Z')
      const storagePath = `${layer}/goyang-41280-${timestamp}.png`
      const upload = await fetch(`${context.supabaseUrl}/storage/v1/object/hazard-snapshots/${storagePath}`, {
        method: 'POST',
        headers: {
          apikey: context.serviceRoleKey,
          authorization: `Bearer ${context.serviceRoleKey}`,
          'content-type': 'image/png',
          'x-upsert': 'true',
        },
        body: bytes,
        signal: AbortSignal.timeout(60000),
      })
      if (!upload.ok) throw new Error(`Storage HTTP ${upload.status}: ${(await upload.text()).slice(0, 200)}`)
      await supabaseRequest(`${context.supabaseUrl}/rest/v1/hazard_layer_snapshots`, context.serviceRoleKey, {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          layer_code: layer,
          scope_region_code: '41280',
          frequency: layer === 'flood_trace' ? null : 100,
          bbox: GOYANG_BBOX,
          srs: 'EPSG:4326',
          width: 1024,
          height: 768,
          storage_path: storagePath,
          content_type: 'image/png',
          byte_size: bytes.length,
          checksum,
          captured_at: capturedAt.toISOString(),
          raw: { administrativeCode: '41280' },
        }),
      })
      await supabaseRequest(`${context.supabaseUrl}/rest/v1/hazard_layers?code=eq.${layer}`, context.serviceRoleKey, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ last_checked_at: capturedAt.toISOString(), last_status: 'complete', last_message: '', updated_at: capturedAt.toISOString() }),
      })
      results.push({ layer, ok: true, bytes: bytes.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'capture failed'
      await supabaseRequest(`${context.supabaseUrl}/rest/v1/hazard_layers?code=eq.${layer}`, context.serviceRoleKey, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ last_checked_at: capturedAt.toISOString(), last_status: 'failed', last_message: message, updated_at: capturedAt.toISOString() }),
      }).catch(() => null)
      results.push({ layer, ok: false, error: message })
    }
  }
  for (const source of ['safemap', 'floodmap']) {
    const sourceResults = results.filter((result) => source === 'safemap' ? result.layer === 'flood_trace' : result.layer !== 'flood_trace')
    const accepted = sourceResults.filter((result) => result.ok).length
    await supabaseRequest(`${context.supabaseUrl}/rest/v1/ingestion_runs`, context.serviceRoleKey, {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        source, scope_region_code: '41280', status: accepted === sourceResults.length ? 'complete' : accepted ? 'partial' : 'failed',
        accepted_count: accepted, excluded_count: 0,
        message: sourceResults.filter((result) => !result.ok).map((result) => `${result.layer}: ${result.error}`).join(' | '),
        finished_at: capturedAt.toISOString(),
      }),
    })
  }
  return { ok: results.every((result) => result.ok), capturedAt: capturedAt.toISOString(), results }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)
  const configuredToken = Deno.env.get('HISTORICAL_IMPORT_TOKEN')?.trim()
  const suppliedToken = request.headers.get('x-historical-import-token')?.trim()
  if (!configuredToken || suppliedToken !== configuredToken) return jsonResponse({ error: 'Unauthorized.' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Supabase server secrets are unavailable.' }, 500)

  try {
    const input = await request.json().catch(() => ({})) as { action?: string; year?: number; month?: number; refreshStations?: boolean }
    if (input.action === 'flood-layers') return jsonResponse(await captureHazardLayers({ supabaseUrl, serviceRoleKey }))
    if (input.action === 'status') {
      const start = typeof input.year === 'number' ? `${input.year}-01-01` : '2025-01-01'
      const end = typeof input.year === 'number' ? `${input.year}-12-31` : '2025-12-31'
      const [analysis, hazardLayers] = await Promise.all([
        supabaseRequest(`${supabaseUrl}/rest/v1/rpc/get_historical_analysis`, serviceRoleKey, {
          method: 'POST', body: JSON.stringify({ p_start: start, p_end: end }),
        }),
        supabaseRequest(`${supabaseUrl}/rest/v1/hazard_layers?select=code,name,last_status,last_message,last_checked_at&order=code`, serviceRoleKey),
      ])
      return jsonResponse({ analysis, hazardLayers })
    }
    if (input.action !== 'water-level') return jsonResponse({ error: 'Unsupported import action.' }, 400)
    const year = Number(input.year)
    const month = Number(input.month)
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      return jsonResponse({ error: 'Valid year and month are required.' }, 400)
    }
    const hrfcoKey = Deno.env.get('HRFCO_SERVICE_KEY')?.trim()
    if (!hrfcoKey) return jsonResponse({ error: 'HRFCO_SERVICE_KEY is unavailable.' }, 500)
    return jsonResponse(await importWaterLevel({ year, month, refreshStations: input.refreshStations }, { hrfcoKey, supabaseUrl, serviceRoleKey }))
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Historical hydrology import failed.' }, 500)
  }
})
