import React, { useState } from 'react'
import {
  Cloud, CloudOff, AlertCircle, Copy, Check, LogOut,
  Users, UserPlus, RefreshCw,
} from 'lucide-react'
import { useSyncStatus, configure, signIn, signUp, signOutSync, createFamily, joinFamily } from '../sync/useSync'
import { DETAIL_FAMILY_NEEDED, DETAIL_FAMILY_NOT_FOUND } from '../sync/syncEngine'
import { useAppStore } from '../store/useAppStore'
import { AppSettings } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'

// ────────────────────────────────────────────────────────────
// Sub-views
// ────────────────────────────────────────────────────────────

/** no-config: paste Firebase config JSON */
function NoConfigView() {
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const { settings, saveSettings } = useAppStore()
  const { t } = useTranslation()

  const handleSave = async () => {
    setError(null)
    let parsed: Record<string, string>
    try {
      parsed = JSON.parse(raw.trim())
    } catch {
      setError(t('sync.errorInvalidJson'))
      return
    }

    const required = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId']
    const missing = required.filter(k => !parsed[k])
    if (missing.length > 0) {
      setError(t('sync.errorMissingFields', { fields: missing.join(', ') }))
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
        language: settings?.language,
      }
      await saveSettings(updated)
      configure(updated.firebase, updated.familyId)
    } catch (e) {
      setError(t('sync.errorSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Cloud size={16} style={{ color: 'var(--stone-400)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>{t('sync.noConfigTitle')}</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--stone-500)', margin: 0, lineHeight: 1.6 }}>
        {t('sync.noConfigDesc')}
        {' '}<code style={{ fontSize: 11, background: 'var(--stone-200)', borderRadius: 4, padding: '1px 4px' }}>FIREBASE_SETUP.md</code>
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
        {saving ? t('sync.saving') : t('sync.save')}
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
  const { settings, saveSettings } = useAppStore()
  const { t } = useTranslation()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const user = mode === 'login'
        ? await signIn(email, password)
        : await signUp(email, password)

      // Persist the real Firebase uid into settings.profile so that future
      // events and family membership use the authoritative uid, not the
      // locally-generated placeholder that may be empty on a fresh install.
      if (user?.uid && settings?.profile?.uid !== user.uid) {
        const updated: AppSettings = {
          ...(settings ?? { baby: { name: '', birthdate: '' }, firebase: null, familyId: '' }),
          profile: {
            ...(settings?.profile ?? { name: '', role: 'mom' as const }),
            uid: user.uid,
          },
        }
        await saveSettings(updated).catch(() => { /* best-effort */ })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('user-not-found') || msg.includes('wrong-password') || msg.includes('invalid-credential')) {
        setError(t('sync.errorWrongCredentials'))
      } else if (msg.includes('email-already-in-use')) {
        setError(t('sync.errorEmailInUse'))
      } else if (msg.includes('weak-password')) {
        setError(t('sync.errorWeakPassword'))
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
          {mode === 'login' ? t('sync.login') : t('sync.signup')}
        </span>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          type="email"
          className="input-field"
          placeholder={t('sync.emailPlaceholder')}
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          type="password"
          className="input-field"
          placeholder={mode === 'signup' ? t('sync.passwordSignupPlaceholder') : t('sync.passwordPlaceholder')}
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
          {busy ? t('sync.processing') : mode === 'login' ? t('sync.login') : t('sync.signup')}
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
        {mode === 'login' ? t('sync.switchToSignup') : t('sync.switchToLogin')}
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
  const { t } = useTranslation()

  const uid = settings?.profile?.uid ?? ''
  const name = settings?.profile?.name || ''
  const role = settings?.profile?.role ?? 'mom'

  const handleCreate = async () => {
    setBusy(true)
    setError(null)
    try {
      // F2: createFamily now returns { familyId, inviteCode }
      const { familyId } = await createFamily(
        {
          babyName:      settings?.baby?.name ?? '',
          babyBirthdate: settings?.baby?.birthdate ?? '',
          familyName:    `${name}の家族`,
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
      setError(t('sync.errorInviteCodeLength'))
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
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg === DETAIL_FAMILY_NOT_FOUND ? t('sync.errorFamilyNotFound') : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>{t('sync.familyConnect')}</div>
      <p style={{ fontSize: 12, color: 'var(--stone-500)', margin: 0 }}>
        {t('sync.familyConnectDesc')}
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
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>{t('sync.createFamily')}</span>
            <span style={{ fontSize: 11, color: 'var(--stone-400)', textAlign: 'center' }}>
              {t('sync.createFamilyDesc')}
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
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)' }}>{t('sync.joinFamily')}</span>
            <span style={{ fontSize: 11, color: 'var(--stone-400)', textAlign: 'center' }}>
              {t('sync.joinFamilyDesc')}
            </span>
          </button>
        </div>
      )}

      {mode === 'create' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--stone-500)', margin: 0 }}>
            {t('sync.createFamilyNote')}
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
              {busy ? t('sync.creating') : t('sync.createFamily')}
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setMode('none'); setError(null) }}
              style={{ padding: '9px 14px', fontSize: 13 }}
            >
              {t('sync.cancel')}
            </button>
          </div>
        </div>
      )}

      {mode === 'join' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            className="input-field"
            placeholder={t('sync.inviteCodePlaceholder')}
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
              {busy ? t('sync.joining') : t('sync.join')}
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setMode('none'); setError(null); setInviteCode('') }}
              style={{ padding: '9px 14px', fontSize: 13 }}
            >
              {t('sync.cancel')}
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
  const { t } = useTranslation()

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
      title={t('sync.copy')}
      style={{
        background: 'var(--stone-100)', border: '1px solid var(--stone-200)',
        borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 11, color: 'var(--stone-600)',
      }}
    >
      {copied ? <Check size={12} style={{ color: 'var(--sage-500)' }} /> : <Copy size={12} />}
      {copied ? t('sync.copied') : t('sync.copy')}
    </button>
  )
}

