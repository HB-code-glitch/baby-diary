import React, { useEffect, useRef, useState } from 'react'
import { IconPencil, IconTrash } from './icons'
import type { DiaryEvent } from '../../shared/types'
import { EventIcon, eventLabel } from './EventIcon'
import { formatEventValue, formatTime, useAppStore } from '../store/useAppStore'
import { TimeEditModal } from './TimeEditModal'
import { useToast } from './Toast'
import { useTranslation } from 'react-i18next'
import { getBoundedStaggerDelay } from '../lib/useProgressiveList'

interface EventTimelineProps {
  events: readonly DiaryEvent[]
  showAuthor?: boolean
  editable?: boolean
  emptyTitle?: string
  emptySub?: string
  compact?: boolean
}

/** Warm palette pairs: [bg, text] using CSS hex values */
const WARM_PALETTE: [string, string][] = [
  ['#e0edd9', '#3d7535'],
  ['#fde8df', '#c55c30'],
  ['#fef0cd', '#b07208'],
  ['#fde3e8', '#d44060'],
  ['#faf0d0', '#8c6a1a'],
]

/** Deterministic warm color pair from name string */
function nameToWarmPair(name: string): [string, string] {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return WARM_PALETTE[Math.abs(hash) % WARM_PALETTE.length]
}

interface PendingDeleteFocus {
  deletedId: string
  targetId: string | null
}

interface PendingEditFocus {
  editedId: string
  targetId: string | null
}

