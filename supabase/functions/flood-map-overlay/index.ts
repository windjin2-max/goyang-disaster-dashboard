import { PNG } from 'npm:pngjs@7.0.0'

type LayerCode = 'flood_trace' | 'urban_flood' | 'national_river_flood' | 'local_river_flood'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const layerEndpoints: Record<Exclude<LayerCode, 'flood_trace'>, string> = {
  urban_flood: 'adm-cty-wms',
  national_river_flood: 'adm-ntn-wms',
  local_river_flood: 'adm-rgn-wms',
}

function floodMapBbox([west, south, east, north]: [number, number, number, number]) {
  return [south, west, north, east]
}

function jsonResponse(body: unknown, status = 200, cacheControl = 'no-store') {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders, 'Cache-Control': cacheControl },
  })
}

function decodedKey(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
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

function validBbox(value: unknown): value is [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return false
  const [west, south, east, north] = value.map(Number)
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) return false
  if (east < 126.55 || west > 127.1 || north < 37.45 || south > 37.85) return false
  return east - west <= 1.5 && north - south <= 1.5
}

async function fetchWmsImage(input: {
  layer: LayerCode
  bbox: [number, number, number, number]
  width: number
  height: number
  frequency: number
}) {
  const isTrace = input.layer === 'flood_trace'
  const secret = Deno.env.get(isTrace ? 'SAFEMAP_SERVICE_KEY' : 'FLOODMAP_SERVICE_KEY')?.trim()
  if (!secret) throw new Error(`${isTrace ? 'SAFEMAP_SERVICE_KEY' : 'FLOODMAP_SERVICE_KEY'} is unavailable.`)

  const urls = isTrace
    ? [
      new URL('https://www.safemap.go.kr/openapi2/IF_0092_WMS'),
      new URL('https://www.safemap.go.kr/sm/apis.do'),
    ]
    : [new URL(`https://data.floodmap.go.kr/api/wms-service/${layerEndpoints[input.layer as Exclude<LayerCode, 'flood_trace'>]}`)]
  let lastError = 'PNG image was not returned.'
  for (const [index, url] of urls.entries()) {
    url.searchParams.set(isTrace ? (index === 0 ? 'serviceKey' : 'apikey') : 'ServiceKey', decodedKey(secret))
    url.searchParams.set('srs', 'EPSG:4326')
    url.searchParams.set('Bbox', (isTrace ? input.bbox : floodMapBbox(input.bbox)).join(','))
    url.searchParams.set('Format', 'image/png')
    url.searchParams.set('width', String(input.width))
    url.searchParams.set('height', String(input.height))
    url.searchParams.set('transparent', 'TRUE')
    if (isTrace && index === 1) {
      url.searchParams.set('service', 'WMS')
      url.searchParams.set('request', 'GetMap')
      url.searchParams.set('version', '1.1.1')
      url.searchParams.set('layers', 'A2SM_FLUDMARKS')
      url.searchParams.set('styles', 'A2SM_FludMarks')
    } else if (!isTrace) {
      url.searchParams.set('Freq', String(input.frequency))
      url.searchParams.set('STDG_SGG_CD', '41280')
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    const contentType = response.headers.get('content-type') ?? ''
    const bytes = new Uint8Array(await response.arrayBuffer())
    const isPng = contentType.includes('image/png') && bytes.length > 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    if (response.ok && isPng && hasVisiblePixels(bytes)) return { bytes, contentType: 'image/png' }
    if (response.ok && isPng) {
      lastError = 'WMS returned an empty transparent image. Check API utilization approval and layer availability.'
      continue
    }
    lastError = `WMS ${response.status}: ${new TextDecoder().decode(bytes.slice(0, 240)).replace(secret, '[REDACTED]')}`
  }
  throw new Error(lastError)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return jsonResponse({ error: 'POST 요청만 지원합니다.' }, 405)

  try {
    const input = await request.json() as {
      layer?: LayerCode
      bbox?: [number, number, number, number]
      width?: number
      height?: number
      frequency?: number
    }
    if (!input.layer || !['flood_trace', 'urban_flood', 'national_river_flood', 'local_river_flood'].includes(input.layer)) {
      return jsonResponse({ error: '지원하지 않는 지도 레이어입니다.' }, 400)
    }
    if (!validBbox(input.bbox)) return jsonResponse({ error: '고양시 주변의 올바른 지도 범위가 필요합니다.' }, 400)

    const width = Math.max(256, Math.min(1024, Math.round(Number(input.width) || 768)))
    const height = Math.max(256, Math.min(1024, Math.round(Number(input.height) || 640)))
    const frequency = [50, 80, 100, 200, 500].includes(Number(input.frequency)) ? Number(input.frequency) : 100
    const result = await fetchWmsImage({ layer: input.layer, bbox: input.bbox, width, height, frequency })

    return jsonResponse({
      layer: input.layer,
      frequency: input.layer === 'flood_trace' ? null : frequency,
      imageDataUrl: `data:${result.contentType};base64,${bytesToBase64(result.bytes)}`,
      source: input.layer === 'flood_trace' ? '생활안전지도' : '홍수위험지도 정보시스템',
    }, 200, 'private, max-age=900')
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : '위험지도 조회에 실패했습니다.' }, 502)
  }
})
