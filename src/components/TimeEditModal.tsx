import React, { useEffect, useId, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { IconX } from './icons'
import { useTranslation } from 'react-i18next'

interface TimeEditModalProps {
  currentAt: string
  onConfirm: (newAt: string) => Promise<void> | void
  onClose: () => void
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function TimeEditModal({ currentAt, onConfirm, onClose }: TimeEditModalProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const dialogRef = useRef<HTMLFormElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )
  const submittingRef = useRef(false)
  const mountedRef = useRef(true)
  const refocusAfterSubmitRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [value, setValue] = useState(
    format(parseISO(currentAt), "yyyy-MM-dd'T'HH:mm"),
  )

  useEffect(() => {
    mountedRef.current = true
    inputRef.current?.focus()
    return () => {
      mountedRef.current = false
      const trigger = restoreFocusRef.current
      if (trigger?.isConnected) trigger.focus()
    }
  }, [])

  useEffect(() => {
    if (!submitting && refocusAfterSubmitRef.current) {
      refocusAfterSubmitRef.current = false
      inputRef.current?.focus()
    }
  }, [submitting])

  const close = () => {
    if (!submittingRef.current) onClose()
  }

  const handleConfirm = async () => {
    if (!value || submittingRef.current) return
    submittingRef.current = true
    dialogRef.current?.focus()
    setSubmitting(true)
    try {
      await onConfirm(new Date(value).toISOString())
    } catch {
      // The caller provides the alert. Keep this dialog and the entered value
      // intact so a failed disk write can be retried without data re-entry.
    } finally {
      submittingRef.current = false
      if (mountedRef.current) {
        refocusAfterSubmitRef.current = true
        setSubmitting(false)
      }
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }

    if (
      event.key === 'Enter'
      && event.target instanceof HTMLInputElement
      && !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      void handleConfirm()
      return
    }

    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      data-time-edit-modal
      className="time-edit-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <form
        ref={dialogRef}
        className="popover time-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={submitting || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onSubmit={event => {
          event.preventDefault()
          void handleConfirm()
        }}
      >
        <div className="time-edit-header">
          <h2 id={titleId} className="time-edit-title">{t('timeEdit.title')}</h2>
          <button
            data-time-edit-action="close"
            type="button"
            className="time-edit-control time-edit-close"
            onClick={close}
            disabled={submitting}
            aria-label={t('timeEdit.close')}
          >
            <IconX size={16} color="currentColor" />
          </button>
        </div>

        <p id={descriptionId} className="time-edit-description">{t('timeEdit.description')}</p>
        <label className="label" htmlFor={inputId}>{t('timeEdit.label')}</label>
        <input
          ref={inputRef}
          id={inputId}
          name="recordedAt"
          autoComplete="off"
          data-time-edit-input
          type="datetime-local"
          className="input-field time-edit-input"
          value={value}
          onChange={event => setValue(event.target.value)}
          disabled={submitting}
        />

        <div className="time-edit-actions">
          <button
            type="button"
            className="btn-secondary time-edit-control"
            onClick={close}
            disabled={submitting}
          >
            {t('timeEdit.cancel')}
          </button>
          <button
            data-time-edit-action="confirm"
            type="submit"
            className="btn-primary time-edit-control"
            disabled={submitting || !value}
          >
            {submitting ? t('timeEdit.saving') : t('timeEdit.confirm')}
          </button>
        </div>
      </form>
    </div>
  )
}