export function EventTimeline({
  events,
  showAuthor = true,
  editable = true,
  emptyTitle,
  emptySub,
  compact = false,
}: EventTimelineProps) {
  const { editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t } = useTranslation()
  const [editingAt, setEditingAt] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null)
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const timelineRegionRef = useRef<HTMLDivElement | null>(null)
  const restoreDeleteFocusRef = useRef<string | null>(null)
  const pendingDeleteFocusRef = useRef<PendingDeleteFocus | null>(null)
  const pendingEditFocusRef = useRef<PendingEditFocus | null>(null)
  const deletingRef = useRef<string | null>(null)

  useEffect(() => {
    if (confirmDelete) cancelDeleteRef.current?.focus()
    if (!confirmDelete && restoreDeleteFocusRef.current) {
      deleteButtonRefs.current.get(restoreDeleteFocusRef.current)?.focus()
      restoreDeleteFocusRef.current = null
    }
  }, [confirmDelete])

  useEffect(() => {
    if (confirmDelete && !events.some(event => event.id === confirmDelete)) {
      setConfirmDelete(null)
    }
  }, [confirmDelete, events])

  useEffect(() => {
    const pending = pendingDeleteFocusRef.current
    if (!pending || events.some(event => event.id === pending.deletedId)) return
    const preferredTarget = pending.targetId
      ? editButtonRefs.current.get(pending.targetId) ?? deleteButtonRefs.current.get(pending.targetId)
      : null
    const firstEventId = events[0]?.id
    const firstAvailableTarget = firstEventId
      ? editButtonRefs.current.get(firstEventId) ?? deleteButtonRefs.current.get(firstEventId)
      : null
    ;(preferredTarget ?? firstAvailableTarget ?? timelineRegionRef.current)?.focus()
    pendingDeleteFocusRef.current = null
  }, [events])

  useEffect(() => {
    const pending = pendingEditFocusRef.current
    if (!pending || editingAt) return
    const focusIds = [pending.editedId, pending.targetId, events[0]?.id]
      .filter((id): id is string => Boolean(id))
    const target = focusIds
      .map(id => editButtonRefs.current.get(id) ?? deleteButtonRefs.current.get(id))
      .find(Boolean)
    ;(target ?? timelineRegionRef.current)?.focus()
    pendingEditFocusRef.current = null
  }, [editingAt, events])

  const handleTimeEdit = async (event: DiaryEvent, newAt: string) => {
    const index = events.findIndex(item => item.id === event.id)
    const targetEvent = index >= 0
      ? events[index + 1] ?? events[index - 1] ?? null
      : events[0] ?? null
    try {
      await editEvent(event, { at: newAt })
      pendingEditFocusRef.current = { editedId: event.id, targetId: targetEvent?.id ?? null }
      showToast({ message: t('toast.timeEdited'), tone: 'status' })
      setEditingAt(null)
    } catch (error) {
      showToast({ message: t('toast.editFailed'), tone: 'error' })
      throw error
    }
  }

  const closeDeleteConfirmation = (eventId: string, restoreFocus = true) => {
    restoreDeleteFocusRef.current = restoreFocus ? eventId : null
    setConfirmDelete(null)
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (deletingRef.current) return
    const index = events.findIndex(item => item.id === event.id)
    const targetEvent = events[index + 1] ?? events[index - 1] ?? null
    pendingDeleteFocusRef.current = {
      deletedId: event.id,
      targetId: targetEvent?.id ?? null,
    }
    deletingRef.current = event.id
    setDeletingId(event.id)
    try {
      await softDeleteEvent(event)
      setConfirmDelete(null)
      showToast({ message: t('toast.deleted'), tone: 'status' })
    } catch {
      pendingDeleteFocusRef.current = null
      closeDeleteConfirmation(event.id)
      showToast({ message: t('toast.deleteFailed'), tone: 'error' })
    } finally {
      deletingRef.current = null
      setDeletingId(null)
    }
  }

  return (
    <div
      ref={timelineRegionRef}
      className="timeline-region"
      data-timeline-region
      role="region"
      aria-label={t('timeline.label')}
      tabIndex={-1}
    >
      {events.length === 0 ? (
        <div className="empty-state">
          <svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M22 36C22 27.163 29.163 20 38 20C39.4 20 40.76 20.18 42.06 20.52C40.14 14.42 34.54 10 28 10C19.716 10 13 16.716 13 25C13 33.284 19.716 40 28 40C29.14 40 30.26 39.87 31.32 39.62C25.8 38.3 22 32.58 22 36Z" stroke="var(--stone-300)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="42" cy="9" r="2" stroke="var(--stone-300)" strokeWidth="2.5"/>
            <circle cx="50" cy="18" r="1.5" stroke="var(--stone-300)" strokeWidth="2.5"/>
            <circle cx="46" cy="3" r="1" stroke="var(--stone-300)" strokeWidth="2.5"/>
          </svg>
          <div className="empty-state-title">{emptyTitle ?? t('timeline.emptyTitle')}</div>
          {(emptySub ?? t('timeline.emptySub')) && (
            <div className="empty-state-sub">{emptySub ?? t('timeline.emptySub')}</div>
          )}
        </div>
      ) : (
        <>
          <div className={`timeline-rail${compact ? ' timeline-rail-compact' : ''}`}>
            {events.map((event, index) => {
              const authorName = event.author?.name ?? ''
              const initial = authorName ? authorName.charAt(0).toUpperCase() : ''
              const [avatarBg, avatarFg] = nameToWarmPair(authorName)
              const isDeleting = deletingId === event.id

              return (
                <div
                  key={event.id}
                  data-event-id={event.id}
                  data-event-rev={event.rev}
                  className="timeline-item stagger-mount bounded-stagger"
                  style={{ '--stagger-delay': getBoundedStaggerDelay(index) } as React.CSSProperties}
                >
                  <span className="timeline-dot" aria-hidden="true" />
                  <span className="timeline-time">{formatTime(event.at)}</span>
                  <EventIcon type={event.type} size={14} />

                  <div className="timeline-content">
                    <div className="timeline-event-copy">
                      <span className="timeline-event-label">{eventLabel(event.type)}</span>
                      <span className="timeline-event-value">{formatEventValue(event)}</span>
                    </div>
                  </div>

                  {showAuthor && initial && (
                    <div
                      className="author-avatar"
                      style={{ background: avatarBg, color: avatarFg }}
                      title={authorName}
                      aria-label={authorName}
                    >
                      {initial}
                    </div>
                  )}

                  {editable && (
                    <div className="timeline-actions">
                      {confirmDelete === event.id ? (
                        <div
                          className="timeline-delete-confirm"
                          role="group"
                          aria-label={t('timeline.deleteConfirmAria', {
                            label: eventLabel(event.type),
                            time: formatTime(event.at),
                          })}
                          aria-busy={isDeleting || undefined}
                          onKeyDown={keyboardEvent => {
                            if (keyboardEvent.key === 'Escape' && !isDeleting) {
                              keyboardEvent.preventDefault()
                              closeDeleteConfirmation(event.id)
                            }
                          }}
                        >
                          <span className="timeline-delete-prompt">{t('timeline.deletePrompt')}</span>
                          <button
                            ref={cancelDeleteRef}
                            type="button"
                            className="timeline-confirm-button"
                            onClick={() => closeDeleteConfirmation(event.id)}
                            disabled={isDeleting}
                          >
                            {t('timeline.cancelDelete')}
                          </button>
                          <button
                            data-event-action="confirm-delete"
                            type="button"
                            className="timeline-confirm-button timeline-confirm-button-danger"
                            onClick={() => { void handleDelete(event) }}
                            disabled={isDeleting}
                          >
                            {t('timeline.confirmDeleteAction')}
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            data-event-action="edit"
                            ref={button => {
                              if (button) editButtonRefs.current.set(event.id, button)
                              else editButtonRefs.current.delete(event.id)
                            }}
                            type="button"
                            className="timeline-action-button"
                            onClick={() => setEditingAt(event)}
                            aria-label={t('timeline.editEventAria', {
                              label: eventLabel(event.type),
                              time: formatTime(event.at),
                            })}
                            title={t('timeline.editTime')}
                          >
                            <IconPencil size={15} color="currentColor" />
                          </button>
                          <button
                            data-event-action="delete"
                            ref={button => {
                              if (button) deleteButtonRefs.current.set(event.id, button)
                              else deleteButtonRefs.current.delete(event.id)
                            }}
                            type="button"
                            className="timeline-action-button"
                            onClick={() => setConfirmDelete(event.id)}
                            aria-label={t('timeline.deleteEventAria', {
                              label: eventLabel(event.type),
                              time: formatTime(event.at),
                            })}
                            title={t('timeline.delete')}
                          >
                            <IconTrash size={15} color="currentColor" />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {editingAt && (
            <TimeEditModal
              currentAt={editingAt.at}
              onConfirm={newAt => handleTimeEdit(editingAt, newAt)}
              onClose={() => setEditingAt(null)}
            />
          )}
        </>
      )}
    </div>
  )
}
