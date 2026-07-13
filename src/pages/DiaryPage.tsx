import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconPlus, IconPencil, IconTrash, IconX } from '../components/icons'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { DiaryEvent, DiaryData } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'
import { sortValidEventsNewestFirst } from '../lib/eventTime'
import { getBoundedStaggerDelay, useProgressiveList } from '../lib/useProgressiveList'
import { AccessibleFormDialog } from '../components/AccessibleFormDialog'

// ---------------------------------------------------------------------------
// Diary entry editor
// ---------------------------------------------------------------------------

interface EditorProps {
  initial?: DiaryEvent
  onSave: (title: string, text: string) => Promise<void>
  onClose: () => void
}

function DiaryEditor({ initial, onSave, onClose }: EditorProps) {
  const data = initial?.data as DiaryData | undefined
  const [title, setTitle]  = useState(data?.title ?? '')
  const [text, setText]    = useState(data?.text  ?? '')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const titleId = useId()
  const titleInputId = useId()
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
      await onSave(title.trim(), text.trim())
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
      modalName="diary"
      titleId={titleId}
      busy={saving}
      initialFocusRef={textRef}
      onClose={onClose}
      onSubmit={() => { void handleSave() }}
    >
        <div className="editor-modal-header">
          <h2 id={titleId} className="editor-modal-title">
            {initial ? t('diary.editTitle') : t('diary.write')}
          </h2>
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

        <div>
          <label className="label" htmlFor={titleInputId}>{t('diary.titleLabel')}</label>
          <input
            id={titleInputId}
            data-editor-input="diary-title"
            type="text"
            className="input-field"
            placeholder={t('diary.titlePlaceholder')}
            value={title}
            onChange={e => {
              setTitle(e.target.value)
              setSaveFailed(false)
            }}
            disabled={saving}
          />
        </div>

        <div>
          <label className="label" htmlFor={textInputId}>{t('diary.contentLabel')}</label>
          <textarea
            ref={textRef}
            id={textInputId}
            data-editor-input="diary-text"
            className="textarea-field"
            placeholder={t('diary.contentPlaceholder')}
            style={{ minHeight: 160 }}
            value={text}
            onChange={e => {
              setText(e.target.value)
              setSaveFailed(false)
            }}
            aria-describedby={saveFailed ? errorId : undefined}
            disabled={saving}
          />
        </div>

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
            {t('diary.cancel')}
          </button>
          <button
            type="submit"
            data-editor-action="save"
            className="btn-primary editor-modal-control"
            disabled={saving || !text.trim()}
            style={{ opacity: !text.trim() ? 0.5 : 1 }}
          >
            {saving ? t('diary.saving') : t('diary.save')}
          </button>
        </div>
    </AccessibleFormDialog>
  )
}

// ---------------------------------------------------------------------------
// DiaryPage
// ---------------------------------------------------------------------------

