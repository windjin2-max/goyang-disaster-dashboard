const POPULATION_API_URL = 'https://apis.data.go.kr/1741000/admmPpltnHhStus/selectAdmmPpltnHhStus'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function decodedKey(key: string) {
  try { return decodeURIComponent(key) } catch { return key }
}

function jwtRole(token: string | undefined) {
  if (!token) return ''
  try {
    const payload = token.split('.')[1]
    if (!payload) return ''
    return String(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role ?? '')
  } catch {
    return ''
  }
}

function findItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  if (!payload || typeof payload !== 'object') return []
  const value = payload as Record<string, unknown>
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

function previousMonth(offset = 1) {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000)
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - offset)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function value(row: Record<string, unknown>, key: string) {
  return String(row[key] ?? '').replaceAll(',', '').trim()
}

function integerValue(row: Record<string, unknown>, key: string) {
  const parsed = Number(value(row, key))
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${key} value for ${value(row, 'dongNm') || 'unknown dong'}.`)
  return parsed
}

async function supabaseRpc(url: string, serviceRoleKey: string, functionName: string, body: unknown) {
  const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase RPC ${functionName} failed (HTTP ${response.status}): ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}

async function fetchPopulationRows(key: string, month: string) {
  const url = new URL(POPULATION_API_URL)
  url.searchParams.set('serviceKey', decodedKey(key))
  url.searchParams.set('admmCd', '4128000000')
  url.searchParams.set('srchFrYm', month)
  url.searchParams.set('srchToYm', month)
  url.searchParams.set('lv', '3')
  url.searchParams.set('regSeCd', '1')
  url.searchParams.set('type', 'JSON')
  url.searchParams.set('numOfRows', '1000')
  url.searchParams.set('pageNo', '1')
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`Population API request failed (HTTP ${response.status}): ${text.slice(0, 300)}`)
  let payload: unknown
  try { payload = JSON.parse(text) } catch { throw new Error(`Population API returned non-JSON data: ${text.slice(0, 300)}`) }
  return findItems(payload)
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  const suppliedToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!supabaseUrl || !serviceRoleKey || jwtRole(suppliedToken) !== 'service_role') return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)

  const populationKey = Deno.env.get('MOIS_RESIDENT_POPULATION_SERVICE_KEY')?.trim()
  if (!populationKey) return jsonResponse({ ok: false, error: 'Population API secret is unavailable.' }, 500)

  try {
    let input: { month?: string } = {}
    try { input = await request.json() } catch { /* use latest available month */ }
    let selectedMonth = String(input.month ?? '').replace(/[^0-9]/g, '')
    let rows: Record<string, unknown>[] = []
    for (let offset = 1; offset <= 4 && !rows.length; offset += 1) {
      const month = selectedMonth || previousMonth(offset)
      rows = await fetchPopulationRows(populationKey, month)
      if (rows.length) selectedMonth = month
      if (input.month) break
    }
    const diagnostic = {
      ok: true,
      statisticMonth: selectedMonth,
      rowCount: rows.length,
      fieldNames: rows[0] ? Object.keys(rows[0]) : [],
      samples: rows.slice(0, 5).map((row) => Object.fromEntries(
        Object.entries(row).filter(([key]) => /cd|nm|cnt|ym/i.test(key)),
      )),
    }
    if ((input as { action?: string }).action === 'diagnose') return jsonResponse(diagnostic)

    const normalizedRows = rows
      .filter((row) => value(row, 'sggNm').includes('고양시'))
      .map((row) => ({
        districtName: value(row, 'sggNm'),
        dongName: value(row, 'dongNm'),
        moisAdminCode: value(row, 'admmCd'),
        population: integerValue(row, 'totNmprCnt'),
        malePopulation: integerValue(row, 'maleNmprCnt'),
        femalePopulation: integerValue(row, 'femlNmprCnt'),
        households: integerValue(row, 'hhCnt'),
        peoplePerHousehold: value(row, 'hhNmpr'),
        raw: row,
      }))
    const imported = await supabaseRpc(supabaseUrl, serviceRoleKey, 'import_mois_population', {
      p_rows: normalizedRows,
      p_statistic_month: selectedMonth,
    })
    return jsonResponse({ ...diagnostic, imported })
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Population diagnostic failed.' }, 502)
  }
})
