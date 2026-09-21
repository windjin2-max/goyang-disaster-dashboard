type JsonObject = Record<string, unknown>

const KMA_BASE = 'https://apihub.kma.go.kr/api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function pick(row: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function findItems(payload: unknown): JsonObject[] {
  if (Array.isArray(payload)) return payload.filter((item): item is JsonObject => Boolean(item && typeof item === 'object'))
  if (!payload || typeof payload !== 'object') return []
  const value = payload as JsonObject
  for (const key of ['item', 'items', 'data', 'records', 'result']) {
    const found = findItems(value[key])
    if (found.length) return found
  }
  for (const nested of Object.values(value)) {
    const found = findItems(nested)
    if (found.length) return found
  }
  return []
}

async function fetchKmaJson(path: string, params: Record<string, string>, key: string) {
  const url = new URL(`${KMA_BASE}/${path}`)
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value))
  url.searchParams.set('authKey', key)
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`KMA HTTP ${response.status}: ${text.slice(0, 160)}`)
  try {
    const payload = JSON.parse(text)
    const header = payload?.response?.header
    if (header?.resultCode && header.resultCode !== '00') throw new Error(header.resultMsg || header.resultCode)
    return payload
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`KMA returned non-JSON data: ${text.slice(0, 160)}`)
    throw error
  }
}

async function fetchKmaText(path: string, params: Record<string, string>, key: string, maxAttempts = 3) {
  const url = new URL(`${KMA_BASE}/${path}`)
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value))
  url.searchParams.set('authKey', key)
  let lastError = 'KMA request failed.'
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) })
      const bytes = await response.arrayBuffer()
      const text = new TextDecoder('euc-kr').decode(bytes)
      if (response.ok) {
        if (/SERVICE KEY|AUTH|인증|ERROR/i.test(text.slice(0, 300)) && !text.includes('#')) {
          throw new Error(`KMA authorization response: ${text.slice(0, 160)}`)
        }
        return text
      }
      lastError = `KMA HTTP ${response.status}: ${text.slice(0, 160)}`
      if (![502, 503, 504].includes(response.status)) throw new Error(lastError)
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750))
  }
  throw new Error(lastError)
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
    signal: AbortSignal.timeout(30000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

function parseDailyValues(text: string, stationIds: Map<string, number>, metric: string, unit: string) {
  const rows: JsonObject[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('END')) continue
    const fields = trimmed.split(/\s+/)
    if (!/^\d{8}$/.test(fields[0] ?? '') || fields.length < 3) continue
    const stationId = stationIds.get(fields[1])
    const value = numberValue(fields[5])
    if (!stationId || value == null || value < 0) continue
    const date = `${fields[0].slice(0, 4)}-${fields[0].slice(4, 6)}-${fields[0].slice(6, 8)}`
    rows.push({
      station_id: stationId,
      observed_at: `${date}T12:00:00+09:00`,
      metric,
      value,
      unit,
      quality_code: 'kma_daily',
      raw: { sourceLine: trimmed },
    })
  }
  return rows
}

function parseStationInfo(text: string) {
  const stations: JsonObject[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('END')) continue
    const fields = trimmed.split(/\s+/)
    const stationCode = fields[0] ?? ''
    const longitude = numberValue(fields[1])
    const latitude = numberValue(fields[2])
    if (!/^\d+$/.test(stationCode) || longitude == null || latitude == null) continue
    stations.push({
      station_code: stationCode,
      station_name: fields[8] || stationCode,
      address: '',
      latitude,
      longitude,
      raw: { sourceLine: trimmed },
    })
  }
  return stations
}

function parseSnowStationInfo(text: string) {
  const stations: JsonObject[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('END')) continue
    const fields = trimmed.split(/\s+/)
    const stationCode = fields[0] ?? ''
    const longitude = numberValue(fields[1])
    const latitude = numberValue(fields[2])
    if (!/^\d+$/.test(stationCode) || longitude == null || latitude == null) continue
    stations.push({
      station_code: stationCode,
      station_name: fields[6] || stationCode,
      address: '',
      latitude,
      longitude,
      raw: { sourceLine: trimmed, stationType: fields[3] ?? '' },
    })
  }
  return stations
}

