import type { DisasterArea, DisasterMapPoint, HistoricalAnalysis, HistoricalMetricFilter } from '../types'
import { supabase } from './supabase'

type RawAnalysis = {
  scope?: { regionCode?: string; regionName?: string }
  period?: { start?: string; end?: string }
  generatedAt?: string
  summary?: Record<string, unknown>
  stations?: Array<Record<string, unknown>>
  areas?: Array<Record<string, unknown>>
  sources?: Array<Record<string, unknown>>
}

const numberOrNull = (value: unknown) => {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function emptyHistoricalAnalysis(start = '2020-01-01', end = '2025-12-31'): HistoricalAnalysis {
  return {
    schemaReady: false,
    scope: { regionCode: '41280', regionName: '경기도 고양시' },
    period: { start, end },
    generatedAt: '',
    summary: {
      stationCount: 0,
      observationCount: 0,
      maxRainfall1h: null,
      maxRainfallDaily: null,
      maxSnowDepth: null,
      maxWaterLevel: null,
      floodTraceCount: 0,
      analysedFacilityCount: 0,
    },
    stations: [],
    areas: [],
    sources: [],
  }
}

export async function fetchHistoricalAnalysis(start: string, end: string): Promise<HistoricalAnalysis> {
  if (!supabase) return emptyHistoricalAnalysis(start, end)
  const { data, error } = await supabase.rpc('get_historical_analysis', { p_start: start, p_end: end })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01') return emptyHistoricalAnalysis(start, end)
    throw new Error(`과거 재난 분석 조회 실패: ${error.message}`)
  }
  const raw = (data ?? {}) as RawAnalysis
  const summary = raw.summary ?? {}
  return {
    schemaReady: true,
    scope: { regionCode: raw.scope?.regionCode ?? '41280', regionName: raw.scope?.regionName ?? '경기도 고양시' },
    period: { start: raw.period?.start ?? start, end: raw.period?.end ?? end },
    generatedAt: raw.generatedAt ?? '',
    summary: {
      stationCount: Number(summary.stationCount ?? 0),
      observationCount: Number(summary.observationCount ?? 0),
      maxRainfall1h: numberOrNull(summary.maxRainfall1h),
      maxRainfallDaily: numberOrNull(summary.maxRainfallDaily),
      maxSnowDepth: numberOrNull(summary.maxSnowDepth),
      maxWaterLevel: numberOrNull(summary.maxWaterLevel),
      floodTraceCount: Number(summary.floodTraceCount ?? 0),
      analysedFacilityCount: Number(summary.analysedFacilityCount ?? 0),
    },
    stations: (raw.stations ?? []).map((row) => ({
      source: String(row.source ?? ''),
      stationCode: String(row.station_code ?? ''),
      stationName: String(row.station_name ?? ''),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      metric: String(row.metric ?? ''),
      maxValue: numberOrNull(row.max_value),
      firstObservedAt: String(row.first_observed_at ?? ''),
      lastObservedAt: String(row.last_observed_at ?? ''),
      observationCount: Number(row.observation_count ?? 0),
    })),
    areas: (raw.areas ?? []).flatMap((row) => {
      const geojson = row.geojson as { type?: string; coordinates?: unknown } | undefined
      if (!geojson?.coordinates) return []
      const polygons = geojson.type === 'MultiPolygon'
        ? geojson.coordinates as number[][][][]
        : [geojson.coordinates as number[][][]]
      return polygons.map((coordinates, index) => ({
        id: `${String(row.id)}-${index}`,
        name: String(row.name ?? '침수·홍수 공간자료'),
        kind: String(row.kind ?? 'floodTrace') as DisasterArea['kind'],
        coordinates,
        value: numberOrNull(row.value),
        unit: String(row.unit ?? ''),
      }))
    }),
    sources: (raw.sources ?? []).map((row) => ({
      source: String(row.source ?? ''),
      status: String(row.status ?? 'pending') as HistoricalAnalysis['sources'][number]['status'],
      acceptedCount: Number(row.accepted_count ?? 0),
      excludedCount: Number(row.excluded_count ?? 0),
      message: String(row.message ?? ''),
      finishedAt: String(row.finished_at ?? ''),
    })),
  }
}

export function historicalMapPoints(analysis: HistoricalAnalysis, filter: HistoricalMetricFilter): DisasterMapPoint[] {
  return analysis.stations.flatMap((station) => {
    const kind = station.metric.startsWith('rainfall') ? 'rainfall'
      : station.metric.includes('snow') ? 'snowfall'
        : station.metric === 'water_level' || station.metric === 'flow_rate' ? 'waterLevel'
          : null
    if (!kind || (filter !== 'all' && filter !== kind)) return []
    return [{
      id: `${station.source}-${station.stationCode}-${station.metric}`,
      name: `${station.stationName} · 기간 최대`,
      kind,
      latitude: station.latitude,
      longitude: station.longitude,
      value: station.maxValue,
      unit: kind === 'waterLevel' ? 'm' : kind === 'snowfall' ? 'cm' : 'mm',
      source: station.source,
      observedAt: station.lastObservedAt,
    } satisfies DisasterMapPoint]
  })
}

export function historicalMapAreas(analysis: HistoricalAnalysis, filter: HistoricalMetricFilter): DisasterArea[] {
  if (filter === 'all' || filter === 'flood') return analysis.areas
  return []
}
