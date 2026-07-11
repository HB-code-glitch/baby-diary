import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconX } from './icons'

interface DeleteAllModalProps {
  onConfirm: () => void
  onClose: () => void
  busy: boolean
}

export function DeleteAllModal({ onConfirm, onClose, busy }: DeleteAllModalProps) {
  const { t } = useTranslation()
  const [confirmInput, setConfirmInput] = useState('')

  const confirmWord = t('settings.deleteAllConfirmWord')
  const isConfirmed = confirmInput === confirmWord

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !busy) {
      onClose()
    }
  }

  return (
    <div
      className="delete-all-overlay"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.deleteAllTitle')}
    >
      <div className="delete-all-modal">
        {/* Header */}
        <div className="delete-all-header">
          <h2 className="delete-all-title">{t('settings.deleteAllTitle')}</h2>
          {!busy && (
            <button
              className="delete-all-close"
              onClick={onClose}
              aria-label={t('settings.deleteAllCancel')}
            >
              <IconX size={16} color="var(--text-muted)" />
            </button>
          )}
        </div>

        {/* Body */}
        <p className="delete-all-body">
          {t('settings.deleteAllBody').split('\n').map((line, i, arr) => (
            <React.Fragment key={i}>
              {line}
              {i < arr.length - 1 && <br />}
            </React.Fragment>
          ))}
        </p>

        {/* Type-to-confirm */}
        <div className="delete-all-confirm-section">
          <div className="label delete-all-confirm-hint">
            {t('settings.deleteAllConfirmHint')}
          </div>
          <input
            type="text"
            className="input-field"
            placeholder={t('settings.deleteAllConfirmPlaceholder')}
            value={confirmInput}
            onChange={e => setConfirmInput(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>

        {/* Actions */}
        <div className="delete-all-actions">
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            {t('settings.deleteAllCancel')}
          </button>
          <button
            className="btn-danger"
            onClick={onConfirm}
            disabled={!isConfirmed || busy}
          >
            {busy ? '…' : t('settings.deleteAllConfirmBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
