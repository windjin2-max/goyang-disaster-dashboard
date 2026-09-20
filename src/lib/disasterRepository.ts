import type { DisasterOverview, DisasterSourceId } from '../types'
import { supabase } from './supabase'

const SOURCE_LABELS: Record<DisasterSourceId, string> = {
  weather: '기상청 강수·적설',
  hydrology: '한강홍수통제소 수문',
  kwater: 'K-water 우량·수위',
  flood: '생활안전지도 침수흔적',
  pump: '전국 배수펌프장',
  population: '행정안전부 주민등록 인구',
}

export function emptyDisasterOverview(message = '데이터 수집을 기다리고 있습니다.'): DisasterOverview {
  return {
    generatedAt: '',
    locationLabel: '고양시',
    weather: { rainfall1h: null, temperature: null, humidity: null, snowDepth: null },
    points: [],
    areas: [],
    population: null,
    floodTraceMatched: null,
    sources: (Object.entries(SOURCE_LABELS) as [DisasterSourceId, string][]).map(([id, label]) => ({
      id,
      label,
      state: 'configured',
      message,
    })),
  }
}

export async function fetchDisasterOverview(location?: { latitude: number; longitude: number; address?: string }) {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.')

  const { data, error } = await supabase.functions.invoke<DisasterOverview>('disaster-overview', {
    body: location ?? { latitude: 37.6584, longitude: 126.832, address: '경기도 고양시' },
  })

  if (error) throw new Error(`재난 API 조회 실패: ${error.message}`)
  if (!data) throw new Error('재난 API가 빈 응답을 반환했습니다.')
  return data
}

export async function fetchFloodOverlay(input: { bbox: [number, number, number, number]; width: number; height: number }) {
  if (!supabase) return null
  const { data, error } = await supabase.functions.invoke<{ imageDataUrl?: string }>('disaster-overview', {
    body: { action: 'flood-wms', ...input },
  })
  if (error || !data?.imageDataUrl) return null
  return data.imageDataUrl
}

export function formatMetric(value: number | null | undefined, unit: string, fallback = '수집 대기') {
  return value == null || Number.isNaN(value) ? fallback : `${value.toLocaleString('ko-KR')}${unit}`
}
