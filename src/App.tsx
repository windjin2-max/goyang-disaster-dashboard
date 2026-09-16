import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as XLSX from 'xlsx'
import {
  Activity, Building2, CheckCircle2, ChevronRight, CircleGauge, Database, Download,
  FileDown, HardDrive, History, LayoutDashboard, ListChecks, Map as MapIcon,
  MapPin, Menu, Pencil, Plus, RadioTower, RefreshCcw, Search, SlidersHorizontal,
  Upload, X,
} from 'lucide-react'
import KakaoMap from './KakaoMap'
import FacilityModal from './FacilityModal'
import type { ChangeRecord, Facility, FacilityData, Filters, ViewName } from './types'
import { colorForType, downloadText, filterFacilities, formatCoordinate, HISTORY_KEY, STORAGE_KEY, toCsv } from './utils'

const emptyFilters: Filters = { query: '', type: '', status: '', district: '', agency: '' }

function readStoredFacilities(): Facility[] | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value ? JSON.parse(value) as Facility[] : null
  } catch { return null }
}

function readHistory(): ChangeRecord[] {
  try {
    const value = localStorage.getItem(HISTORY_KEY)
    return value ? JSON.parse(value) as ChangeRecord[] : []
  } catch { return [] }
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
    id: `import-${Date.now()}-${index}`,
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

export default function App() {
  const [view, setView] = useState<ViewName>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [baseFacilities, setBaseFacilities] = useState<Facility[]>([])
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [dataInfo, setDataInfo] = useState({ sourceFile: '', generatedAt: '' })
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [selected, setSelected] = useState<Facility | null>(null)
  const [editing, setEditing] = useState<Facility | null | undefined>(undefined)
  const [history, setHistory] = useState<ChangeRecord[]>(readHistory)
  const [toast, setToast] = useState('')
  const [page, setPage] = useState(1)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pageSize = 12

  useEffect(() => {
    fetch('/data/facilities.json')
      .then((response) => response.json())
      .then((data: FacilityData) => {
        setBaseFacilities(data.facilities)
        setFacilities(readStoredFacilities() ?? data.facilities)
        setDataInfo({ sourceFile: data.sourceFile, generatedAt: data.generatedAt })
        setSelected(data.facilities[0] ?? null)
      })
      .catch(() => setToast('시설물 데이터를 불러오지 못했습니다.'))
  }, [])

  useEffect(() => {
    if (!facilities.length) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(facilities))
  }, [facilities])

  useEffect(() => localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100))), [history])
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 2800); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => setPage(1), [filters])

  const types = useMemo(() => [...new Set(facilities.map((item) => item.type))].sort(), [facilities])
  const districts = useMemo(() => [...new Set(facilities.map((item) => item.district))].sort(), [facilities])
  const agencies = useMemo(() => [...new Set(facilities.map((item) => item.agency))].sort(), [facilities])
  const filtered = useMemo(() => filterFacilities(facilities, filters), [facilities, filters])
  const typeCounts = useMemo(() => countBy(facilities, 'type'), [facilities])
  const districtCounts = useMemo(() => countBy(facilities, 'district'), [facilities])
  const statusCounts = useMemo(() => countBy(facilities, 'status'), [facilities])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)
  const activeCount = facilities.filter((item) => item.status === '운영중').length
  const coordCount = facilities.filter((item) => item.longitude != null && item.latitude != null).length

  const notify = (message: string) => setToast(message)
  const addHistory = (facility: Facility, action: ChangeRecord['action'], summary: string) => {
    setHistory((current) => [{ id: crypto.randomUUID(), facilityId: facility.id, facilityName: facility.name, action, changedAt: new Date().toISOString(), summary }, ...current])
  }
  const goToMap = (nextFilters: Partial<Filters> = {}) => {
    setFilters({ ...emptyFilters, ...nextFilters })
    setView('map')
  }
  const saveFacility = (facility: Facility) => {
    const exists = facilities.some((item) => item.id === facility.id)
    setFacilities((current) => exists ? current.map((item) => item.id === facility.id ? facility : item) : [facility, ...current])
    addHistory(facility, exists ? '수정' : '등록', exists ? '시설 기본정보를 수정했습니다.' : '신규 시설을 등록했습니다.')
    setEditing(undefined)
    setSelected(facility)
    notify(exists ? '시설 정보가 수정되었습니다.' : '시설이 등록되었습니다.')
  }
  const changeStatus = (facility: Facility, status: Facility['status']) => {
    const updated = { ...facility, status }
    setFacilities((current) => current.map((item) => item.id === facility.id ? updated : item))
    setSelected(updated)
    addHistory(updated, '상태변경', `운영 상태를 ${status}(으)로 변경했습니다.`)
    notify(`운영 상태를 ${status}(으)로 변경했습니다.`)
  }
  const exportCsv = () => downloadText(`재난시설_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(facilities), 'text/csv;charset=utf-8')
  const exportJson = () => downloadText(`재난시설_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(facilities, null, 2), 'application/json')
  const resetData = () => {
    if (!confirm('브라우저에 저장된 변경 내용을 모두 지우고 최초 데이터로 되돌릴까요?')) return
    setFacilities(baseFacilities)
    localStorage.removeItem(STORAGE_KEY)
    setHistory([])
    localStorage.removeItem(HISTORY_KEY)
    notify('최초 데이터로 복원했습니다.')
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
      setFacilities((current) => [...newRows, ...current])
      if (newRows[0]) addHistory(newRows[0], '일괄등록', `${newRows.length}개 시설을 일괄 등록했습니다.`)
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
      description: '시설 ID에 해당하는 시설의 운영 상태를 운영중, 점검필요 또는 비활성으로 변경하고 로컬 변경 이력에 기록합니다.',
      inputSchema: {
        type: 'object',
        properties: { facilityId: { type: 'string' }, status: { type: 'string', enum: ['운영중', '점검필요', '비활성'] } },
        required: ['facilityId', 'status'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input) => {
        if (typeof input !== 'object' || !input) throw new Error('시설 ID와 운영 상태가 필요합니다.')
        const { facilityId, status } = input as { facilityId?: string; status?: Facility['status'] }
        const facility = facilities.find((item) => item.id === facilityId)
        if (!facility) throw new Error('해당 시설을 찾을 수 없습니다.')
        if (!status || !['운영중', '점검필요', '비활성'].includes(status)) throw new Error('올바른 운영 상태가 아닙니다.')
        changeStatus(facility, status)
        return { facilityId, facilityName: facility.name, status }
      },
    })
    return () => lifecycle.abort()
  }, [facilities, activeCount, types.length, districtCounts])

  const navigation = [
    { id: 'dashboard' as const, label: '통합 대시보드', icon: LayoutDashboard },
    { id: 'map' as const, label: '지도 상황판', icon: MapIcon },
    { id: 'facilities' as const, label: '시설물 관리', icon: ListChecks },
  ]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><RadioTower size={21} /></div><div><strong>재난시설 통합관리</strong><span>고양시 상황판</span></div></div>
        <nav className="main-nav" aria-label="주요 화면">
          {navigation.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'is-active' : ''} onClick={() => { setView(id); setSidebarOpen(false) }}><Icon size={19} /><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-status"><HardDrive size={17} /><div><strong>브라우저 저장</strong><span>변경 내용은 이 기기에만 저장됩니다.</span></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSidebarOpen((value) => !value)} aria-label="메뉴 열기">{sidebarOpen ? <X /> : <Menu />}</button>
          <div className="page-heading"><h1>{navigation.find((item) => item.id === view)?.label}</h1><p>{dataInfo.sourceFile || '시설물 데이터를 불러오는 중입니다'} · 기준일 {dataInfo.generatedAt || '-'}</p></div>
          <div className="top-actions"><button className="button secondary" onClick={exportCsv}><Download size={17} />CSV 내보내기</button><button className="button primary" onClick={() => goToMap()}><MapPin size={17} />지도 열기</button></div>
        </header>

        <div className="content">
          {view === 'dashboard' && (
            <section className="view-stack" aria-label="통합 대시보드">
              <div className="kpi-grid">
                <button className="kpi-card" onClick={() => goToMap()}><span><Building2 />전체 시설</span><strong>{facilities.length.toLocaleString('ko-KR')}</strong><small>전체 위치 보기 <ChevronRight size={14} /></small></button>
                <button className="kpi-card" onClick={() => goToMap({ status: '운영중' })}><span><CheckCircle2 />운영 중</span><strong>{activeCount.toLocaleString('ko-KR')}</strong><small>전체의 {facilities.length ? Math.round(activeCount / facilities.length * 100) : 0}%</small></button>
                <button className="kpi-card" onClick={() => goToMap()}><span><MapPin />좌표 보유</span><strong>{coordCount.toLocaleString('ko-KR')}</strong><small>지도 표시 가능 시설</small></button>
                <button className="kpi-card" onClick={() => setView('facilities')}><span><Database />시설 유형</span><strong>{types.length.toLocaleString('ko-KR')}</strong><small>유형별 목록 보기 <ChevronRight size={14} /></small></button>
              </div>

              <div className="dashboard-grid">
                <article className="panel type-panel">
                  <header className="panel-header"><div><span className="eyebrow">시설 분포</span><h2>시설 유형별 현황</h2></div><button className="text-button" onClick={() => goToMap()}>지도에서 보기 <ChevronRight size={15} /></button></header>
                  <div className="bar-chart">
                    {typeCounts.slice(0, 8).map(([type, count]) => (
                      <button className="bar-row" key={type} onClick={() => goToMap({ type })}>
                        <span className="bar-label"><i style={{ background: colorForType(type, types) }} />{type}</span>
                        <span className="bar-track"><i style={{ width: `${Math.max(4, count / typeCounts[0][1] * 100)}%`, background: colorForType(type, types) }} /></span>
                        <strong>{count}</strong>
                      </button>
                    ))}
                  </div>
                </article>

                <article className="panel district-panel">
                  <header className="panel-header"><div><span className="eyebrow">행정구역</span><h2>구별 시설 현황</h2></div><CircleGauge size={21} /></header>
                  <div className="district-visual" style={{ '--dongyang': `${(districtCounts.find(([name]) => name === '덕양구')?.[1] ?? 0) / Math.max(1, facilities.length) * 100}%` } as CSSProperties}>
                    <div className="donut"><div><strong>{facilities.length}</strong><span>전체 시설</span></div></div>
                    <div className="district-list">{districtCounts.map(([district, count]) => <button key={district} onClick={() => goToMap({ district })}><span>{district}</span><strong>{count}개</strong><ChevronRight size={15} /></button>)}</div>
                  </div>
                </article>

                <article className="panel status-panel">
                  <header className="panel-header"><div><span className="eyebrow">운영 상태</span><h2>상태별 시설</h2></div><Activity size={21} /></header>
                  <div className="status-list">{statusCounts.map(([status, count]) => <button key={status} onClick={() => goToMap({ status })}><i className={`status-dot ${status}`} /><span>{status}</span><strong>{count}</strong></button>)}</div>
                </article>

                <article className="panel recent-panel">
                  <header className="panel-header"><div><span className="eyebrow">로컬 변경</span><h2>최근 수정 이력</h2></div><History size={21} /></header>
                  {history.length ? <div className="history-list">{history.slice(0, 4).map((item) => <div key={item.id}><span>{item.action}</span><div><strong>{item.facilityName}</strong><small>{new Date(item.changedAt).toLocaleString('ko-KR')}</small></div></div>)}</div> : <div className="empty-compact">아직 로컬 변경 이력이 없습니다.</div>}
                </article>
              </div>
            </section>
          )}

          {view === 'map' && (
            <section className="map-layout" aria-label="지도 상황판">
              <aside className="filter-panel">
                <div className="filter-title"><SlidersHorizontal size={18} /><h2>시설 검색·필터</h2></div>
                <label className="search-field"><Search size={17} /><input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder="시설명·주소·좌표 검색" /></label>
                <label className="field"><span>시설 유형</span><select value={filters.type} onChange={(event) => setFilters((current) => ({ ...current, type: event.target.value }))}><option value="">전체 유형</option>{types.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="field"><span>운영 상태</span><select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}><option value="">전체 상태</option><option>운영중</option><option>점검필요</option><option>비활성</option></select></label>
                <label className="field"><span>행정구역</span><select value={filters.district} onChange={(event) => setFilters((current) => ({ ...current, district: event.target.value }))}><option value="">고양시 전체</option>{districts.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="field"><span>담당 기관</span><select value={filters.agency} onChange={(event) => setFilters((current) => ({ ...current, agency: event.target.value }))}><option value="">전체 기관</option>{agencies.map((value) => <option key={value}>{value}</option>)}</select></label>
                <button className="button secondary full" onClick={() => setFilters(emptyFilters)}><RefreshCcw size={16} />필터 초기화</button>
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

          {view === 'facilities' && (
            <section className="view-stack" aria-label="시설물 관리">
              <div className="local-notice"><HardDrive size={18} /><div><strong>브라우저 저장 방식</strong><span>수정 내용은 현재 기기에만 보관됩니다. 업무 반영 전 반드시 내보내기 파일을 저장해 주세요.</span></div></div>
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
                <div className="table-meta"><span>총 {filtered.length.toLocaleString('ko-KR')}개</span><button className="text-button danger" onClick={resetData}><RefreshCcw size={14} />최초 데이터 복원</button></div>
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