/** online: status + invite code + logout */
function OnlineView({ detail }: { detail: string }) {
  const { settings } = useAppStore()
  const syncStatus = useSyncStatus()
  const [busySignOut, setBusySignOut] = useState(false)
  const { t } = useTranslation()

  // F2: display the actual 6-char invite code (surfaced from syncEngine state),
  // not the internal familyId UUID which is useless to the user.
  const inviteCode = syncStatus.inviteCode ?? ''
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
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--sage-500)' }}>{t('sync.syncing')}</span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--stone-500)' }}>{detail}</div>

      {/* F2: Show the 6-char invite code with copy button and correct instruction */}
      {(inviteCode || familyId) && (
        <div style={{
          background: 'var(--cream-100)',
          border: '1px solid var(--stone-200)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ fontSize: 11, color: 'var(--stone-400)', fontWeight: 500 }}>{t('sync.inviteCodeLabel')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{
              fontSize: 18, fontWeight: 700, color: 'var(--stone-700)',
              letterSpacing: '0.2em', flex: 1,
            }}>
              {inviteCode || t('sync.inviteCodeLoading')}
            </code>
            {inviteCode && <CopyButton text={inviteCode} />}
          </div>
          <div style={{ fontSize: 11, color: 'var(--stone-400)', lineHeight: 1.5 }}>
            {t('sync.inviteCodeInstruction')}
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
        {busySignOut ? t('sync.signingOut') : t('sync.signOut')}
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
  const { t } = useTranslation()

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
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--rose-500)' }}>{t('sync.syncError')}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--stone-500)', lineHeight: 1.6 }}>{detail}</div>
      <button
        className="btn-secondary"
        onClick={handleRetry}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 14px', alignSelf: 'flex-start' }}
      >
        <RefreshCw size={13} />
        {t('sync.retry')}
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
  const { t } = useTranslation()

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
      // Detect the latter via the internal sentinel constant from syncEngine.
      if (detail === DETAIL_FAMILY_NEEDED) {
        content = <NoFamilyView />
      } else {
        content = <SignedOutView />
      }
      break

    case 'connecting':
      content = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--stone-500)', fontSize: 13 }}>
          <Cloud size={16} style={{ color: 'var(--stone-400)', animation: 'spin 1.2s linear infinite' }} />
          {t('sync.connecting')}
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
          <div style={{ fontSize: 12, color: 'var(--stone-400)' }}>{t('sync.syncOff')}</div>
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
