import React, { useState } from 'react'
import { IconPencil, IconTrash } from './icons'
import { DiaryEvent } from '../../shared/types'
import { EventIcon, eventLabel } from './EventIcon'
import { formatEventValue, formatTime } from '../store/useAppStore'
import { TimeEditModal } from './TimeEditModal'
import { useAppStore } from '../store/useAppStore'
import { useToast } from './Toast'
import { useTranslation } from 'react-i18next'

interface EventTimelineProps {
  events: DiaryEvent[]
  showAuthor?: boolean
  editable?: boolean
}

/** Warm palette pairs: [bg, text] using CSS hex values */
const WARM_PALETTE: [string, string][] = [
  ['#e0edd9', '#3d7535'], // sage
  ['#fde8df', '#c55c30'], // peach
  ['#fef0cd', '#b07208'], // amber
  ['#fde3e8', '#d44060'], // rose
  ['#faf0d0', '#8c6a1a'], // warm sand
]

/** Deterministic warm color pair from name string */
function nameToWarmPair(name: string): [string, string] {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return WARM_PALETTE[Math.abs(hash) % WARM_PALETTE.length]
}

export function EventTimeline({ events, showAuthor = true, editable = true }: EventTimelineProps) {
  const { editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t } = useTranslation()
  const [editingAt, setEditingAt] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleTimeEdit = async (event: DiaryEvent, newAt: string) => {
    try {
      await editEvent(event, { at: newAt })
      setEditingAt(null)
      showToast({ message: t('toast.timeEdited') })
    } catch {
      setEditingAt(null)
      showToast({ message: t('toast.editFailed') })
    }
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      try {
        await softDeleteEvent(event)
        setConfirmDelete(null)
        showToast({ message: t('toast.deleted') })
      } catch {
        setConfirmDelete(null)
        showToast({ message: t('toast.deleteFailed') })
      }
    } else {
      setConfirmDelete(event.id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  if (events.length === 0) {
    return (
      <div className="empty-state">
        <svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M22 36C22 27.163 29.163 20 38 20C39.4 20 40.76 20.18 42.06 20.52C40.14 14.42 34.54 10 28 10C19.716 10 13 16.716 13 25C13 33.284 19.716 40 28 40C29.14 40 30.26 39.87 31.32 39.62C25.8 38.3 22 32.58 22 36Z" stroke="var(--stone-300)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="42" cy="9" r="2" stroke="var(--stone-300)" strokeWidth="2.5"/>
          <circle cx="50" cy="18" r="1.5" stroke="var(--stone-300)" strokeWidth="2.5"/>
          <circle cx="46" cy="3" r="1" stroke="var(--stone-300)" strokeWidth="2.5"/>
        </svg>
        <div className="empty-state-title">{t('timeline.emptyTitle')}</div>
        <div className="empty-state-sub">{t('timeline.emptySub')}</div>
      </div>
    )
  }

  return (
    <>
      <div className="timeline-rail">
        {events.map((event, i) => {
          const authorName = event.author?.name ?? ''
          const initial = authorName ? authorName.charAt(0).toUpperCase() : ''
          const [avatarBg, avatarFg] = nameToWarmPair(authorName)

          return (
            <div
              key={`${event.id}-${event.rev}`}
              className="timeline-item stagger-mount"
              style={{ '--i': i } as React.CSSProperties}
            >
              {/* Rail dot */}
              <span className="timeline-dot" />

              {/* Time */}
              <span className="timeline-time">{formatTime(event.at)}</span>

              {/* Icon chip */}
              <EventIcon type={event.type} size={14} />

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-800)' }}>
                    {eventLabel(event.type)}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--stone-500)' }}>
                    {formatEventValue(event)}
                  </span>
                </div>
              </div>

              {/* Author avatar */}
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

              {/* Edit/delete */}
              {editable && (
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <button
                    onClick={() => setEditingAt(event)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '4px', color: 'var(--stone-400)', borderRadius: 5,
                    }}
                    title={t('timeline.editTime')}
                  >
                    <IconPencil size={13} color="var(--stone-400)" />
                  </button>
                  <button
                    onClick={() => handleDelete(event)}
                    style={{
                      background: confirmDelete === event.id ? 'var(--rose-100)' : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '4px',
                      color: confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)',
                      borderRadius: 5,
                    }}
                    title={confirmDelete === event.id ? t('timeline.confirmDelete') : t('timeline.delete')}
                  >
                    <IconTrash size={13} color={confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)'} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {editingAt && (
        <TimeEditModal
          currentAt={editingAt.at}
          onConfirm={(newAt) => handleTimeEdit(editingAt, newAt)}
          onClose={() => setEditingAt(null)}
        />
      )}
    </>
  )
}
