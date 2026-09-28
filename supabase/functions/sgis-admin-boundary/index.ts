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

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405)

  const consumerKey = Deno.env.get('SGIS_CONSUMER_KEY')?.trim()
  const consumerSecret = Deno.env.get('SGIS_CONSUMER_SECRET')?.trim()
  if (!consumerKey || !consumerSecret) {
    return jsonResponse({ ok: false, error: 'SGIS server secrets are unavailable.' }, 500)
  }

  try {
    const accessToken = await createAccessToken(consumerKey, consumerSecret)
    const districts = await findGoyangDistricts(accessToken)
    return jsonResponse({
      ok: true,
      authenticated: true,
      districtCount: districts.length,
      districts,
    })
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'SGIS boundary diagnostic failed.',
    }, 502)
  }
})
