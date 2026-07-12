/**
 * UpdateBanner — glass pill shown bottom-right when an update is available.
 *
 * Automatic mode: "update:ready" shows version + [지금 재시작] [나중에].
 * Manual mode: "update:available" shows version + [다운로드] [나중에].
 *
 * [나중에] dismisses until next app start.
 * z-index below FeverModal (z-50 in project convention), above toasts.
 * Animation: opacity + margin (house rule — no transform-only).
 * No emoji per project rules.
 */

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../lib/ipc'

// `ready` is automatic (NSIS); `available` is manual (portable Windows/macOS).
type BannerState =
  | { type: 'idle' }
  | { type: 'ready'; version: string }
  | { type: 'available'; version: string; url: string }

export function UpdateBanner() {
  const { t } = useTranslation()
  const [state, setState] = useState<BannerState>({ type: 'idle' })
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const offReady = ipc.onUpdateReady(({ version }) => {
      setState({ type: 'ready', version })
      setVisible(true)
    })
    const offAvailable = ipc.onUpdateAvailable(({ version, url }) => {
      setState({ type: 'available', version, url })
      setVisible(true)
    })
    return () => {
      offReady()
      offAvailable()
    }
  }, [])

  if (!visible || state.type === 'idle') return null

  function dismiss() {
    setVisible(false)
  }

  function handlePrimary() {
    if (state.type === 'ready') {
      ipc.installUpdate()
    } else if (state.type === 'available') {
      ipc.openUpdateDownload()
    }
  }

  const version = state.version

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: '80px',   // above toast-container (toasts sit at bottom: 24px, stack up)
        right: '20px',
        zIndex: 40,       // below fever-modal (z-index 50), above toasts (z-index 30)
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        borderRadius: '999px',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        background: 'rgba(255,255,255,0.72)',
        boxShadow: 'var(--glass-inset-light), 0 4px 20px rgba(0,0,0,0.10)',
        fontSize: '13px',
        fontWeight: 500,
        color: 'var(--text-primary)',
        opacity: visible ? 1 : 0,
        marginBottom: visible ? '0px' : '-16px',
        transition:
          'opacity var(--dur-appear) var(--ease-out-smooth), ' +
          'margin-bottom var(--dur-appear) var(--ease-out-smooth)',
      }}
      data-update-banner
    >
      <span>
        {state.type === 'ready'
          ? t('update.readyMessage', { v: version })
          : t('update.availableMessage', { v: version })}
      </span>

      <button
        onClick={handlePrimary}
        style={{
          padding: '4px 12px',
          borderRadius: '999px',
          border: 'none',
          background: 'var(--action-bg)',
          color: '#fff',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
          flexShrink: 0,
          letterSpacing: '-0.01em',
        }}
      >
        {state.type === 'ready' ? t('update.installBtn') : t('update.downloadBtn')}
      </button>

      <button
        onClick={dismiss}
        style={{
          padding: '4px 10px',
          borderRadius: '999px',
          border: '1px solid var(--border)',
          background: 'transparent',
          color: 'var(--text-secondary)',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {t('update.laterBtn')}
      </button>
    </div>
  )
}

// ── Dark mode overrides via CSS ────────────────────────────────────────────────
// Injected once. Using a <style> element is the lightest approach that keeps
// the dark-mode rule co-located with the component (no separate CSS file needed).
const STYLE_ID = '__update-banner-dark'
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
[data-theme="dark"] [data-update-banner] {
  background: rgba(30,30,36,0.82);
  box-shadow: var(--glass-inset-dark), 0 4px 20px rgba(0,0,0,0.35);
  color: var(--text-primary);
}
`
  document.head.appendChild(el)
}
