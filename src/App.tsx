import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as XLSX from 'xlsx'
import {
  Activity, Building2, CheckCircle2, ChevronRight, CircleGauge, Database, Download,
  FileDown, History, LayoutDashboard, ListChecks, Map as MapIcon,
  LocateFixed, LogOut, MapPin, Menu, Pencil, Plus, RefreshCcw, Search, Siren, SlidersHorizontal, TriangleAlert,
  Upload, X,
} from 'lucide-react'
import KakaoMap from './KakaoMap'
import FacilityModal from './FacilityModal'
import type { ChangeRecord, Facility, Filters, ViewName } from './types'
import { fetchFacilities, fetchFacilityHistory, importFacilities, persistFacility } from './lib/facilityRepository'
import { CCTV_ALL_TYPE, colorForType, downloadText, filterFacilities, formatCoordinate, haversineKm, isCctvType, toCsv } from './utils'

const emptyFilters: Filters = { query: '', type: '', status: '', district: '', agency: '' }
const defaultMapFilters: Filters = { ...emptyFilters, status: '운영중' }

interface NearbyLocation {
  address: string
  latitude: number
  longitude: number
}

function countBy(items: Facility[], key: keyof Facility) {
  const counts = new globalThis.Map<string, number>()
  items.forEach((item) => {
    const value = String(item[key] || '미분류')
    counts.set(value, (counts.get(value) ?? 0) + 1)
  })
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function normalizeImportedRow(row: Record<string, unknown>, index: number, source = '일괄등록'): Facility | null {
  const name = String(row['시설명'] ?? row['지점명'] ?? row['지정명'] ?? '').trim()
  const upper = String(row['지번주소 상위부분'] ?? '')
  const lower = String(row['지번주소 하위부분'] ?? '')
  const address = String(row['주소'] ?? `${upper} ${lower}`).trim()
  const longitude = Number(row['X좌표'] ?? row['경도'])
  const latitude = Number(row['Y좌표'] ?? row['위도'])
  if (!name || !address || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  const district = ['덕양구', '일산동구', '일산서구'].find((value) => address.includes(value)) ?? '미분류'
  return {
    id: `import-${crypto.randomUUID()}`,
    name,
    type: String(row['시설유형'] ?? row['유형'] ?? source),
    sourceType: source,
    status: String(row['운영상태'] ?? '운영중') as Facility['status'],
    address,
    district,
    longitude,
    latitude,
    agency: String(row['관리부서'] ?? row['관련과'] ?? '미등록'),
    installedAt: String(row['설치연도'] ?? row['설치년도'] ?? ''),
    detail: String(row['상세정보'] ?? row['설치목적'] ?? row['시설명'] ?? ''),
    pnu: String(row['PNU코드'] ?? ''),
    postalCode: String(row['새우편번호'] ?? row['우편번호'] ?? ''),
    sourceSheet: source,
    sourceRow: index + 2,
  }
}

export default function App({ onSignOut }: { onSignOut?: () => void | Promise<void> }) {
  const [view, setView] = useState<ViewName>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [dataInfo, setDataInfo] = useState({ sourceFile: '', generatedAt: '' })
  const [filters, setFilters] = useState<Filters>(defaultMapFilters)
  const [selected, setSelected] = useState<Facility | null>(null)
  const [editing, setEditing] = useState<Facility | null | undefined>(undefined)
  const [history, setHistory] = useState<ChangeRecord[]>([])
  const [toast, setToast] = useState('')
  const [page, setPage] = useState(1)
  const [nearbyAddress, setNearbyAddress] = useState('')
  const [nearbyRequest, setNearbyRequest] = useState<{ address: string; id: number } | null>(null)
  const [nearbyLocation, setNearbyLocation] = useState<NearbyLocation | null>(null)
  const [nearbyError, setNearbyError] = useState('')
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pageSize = 12

  const loadDatabase = useCallback(async () => {
    try {
      const [facilityResult, historyResult] = await Promise.all([fetchFacilities(), fetchFacilityHistory()])
      setFacilities(facilityResult.facilities)
      setHistory(historyResult)
      setDataInfo({ sourceFile: 'Supabase 시설물 DB', generatedAt: facilityResult.latestUpdatedAt ? facilityResult.latestUpdatedAt.slice(0, 10) : '-' })
      setSelected((current) => current ? facilityResult.facilities.find((item) => item.id === current.id) ?? null : facilityResult.facilities[0] ?? null)
      return true
    } catch (error) {
      setToast(error instanceof Error ? error.message : '시설물 데이터를 불러오지 못했습니다.')
      return false
    }
  }, [])

  useEffect(() => { void loadDatabase() }, [loadDatabase])
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 2800); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => setPage(1), [filters])

  const types = useMemo(() => [...new Set(facilities.map((item) => item.type))].sort(), [facilities])
  const districts = useMemo(() => [...new Set(facilities.map((item) => item.district))].sort((a, b) => {
    if (a === '미분류') return 1
    if (b === '미분류') return -1
    return a.localeCompare(b, 'ko')
  }), [facilities])
  const agencies = useMemo(() => [...new Set(facilities.map((item) => item.agency))].sort(), [facilities])
  const filtered = useMemo(() => filterFacilities(facilities, filters), [facilities, filters])
  const typeCounts = useMemo(() => countBy(facilities, 'type'), [facilities])
  const cctvCount = useMemo(() => facilities.filter((item) => isCctvType(item.type)).length, [facilities])
  const nonCctvTypeCounts = useMemo(() => typeCounts.filter(([type]) => !isCctvType(type)), [typeCounts])
  const nonCctvTypes = useMemo(() => nonCctvTypeCounts.map(([type]) => type), [nonCctvTypeCounts])
  const groupedTypeCount = nonCctvTypeCounts.length + (cctvCount ? 1 : 0)
  const districtCounts = useMemo(() => countBy(facilities, 'district'), [facilities])
  const statusCounts = useMemo(() => countBy(facilities, 'status'), [facilities])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)
  const activeCount = facilities.filter((item) => item.status === '운영중').length
  const coordCount = facilities.filter((item) => item.longitude != null && item.latitude != null).length
  const inspectionCount = facilities.filter((item) => item.status === '점검필요').length
  const missingCoordCount = facilities.length - coordCount
  const districtGradient = useMemo(() => {
    if (!facilities.length || !districtCounts.length) return '#dce4ee'
    const colors = ['#256fd2', '#16a1b3', '#7b61d1', '#e38b2c', '#66768c']
    let cursor = 0
    const segments = districtCounts.map(([, count], index) => {
      const start = cursor
      cursor += count / facilities.length * 100
      return `${colors[index % colors.length]} ${start}% ${cursor}%`
    })
    return `conic-gradient(${segments.join(', ')})`
  }, [districtCounts, facilities.length])
  const nearbyResults = useMemo(() => {
    if (!nearbyLocation) return []
    return facilities
      .map((facility) => ({ facility, distance: haversineKm(nearbyLocation, facility) }))
      .filter((item): item is { facility: Facility; distance: number } => item.distance != null && item.distance <= nearbyRadiusKm)
      .sort((a, b) => a.distance - b.distance)
  }, [facilities, nearbyLocation, nearbyRadiusKm])
  const nearbyIds = useMemo(() => new Set(nearbyResults.map((item) => item.facility.id)), [nearbyResults])

  const notify = (message: string) => setToast(message)
  const goToMap = (nextFilters: Partial<Filters> = {}) => {
    setFilters({ ...emptyFilters, ...nextFilters })
    setView('map')
  }
  const goToNearby = () => {
    setFilters(emptyFilters)
    setSelected(null)
    setView('nearby')
  }
  const searchNearby = (event: FormEvent) => {
    event.preventDefault()
    const address = nearbyAddress.trim()
    if (!address) {
      setNearbyError('검색할 주소를 입력해 주세요.')
      return
    }
    setNearbyError('')
    setNearbyLocation(null)
    setNearbyRequest({ address, id: Date.now() })
  }
  const resetNearby = () => {
    setNearbyAddress('')
    setNearbyRequest(null)
    setNearbyLocation(null)
    setNearbyError('')
    setNearbyRadiusKm(1)
    setSelected(null)
  }
  const handleAddressResolved = useCallback((location: NearbyLocation | null, error?: string) => {
    setNearbyLocation(location)
    setNearbyError(error ?? '')
  }, [])
  const saveFacility = async (facility: Facility) => {
    const exists = facilities.some((item) => item.id === facility.id)
    try {
      const result = await persistFacility(facility, exists, exists ? '수정' : '등록', exists ? '시설 기본정보를 수정했습니다.' : '신규 시설을 등록했습니다.')
      setFacilities((current) => exists ? current.map((item) => item.id === result.facility.id ? result.facility : item) : [result.facility, ...current])
      setHistory((current) => [result.history, ...current].slice(0, 100))
      setEditing(undefined)
      setSelected(result.facility)
      notify(exists ? '시설 정보가 DB에 저장되었습니다.' : '시설이 DB에 등록되었습니다.')
    } catch (error) {
      notify(error instanceof Error ? error.message : '시설물 저장에 실패했습니다.')
    }
  }
  const changeStatus = async (facility: Facility, status: Facility['status']) => {
    const updated = { ...facility, status }
    try {
      const result = await persistFacility(updated, true, '상태변경', `운영 상태를 ${status}(으)로 변경했습니다.`)
      setFacilities((current) => current.map((item) => item.id === result.facility.id ? result.facility : item))
      setSelected(result.facility)
      setHistory((current) => [result.history, ...current].slice(0, 100))
      notify(`운영 상태를 ${status}(으)로 변경했습니다.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '운영 상태 변경에 실패했습니다.')
    }
  }
  const exportCsv = () => downloadText(`재난시설_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(facilities), 'text/csv;charset=utf-8')
  const exportJson = () => downloadText(`재난시설_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(facilities, null, 2), 'application/json')
  const reloadData = async () => {
    const loaded = await loadDatabase()
    if (loaded) notify('Supabase에서 최신 데이터를 다시 불러왔습니다.')
  }
  const importWorkbook = async (file: File) => {
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const imported: Facility[] = []
      workbook.SheetNames.forEach((sheetName) => {
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: '' })
        rows.forEach((row, index) => {
          const facility = normalizeImportedRow(row, index, sheetName)
          if (facility) imported.push(facility)
        })
      })
      if (!imported.length) throw new Error('필수값이 있는 시설을 찾지 못했습니다.')
      const keys = new Set(facilities.map((item) => `${item.name}|${item.address}|${item.longitude}|${item.latitude}`))
      const newRows = imported.filter((item) => !keys.has(`${item.name}|${item.address}|${item.longitude}|${item.latitude}`))
      const savedRows = await importFacilities(newRows)
      setFacilities((current) => [...savedRows, ...current])
      setHistory(await fetchFacilityHistory())
      notify(`${newRows.length}개 시설을 추가했습니다. 중복 ${imported.length - newRows.length}개는 제외했습니다.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : '파일을 불러오지 못했습니다.')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    const context = document.modelContext
    if (!context?.registerTool || !facilities.length) return
    const lifecycle = new AbortController()
    const register = (tool: Parameters<typeof context.registerTool>[0]) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined) } catch { /* unsupported host */ }
    }

    register({
      name: 'read_facility_summary',
      title: '시설 현황 조회',
      description: '현재 시설 데이터의 전체 수, 운영 상태, 유형 수, 행정구역별 수를 조회합니다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => ({ total: facilities.length, active: activeCount, types: types.length, districts: Object.fromEntries(districtCounts) }),
    })
    register({
      name: 'filter_facility_map',
      title: '지도 시설 필터',
      description: '지도 상황판으로 이동하고 시설 유형, 운영 상태, 행정구역, 담당 기관, 검색어 조건을 적용합니다.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' },
          district: { type: 'string' }, agency: { type: 'string' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: (input) => {
        const value = typeof input === 'object' && input ? input as Partial<Filters> : {}
        const next = { ...emptyFilters, ...value }
        setFilters(next); setView('map')
        return { view: 'map', resultCount: filterFacilities(facilities, next).length, filters: next }
      },
    })
    register({
      name: 'update_facility_status',
      title: '시설 운영 상태 변경',
      description: '시설 ID에 해당하는 시설의 운영 상태를 운영중, 점검필요 또는 비활성으로 변경하고 DB 변경 이력에 기록합니다.',
      inputSchema: {
        type: 'object',
        properties: { facilityId: { type: 'string' }, status: { type: 'string', enum: ['운영중', '점검필요', '비활성'] } },
        required: ['facilityId', 'status'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => {
        if (typeof input !== 'object' || !input) throw new Error('시설 ID와 운영 상태가 필요합니다.')
        const { facilityId, status } = input as { facilityId?: string; status?: Facility['status'] }
        const facility = facilities.find((item) => item.id === facilityId)
        if (!facility) throw new Error('해당 시설을 찾을 수 없습니다.')
        if (!status || !['운영중', '점검필요', '비활성'].includes(status)) throw new Error('올바른 운영 상태가 아닙니다.')
        await changeStatus(facility, status)
        return { facilityId, facilityName: facility.name, status }
      },
    })
    return () => lifecycle.abort()
  }, [facilities, activeCount, types.length, districtCounts])

  const navigation = [
    { id: 'dashboard' as const, label: '통합 대시보드', icon: LayoutDashboard },
    { id: 'map' as const, label: '지도 상황판', icon: MapIcon },
    { id: 'nearby' as const, label: '주변 시설물 검색', icon: LocateFixed },
    { id: 'facilities' as const, label: '시설물 관리', icon: ListChecks },
  ]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <button className="brand" onClick={() => { setView('dashboard'); setSidebarOpen(false) }} aria-label="통합 대시보드로 이동"><div className="brand-mark"><Siren size={21} /></div><div><strong>재난 예·경보시설물 통합관리</strong><span>고양시 상황판</span></div></button>
        <nav className="main-nav" aria-label="주요 화면">
          {navigation.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'is-active' : ''} onClick={() => { if (id === 'map') goToMap(); else if (id === 'nearby') goToNearby(); else setView(id); setSidebarOpen(false) }}><Icon size={19} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-status"><Database size={17} /><div><strong>Supabase 연결</strong><span>시설물과 변경 이력을 중앙 DB에 저장합니다.</span></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSidebarOpen((value) => !value)} aria-label="메뉴 열기">{sidebarOpen ? <X /> : <Menu />}</button>
          <div className="page-heading"><h1>{navigation.find((item) => item.id === view)?.label}</h1><p>{dataInfo.sourceFile || '시설물 데이터를 불러오는 중입니다'} · 기준일 {dataInfo.generatedAt || '-'}</p></div>
          <div className="top-actions"><button className="button secondary" onClick={exportCsv}><Download size={17} />CSV 내보내기</button><button className="button primary" onClick={() => goToMap()}><MapPin size={17} />지도 열기</button>{onSignOut && <button className="button secondary signout-button" onClick={() => void onSignOut()}><LogOut size={17} />로그아웃</button>}</div>
        </header>

        <div className="content">
          {view === 'dashboard' && (
            <section className="view-stack" aria-label="통합 대시보드">
              <div className="situation-kpi-grid">
                <button className="situation-kpi tone-blue" onClick={() => goToMap()}><span className="kpi-icon"><Building2 /></span><span className="kpi-copy"><small>전체 시설</small><strong>{facilities.length.toLocaleString('ko-KR')}</strong><em>전체 위치 보기 <ChevronRight size={14} /></em></span></button>
                <button className="situation-kpi tone-green" onClick={() => goToMap({ status: '운영중' })}><span className="kpi-icon"><CheckCircle2 /></span><span className="kpi-copy"><small>운영 중</small><strong>{activeCount.toLocaleString('ko-KR')}</strong><em>전체의 {facilities.length ? Math.round(activeCount / facilities.length * 100) : 0}%</em></span></button>
                <button className="situation-kpi tone-orange" onClick={() => goToMap({ status: '점검필요' })}><span className="kpi-icon"><TriangleAlert /></span><span className="kpi-copy"><small>점검 필요</small><strong>{inspectionCount.toLocaleString('ko-KR')}</strong><em>{inspectionCount ? '확인 대상 시설 보기' : '확인 대상 없음'}</em></span></button>
                <button className="situation-kpi tone-slate" onClick={() => setView('facilities')}><span className="kpi-icon"><MapPin /></span><span className="kpi-copy"><small>좌표 누락</small><strong>{missingCoordCount.toLocaleString('ko-KR')}</strong><em>{missingCoordCount ? '시설 정보 확인 필요' : `전체 ${coordCount.toLocaleString('ko-KR')}개 등록 완료`}</em></span></button>
              </div>

              <div className="situation-main-grid">
                <article className="panel dashboard-map-panel">
                  <header className="panel-header"><div><span className="eyebrow">고양시 전역</span><h2>시설 분포 지도</h2></div><div className="map-panel-actions"><span>지도 표시 {coordCount.toLocaleString('ko-KR')}개</span><button className="text-button" onClick={() => goToMap()}>상황판 열기 <ChevronRight size={15} /></button></div></header>
                  <KakaoMap facilities={facilities} selected={null} onSelect={(facility) => { setSelected(facility); goToMap() }} allTypes={types} compact />
                </article>

                <div className="dashboard-side-column">
                  <article className="panel type-panel">
                  <header className="panel-header"><div><span className="eyebrow">유형별 분포</span><h2>시설 유형 현황</h2></div><span className="panel-count">{groupedTypeCount}개 유형</span></header>
                  <div className="bar-chart cctv-bar-group">
                    <span className="bar-group-label">CCTV 시설 통합</span>
                    <button className="bar-row bar-row-featured" onClick={() => goToMap({ type: CCTV_ALL_TYPE })}>
                      <span className="bar-label"><i />{CCTV_ALL_TYPE}</span>
                      <span className="bar-track"><i style={{ width: '100%' }} /></span>
                      <strong>{cctvCount}</strong>
                    </button>
                    <small>CCTV 세부 유형 합계 · 전체의 {facilities.length ? (cctvCount / facilities.length * 100).toFixed(1) : 0}%</small>
                  </div>
                  <div className="bar-chart other-type-bars">
                    <span className="bar-group-label">기타 예·경보 시설</span>
                    {nonCctvTypeCounts.map(([type, count]) => (
                      <button className="bar-row" key={type} onClick={() => goToMap({ type })}>
                        <span className="bar-label"><i style={{ background: colorForType(type, nonCctvTypes) }} />{type}</span>
                        <span className="bar-track"><i style={{ width: `${count / Math.max(1, nonCctvTypeCounts[0]?.[1] ?? 1) * 100}%`, background: colorForType(type, nonCctvTypes) }} /></span>
                        <strong>{count}</strong>
                      </button>
                    ))}
                  </div>
                </article>

                <article className="panel district-panel">
                  <header className="panel-header"><div><span className="eyebrow">행정구역</span><h2>구별 시설 현황</h2></div><CircleGauge size={21} /></header>
                  <div className="district-visual">
                    <div className="donut" style={{ background: districtGradient }}><div><strong>{facilities.length}</strong><span>전체 시설</span></div></div>
                    <div className="district-list">{districtCounts.map(([district, count], index) => <button key={district} onClick={() => goToMap({ district })}><i style={{ background: ['#256fd2', '#16a1b3', '#7b61d1', '#e38b2c', '#66768c'][index % 5] }} /><span>{district === '미분류' ? '관외' : district}</span><strong>{count}개</strong><ChevronRight size={15} /></button>)}</div>
                  </div>
                </article>
                </div>
              </div>

              <div className="situation-bottom-grid">
                <article className="panel status-panel">
                  <header className="panel-header"><div><span className="eyebrow">운영 상태</span><h2>상태별 시설</h2></div><Activity size={21} /></header>
                  <div className="status-list">{statusCounts.map(([status, count]) => <button key={status} onClick={() => goToMap({ status })}><i className={`status-dot ${status}`} /><span>{status}</span><strong>{count}</strong></button>)}</div>
                </article>

                <article className="panel recent-panel">
                  <header className="panel-header"><div><span className="eyebrow">최근 활동</span><h2>시설 변경 이력</h2></div><History size={21} /></header>
                  {history.length ? <div className="history-list">{history.slice(0, 5).map((item) => <div key={item.id}><span>{item.action}</span><div><strong>{item.facilityName}</strong><small>{new Date(item.changedAt).toLocaleString('ko-KR')}</small></div></div>)}</div> : <div className="empty-compact">아직 변경 이력이 없습니다.</div>}
                </article>
              </div>
            </section>
          )}

          {view === 'map' && (
            <section className="map-layout" aria-label="지도 상황판">
              <aside className="filter-panel">
                <div className="filter-title"><SlidersHorizontal size={18} /><h2>시설 검색·필터</h2></div>
                <label className="search-field"><Search size={17} /><input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="시설명·주소·좌표 검색" /></label>
                <label className="field"><span>시설 유형</span><select value={filters.type} onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))}><option value="">전체 유형</option><optgroup label="통합 유형"><option value={CCTV_ALL_TYPE}>{CCTV_ALL_TYPE}</option></optgroup><optgroup label="세부 유형">{types.map((value) => <option key={value}>{value}</option>)}</optgroup></select></label>
                <label className="field"><span>운영 상태</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="">전체 상태</option><option>운영중</option><option>점검필요</option><option>비활성</option></select></label>
                <label className="field"><span>행정구역</span><select value={filters.district} onChange={(event) => setFilters((current) => ({ ...current, district: event.target.value }))}><option value="">고양시 전체</option>{districts.map((value) => <option key={value} value={value}>{value === '미분류' ? '관외' : value}</option>)}</select></label>
                <label className="field"><span>담당 기관</span><select value={filters.agency} onChange={(event) => setFilters((current) => ({ ...current, agency: event.target.value }))}><option value="">전체 기관</option>{agencies.map((value) => <option key={value}>{value}</option>)}</select></label>
                <button className="button secondary full" onClick={() => setFilters(defaultMapFilters)}><RefreshCcw size={16} />필터 초기화</button>
                <div className="filter-summary"><strong>{filtered.length.toLocaleString('ko-KR')}</strong><span>개 시설 표시 중</span></div>
              </aside>

              <KakaoMap facilities={filtered} selected={selected} onSelect={setSelected} allTypes={types} />

              <aside className={`detail-panel ${selected ? 'has-selection' : ''}`}>
                {selected ? <>
                  <header><div><span className={`status-badge ${selected.status}`}>{selected.status}</span><h2>{selected.name}</h2><p>{selected.type}</p></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="선택 해제"><X size={17} /></button></header>
                  <dl className="detail-list"><div><dt>주소</dt><dd>{selected.address || '미등록'}</dd></div><div><dt>좌표</dt><dd>{formatCoordinate(selected.longitude)}, {formatCoordinate(selected.latitude)}</dd></div><div><dt>행정구역</dt><dd>{selected.district}</dd></div><div><dt>관리부서</dt><dd>{selected.agency}</dd></div><div><dt>설치연도</dt><dd>{selected.installedAt || '미등록'}</dd></div><div><dt>상세정보</dt><dd>{selected.detail || '미등록'}</dd></div><div><dt>원본 위치</dt><dd>{selected.sourceSheet} {selected.sourceRow}행</dd></div></dl>
                  <div className="detail-actions"><button className="button primary full" onClick={() => setEditing(selected)}><Pencil size={16} />시설 정보 수정</button><select value={selected.status} onChange={(event) => changeStatus(selected, event.target.value as Facility['status'])} aria-label="운영 상태 변경"><option>운영중</option><option>점검필요</option><option>비활성</option></select></div>
                </> : <div className="detail-empty"><MapPin size={28} /><h2>시설을 선택해 주세요</h2><p>마커를 선택하면 전체 정보를 확인할 수 있습니다.</p></div>}
              </aside>
            </section>
          )}

          {view === 'nearby' && (
            <section className="map-layout nearby-layout" aria-label="주변 시설물 검색">
              <aside className="filter-panel nearby-search-panel">
                <div className="filter-title"><LocateFixed size={18} /><h2>주소 기준 검색</h2></div>
                <p className="nearby-help">주소를 검색하면 해당 위치와 반경 안의 시설물을 거리순으로 확인할 수 있습니다.</p>
                <form className="nearby-search-form" onSubmit={searchNearby}>
                  <label className="search-field"><Search size={17} /><input value={nearbyAddress} onChange={(event) => setNearbyAddress(event.target.value)} placeholder="도로명 또는 지번 주소" /></label>
                  <button className="button primary full" type="submit"><Search size={16} />주소 검색</button>
                </form>
                <label className="field"><span>검색 반경</span><select value={nearbyRadiusKm} onChange={(event) => setNearbyRadiusKm(Number(event.target.value))}><option value={0.5}>500m</option><option value={1}>1km</option><option value={2}>2km</option><option value={5}>5km</option></select></label>
                <button className="button secondary full" onClick={resetNearby}><RefreshCcw size={16} />검색 초기화</button>
                {nearbyError && <div className="nearby-error" role="alert">{nearbyError}</div>}
                <div className="filter-summary"><strong>{nearbyLocation ? nearbyResults.length.toLocaleString('ko-KR') : facilities.length.toLocaleString('ko-KR')}</strong><span>{nearbyLocation ? `개 시설 · ${nearbyRadiusKm}km 이내` : '개 전체 시설 표시 중'}</span></div>
              </aside>

              <KakaoMap
                facilities={facilities}
                selected={selected}
                onSelect={setSelected}
                allTypes={types}
                searchRequest={nearbyRequest}
                searchRadiusKm={nearbyRadiusKm}
                highlightedFacilityIds={nearbyLocation ? nearbyIds : undefined}
                onAddressResolved={handleAddressResolved}
              />

              <aside className="detail-panel nearby-results-panel">
                <header><div><span className="eyebrow">거리순 결과</span><h2>{nearbyLocation ? `${nearbyResults.length.toLocaleString('ko-KR')}개 시설` : '주변 시설물'}</h2><p>{nearbyLocation?.address ?? '주소를 검색하면 결과가 표시됩니다.'}</p></div></header>
                {!nearbyLocation ? <div className="detail-empty nearby-empty"><LocateFixed size={28} /><h2>검색 위치를 지정해 주세요</h2><p>지도에는 전체 시설물이 먼저 표시됩니다.</p></div> : nearbyResults.length ? (
                  <div className="nearby-result-list">
                    {nearbyResults.map(({ facility, distance }) => <button key={facility.id} className={selected?.id === facility.id ? 'is-selected' : ''} onClick={() => setSelected(facility)}><span className="nearby-result-top"><strong>{facility.name}</strong><b>{distance < 1 ? `${Math.round(distance * 1000)}m` : `${distance.toFixed(2)}km`}</b></span><span>{facility.type} · {facility.status}</span><small>{facility.address}</small></button>)}
                  </div>
                ) : <div className="detail-empty nearby-empty"><Search size={28} /><h2>반경 안에 시설이 없습니다</h2><p>검색 반경을 넓혀 다시 확인해 주세요.</p></div>}
              </aside>
            </section>
          )}

          {view === 'facilities' && (
            <section className="view-stack" aria-label="시설물 관리">
              <div className="local-notice"><Database size={18} /><div><strong>Supabase 중앙 저장</strong><span>등록·수정·운영 상태 변경 내용이 관리자 전용 데이터베이스에 즉시 반영됩니다.</span></div></div>
              <article className="panel facility-panel">
                <div className="facility-toolbar">
                  <label className="search-field table-search"><Search size={17} /><input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="시설명·주소 검색" /></label>
                  <div className="toolbar-actions">
                    <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(event) => event.target.files?.[0] && importWorkbook(event.target.files[0])} />
                    <button className="button secondary" onClick={() => fileInputRef.current?.click()}><Upload size={16} />엑셀·CSV 등록</button>
                    <button className="button secondary" onClick={exportJson}><FileDown size={16} />JSON</button>
                    <button className="button primary" onClick={() => setEditing(null)}><Plus size={17} />시설 등록</button>
                  </div>
                </div>
                <div className="table-meta"><span>총 {filtered.length.toLocaleString('ko-KR')}개</span><button className="text-button" onClick={() => void reloadData()}><RefreshCcw size={14} />DB 새로고침</button></div>
                <div className="table-wrap"><table><thead><tr><th>시설명</th><th>시설 유형</th><th>행정구역</th><th>관리부서</th><th>운영 상태</th><th>좌표</th><th>관리</th></tr></thead><tbody>{pageRows.map((facility) => <tr key={facility.id}><td><button className="facility-name" onClick={() => { setSelected(facility); setView('map') }}><strong>{facility.name}</strong><span>{facility.address}</span></button></td><td>{facility.type}</td><td>{facility.district}</td><td>{facility.agency}</td><td><span className={`status-badge ${facility.status}`}>{facility.status}</span></td><td>{facility.longitude != null && facility.latitude != null ? '등록 완료' : '좌표 없음'}</td><td><button className="icon-button" onClick={() => setEditing(facility)} aria-label={`${facility.name} 수정`}><Pencil size={16} /></button></td></tr>)}</tbody></table></div>
                {!pageRows.length && <div className="empty-state"><Search size={28} /><h3>검색 결과가 없습니다.</h3><p>검색어 또는 필터를 변경해 주세요.</p></div>}
                <div className="pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>이전</button><span>{page} / {pageCount}</span><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>다음</button></div>
              </article>
            </section>
          )}
        </div>
      </main>

      {sidebarOpen && <button className="mobile-overlay" onClick={() => setSidebarOpen(false)} aria-label="메뉴 닫기" />}
      {editing !== undefined && <FacilityModal facility={editing} types={types} onClose={() => setEditing(undefined)} onSave={saveFacility} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}</div>}
    </div>
  )
}
