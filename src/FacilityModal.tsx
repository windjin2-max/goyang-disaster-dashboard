import { useEffect, useState } from 'react'
import { MapPin, Save, X } from 'lucide-react'
import type { Facility, FacilityStatus } from './types'

interface FacilityModalProps {
  facility: Facility | null
  types: string[]
  onClose: () => void
  onSave: (facility: Facility) => void | Promise<void>
}

const blankFacility = (): Facility => ({
  id: `local-${crypto.randomUUID()}`,
  name: '',
  type: '기타 시설',
  sourceType: '로컬 등록',
  status: '운영중',
  address: '',
  district: '덕양구',
  longitude: null,
  latitude: null,
  agency: '',
  installedAt: '',
  detail: '',
  pnu: '',
  postalCode: '',
  sourceSheet: '로컬 등록',
  sourceRow: 0,
})

export default function FacilityModal({ facility, types, onClose, onSave }: FacilityModalProps) {
  const [draft, setDraft] = useState<Facility>(() => facility ? { ...facility } : blankFacility())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => setDraft(facility ? { ...facility } : blankFacility()), [facility])

  const update = <K extends keyof Facility>(key: K, value: Facility[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const save = async () => {
    if (!draft.name.trim() || !draft.address.trim() || draft.longitude == null || draft.latitude == null) {
      setError('시설명, 주소, X좌표, Y좌표는 필수입니다.')
      return
    }
    if (draft.longitude < 124 || draft.longitude > 132 || draft.latitude < 33 || draft.latitude > 39) {
      setError('대한민국 경위도 범위에 맞는 좌표를 입력해 주세요.')
      return
    }
    setSaving(true)
    try {
      await onSave({ ...draft, name: draft.name.trim(), address: draft.address.trim() })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="facility-modal-title">
        <header className="modal-header">
          <div><span className="eyebrow">시설물 관리</span><h2 id="facility-modal-title">{facility ? '시설 정보 수정' : '시설 등록'}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="닫기"><X size={19} /></button>
        </header>
        <div className="modal-body">
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="form-grid">
            <label className="field field-wide"><span>시설명 *</span><input value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
            <label className="field"><span>시설 유형</span><select value={draft.type} onChange={(event) => update('type', event.target.value)}>{[...new Set([...types, draft.type, '기타 시설'])].map((type) => <option key={type}>{type}</option>)}</select></label>
            <label className="field"><span>운영 상태</span><select value={draft.status} onChange={(event) => update('status', event.target.value as FacilityStatus)}><option>운영중</option><option>점검필요</option><option>비활성</option></select></label>
            <label className="field field-wide"><span>주소 *</span><input value={draft.address} onChange={(event) => update('address', event.target.value)} /></label>
            <label className="field"><span>행정구역</span><select value={draft.district} onChange={(event) => update('district', event.target.value)}><option>덕양구</option><option>일산동구</option><option>일산서구</option><option>미분류</option></select></label>
            <label className="field"><span>관리부서</span><input value={draft.agency} onChange={(event) => update('agency', event.target.value)} /></label>
            <label className="field"><span>X좌표(경도) *</span><input type="number" step="0.000001" value={draft.longitude ?? ''} onChange={(event) => update('longitude', event.target.value === '' ? null : Number(event.target.value))} /></label>
            <label className="field"><span>Y좌표(위도) *</span><input type="number" step="0.000001" value={draft.latitude ?? ''} onChange={(event) => update('latitude', event.target.value === '' ? null : Number(event.target.value))} /></label>
            <label className="field"><span>설치연도</span><input value={draft.installedAt} onChange={(event) => update('installedAt', event.target.value)} /></label>
            <label className="field"><span>우편번호</span><input value={draft.postalCode} onChange={(event) => update('postalCode', event.target.value)} /></label>
            <label className="field field-wide"><span>상세정보</span><textarea rows={3} value={draft.detail} onChange={(event) => update('detail', event.target.value)} /></label>
          </div>
          <div className="coordinate-note"><MapPin size={16} /> 지도에서 위치 지정은 카카오 지도 키 연결 후 활성화됩니다.</div>
        </div>
        <footer className="modal-footer"><button className="button secondary" onClick={onClose} disabled={saving}>취소</button><button className="button primary" onClick={() => void save()} disabled={saving}><Save size={17} />{saving ? '저장 중' : '저장'}</button></footer>
      </section>
    </div>
  )
}