function parseSnowValues(text: string, stationIds: Map<string, number>, metric: 'snow_depth' | 'new_snow') {
  const rows: JsonObject[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('END')) continue
    const fields = trimmed.split(',').map((value) => value.trim())
    const timestamp = String(fields[0] ?? '').replace(/\D/g, '')
    const stationCode = fields[1] ?? ''
    const stationId = stationIds.get(stationCode)
    const value = numberValue(String(fields[6] ?? '').replaceAll('=', ''))
    if (!stationId || timestamp.length < 12 || value == null || value < 0) continue
    rows.push({
      station_id: stationId,
      observed_at: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:00+09:00`,
      metric,
      value,
      unit: 'cm',
      quality_code: 'kma_snow_daily_snapshot',
      raw: { sourceLine: trimmed, stationCode },
    })
  }
  return rows
}

function monthRange(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    compactStart: `${year}${mm}01`,
    compactEnd: `${year}${mm}${String(lastDay).padStart(2, '0')}`,
    lastDay,
  }
}

async function importSnow(input: { year: number; month: number; refreshStations?: boolean }, context: {
  kmaKey: string
  supabaseUrl: string
  serviceRoleKey: string
}) {
  const range = monthRange(input.year, input.month)
  let excludedCount = 0
  let storedStations = await supabaseRequest(
    `${context.supabaseUrl}/rest/v1/observation_stations?select=id,station_code&source=eq.kma_snow&is_goyang=eq.true&is_active=eq.true`,
    context.serviceRoleKey,
  ) as Array<{ id: number; station_code: string }>

  if (!storedStations.length || input.refreshStations) {
    const stationText = await fetchKmaText('typ01/url/stn_snow.php', {
      stn: '', tm: `${input.year}${String(input.month).padStart(2, '0')}151200`, mode: '0', help: '0',
    }, context.kmaKey)
    const stations = parseSnowStationInfo(stationText)
    if (!stations.length) throw new Error('KMA snow station list returned no usable rows.')
    const stationResult = await supabaseRequest(
      `${context.supabaseUrl}/rest/v1/rpc/upsert_scoped_observation_stations`,
      context.serviceRoleKey,
      {
        method: 'POST',
        body: JSON.stringify({ p_source: 'kma_snow', p_metrics: ['snow_depth', 'new_snow'], p_stations: stations }),
      },
    ) as { excludedCount?: number }
    excludedCount = Number(stationResult?.excludedCount ?? 0)
    storedStations = await supabaseRequest(
      `${context.supabaseUrl}/rest/v1/observation_stations?select=id,station_code&source=eq.kma_snow&is_goyang=eq.true&is_active=eq.true`,
      context.serviceRoleKey,
    ) as Array<{ id: number; station_code: string }>
  }

  if (!storedStations.length) throw new Error('No KMA snow station falls inside the loaded Goyang boundary.')
  const stationIds = new Map(storedStations.map((station) => [station.station_code, station.id]))
  const days = Array.from({ length: range.lastDay }, (_, index) => String(index + 1).padStart(2, '0'))
  const observations: JsonObject[] = []
  const errors: string[] = []

  const results = await Promise.all(days.flatMap((day) => ([
    { day, sd: 'tot', metric: 'snow_depth' as const },
    { day, sd: 'day', metric: 'new_snow' as const },
  ])).map(async ({ day, sd, metric }) => {
    try {
      const text = await fetchKmaText('typ01/url/kma_snow1.php', {
        sd,
        tm: `${input.year}${String(input.month).padStart(2, '0')}${day}2359`,
        snow: '0',
        help: '0',
      }, context.kmaKey, 1)
      return { rows: parseSnowValues(text, stationIds, metric), error: '' }
    } catch (error) {
      return { rows: [] as JsonObject[], error: `${input.year}-${String(input.month).padStart(2, '0')}-${day} ${metric}: ${error instanceof Error ? error.message : 'request failed'}` }
    }
  }))
  observations.push(...results.flatMap((result) => result.rows))
  errors.push(...results.map((result) => result.error).filter(Boolean))

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
      source: 'kma_snow', scope_region_code: '41280', period_start: range.start, period_end: range.end,
      status, accepted_count: observations.length, excluded_count: excludedCount,
      message: errors.join(' | '), finished_at: new Date().toISOString(),
    }),
  })
  return { ok: status !== 'failed', status, stationCount: storedStations.length, acceptedCount: observations.length, excludedCount, errors }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)

  const configuredToken = Deno.env.get('HISTORICAL_IMPORT_TOKEN')?.trim()
  const suppliedToken = request.headers.get('x-historical-import-token')?.trim()
  if (!configuredToken || suppliedToken !== configuredToken) return jsonResponse({ error: 'Unauthorized.' }, 401)

  const kmaKey = Deno.env.get('KMA_API_HUB_KEY')?.trim()
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  if (!kmaKey || !supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Required server secrets are unavailable.' }, 500)

  let input: { action?: string; year?: number; month?: number; refreshStations?: boolean }
  try { input = await request.json() } catch { return jsonResponse({ error: 'JSON body is required.' }, 400) }
  const year = Number(input.year)
  const month = Number(input.month)
  if (!Number.isInteger(year) || year < 1997 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return jsonResponse({ error: 'Valid year and month are required.' }, 400)
  }

  const range = monthRange(year, month)
  if (input.action === 'snow') {
    try {
      return jsonResponse(await importSnow(
        { year, month, refreshStations: input.refreshStations },
        { kmaKey, supabaseUrl, serviceRoleKey },
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Historical snow import failed.'
      try {
        await supabaseRequest(`${supabaseUrl}/rest/v1/ingestion_runs`, serviceRoleKey, {
          method: 'POST', headers: { prefer: 'return=minimal' },
          body: JSON.stringify({
            source: 'kma_snow', scope_region_code: '41280', period_start: range.start, period_end: range.end,
            status: 'failed', accepted_count: 0, excluded_count: 0, message, finished_at: new Date().toISOString(),
          }),
        })
      } catch { /* preserve the original error */ }
      return jsonResponse({ ok: false, year, month, error: message }, 500)
    }
  }
  const errors: string[] = []
  let acceptedCount = 0
  let excludedCount = 0

  try {
    let storedStations = await supabaseRequest(
      `${supabaseUrl}/rest/v1/observation_stations?select=id,station_code&source=eq.kma_aws&is_goyang=eq.true&is_active=eq.true`,
      serviceRoleKey,
    ) as Array<{ id: number; station_code: string }>
    if (!storedStations.length || input.refreshStations === true) {
      let stations: JsonObject[] = []
      try {
        const stationPayload = await fetchKmaJson('typ02/openApi/AwsMtlyInfoService/getAwsStnLstTbl', {
          pageNo: '1', numOfRows: '1000', dataType: 'JSON', year: String(year), month: String(month).padStart(2, '0'),
        }, kmaKey)
        stations = findItems(stationPayload).flatMap((row) => {
          const stationCode = String(pick(row, ['stn_id', 'stnId', 'STN_ID']) ?? '').trim()
          const latitude = numberValue(pick(row, ['lat', 'latitude', 'LAT']))
          const longitude = numberValue(pick(row, ['lon', 'longitude', 'LON']))
          if (!stationCode || latitude == null || longitude == null) return []
          return [{
            station_code: stationCode,
            station_name: String(pick(row, ['stn_ko', 'stnKo', 'STN_KO']) ?? stationCode),
            address: '', latitude, longitude, raw: row,
          }]
        })
      } catch (primaryError) {
        const stationText = await fetchKmaText('typ01/url/stn_inf.php', {
          inf: 'AWS', stn: '', tm: `${year}${String(month).padStart(2, '0')}150900`, help: '0',
        }, kmaKey)
        stations = parseStationInfo(stationText)
        if (!stations.length) throw primaryError
      }
      if (!stations.length) throw new Error('KMA AWS station list returned no usable rows.')

      const stationResult = await supabaseRequest(`${supabaseUrl}/rest/v1/rpc/upsert_goyang_observation_stations`, serviceRoleKey, {
        method: 'POST', body: JSON.stringify({ p_source: 'kma_aws', p_stations: stations }),
      }) as { acceptedCount?: number; excludedCount?: number }
      excludedCount = Number(stationResult?.excludedCount ?? 0)
      storedStations = await supabaseRequest(
        `${supabaseUrl}/rest/v1/observation_stations?select=id,station_code&source=eq.kma_aws&is_goyang=eq.true&is_active=eq.true`,
        serviceRoleKey,
      ) as Array<{ id: number; station_code: string }>
    }
    if (!storedStations.length) throw new Error('No KMA AWS station falls inside the loaded Goyang boundary.')
    const stationIds = new Map(storedStations.map((station) => [station.station_code, station.id]))
    const stationCodes = storedStations.map((station) => station.station_code).join(':')

    const metricRequests = [
      { obs: 'rn_day', metric: 'rainfall_daily', unit: 'mm' },
      { obs: 'sd_tot_max', metric: 'snow_depth', unit: 'cm' },
      { obs: 'sd_day_max', metric: 'new_snow', unit: 'cm' },
    ]

    const observations: JsonObject[] = []
    for (const requestMetric of metricRequests) {
      let parsedRows: JsonObject[] = []
      try {
        const text = await fetchKmaText('typ01/url/sfc_aws_day.php', {
          tm1: range.compactStart,
          tm2: range.compactEnd,
          obs: requestMetric.obs,
          stn: stationCodes,
          disp: '0',
          help: '0',
        }, kmaKey, 1)
        parsedRows = parseDailyValues(text, stationIds, requestMetric.metric, requestMetric.unit)
      } catch (batchError) {
        const stationResults = await Promise.all(storedStations.map(async (station) => {
          try {
            const text = await fetchKmaText('typ01/url/sfc_aws_day.php', {
              tm1: range.compactStart,
              tm2: range.compactEnd,
              obs: requestMetric.obs,
              stn: station.station_code,
              disp: '0',
              help: '0',
            }, kmaKey, 2)
            return { rows: parseDailyValues(text, stationIds, requestMetric.metric, requestMetric.unit), error: '' }
          } catch (stationError) {
            return { rows: [] as JsonObject[], error: `${station.station_code}: ${stationError instanceof Error ? stationError.message : 'request failed'}` }
          }
        }))
        const stationErrors = stationResults.map((result) => result.error).filter(Boolean)
        parsedRows.push(...stationResults.flatMap((result) => result.rows))
        if (stationErrors.length) {
          const batchMessage = batchError instanceof Error ? batchError.message : 'request failed'
          errors.push(`${requestMetric.metric}: batch ${batchMessage}; stations ${stationErrors.join(', ')}`)
        }
      }
      observations.push(...parsedRows)
      if (!parsedRows.length && requestMetric.metric === 'rainfall_daily' && !errors.some((error) => error.startsWith(`${requestMetric.metric}:`))) {
        errors.push(`${requestMetric.metric}: no usable rows`)
      }
    }

    if (observations.length) {
      await supabaseRequest(
        `${supabaseUrl}/rest/v1/historical_observations?on_conflict=station_id,observed_at,metric`,
        serviceRoleKey,
        {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(observations),
        },
      )
      acceptedCount = observations.length
    }

    const status = errors.length ? (acceptedCount ? 'partial' : 'failed') : 'complete'
    await supabaseRequest(`${supabaseUrl}/rest/v1/ingestion_runs`, serviceRoleKey, {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        source: 'kma_aws', scope_region_code: '41280', period_start: range.start, period_end: range.end,
        status, accepted_count: acceptedCount, excluded_count: excludedCount,
        message: errors.join(' | '), finished_at: new Date().toISOString(),
      }),
    })

    return jsonResponse({ ok: status !== 'failed', year, month, stationCount: storedStations.length, acceptedCount, excludedCount, status, errors })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Historical weather import failed.'
    try {
      await supabaseRequest(`${supabaseUrl}/rest/v1/ingestion_runs`, serviceRoleKey, {
        method: 'POST', headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          source: 'kma_aws', scope_region_code: '41280', period_start: range.start, period_end: range.end,
          status: 'failed', accepted_count: acceptedCount, excluded_count: excludedCount,
          message, finished_at: new Date().toISOString(),
        }),
      })
    } catch { /* preserve the original error */ }
    return jsonResponse({ ok: false, year, month, error: message }, 500)
  }
})
