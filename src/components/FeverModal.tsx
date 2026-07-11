import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GUIDANCE_MARKERS, FEVER_CARE, FeverLevel } from '../lib/guidance'

interface FeverModalProps {
  celsius: number
  level: Exclude<FeverLevel, null | 'caution'>
  ageDays: number | null
  lang: string
  onConfirm: () => void
}

export function FeverModal({ celsius, level, ageDays, lang, onConfirm }: FeverModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const [redFlagsOpen, setRedFlagsOpen] = useState(level === 'danger')

  const emergencyMarker = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')!
  const redFlagsMarker = GUIDANCE_MARKERS.find(m => m.id === 'fever_red_flags')!
  const antipyreticMarker = GUIDANCE_MARKERS.find(m => m.id === 'antipyretic_age_limits')!

  const title =
    level === 'emergency' ? t('feverModal.emergencyTitle') :
    level === 'danger'    ? t('feverModal.dangerTitle') :
                            t('feverModal.warningTitle')

  const isRed = level === 'emergency' || level === 'danger'

  // Red flags as bullet list from marker body — split on colon after intro sentence
  const redFlagsBody = lang === 'ja' ? redFlagsMarker.bodyJa : redFlagsMarker.bodyKo
  const rfColonIdx = redFlagsBody.indexOf(':')
  const rfItems = rfColonIdx >= 0
    ? redFlagsBody
        .slice(rfColonIdx + 1)
        .split(/[,、，]/)
        .map(s => s.trim().replace(/^\s*[·•\-]\s*/, '').trim())
        .filter(s => s.length > 2)
    : [redFlagsBody]

  const emergencyBody = lang === 'ja' ? emergencyMarker.bodyJa : emergencyMarker.bodyKo
  const antipyreticBody = lang === 'ja' ? antipyreticMarker.bodyJa : antipyreticMarker.bodyKo

  const feverSource = `${redFlagsMarker.sourceLabel} · ${FEVER_CARE.sourceLabel}`

  return (
    <>
      <div className="fever-modal-overlay" />
      <div
        className={`fever-modal${isRed ? ' fever-modal-red' : ' fever-modal-amber'}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Temp badge */}
        <div className="fever-modal-temp">{celsius.toFixed(1)}&deg;C</div>

        <h2 className="fever-modal-title">{title}</h2>

        {/* emergency: show emergency marker key sentence */}
        {level === 'emergency' && (
          <p className="fever-modal-body">
            {emergencyBody.split(/[。.]\s*/)[0]}.
          </p>
        )}

        {/* Unknown age note */}
        {ageDays === null && (
          <p className="fever-modal-note">{t('feverModal.unknownAgeNote')}</p>
        )}

        {/* Care steps */}
        <div className="fever-modal-section">
          <div className="fever-modal-section-title">{t('feverModal.careStepsTitle')}</div>
          <ul className="fever-modal-list">
            {FEVER_CARE.steps.map((step, i) => (
              <li key={i} className="fever-modal-list-item">
                {lang === 'ja' ? step.ja : step.ko}
              </li>
            ))}
          </ul>
        </div>

        {/* Antipyretic note (danger + warning) */}
        {(level === 'danger' || level === 'warning') && (
          <p className="fever-modal-note fever-modal-note-rule">
            {t('feverModal.antipyreticNote')}
          </p>
        )}

        {/* Duration note (warning) */}
        {level === 'warning' && (
          <p className="fever-modal-note fever-modal-note-rule">
            {t('feverModal.durationNote')}
          </p>
        )}

        {/* Red flags (collapsible) */}
        <div className="fever-modal-section">
          <button
            className="fever-modal-collapse-btn"
            onClick={() => setRedFlagsOpen(o => !o)}
            aria-expanded={redFlagsOpen}
          >
            {redFlagsOpen ? t('feverModal.redFlagCollapse') : t('feverModal.redFlagExpand')}
          </button>
          {redFlagsOpen && (
            <div className="fever-modal-flags">
              <div className="fever-modal-section-title">{t('feverModal.redFlagsTitle')}</div>
              <ul className="fever-modal-list">
                {rfItems.map((item, i) => (
                  <li key={i} className="fever-modal-list-item fever-modal-flag-item">{item}</li>
                ))}
              </ul>
              {/* antipyretic_age_limits first sentence for emergency */}
              {level === 'emergency' && (
                <p className="fever-modal-note" style={{ marginTop: 8 }}>
                  {antipyreticBody.split(/[。.]\s*/)[0]}.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Source + disclaimer */}
        <div className="fever-modal-footer">
          <span className="fever-modal-source">{feverSource}</span>
          <p className="fever-modal-disclaimer">{t('feverModal.disclaimer')}</p>
        </div>

        <button className="btn-primary fever-modal-confirm" onClick={onConfirm}>
          {t('feverModal.confirm')}
        </button>
      </div>
    </>
  )
}
