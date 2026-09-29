import type { AdminDongFloodExposure, FacilityFloodExposure, FloodOverlapSummary, FloodResultLayerCode } from '../types'
import { supabase } from './supabase'

function client() {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.')
  return supabase
}

export async function fetchFloodOverlapSummary(): Promise<FloodOverlapSummary> {
  const { data, error } = await client().rpc('get_flood_overlap_summary')
  if (error) throw new Error(`분석 결과 요약 조회 실패: ${error.message}`)
  const summary = data as FloodOverlapSummary | null
  if (!summary?.layers) throw new Error('분석 결과 요약이 비어 있습니다.')
  return summary
}

export async function fetchFacilityFloodExposure(layerCode: FloodResultLayerCode): Promise<FacilityFloodExposure[]> {
  const { data, error } = await client().from('facility_flood_exposure')
    .select('facility_id,layer_code,max_depth_m,depth_label,frequency_years,calculated_at')
    .eq('layer_code', layerCode).eq('is_exposed', true).order('facility_id')
  if (error) throw new Error(`중첩 시설 조회 실패: ${error.message}`)
  return (data ?? []).map((row) => ({
    facilityId: row.facility_id,
    layerCode: row.layer_code as FloodResultLayerCode,
    maxDepthM: row.max_depth_m == null ? null : Number(row.max_depth_m),
    depthLabel: row.depth_label,
    frequencyYears: row.frequency_years,
    calculatedAt: row.calculated_at,
  }))
}

export async function fetchAdminDongFloodExposure(layerCode: FloodResultLayerCode, statisticMonth: string): Promise<AdminDongFloodExposure[]> {
  const { data, error } = await client().from('admin_dong_flood_exposure')
    .select('admin_code,layer_code,statistic_month,hazard_area_sq_km,hazard_area_percent,population,estimated_exposed_population,max_depth_m,calculated_at')
    .eq('layer_code', layerCode).eq('statistic_month', statisticMonth).order('hazard_area_percent', { ascending: false })
  if (error) throw new Error(`행정동·인구 중첩 결과 조회 실패: ${error.message}`)
  return (data ?? []).map((row) => ({
    adminCode: row.admin_code,
    layerCode: row.layer_code as FloodResultLayerCode,
    statisticMonth: row.statistic_month,
    hazardAreaSquareKm: Number(row.hazard_area_sq_km),
    hazardAreaPercent: Number(row.hazard_area_percent),
    population: Number(row.population),
    estimatedExposedPopulation: Number(row.estimated_exposed_population),
    maxDepthM: row.max_depth_m == null ? null : Number(row.max_depth_m),
    calculatedAt: row.calculated_at,
  }))
}
