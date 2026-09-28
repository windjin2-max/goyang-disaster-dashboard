const SGIS_BASE_URL = 'https://sgisapi.mods.go.kr/OpenAPI3'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function fetchJson(url: URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  const text = await response.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`SGIS returned a non-JSON response (HTTP ${response.status}).`)
  }
  if (!response.ok) throw new Error(`SGIS request failed (HTTP ${response.status}).`)
  const errorCode = String(payload.errCd ?? '0')
  if (errorCode !== '0') throw new Error(`SGIS error ${errorCode}: ${String(payload.errMsg ?? 'Unknown error')}`)
  return payload
}

async function createAccessToken(consumerKey: string, consumerSecret: string) {
  const url = new URL(`${SGIS_BASE_URL}/auth/authentication.json`)
  url.searchParams.set('consumer_key', consumerKey)
  url.searchParams.set('consumer_secret', consumerSecret)
  const payload = await fetchJson(url)
  const result = payload.result as Record<string, unknown> | undefined
  const accessToken = String(result?.accessToken ?? '').trim()
  if (!accessToken) throw new Error('SGIS authentication succeeded without an access token.')
  return accessToken
}

async function findGoyangDistricts(accessToken: string) {
  const url = new URL(`${SGIS_BASE_URL}/addr/stage.json`)
  url.searchParams.set('accessToken', accessToken)
  url.searchParams.set('cd', '31')
  url.searchParams.set('pg_yn', '0')
  const payload = await fetchJson(url)
  const rows = Array.isArray(payload.result) ? payload.result as Array<Record<string, unknown>> : []
  return rows
    .filter((row) => Object.values(row).some((value) => String(value).includes('고양')))
    .map((row) => ({
      code: String(row.cd ?? `${row.sido_cd ?? ''}${row.sgg_cd ?? ''}`).trim(),
      districtName: String(row.sgg_nm ?? row.addr_name ?? row.full_addr ?? '').trim(),
      fullAddress: String(row.full_addr ?? '').trim(),
    }))
}

async function fetchDistrictBoundaries(accessToken: string, district: { code: string; districtName: string }, year: number) {
  const url = new URL(`${SGIS_BASE_URL}/boundary/hadmarea.geojson`)
  url.searchParams.set('accessToken', accessToken)
  url.searchParams.set('year', String(year))
  url.searchParams.set('adm_cd', district.code)
  url.searchParams.set('low_search', '1')
  let payload: Record<string, unknown>
  try {
    payload = await fetchJson(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown SGIS boundary error.'
    throw new Error(`${district.districtName}(${district.code}) boundary request failed: ${message}`)
  }
  const features = Array.isArray(payload.features) ? payload.features as Array<Record<string, unknown>> : []
  return features.flatMap((feature) => {
    const properties = feature.properties as Record<string, unknown> | undefined
    const geometry = feature.geometry as Record<string, unknown> | undefined
    const adminCode = String(properties?.adm_cd ?? '').trim()
    const adminName = String(properties?.adm_nm ?? '').trim()
    if (!adminCode || !adminName || !geometry) return []
    return [{
      adminCode,
      adminName,
      districtCode: district.code,
      districtName: district.districtName,
      geometry,
    }]
  })
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

function jwtRole(token: string | undefined) {
  if (!token) return ''
  try {
    const payload = token.split('.')[1]
    if (!payload) return ''
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    return String(JSON.parse(atob(normalized)).role ?? '')
  } catch {
    return ''
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim()
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  const suppliedToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!supabaseUrl || !serviceRoleKey || jwtRole(suppliedToken) !== 'service_role') {
    return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
  }

  const consumerKey = Deno.env.get('SGIS_CONSUMER_KEY')?.trim()
  const consumerSecret = Deno.env.get('SGIS_CONSUMER_SECRET')?.trim()
  if (!consumerKey || !consumerSecret) {
    return jsonResponse({ ok: false, error: 'SGIS server secrets are unavailable.' }, 500)
  }

  try {
    let input: { action?: string; year?: number } = {}
    try { input = await request.json() } catch { /* an empty body uses defaults */ }
    const year = Number(input.year ?? 2025)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return jsonResponse({ ok: false, error: 'A valid SGIS source year is required.' }, 400)
    }
    const accessToken = await createAccessToken(consumerKey, consumerSecret)
    const districts = await findGoyangDistricts(accessToken)
    if (districts.length !== 3) throw new Error(`Expected 3 Goyang districts, received ${districts.length}.`)
    if (input.action === 'diagnose') {
      return jsonResponse({ ok: true, authenticated: true, districtCount: districts.length, districts })
    }
    const features: Array<Record<string, unknown>> = []
    for (const district of districts) {
      features.push(...await fetchDistrictBoundaries(accessToken, district, year))
    }
    if (!features.length) throw new Error(`SGIS returned no Goyang administrative-dong boundaries for ${year}.`)
    const imported = await supabaseRpc(supabaseUrl, serviceRoleKey, 'import_sgis_admin_dong_boundaries', {
      p_features: features,
      p_source_year: year,
    }) as Record<string, unknown>
    return jsonResponse({
      ok: true,
      authenticated: true,
      districtCount: districts.length,
      districts,
      fetchedFeatureCount: features.length,
      imported,
    })
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'SGIS boundary diagnostic failed.',
    }, 502)
  }
})
