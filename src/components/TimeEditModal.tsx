import React, { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { IconX } from './icons'
import { useTranslation } from 'react-i18next'

interface TimeEditModalProps {
  currentAt: string
  onConfirm: (newAt: string) => void
  onClose: () => void
}

export function TimeEditModal({ currentAt, onConfirm, onClose }: TimeEditModalProps) {
  const { t } = useTranslation()
  // datetime-local input needs 'YYYY-MM-DDTHH:mm'
  const [value, setValue] = useState(
    format(parseISO(currentAt), "yyyy-MM-dd'T'HH:mm")
  )

  const handleConfirm = () => {
    if (!value) return
    // Convert local datetime string to ISO
    const date = new Date(value)
    onConfirm(date.toISOString())
  }

  return (
    <div
      data-time-edit-modal
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="popover"
        style={{ minWidth: 300, position: 'static' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--stone-800)' }}>{t('timeEdit.title')}</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--stone-500)', padding: 2 }}
          >
            <IconX size={16} color="var(--stone-500)" />
          </button>
        </div>

        <div className="label">{t('timeEdit.label')}</div>
        <input
          data-time-edit-input
          type="datetime-local"
          className="input-field"
          value={value}
          onChange={e => setValue(e.target.value)}
          style={{ marginBottom: 12 }}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>{t('timeEdit.cancel')}</button>
          <button data-time-edit-action="confirm" className="btn-primary" onClick={handleConfirm}>{t('timeEdit.confirm')}</button>
        </div>
      </div>
    </div>
  )
}
