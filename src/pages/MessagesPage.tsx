import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconPlus, IconPencil, IconTrash, IconX } from '../components/icons'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { DiaryEvent, MessageData } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'
import { sortValidEventsNewestFirst } from '../lib/eventTime'
import { getBoundedStaggerDelay, useProgressiveList } from '../lib/useProgressiveList'
import { AccessibleFormDialog } from '../components/AccessibleFormDialog'

// ---------------------------------------------------------------------------
// Message composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  initial?: DiaryEvent
  babyName: string
  onSave: (text: string) => Promise<void>
  onClose: () => void
}

function MessageComposer({ initial, babyName, onSave, onClose }: ComposerProps) {
  const data = initial?.data as MessageData | undefined
  const [text, setText] = useState(data?.text ?? '')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const textInputId = useId()
  const errorId = useId()
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const submittingRef = useRef(false)
  const mountedRef = useRef(true)
  const refocusAfterFailure = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!saving && refocusAfterFailure.current) {
      refocusAfterFailure.current = false
      textRef.current?.focus()
    }
  }, [saving])

  const handleSave = async () => {
    if (!text.trim() || submittingRef.current) return
    submittingRef.current = true
    setSaveFailed(false)
    setSaving(true)
    try {
      await onSave(text.trim())
      onClose()
    } catch {
      refocusAfterFailure.current = true
      setSaveFailed(true)
    } finally {
      submittingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <AccessibleFormDialog
      modalName="messages"
      titleId={titleId}
      descriptionId={descriptionId}
      busy={saving}
      initialFocusRef={textRef}
      onClose={onClose}
      onSubmit={() => { void handleSave() }}
      className="editor-modal-dialog--message"
    >
        <div className="editor-modal-header">
          <div>
            <h2 id={titleId} className="editor-modal-title">
              {initial ? t('messages.editTitle') : t('messages.composerToBaby', { babyName })}
            </h2>
            <p id={descriptionId} className="editor-modal-description">
              {t('messages.composerSubtitle')}
            </p>
          </div>
          <button
            type="button"
            data-editor-action="close"
            className="editor-modal-control editor-modal-close"
            onClick={onClose}
            disabled={saving}
            aria-label={t('timeEdit.close')}
          >
            <IconX size={18} color="var(--stone-500)" />
          </button>
        </div>

        <label className="sr-only" htmlFor={textInputId}>{t('messages.write')}</label>
        <textarea
          ref={textRef}
          id={textInputId}
          data-editor-input="message-text"
          className="textarea-field"
          style={{
            minHeight: 180,
            background: 'var(--cream-100)',
            border: '1.5px solid var(--stone-200)',
            lineHeight: 1.8,
            fontSize: 14,
          }}
          placeholder={t('messages.placeholder', { babyName })}
          value={text}
          onChange={e => {
            setText(e.target.value)
            setSaveFailed(false)
          }}
          aria-describedby={saveFailed ? errorId : undefined}
          disabled={saving}
        />

        {saveFailed && (
          <p
            id={errorId}
            className="editor-modal-error"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {t('toast.saveFailed')}
          </p>
        )}

        <div className="editor-modal-actions">
          <button
            type="button"
            className="btn-secondary editor-modal-control"
            onClick={onClose}
            disabled={saving}
          >
            {t('messages.cancel')}
          </button>
          <button
            type="submit"
            data-editor-action="save"
            className="btn-primary editor-modal-control"
            disabled={saving || !text.trim()}
            style={{ opacity: !text.trim() ? 0.5 : 1 }}
          >
            {saving ? t('messages.saving') : t('messages.send')}
          </button>
        </div>
    </AccessibleFormDialog>
  )
}

// ---------------------------------------------------------------------------
// MessagesPage
// ---------------------------------------------------------------------------

