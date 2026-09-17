import type { Facility, Filters } from './types'

export const typeColors = [
  '#2f80ed', '#0f9aaa', '#f08a24', '#7b61d1', '#18a76e', '#d34d64',
  '#54728f', '#b07135', '#1e88a8', '#7c8f2c', '#c4579f', '#5367d7',
]

export function colorForType(type: string, allTypes: string[]) {
  const index = Math.max(0, allTypes.indexOf(type))
  return typeColors[index % typeColors.length]
}

export function filterFacilities(facilities: Facility[], filters: Filters) {
  const query = filters.query.trim().toLocaleLowerCase('ko-KR')
  return facilities.filter((facility) => {
    const matchesQuery = !query || [facility.name, facility.address, facility.agency, facility.longitude, facility.latitude]
      .join(' ').toLocaleLowerCase('ko-KR').includes(query)
    return matchesQuery
      && (!filters.type || facility.type === filters.type)
      && (!filters.status || facility.status === filters.status)
      && (!filters.district || facility.district === filters.district)
      && (!filters.agency || facility.agency === filters.agency)
  })
}

export function haversineKm(
  a: Pick<Facility, 'latitude' | 'longitude'>,
  b: Pick<Facility, 'latitude' | 'longitude'>,
) {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null
  const radius = 6371
  const toRad = (value: number) => value * Math.PI / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

export function formatCoordinate(value: number | null) {
  return value == null ? '미등록' : value.toFixed(6)
}

export function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function toCsv(facilities: Facility[]) {
  const headers = ['시설ID', '시설명', '시설유형', '운영상태', '주소', '행정구역', 'X좌표', 'Y좌표', '관리부서', '설치연도', '상세정보', '원본시트', '원본행']
  const rows = facilities.map((facility) => [
    facility.id, facility.name, facility.type, facility.status, facility.address, facility.district,
    facility.longitude ?? '', facility.latitude ?? '', facility.agency, facility.installedAt,
    facility.detail, facility.sourceSheet, facility.sourceRow,
  ])
  const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  return '\ufeff' + [headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')
}