export function DiaryPage() {
  const events    = useAppStore(s => s.events)
  const settings  = useAppStore(s => s.settings)
  const { addEvent, editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  const [editorOpen, setEditorOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const deleteFocusTarget = useRef<string | null>(null)
  const loadMoreFocusTarget = useRef<string | null>(null)
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const diaryEvents = useMemo(() =>
    sortValidEventsNewestFirst(events.filter(e => !e.deleted && e.type === 'diary')),
    [events]
  )
  const {
    visibleItems,
    remainingCount,
    canLoadMore,
    nextBatchCount,
    loadMore,
  } = useProgressiveList(diaryEvents)

  useLayoutEffect(() => {
    const targetId = deleteFocusTarget.current
    if (!targetId) return
    const target = Array.from(
      pageRef.current?.querySelectorAll<HTMLButtonElement>('[data-diary-action="edit"]') ?? [],
    ).find(button => button.dataset.eventId === targetId)
    if (!target) return
    deleteFocusTarget.current = null
    target.focus({ preventScroll: true })
  }, [diaryEvents])

  useLayoutEffect(() => {
    const targetId = loadMoreFocusTarget.current
    if (!targetId) return
    const target = Array.from(
      pageRef.current?.querySelectorAll<HTMLButtonElement>('[data-diary-action="edit"]') ?? [],
    ).find(button => button.dataset.eventId === targetId)
    if (!target) return
    loadMoreFocusTarget.current = null
    target.focus({ preventScroll: true })
  }, [visibleItems.length])

  const handleLoadMore = () => {
    if (remainingCount <= nextBatchCount) {
      loadMoreFocusTarget.current = diaryEvents[visibleItems.length]?.id ?? null
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

  const handleSave = async (title: string, text: string) => {
    const time = new Date().toISOString()
    try {
      if (editTarget) {
        await editEvent(editTarget, { data: { title, text } as DiaryData })
        showToast({ message: t('diary.toastEdited') })
      } else {
        const event: DiaryEvent = {
          id: uuidv4(),
          mutationId: uuidv4(),
          type: 'diary',
          at: time,
          data: { title, text } as DiaryData,
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
        showToast({ message: t('diary.toastSaved') })
      }
    } catch {
      showToast({ message: t('toast.saveFailed') })
      throw new Error('diary_save_failed')
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
        showToast({ message: t('diary.toastDeleted') })
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

  const openEditor = (event?: DiaryEvent) => {
    setEditTarget(event ?? null)
    setEditorOpen(true)
  }

  return (
    <div ref={pageRef} className="page-container" data-tour="diary">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div className="page-title">{t('diary.title')}</div>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => openEditor()}
        >
          <IconPlus size={14} color="white" />
          {t('diary.write')}
        </button>
      </div>

      {diaryEvents.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            {/* Open book illustration */}
            <svg width="64" height="52" viewBox="0 0 64 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M32 8V44" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M32 10C32 10 24 6 12 8V42C24 40 32 44 32 44" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M32 10C32 10 40 6 52 8V42C40 40 32 44 32 44" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M17 16C20 15.5 24 15.5 27 16" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M17 22C20 21.5 24 21.5 27 22" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M17 28C20 27.5 24 27.5 27 28" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M37 16C40 15.5 44 15.5 47 16" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M37 22C40 21.5 44 21.5 47 22" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <div className="empty-state-title">{t('diary.emptyTitle')}</div>
            <div className="empty-state-sub">{t('diary.emptySub')}</div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
          {visibleItems.map((event, i) => {
            const data = event.data as DiaryData
            return (
              <div
                key={`${event.id}-${event.rev}`}
                data-diary-entry
                data-event-id={event.id}
                className="card stagger-mount bounded-stagger"
                style={{
                  padding: '16px 18px',
                  '--stagger-delay': getBoundedStaggerDelay(i),
                } as React.CSSProperties}
              >
                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {data.title && (
                      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--stone-800)', marginBottom: 4 }}>
                        {data.title}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: 'var(--stone-600)', lineHeight: 1.65, whiteSpace: 'pre-line' }}>
                      {data.text.length > 120 ? data.text.slice(0, 120) + '…' : data.text}
                    </div>
                  </div>
                </div>
                {/* Footer row: date + author chip (right-aligned) */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                    {format(parseISO(event.at), t('date.formatFull'), { locale: dateFnsLocale })}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {event.author?.name && (
                      <span style={{
                        fontSize: 11, color: 'var(--stone-500)',
                        background: 'var(--stone-100)', borderRadius: 99, padding: '2px 8px',
                      }}>
                        {t(`role.${event.author.role}`)} {event.author.name}
                      </span>
                    )}
                    <button
                      type="button"
                      data-diary-action="edit"
                      data-event-id={event.id}
                      className="record-icon-button"
                      onClick={() => openEditor(event)}
                      aria-label={t('diary.editTitle')}
                    >
                      <IconPencil size={13} color="var(--stone-400)" />
                    </button>
                    <button
                      type="button"
                      data-diary-action="delete"
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
                data-list-load-more="diary"
                data-list-remaining={remainingCount}
                onClick={handleLoadMore}
              >
                {t('diary.loadMore', { count: nextBatchCount })}
              </button>
            </div>
          )}
        </div>
      )}

      {editorOpen && (
        <DiaryEditor
          initial={editTarget ?? undefined}
          onSave={handleSave}
          onClose={() => { setEditorOpen(false); setEditTarget(null) }}
        />
      )}
    </div>
  )
}
