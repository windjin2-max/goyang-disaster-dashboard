export type FacilityStatus = '운영중' | '점검필요' | '비활성'

export interface Facility {
  id: string
  name: string
  type: string
  sourceType: string
  status: FacilityStatus
  address: string
  district: string
  longitude: number | null
  latitude: number | null
  agency: string
  installedAt: string
  detail: string
  pnu: string
  postalCode: string
  sourceSheet: string
  sourceRow: number
  original?: Record<string, unknown>
}

export interface FacilityData {
  sourceFile: string
  generatedAt: string
  total: number
  facilities: Facility[]
}

export interface Filters {
  query: string
  type: string
  status: string
  district: string
  agency: string
}

export interface ChangeRecord {
  id: string
  facilityId: string
  facilityName: string
  action: '등록' | '수정' | '상태변경' | '일괄등록' | '초기화'
  changedAt: string
  summary: string
}

export type ViewName = 'dashboard' | 'map' | 'nearby' | 'facilities'