export function MessagesPage() {
  const events    = useAppStore(s => s.events)
  const settings  = useAppStore(s => s.settings)
  const { addEvent, editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  const [composerOpen, setComposerOpen] = useState(false)
  const [editTarget, setEditTarget]     = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const deleteFocusTarget = useRef<string | null>(null)
  const loadMoreFocusTarget = useRef<string | null>(null)
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')

  const messageEvents = useMemo(() =>
    sortValidEventsNewestFirst(events.filter(e => !e.deleted && e.type === 'message')),
    [events]
  )
  const {
    visibleItems,
    remainingCount,
    canLoadMore,
    nextBatchCount,
    loadMore,
  } = useProgressiveList(messageEvents)

  useLayoutEffect(() => {
    const targetId = deleteFocusTarget.current
    if (!targetId) return
    const target = Array.from(
      pageRef.current?.querySelectorAll<HTMLButtonElement>('[data-message-action="edit"]') ?? [],
    ).find(button => button.dataset.eventId === targetId)
    if (!target) return
    deleteFocusTarget.current = null
    target.focus({ preventScroll: true })
  }, [messageEvents])

  useLayoutEffect(() => {
    const targetId = loadMoreFocusTarget.current
    if (!targetId) return
    const target = Array.from(
      pageRef.current?.querySelectorAll<HTMLButtonElement>('[data-message-action="edit"]') ?? [],
    ).find(button => button.dataset.eventId === targetId)
    if (!target) return
    loadMoreFocusTarget.current = null
    target.focus({ preventScroll: true })
  }, [visibleItems.length])

  const handleLoadMore = () => {
    if (remainingCount <= nextBatchCount) {
      loadMoreFocusTarget.current = messageEvents[visibleItems.length]?.id ?? null
    }
    loadMore()
  }

  useEffect(() => () => {
    if (confirmDeleteTimer.current !== null) clearTimeout(confirmDeleteTimer.current)
    confirmDeleteTimer.current = null
  }, [])

  const clearConfirmDeleteTimer = () => {
    if (confirmDeleteTimer.current !== null) clearTimeout(confirmDeleteTimer.current)
    confirmDeleteTimer.current = null
  }

  const handleSave = async (text: string) => {
    const time = new Date().toISOString()
    try {
      if (editTarget) {
        await editEvent(editTarget, { data: { text } as MessageData })
        showToast({ message: t('messages.toastEdited') })
      } else {
        const event: DiaryEvent = {
          id: uuidv4(),
          mutationId: uuidv4(),
          type: 'message',
          at: time,
          data: { text } as MessageData,
          author: {
            uid:  settings?.profile?.uid  ?? 'local',
            name: settings?.profile?.name ?? '',
            role: settings?.profile?.role ?? 'mom',
          },
          createdAt: time,
          updatedAt: time,
          rev: 1,
          deleted: false,
        }
        await addEvent(event)
        showToast({ message: t('messages.toastSaved') })
      }
    } catch {
      showToast({ message: t('toast.saveFailed') })
      throw new Error('message_save_failed')
    }
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      clearConfirmDeleteTimer()
      const index = visibleItems.findIndex(candidate => candidate.id === event.id)
      deleteFocusTarget.current = visibleItems[index + 1]?.id ?? visibleItems[index - 1]?.id ?? null
      try {
        await softDeleteEvent(event)
        setConfirmDelete(current => current === event.id ? null : current)
        showToast({ message: t('messages.toastDeleted') })
      } catch {
        deleteFocusTarget.current = null
        setConfirmDelete(current => current === event.id ? null : current)
        showToast({ message: t('toast.deleteFailed') })
      }
    } else {
      clearConfirmDeleteTimer()
      setConfirmDelete(event.id)
      const timer = setTimeout(() => {
        if (confirmDeleteTimer.current === timer) confirmDeleteTimer.current = null
        setConfirmDelete(current => current === event.id ? null : current)
      }, 3000)
      confirmDeleteTimer.current = timer
    }
  }

  const openComposer = (event?: DiaryEvent) => {
    setEditTarget(event ?? null)
    setComposerOpen(true)
  }

  return (
    <div ref={pageRef} className="page-container" data-tour="messages">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="page-title">{t('messages.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--stone-500)', marginTop: 2 }}>
            {t('messages.subtitle', { babyName })}
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => openComposer()}
        >
          <IconPlus size={14} color="white" />
          {t('messages.write')}
        </button>
      </div>

      <div style={{ marginBottom: 24 }}>
        <hr className="divider" />
      </div>

      {messageEvents.length === 0 ? (
        <div className="empty-state">
          {/* Envelope with heart illustration */}
          <svg width="64" height="52" viewBox="0 0 64 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="8" y="12" width="48" height="32" rx="4" stroke="var(--stone-300)" strokeWidth="1.5"/>
            <path d="M8 16L32 30L56 16" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M32 22C32 22 28.5 19 27 21C25.5 23 27 25 32 28C37 25 38.5 23 37 21C35.5 19 32 22 32 22Z" stroke="var(--rose-300)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div className="empty-state-title">{t('messages.emptyTitle')}</div>
          <div className="empty-state-sub">{t('messages.emptySub', { babyName })}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
          {visibleItems.map((event, i) => {
            const data = event.data as MessageData
            return (
              <div
                key={`${event.id}-${event.rev}`}
                data-message-entry
                data-event-id={event.id}
                className="letter-card stagger-mount bounded-stagger"
                style={{ '--stagger-delay': getBoundedStaggerDelay(i) } as React.CSSProperties}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="letter-body">
                      {data.text}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {format(parseISO(event.at), t('date.formatYear'), { locale: dateFnsLocale })}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {t(`role.${event.author.role}`)} {event.author.name}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      data-message-action="edit"
                      data-event-id={event.id}
                      className="record-icon-button"
                      onClick={() => openComposer(event)}
                      aria-label={t('messages.editTitle')}
                    >
                      <IconPencil size={13} color="var(--stone-400)" />
                    </button>
                    <button
                      type="button"
                      data-message-action="delete"
                      data-event-id={event.id}
                      className="record-icon-button"
                      onClick={() => handleDelete(event)}
                      aria-label={confirmDelete === event.id ? t('timeline.confirmDelete') : t('timeline.delete')}
                      style={{
                        background: confirmDelete === event.id ? 'var(--rose-100)' : 'none',
                        color: confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)',
                      }}
                    >
                      <IconTrash size={13} color={confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)'} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
          {canLoadMore && (
            <div className="progressive-list-footer">
              <button
                type="button"
                className="btn-secondary progressive-load-more"
                data-list-load-more="messages"
                data-list-remaining={remainingCount}
                onClick={handleLoadMore}
              >
                {t('messages.loadMore', { count: nextBatchCount })}
              </button>
            </div>
          )}
        </div>
      )}

      {composerOpen && (
        <MessageComposer
          initial={editTarget ?? undefined}
          babyName={babyName}
          onSave={handleSave}
          onClose={() => { setComposerOpen(false); setEditTarget(null) }}
        />
      )}
    </div>
  )
}
