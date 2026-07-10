import React, { useState } from 'react'
import {
  Cloud, CloudOff, CheckCircle, AlertCircle, Copy, Check, LogOut,
  Users, UserPlus, RefreshCw,
} from 'lucide-react'
import { useSyncStatus, configure, signIn, signUp, signOutSync, createFamily, joinFamily } from '../sync/useSync'
import { useAppStore } from '../store/useAppStore'
import { ipc } from '../lib/ipc'
import { AppSettings } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'

// ────────────────────────────────────────────────────────────
// Sub-views
// ────────────────────────────────────────────────────────────

/** no-config: paste Firebase config JSON */
function NoConfigView() {
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const { settings, saveSettings } = useAppStore()

  const handleSave = async () => {
    setError(null)
    let parsed: Record<string, string>
    try {
      parsed = JSON.parse(raw.trim())
    } catch {
      setError('JSON 형식이 올바르지 않습니다. Firebase 콘솔에서 복사한 설정을 그대로 붙여넣어 주세요.')
      return
    }

    const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId']
    const missing = required.filter(k => !parsed[k])
    if (missing.length > 0) {
      setError(`필수 항목이 없습니다: ${missing.join(', ')}`)
      return
    }

    setSaving(true)
    try {
      const updated: AppSettings = {
        baby:     settings?.baby     ?? { name: '', birthdate: '' },
        profile:  settings?.profile  ?? { uid: uuidv4(), name: '', role: 'mom' },
        familyId: settings?.familyId ?? '',
        firebase: {
          apiKey:            parsed.apiKey,
          authDomain:        parsed.authDomain,
          projectId:         parsed.projectId,
          storageBucket:     parsed.storageBucket,
          messagingSenderId: parsed.messagingSenderId,
          appId:             parsed.appId,
        },
      }
      await saveSettings(updated)
      configure(updated.firebase, updated.familyId)
    } catch (e) {
      setError('설정 저장 중 오류가 발생했습니다.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Cloud size={16} style={{ color: 'var(--stone-400)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>Firebase 설정</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--stone-500)', margin: 0, lineHeight: 1.6 }}>
        Firebase 콘솔 → 프로젝트 설정 → 내 앱 → 웹 앱 구성 JSON을 아래에 붙여넣으세요.
        설정 방법은 <code style={{ fontSize: 11, background: 'var(--stone-200)', borderRadius: 4, padding: '1px 4px' }}>FIREBASE_SETUP.md</code> 파일을 참고하세요.
      </p>
      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={'{\n  "apiKey": "...",\n  "authDomain": "...",\n  "projectId": "...",\n  ...\n}'}
        style={{
          width: '100%',
          minHeight: 120,
          fontFamily: 'monospace',
          fontSize: 11,
          background: 'var(--cream-50)',
          border: `1px solid ${error ? 'var(--rose-400)' : 'var(--stone-300)'}`,
          borderRadius: 8,
          padding: '10px 12px',
          color: 'var(--stone-700)',
          resize: 'vertical',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {error && (
        <div style={{ fontSize: 12, color: 'var(--rose-500)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          {error}
        </div>
      )}
      <button
        className="btn-primary"
        onClick={handleSave}
        disabled={saving || !raw.trim()}
        style={{ alignSelf: 'flex-end', padding: '8px 20px', fontSize: 13 }}
      >
        {saving ? '저장 중...' : '저장'}
      </button>
    </div>
  )
}

/** signed-out: login / signup form */
function SignedOutView() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
      } else {
        await signUp(email, password)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('user-not-found') || msg.includes('wrong-password') || msg.includes('invalid-credential')) {
        setError('이메일 또는 비밀번호가 올바르지 않습니다.')
      } else if (msg.includes('email-already-in-use')) {
        setError('이미 사용 중인 이메일입니다.')
      } else if (msg.includes('weak-password')) {
        setError('비밀번호는 6자 이상이어야 합니다.')
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CloudOff size={16} style={{ color: 'var(--stone-400)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>
          {mode === 'login' ? '로그인' : '회원가입'}
        </span>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          type="email"
          className="input-field"
          placeholder="이메일"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          type="password"
          className="input-field"
          placeholder={mode === 'signup' ? '비밀번호 (6자 이상)' : '비밀번호'}
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
        />
        {error && (
          <div style={{ fontSize: 12, color: 'var(--rose-500)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            {error}
          </div>
        )}
        <button
          type="submit"
          className="btn-primary"
          disabled={busy}
          style={{ padding: '9px', fontSize: 13 }}
        >
          {busy ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
        </button>
      </form>

      <button
        onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError(null) }}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 12, color: 'var(--stone-500)', textDecoration: 'underline',
          alignSelf: 'center', padding: 0,
        }}
      >
        {mode === 'login' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
      </button>
    </div>
  )
}

/** signed-in, no family: create or join */
function NoFamilyView() {
  const { settings, saveSettings } = useAppStore()
  const [mode, setMode] = useState<'none' | 'create' | 'join'>('none')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const uid = settings?.profile?.uid ?? ''
  const name = settings?.profile?.name || '나'
  const role = settings?.profile?.role ?? 'mom'

  const handleCreate = async () => {
    setBusy(true)
    setError(null)
    try {
      const familyId = await createFamily(
        {
          babyName:      settings?.baby?.name ?? '아기',
          babyBirthdate: settings?.baby?.birthdate ?? '',
          familyName:    `${name}의 가족`,
        },
        { uid, name, role }
      )
      const updated: AppSettings = {
        ...(settings ?? { baby: { name: '', birthdate: '' }, profile: { uid, name, role }, firebase: null }),
        familyId,
      }
      await saveSettings(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleJoin = async () => {
    if (inviteCode.trim().length !== 6) {
      setError('6자리 초대 코드를 입력해 주세요.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const familyId = await joinFamily(inviteCode.trim(), { uid, name, role })
      const updated: AppSettings = {
        ...(settings ?? { baby: { name: '', birthdate: '' }, profile: { uid, name, role }, firebase: null }),
        familyId,
      }
      await saveSettings(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>가족 연결</div>
      <p style={{ fontSize: 12, color: 'var(--stone-500)', margin: 0 }}>
        처음 시작하면 가족을 만들고, 상대방은 초대코드로 참여합니다.
      </p>

      {mode === 'none' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="card"
            onClick={() => setMode('create')}
            style={{
              flex: 1, cursor: 'pointer', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 8, padding: '16px 12px',
              border: '1.5px solid var(--stone-200)', borderRadius: 12,
              background: 'var(--cream-50)',
            }}
          >
            <Users size={20} style={{ color: 'var(--peach-400)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>가족 만들기</span>
            <span style={{ fontSize: 11, color: 'var(--stone-400)', textAlign: 'center' }}>
              처음 시작하는 경우
            </span>
          </button>
          <button
            className="card"
            onClick={() => setMode('join')}
            style={{
              flex: 1, cursor: 'pointer', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 8, padding: '16px 12px',
              border: '1.5px solid var(--stone-200)', borderRadius: 12,
              background: 'var(--cream-50)',
            }}
          >
            <UserPlus size={20} style={{ color: 'var(--sage-400)' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>초대코드로 참여</span>
            <span style={{ fontSize: 11, color: 'var(--stone-400)', textAlign: 'center' }}>
              상대방에게 코드를 받은 경우
            </span>
          </button>
        </div>
      )}

      {mode === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--stone-500)', margin: 0 }}>
            설정의 아기 정보와 내 이름을 사용해 가족을 만듭니다.
          </p>
          {error && (
            <div style={{ fontSize: 12, color: 'var(--rose-500)', display: 'flex', gap: 6 }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn-primary"
              onClick={handleCreate}
              disabled={busy}
              style={{ flex: 1, padding: '9px', fontSize: 13 }}
            >
              {busy ? '생성 중...' : '가족 만들기'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setMode('none'); setError(null) }}
              style={{ padding: '9px 14px', fontSize: 13 }}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {mode === 'join' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            className="input-field"
            placeholder="6자리 초대 코드"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value.toUpperCase())}
            maxLength={6}
            style={{ letterSpacing: '0.15em', textTransform: 'uppercase', fontWeight: 600 }}
          />
          {error && (
            <div style={{ fontSize: 12, color: 'var(--rose-500)', display: 'flex', gap: 6 }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn-primary"
              onClick={handleJoin}
              disabled={busy || inviteCode.trim().length !== 6}
              style={{ flex: 1, padding: '9px', fontSize: 13 }}
            >
              {busy ? '참여 중...' : '참여'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setMode('none'); setError(null); setInviteCode('') }}
              style={{ padding: '9px 14px', fontSize: 13 }}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** CopyButton helper */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      // fallback
    })
  }

  return (
    <button
      onClick={handleCopy}
      title="복사"
      style={{
        background: 'var(--stone-100)', border: '1px solid var(--stone-200)',
        borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 11, color: 'var(--stone-600)',
      }}
    >
      {copied ? <Check size={12} style={{ color: 'var(--sage-500)' }} /> : <Copy size={12} />}
      {copied ? '복사됨' : '복사'}
    </button>
  )
}

/** online: status + family info + invite code + logout */
function OnlineView({ detail }: { detail: string }) {
  const { settings, saveSettings } = useAppStore()
  const [busySignOut, setBusySignOut] = useState(false)

  // Extract invite code from detail or show placeholder
  // The invite code is stored in Firestore family doc; here we show familyId as fallback
  const familyId = settings?.familyId ?? ''

  const handleSignOut = async () => {
    setBusySignOut(true)
    try {
      await signOutSync()
    } finally {
      setBusySignOut(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Status badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--sage-400)',
          boxShadow: '0 0 0 2px var(--sage-100)',
          flexShrink: 0,
          animation: 'pulse 2s infinite',
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sage-500)' }}>동기화 중</span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--stone-500)' }}>{detail}</div>

      {familyId && (
        <div style={{
          background: 'var(--cream-100)',
          border: '1px solid var(--stone-200)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ fontSize: 11, color: 'var(--stone-400)', fontWeight: 500 }}>가족 ID</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{
              fontSize: 11, color: 'var(--stone-600)',
              flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {familyId}
            </code>
            <CopyButton text={familyId} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--stone-400)', lineHeight: 1.5 }}>
            엄마 맥에서 이 ID를 초대코드 입력란에 붙여넣으세요.
          </div>
        </div>
      )}

      <button
        className="btn-secondary"
        onClick={handleSignOut}
        disabled={busySignOut}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 14px', alignSelf: 'flex-start' }}
      >
        <LogOut size={13} />
        {busySignOut ? '로그아웃 중...' : '로그아웃'}
      </button>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  )
}

/** error view */
function ErrorView({ detail }: { detail: string }) {
  const { settings } = useAppStore()

  const handleRetry = () => {
    const cfg = settings?.firebase ?? null
    const fid = settings?.familyId ?? ''
    configure(cfg, fid)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--rose-400)',
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rose-500)' }}>동기화 오류</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--stone-500)', lineHeight: 1.6 }}>{detail}</div>
      <button
        className="btn-secondary"
        onClick={handleRetry}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 14px', alignSelf: 'flex-start' }}
      >
        <RefreshCw size={13} />
        재시도
      </button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────

export function SyncSettingsSlot() {
  const { status, detail } = useSyncStatus()
  const { settings } = useAppStore()

  // Determine effective status considering family linking
  // If online but no familyId, show no-family view
  const hasFamily = !!(settings?.familyId)

  let content: React.ReactNode

  switch (status) {
    case 'no-config':
      content = <NoConfigView />
      break

    case 'signed-out':
      // Engine sets signed-out both for "not logged in" and "logged in but no family".
      // Detect the latter via the detail message.
      if (detail === '가족 연결 필요') {
        content = <NoFamilyView />
      } else {
        content = <SignedOutView />
      }
      break

    case 'connecting':
      content = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--stone-500)', fontSize: 13 }}>
          <Cloud size={16} style={{ color: 'var(--stone-400)', animation: 'spin 1.2s linear infinite' }} />
          연결 중...
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )
      break

    case 'online':
      if (!hasFamily) {
        content = <NoFamilyView />
      } else {
        content = <OnlineView detail={detail} />
      }
      break

    case 'error':
      content = <ErrorView detail={detail} />
      break

    case 'off':
    default:
      // 'off' means sync was explicitly stopped or Firebase not configured yet
      if (!settings?.firebase) {
        content = <NoConfigView />
      } else {
        content = (
          <div style={{ fontSize: 12, color: 'var(--stone-400)' }}>동기화 꺼짐</div>
        )
      }
      break
  }

  return (
    <div
      style={{
        background: 'var(--cream-50)',
        border: '1px solid var(--stone-200)',
        borderRadius: 12,
        padding: '16px',
      }}
    >
      {content}
    </div>
  )
}
