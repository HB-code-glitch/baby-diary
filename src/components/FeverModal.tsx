import React, { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FEVER_CARE,
  FEVER_DURATION_GUIDANCE,
  FEVER_RED_FLAGS,
  FeverLevel,
} from '../lib/guidance'

export interface FeverModalProps {
  celsius: number
  level: Exclude<FeverLevel, null | 'caution'>
  ageDays: number | null
  completedMonths?: number | null
  lang: string
  returnFocusTo?: HTMLElement | null
  onConfirm: () => void
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface FocusTarget {
  focus: () => void
}

export function focusDialogAndCreateRestore(
  dialog: FocusTarget | null,
  previouslyFocused: FocusTarget | null,
): () => void {
  dialog?.focus()
  return () => previouslyFocused?.focus()
}

export type FeverDialogKeyAction = 'close' | 'dialog' | 'first' | 'last' | null

export function resolveFeverDialogKeyAction({
  key,
  shiftKey,
  activeIndex,
  focusableCount,
}: {
  key: string
  shiftKey: boolean
  /** -1 means the dialog container itself is focused. */
  activeIndex: number
  focusableCount: number
}): FeverDialogKeyAction {
  if (key === 'Escape') return 'close'
  if (key !== 'Tab') return null
  if (focusableCount === 0) return 'dialog'
  if (shiftKey && activeIndex <= 0) return 'last'
  if (!shiftKey && activeIndex === focusableCount - 1) return 'first'
  return null
}

export function FeverModal({
  celsius,
  level,
  ageDays,
  completedMonths = null,
  lang,
  returnFocusTo = null,
  onConfirm,
}: FeverModalProps): React.JSX.Element {
  const { t } = useTranslation()
  const [redFlagsOpen, setRedFlagsOpen] = useState(level === 'emergency' || level === 'danger')
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const activeBeforeDialog = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const restoreFocus = focusDialogAndCreateRestore(
      dialogRef.current,
      returnFocusTo ?? activeBeforeDialog,
    )
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
      restoreFocus()
    }
  }, [returnFocusTo])

  const title = level === 'emergency'
    ? t('feverModal.emergencyTitle')
    : level === 'danger'
      ? t('feverModal.dangerTitle')
      : t('feverModal.warningTitle')

  const isRed = level === 'emergency' || level === 'danger'
  const isNewborn = ageDays != null && ageDays >= 0 && ageDays < 28
  const visibleRedFlags = FEVER_RED_FLAGS.filter(flag => !flag.newbornOnly || isNewborn)
  const language = lang === 'ja' ? 'ja' : 'ko'
  const isOlderHighTemperature = level === 'warning' && completedMonths != null && completedMonths >= 6

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const focusable = dialogRef.current
      ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      : []
    const activeIndex = document.activeElement === dialogRef.current
      ? -1
      : focusable.findIndex(element => element === document.activeElement)
    const action = resolveFeverDialogKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      activeIndex,
      focusableCount: focusable.length,
    })

    if (action === 'close') {
      event.preventDefault()
      onConfirm()
      return
    }
    if (action === 'dialog') {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    if (action === 'last') {
      event.preventDefault()
      focusable[focusable.length - 1]?.focus()
    } else if (action === 'first') {
      event.preventDefault()
      focusable[0]?.focus()
    }
  }

  return (
    <>
      <div className="fever-modal-overlay" aria-hidden="true" />
      <div
        ref={dialogRef}
        className={`fever-modal${isRed ? ' fever-modal-red' : ' fever-modal-amber'}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="fever-modal-temp">{celsius.toFixed(1)}&deg;C</div>
        <h2 id={titleId} className="fever-modal-title">{title}</h2>

        {isRed && (
          <p className="fever-modal-note fever-modal-note-rule">
            {t('feverModal.urgentAction')}
          </p>
        )}

        <p id={descriptionId} className="fever-modal-body">
          {level === 'emergency'
            ? t('feverModal.emergencyBody')
            : level === 'danger'
              ? t('feverModal.dangerBody')
              : isOlderHighTemperature
                ? t('feverModal.olderHighTemperatureBody')
                : t('feverModal.warningBody')}
        </p>

        {ageDays === null && (
          <p className="fever-modal-note">{t('feverModal.unknownAgeNote')}</p>
        )}

        <p className="fever-modal-note fever-modal-note-rule">
          {t('feverModal.measurementSiteNote')}
        </p>

        <div className="fever-modal-section">
          <div className="fever-modal-section-title">{t('feverModal.careStepsTitle')}</div>
          <ul className="fever-modal-list">
            {FEVER_CARE.steps.map((step, index) => (
              <li key={index} className="fever-modal-list-item">{step[language]}</li>
            ))}
          </ul>
        </div>

        <p className="fever-modal-note fever-modal-note-rule">
          {t('feverModal.medicationNote')}
        </p>
        <p className="fever-modal-note fever-modal-note-rule">
          {FEVER_DURATION_GUIDANCE[language]}
        </p>

        <div className="fever-modal-section">
          <p className="fever-modal-note">{t('feverModal.redFlagIntro')}</p>
          <button
            className="fever-modal-collapse-btn"
            onClick={() => setRedFlagsOpen(open => !open)}
            aria-expanded={redFlagsOpen}
          >
            {redFlagsOpen ? t('feverModal.redFlagCollapse') : t('feverModal.redFlagExpand')}
          </button>
          {redFlagsOpen && (
            <div className="fever-modal-flags">
              <div className="fever-modal-section-title">{t('feverModal.redFlagsTitle')}</div>
              <ul className="fever-modal-list">
                {visibleRedFlags.map(flag => (
                  <li key={flag.id} className="fever-modal-list-item fever-modal-flag-item">
                    {flag[language]}
                  </li>
                ))}
              </ul>
              <p className="fever-modal-note">{t('feverModal.redFlagAction')}</p>
            </div>
          )}
        </div>

        <div className="fever-modal-footer">
          <span className="fever-modal-source">{FEVER_CARE.sourceLabel}</span>
          <p className="fever-modal-disclaimer">{t('feverModal.disclaimer')}</p>
        </div>

        <button className="btn-primary fever-modal-confirm" onClick={onConfirm}>
          {t('feverModal.confirm')}
        </button>
      </div>
    </>
  )
}
