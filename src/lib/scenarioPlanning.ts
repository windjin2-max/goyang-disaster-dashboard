import type { Facility, FloodResultLayerCode, PopulationBoundaryFeature } from '../types'

type Geometry = PopulationBoundaryFeature['geometry']

export interface ReviewFunction {
  label: string
  candidateTypes: string
  purpose: string
  existingCount: number
}

const functionsByScenario: Record<FloodResultLayerCode, { label: string; candidateTypes: string; purpose: string; matches: (facility: Facility) => boolean }[]> = {
  national_river_flood: [
    { label: '수위 관측', candidateTypes: '수위계', purpose: '상·하류 수위 관측 지점 검토', matches: (facility) => facility.type === '수위계' },
    { label: '하천 영상감시', candidateTypes: 'CCTV(하천감시)', purpose: '범람 징후를 확인할 촬영 범위 검토', matches: (facility) => facility.type === 'CCTV(하천감시)' },
    { label: '주민 경보', candidateTypes: '자동음성통보 · 재해문자전광판', purpose: '하천 주변·대피 동선의 경보 전달 검토', matches: isWarningFacility },
  ],
  local_river_flood: [
    { label: '수위 관측', candidateTypes: '수위계', purpose: '상·하류 수위 관측 지점 검토', matches: (facility) => facility.type === '수위계' },
    { label: '하천 영상감시', candidateTypes: 'CCTV(하천감시)', purpose: '범람 징후를 확인할 촬영 범위 검토', matches: (facility) => facility.type === 'CCTV(하천감시)' },
    { label: '주민 경보', candidateTypes: '자동음성통보 · 재해문자전광판', purpose: '하천 주변·대피 동선의 경보 전달 검토', matches: isWarningFacility },
  ],
  urban_flood: [
    { label: '강우 관측', candidateTypes: '강우량계 · AWS', purpose: '국지성 강우 관측 공백 검토', matches: (facility) => facility.type === '강우량계' || facility.type === 'AWS' },
    { label: '도로 영상감시', candidateTypes: 'CCTV(도로감시)', purpose: '저지대·지하차도 등 촬영 범위 검토', matches: (facility) => facility.type === 'CCTV(도로감시)' },
    { label: '현장 경보', candidateTypes: '자동음성통보 · 재해문자전광판', purpose: '침수 예상지 인근 대피 동선의 경보 전달 검토', matches: isWarningFacility },
  ],
}

function isWarningFacility(facility: Facility) {
  return facility.type === '자동음성통보' || facility.type === '재해문자전광판'
}

function pointInRing(longitude: number, latitude: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > latitude) !== (yj > latitude)
      && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function facilityInBoundary(facility: Facility, geometry: Geometry): boolean {
  const { longitude, latitude } = facility
  if (longitude == null || latitude == null) return false
  const polygons = geometry.type === 'MultiPolygon'
    ? geometry.coordinates as number[][][][]
    : [geometry.coordinates as number[][][]]
  return polygons.some((rings) => rings.length > 0
    && pointInRing(longitude, latitude, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(longitude, latitude, hole)))
}

export function reviewExistingFacilities(facilities: Facility[], geometry: Geometry, layer: FloodResultLayerCode) {
  const existing = facilities.filter((facility) => facility.status === '운영중' && facilityInBoundary(facility, geometry))
  const functions: ReviewFunction[] = functionsByScenario[layer].map(({ label, candidateTypes, purpose, matches }) => ({
    label,
    candidateTypes,
    purpose,
    existingCount: existing.filter(matches).length,
  }))
  return { existingCount: existing.length, functions }
}
