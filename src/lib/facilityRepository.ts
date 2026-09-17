import type { ChangeRecord, Facility } from '../types'
import { supabase } from './supabase'

interface FacilityRow {
  id: string
  name: string
  type: string
  source_type: string
  status: Facility['status']
  address: string
  district: string
  longitude: number | null
  latitude: number | null
  agency: string
  installed_at: string
  detail: string
  pnu: string
  postal_code: string
  source_sheet: string
  source_row: number
  original: Record<string, unknown> | null
  updated_at?: string
}

interface HistoryRow {
  id: string
  facility_id: string
  facility_name: string
  action: ChangeRecord['action']
  changed_at: string
  summary: string
}

function requireClient() {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.')
  return supabase
}

function fromRow(row: FacilityRow): Facility {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourceType: row.source_type,
    status: row.status,
    address: row.address,
    district: row.district,
    longitude: row.longitude,
    latitude: row.latitude,
    agency: row.agency,
    installedAt: row.installed_at,
    detail: row.detail,
    pnu: row.pnu,
    postalCode: row.postal_code,
    sourceSheet: row.source_sheet,
    sourceRow: row.source_row,
    original: row.original ?? undefined,
  }
}

function toRow(facility: Facility, userId: string, isNew: boolean) {
  return {
    id: facility.id,
    name: facility.name,
    type: facility.type,
    source_type: facility.sourceType,
    status: facility.status,
    address: facility.address,
    district: facility.district,
    longitude: facility.longitude,
    latitude: facility.latitude,
    agency: facility.agency,
    installed_at: facility.installedAt,
    detail: facility.detail,
    pnu: facility.pnu,
    postal_code: facility.postalCode,
    source_sheet: facility.sourceSheet,
    source_row: facility.sourceRow,
    original: facility.original ?? {},
    updated_at: new Date().toISOString(),
    updated_by: userId,
    ...(isNew ? { created_by: userId } : {}),
  }
}

function fromHistoryRow(row: HistoryRow): ChangeRecord {
  return {
    id: row.id,
    facilityId: row.facility_id,
    facilityName: row.facility_name,
    action: row.action,
    changedAt: row.changed_at,
    summary: row.summary,
  }
}

async function currentUserId() {
  const client = requireClient()
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('관리자 로그인 정보를 확인하지 못했습니다.')
  return data.user.id
}

export async function fetchFacilities() {
  const client = requireClient()
  const { data, error } = await client.from('facilities').select('*').order('name')
  if (error) throw new Error(`시설물 조회 실패: ${error.message}`)
  const rows = (data ?? []) as FacilityRow[]
  return {
    facilities: rows.map(fromRow),
    latestUpdatedAt: rows.reduce((latest, row) => row.updated_at && row.updated_at > latest ? row.updated_at : latest, ''),
  }
}

export async function fetchFacilityHistory() {
  const client = requireClient()
  const { data, error } = await client.from('facility_change_history').select('*').order('changed_at', { ascending: false }).limit(100)
  if (error) throw new Error(`변경 이력 조회 실패: ${error.message}`)
  return ((data ?? []) as HistoryRow[]).map(fromHistoryRow)
}

export async function persistFacility(
  facility: Facility,
  exists: boolean,
  action: ChangeRecord['action'],
  summary: string,
) {
  const client = requireClient()
  const userId = await currentUserId()
  const request = exists
    ? client.from('facilities').update(toRow(facility, userId, false)).eq('id', facility.id)
    : client.from('facilities').insert(toRow(facility, userId, true))
  const { data, error } = await request.select('*').single()
  if (error) throw new Error(`시설물 저장 실패: ${error.message}`)

  const { data: historyData, error: historyError } = await client.from('facility_change_history').insert({
    facility_id: facility.id,
    facility_name: facility.name,
    action,
    summary,
  }).select('*').single()
  if (historyError) throw new Error(`수정 이력 저장 실패: ${historyError.message}`)

  return {
    facility: fromRow(data as FacilityRow),
    history: fromHistoryRow(historyData as HistoryRow),
  }
}

export async function importFacilities(rows: Facility[]) {
  if (!rows.length) return []
  const client = requireClient()
  const userId = await currentUserId()
  const saved: Facility[] = []

  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100)
    const { data, error } = await client.from('facilities').insert(chunk.map((facility) => toRow(facility, userId, true))).select('*')
    if (error) throw new Error(`일괄 등록 실패: ${error.message}`)
    saved.push(...((data ?? []) as FacilityRow[]).map(fromRow))

    const { error: historyError } = await client.from('facility_change_history').insert(chunk.map((facility) => ({
      facility_id: facility.id,
      facility_name: facility.name,
      action: '일괄등록',
      summary: '엑셀·CSV 파일에서 시설물을 등록했습니다.',
    })))
    if (historyError) throw new Error(`일괄 등록 이력 저장 실패: ${historyError.message}`)
  }

  return saved
}
