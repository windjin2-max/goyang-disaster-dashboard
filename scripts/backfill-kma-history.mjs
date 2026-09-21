const endpoint = 'https://kqucbymdlhojssjczkjr.supabase.co/functions/v1/historical-weather-import'
const token = process.env.HISTORICAL_IMPORT_TOKEN
const concurrency = Math.max(1, Math.min(3, Number(process.env.KMA_CONCURRENCY ?? 1)))

if (!token) throw new Error('HISTORICAL_IMPORT_TOKEN is required.')

const requestedMonths = (process.env.KMA_MONTHS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const jobs = requestedMonths.length
  ? requestedMonths.map((value) => {
      const match = /^(\d{4})-(\d{2})$/.exec(value)
      if (!match) throw new Error(`Invalid KMA_MONTHS value: ${value}`)
      return { year: Number(match[1]), month: Number(match[2]) }
    })
  : Array.from({ length: 72 }, (_, index) => ({ year: 2020 + Math.floor(index / 12), month: (index % 12) + 1 }))

const results = []
let cursor = 0

async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor]
    cursor += 1
    const label = `${job.year}-${String(job.month).padStart(2, '0')}`
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-historical-import-token': token,
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(180_000),
      })
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
      results.push({ ...job, httpStatus: response.status, ...payload })
      console.log(`${label} ${payload.status ?? 'failed'} ${payload.acceptedCount ?? 0}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed'
      results.push({ ...job, ok: false, error: message })
      console.log(`${label} failed 0 (${message})`)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

const failed = results.filter((result) => !result.ok)
const accepted = results.reduce((sum, result) => sum + Number(result.acceptedCount ?? 0), 0)
console.log(JSON.stringify({ months: results.length, accepted, failed: failed.length, failedMonths: failed.map(({ year, month, error, errors }) => ({ year, month, error, errors })) }, null, 2))

if (failed.length) process.exitCode = 1
