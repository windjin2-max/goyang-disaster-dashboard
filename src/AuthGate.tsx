import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AlertCircle, LoaderCircle, LockKeyhole, Siren } from 'lucide-react'
import App from './App'
import { isSupabaseConfigured, supabase } from './lib/supabase'

export default function AuthGate() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const verifyAdministrator = useCallback(async (nextSession: Session | null) => {
    if (!supabase || !nextSession) {
      setSession(null)
      setChecking(false)
      return false
    }
    const { data, error: accessError } = await supabase.from('facilities').select('id').limit(1)
    if (accessError) {
      setSession(null)
      setError('관리자 권한을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.')
      setChecking(false)
      return false
    }
    if (!data?.length) {
      await supabase.auth.signOut()
      setSession(null)
      setError('관리자 권한이 없는 계정입니다.')
      setChecking(false)
      return false
    }
    setSession(nextSession)
    setChecking(false)
    return true
  }, [])

  useEffect(() => {
    if (!supabase) {
      setChecking(false)
      return
    }

    let active = true
    void supabase.auth.getSession().then(async ({ data, error: sessionError }) => {
      if (!active) return
      if (sessionError) setError('로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요.')
      await verifyAdministrator(data.session)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!nextSession) {
        setSession(null)
        setChecking(false)
        return
      }
      setSession((current) => current ? nextSession : current)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [verifyAdministrator])

  const signIn = async (event: FormEvent) => {
    event.preventDefault()
    if (!supabase) return
    setSubmitting(true)
    setError('')
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (signInError) {
      setError('이메일 또는 비밀번호가 올바르지 않습니다.')
      setSubmitting(false)
      return
    }
    const allowed = await verifyAdministrator(data.session)
    if (!allowed) {
      setSubmitting(false)
      return
    }
    setPassword('')
    setSubmitting(false)
  }

  const signOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  if (checking) {
    return <div className="auth-loading" role="status"><LoaderCircle size={28} /><span>로그인 상태를 확인하고 있습니다.</span></div>
  }

  if (session) return <App onSignOut={signOut} />

  return (
    <main className="auth-page">
      <section className="auth-intro" aria-label="서비스 안내">
        <div className="auth-brand"><span><Siren size={26} /></span><div><strong>재난 예·경보시설물 통합관리</strong><small>고양시 상황판</small></div></div>
        <div className="auth-intro-copy"><h1>재난 예·경보 시설물 현황을<br />한곳에서 관리합니다.</h1><p>인가된 관리자만 시설물 정보와 지도 상황판에 접근할 수 있습니다.</p></div>
      </section>

      <section className="auth-form-side">
        <form className="auth-card" onSubmit={signIn}>
          <div className="auth-card-icon"><LockKeyhole size={24} /></div>
          <div className="auth-card-heading"><span>SIGN IN</span><h2>로그인</h2><p>등록된 관리자 계정으로 로그인해 주세요.</p></div>

          {!isSupabaseConfigured && <div className="auth-error"><AlertCircle size={17} /><span>Supabase 연결 정보가 없습니다. GitHub Secrets 설정을 확인해 주세요.</span></div>}
          {error && <div className="auth-error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}

          <label className="auth-field"><span>이메일</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" placeholder="admin@example.com" required disabled={!isSupabaseConfigured || submitting} /></label>
          <label className="auth-field"><span>비밀번호</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="비밀번호 입력" required disabled={!isSupabaseConfigured || submitting} /></label>
          <button className="auth-submit" type="submit" disabled={!isSupabaseConfigured || submitting}>{submitting ? <><LoaderCircle className="is-spinning" size={18} />로그인 중</> : '로그인'}</button>
          <p className="auth-admin-note">회원가입은 지원하지 않습니다. 계정 문의는 시스템 관리자에게 요청해 주세요.</p>
        </form>
      </section>
    </main>
  )
}
